// The three TreeDataProviders. Each one fetches, then hands rows to items.js.

const vscode = require("vscode")
const { listPrs, prDetails, stacksOf, status, uncommittedPlan } = require("./but")
const { repoRoot } = require("./exec")
const { branchFiles, changedFiles, contaminated, diffNames, overlapMap } = require("./git")
const { branchGroupItem, branchItem, commitItem, commitsGroupItem, dirtyFileItem, fileItem, folderItem, hunkItem, prItem, prStackItem, stackItem, unplacedGroupItem, wholeStackItem } = require("./items")
const { byBranch, commitLens, commitsKey, committedMode, fileTree, layoutFor, positions, rowsOf, splitOverlap, wholeStack } = require("./model")

/** The boilerplate every provider needs: rows are TreeItems already, so
 *  getTreeItem is the identity, and refreshing is one event. */
class Tree {
    constructor() {
        this.changed = new vscode.EventEmitter()
        this.onDidChangeTreeData = this.changed.event
    }

    refresh() {
        this.changed.fire()
    }

    getTreeItem(node) {
        return node
    }
}

class BranchTree extends Tree {
    constructor(store) {
        super()
        // one workspaceState-backed store, two key namespaces
        this.reviewed = store
        this.overrides = store
        // the one commit open under each branch, and how many times each commit
        // row has been closed to make room for another. Not in the store: both
        // describe rows on screen, and a stored one would outlive them
        this.openCommit = new Map()
        this.shut = new Map()
        // the commits row a branch's commits hang off, so shutting one of them
        // repaints that row alone
        this.rowFor = new Map()
    }

    refresh() {
        this.overlap = undefined // recomputed on next expand
        this.where = undefined
        this.rowFor.clear()
        super.refresh()
    }

    /** One commit open at a time under a branch: expanding a second closes the
     *  first, so a branch's files are never split across two commits on screen.
     *  Does nothing when the row is already in that state — VSCode re-reports
     *  a row it has just repainted, and repainting on the way back in would
     *  never settle. */
    openOneCommit(branch, commit, open) {
        const key = commitsKey(branch)
        const was = this.openCommit.get(key)
        if (open === (was === commit.changeId)) return
        if (!open) return void this.openCommit.delete(key)

        this.openCommit.set(key, commit.changeId)
        // only the row being closed needs a repaint, and only to be handed a
        // new id: the one the reader just opened is already open
        if (was) {
            this.shut.set(was, (this.shut.get(was) ?? 0) + 1)
            this.changed.fire(this.rowFor.get(key))
        }
    }

    async getChildren(node) {
        const root = repoRoot()
        if (!root) return []
        try {
            if (!node) return await this.topLevel(root)
            if (node.stack) return await this.stackChildren(root, node.stack)
            // before the branch case below, which is the fallthrough: a folder
            // row carries a branch too, and reaching that case would refetch
            // the branch's whole diff every time you expanded a directory
            if (node.folder)
                return this.rows(node.folder.node, node.folder.branch)
            if (node.commitsOf) {
                const open = this.openCommit.get(commitsKey(node.commitsOf))
                return node.commitsOf.commits.map((c) =>
                    commitItem(
                        c,
                        node.commitsOf,
                        c.changeId === open,
                        this.shut.get(c.changeId)
                    )
                )
            }
            if (node.commit)
                return await this.filesOf(
                    root,
                    commitLens(node.commit.commit),
                    node.commit.branch
                )

            const rows = await this.filesOf(root, node.branch, node.branch)
            // above the files, because it is the same diff read the other way
            // and a row that moves with the file count is a row you hunt for. A
            // branch of one commit is that commit, so the row would lead to the
            // list it already sits on.
            if (!(node.branch.commits?.length > 1)) return rows
            const group = commitsGroupItem(node.branch)
            this.rowFor.set(group.id, group)
            return [group, ...rows]
        } catch (e) {
            vscode.window.showErrorMessage(`but-review: ${e.message}`)
            return []
        }
    }

    /** The rows for one diff. `lens` is what the diff is taken over — a branch,
     *  the whole stack, or a single commit; `layoutBranch` is who the list/tree
     *  toggle belongs to, which for a commit is the branch it hangs under. */
    async filesOf(root, lens, layoutBranch) {
        // a commit is only ever read as it was committed, whatever the view's
        // own toggle says: there is no workspace side to a diff between two
        // commits, and nothing in it belongs to anyone else
        const committed = lens.committed || committedMode(this.reviewed)
        const [files, dirty] = await Promise.all([
            changedFiles(root, lens, committed),
            lens.committed ? new Set() : contaminated(root, lens),
        ])
        const entries = files.map((f) => ({
            f,
            branch: lens,
            blob: f.blob,
            // the row's tick and its warnings both belong to the pane the
            // row opens, and there are two of those
            committed,
            // whole-stack lens only: which of the stack's own branches build
            // this file. Not gated on `dirty` — a file assembled in steps is
            // worth flagging whether or not anyone else touches it too
            within: (lens.members ?? []).filter((n) =>
                this.overlap?.get(f.file)?.includes(n)
            ),
            // names come from the overlap map, but only for files that
            // actually carry someone else's hunks — and split, because a
            // branch above in your own stack is not the same news as one
            // in a stack of its own
            alsoIn: splitOverlap(
                lens,
                dirty.has(f.file)
                    ? (this.overlap?.get(f.file) ?? []).filter(
                          (n) => n !== lens.name
                      )
                    : [],
                this.where ?? new Map()
            ),
        }))
        if (layoutFor(layoutBranch, this.overrides) === "list")
            return entries.map((e) => fileItem(e, this.reviewed, true))
        return this.rows(fileTree(entries), lens)
    }

    /** One directory's rows. The tree is built once when the branch is expanded
     *  and every folder row carries its own node, so expanding one is free —
     *  no `but` or `git` call is reachable from here. */
    rows(node, branch) {
        return rowsOf(node).map((r) =>
            r.folder
                ? folderItem(r.folder, branch, this.reviewed)
                : fileItem(r.file, this.reviewed, false)
        )
    }

    /** The stack's branches, top-first as `but status` and the GitButler app
     *  show them, under the one row that reads all of them at once. No guard for
     *  a single branch: a one-branch stack renders as its branch, so the two
     *  would be the same diff and this is never reached with one. */
    async stackChildren(root, stack) {
        const ws = wholeStack(stack)
        const files = await diffNames(root, ws.base, ws.name)
        return [
            wholeStackItem(ws, stack, files.length, this.overrides),
            ...stack.branches.map((b) => branchItem(b, this.overrides)),
        ]
    }

    /** A one-branch stack is shown as the branch itself — no pointless wrapper. */
    async topLevel(root) {
        const stacks = stacksOf(await status(root), this.overrides)
        const files = await branchFiles(root, stacks)
        this.overlap = overlapMap(files)
        this.where = positions(stacks)
        for (const s of stacks)
            for (const b of s.branches)
                b.fileCount = files.get(b.name)?.length
        return stacks.map((stack) =>
            stack.branches.length === 1
                ? branchItem(stack.branches[0], this.overrides)
                : stackItem(stack)
        )
    }
}

/** Pending edits are a different mode from browsing branches — an inbox wanting
 *  decisions, not a surface to scan — so they get their own view. */
class UncommittedTree extends Tree {
    async getChildren(node) {
        const root = repoRoot()
        if (!root) return []
        try {
            // a branch row and the Unplaced row both carry their files
            if (node?.rows)
                return node.rows.map((r) => dirtyFileItem(r, node.unplaced))
            if (node?.row)
                return node.row.hunks.map((_, i) =>
                    hunkItem(node.row, i, node.unplaced)
                )
            if (node) return []

            const st = await status(root)
            const plan = await uncommittedPlan(root, st)
            // unplaced last: the branch rows are the plan you skim and
            // accept, and the strays are the leftovers you deal with after —
            // above them they pushed the whole plan down the panel
            return [
                ...byBranch(plan.groups, positions(stacksOf(st))).map(
                    branchGroupItem
                ),
                ...(plan.unplaced.length
                    ? [unplacedGroupItem(plan.unplaced)]
                    : []),
            ]
        } catch (e) {
            vscode.window.showErrorMessage(`but-review: ${e.message}`)
            return []
        }
    }
}

/** Applied branches with an open PR, grouped by stack — the one thing the
 *  GitHub extension cannot show, since it has no idea stacks exist. Lazy and
 *  separately refreshed: `gh` is network, unlike everything else here. */
class PrTree extends Tree {
    constructor(store) {
        super()
        // only for the stack names, which the two views have to agree on
        this.overrides = store
    }

    refresh() {
        this.cache = undefined
        this.threads = undefined
        super.refresh()
    }

    async getChildren(node) {
        const root = repoRoot()
        if (!root) return []
        if (node) return node.prs?.map(prItem) ?? []
        try {
            // the promise is what's cached, not its result: two overlapping
            // refreshes would otherwise both get past the await and fetch twice
            const prs = await (this.cache ??= listPrs(root))
            // threads and conflict state cost another round trip and only ever
            // change a circle, so don't hold the rows for them — fill the same
            // PR objects in the background and repaint. `changed.fire()`, not
            // `refresh()`, or the repaint would clear the cache and loop.
            this.threads ??= prDetails(root, prs)
                .catch(() => {})
                .then(() => this.changed.fire())

            const stacks = stacksOf(await status(root), this.overrides)
            const byBranch = new Map(prs.map((p) => [p.headRefName, p]))

            const rows = []
            for (const stack of stacks) {
                // bottom-first: the branch nearest master is the one that lands next
                const prs = stack.branches
                    .map((b) => ({ branch: b, pr: byBranch.get(b.name) }))
                    .filter((r) => r.pr)
                if (!prs.length) continue
                rows.push(prs.length === 1 ? prItem(prs[0]) : prStackItem(stack, prs))
            }
            return rows
        } catch (e) {
            // a cached rejection would keep failing until a manual refresh
            this.cache = undefined
            vscode.window.showErrorMessage(
                `but-review: could not list pull requests (${e.message.split("\n")[0]})`
            )
            return []
        }
    }
}

module.exports = { BranchTree, UncommittedTree, PrTree }
