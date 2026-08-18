// The three TreeDataProviders. Each one fetches, then hands rows to items.js.

const vscode = require("vscode")
const { listPrs, prDetails, stacksOf, status, uncommittedPlan } = require("./but")
const { repoRoot } = require("./exec")
const { branchFiles, changedFiles, contaminated, diffNames, overlapMap } = require("./git")
const { branchFilesItem, branchGroupItem, branchItem, commitGroupItem, dirtyFileItem, fileItem, groupItem, hunkItem, prItem, prStackItem, stackItem, unanchoredGroupItem, wholeStackItem } = require("./items")
const { byBranch, groupsOf, layoutFor, positions, splitOverlap, wholeStack } = require("./model")

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
            if (node.group)
                return node.group.map((e) => fileItem(e, this.reviewed, false))

            const [files, dirty] = await Promise.all([
                changedFiles(root, node.branch),
                contaminated(root, node.branch),
            ])
            const entries = files.map((f) => ({
                f,
                branch: node.branch,
                blob: f.blob,
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
            // a group of one is two rows and an expand to reach a single file,
            // so it stays a plain row. Directories first, then the strays —
            // the convention every file manager uses.
            const grouped = groupsOf(entries)
            return [
                ...grouped
                    .filter((g) => g.files.length > 1)
                    .map(groupItem),
                ...grouped
                    .filter((g) => g.files.length === 1)
                    .map((g) => fileItem(g.files[0], this.reviewed, true)),
            ]
        } catch (e) {
            vscode.window.showErrorMessage(`but-review: ${e.message}`)
            return []
        }
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
        const stacks = stacksOf(await status(root))
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
            // `commits`, not `branch`: BranchTree means something else by that
            if (node?.commits) {
                // always, even for a single commit: this row is what the
                // branch's absorb acts on, and a tree that changes shape with
                // the commit count is one you have to read twice
                return [
                    branchFilesItem(node.branch),
                    ...node.commits.map((g) => commitGroupItem(g)),
                ]
            }
            if (node?.rows)
                return node.rows.map((r) => dirtyFileItem(r, node.unanchored))
            if (node?.group)
                return node.group.files.map((r) => dirtyFileItem(r, false))
            if (node?.row)
                return node.row.hunks.map((_, i) =>
                    hunkItem(node.row, i, node.unanchored)
                )
            if (node) return []

            const st = await status(root)
            const plan = await uncommittedPlan(root, st)
            // hides the view's Absorb button: with a stray in the list the
            // command can only refuse, and a button that never works is worse
            // than no button. Set here because this is where the plan already
            // is — the command keeps its own guard for the palette, and for a
            // plan that changed since the last render.
            vscode.commands.executeCommand(
                "setContext",
                "butReview.hasUnanchored",
                plan.unanchored.length > 0
            )
            // unanchored last: the commit groups are the plan you skim and
            // accept, and the strays are the leftovers you deal with after —
            // above them they pushed the whole plan down the panel
            return [
                ...byBranch(plan.groups, positions(stacksOf(st))).map(
                    branchGroupItem
                ),
                ...(plan.unanchored.length
                    ? [unanchoredGroupItem(plan.unanchored)]
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

            const stacks = stacksOf(await status(root))
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
