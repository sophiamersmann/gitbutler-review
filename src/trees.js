// The three TreeDataProviders. Each one fetches, then hands rows to items.js.

const vscode = require("vscode")
const { listPrs, prDetails, stacksOf, status, uncommittedPlan } = require("./but")
const { repoRoot } = require("./exec")
const { branchFiles, changedFiles, contaminated, diffNames, overlapMap } = require("./git")
const { branchGroupItem, branchItem, dirtyFileItem, fileItem, folderItem, hunkItem, prItem, prStackItem, stackItem, unplacedGroupItem, wholeStackItem } = require("./items")
const { byBranch, committedMode, fileTree, layoutFor, positions, rowsOf, splitOverlap, wholeStack } = require("./model")

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
    }

    refresh() {
        this.overlap = undefined // recomputed on next expand
        this.where = undefined
        super.refresh()
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

            const committed = committedMode(this.reviewed)
            const [files, dirty] = await Promise.all([
                changedFiles(root, node.branch, committed),
                contaminated(root, node.branch),
            ])
            const entries = files.map((f) => ({
                f,
                branch: node.branch,
                blob: f.blob,
                // the row's tick and its warnings both belong to the pane the
                // row opens, and there are two of those
                committed,
                // whole-stack lens only: which of the stack's own branches build
                // this file. Not gated on `dirty` — a file assembled in steps is
                // worth flagging whether or not anyone else touches it too
                within: (node.branch.members ?? []).filter((n) =>
                    this.overlap?.get(f.file)?.includes(n)
                ),
                // names come from the overlap map, but only for files that
                // actually carry someone else's hunks — and split, because a
                // branch above in your own stack is not the same news as one
                // in a stack of its own
                alsoIn: splitOverlap(
                    node.branch,
                    dirty.has(f.file)
                        ? (this.overlap?.get(f.file) ?? []).filter(
                              (n) => n !== node.branch.name
                          )
                        : [],
                    this.where ?? new Map()
                ),
            }))
            if (layoutFor(node.branch, this.overrides) === "list")
                return entries.map((e) => fileItem(e, this.reviewed, true))
            return this.rows(fileTree(entries), node.branch)
        } catch (e) {
            vscode.window.showErrorMessage(`but-review: ${e.message}`)
            return []
        }
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
