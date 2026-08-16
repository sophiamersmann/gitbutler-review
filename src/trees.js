// The three TreeDataProviders. Each one fetches, then hands rows to items.js.

const vscode = require("vscode")
const { listPrs, reviewThreads, stacksOf, status, uncommittedPlan } = require("./but")
const { repoRoot } = require("./exec")
const { branchFiles, changedFiles, contaminated, overlapMap } = require("./git")
const { branchItem, commitGroupItem, dirtyFileItem, fileItem, groupItem, prItem, prStackItem, stackItem, unanchoredGroupItem } = require("./items")
const { groupsOf, layoutFor } = require("./model")

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
        super.refresh()
    }

    async getChildren(node) {
        const root = repoRoot()
        if (!root) return []
        try {
            if (!node) return await this.topLevel(root)
            // top-first, as `but status` and the GitButler app show a stack
            if (node.stack) return node.stack.branches.map((b) => branchItem(b, this.overrides))
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
                // names come from the overlap map, but only for files that
                // actually carry someone else's hunks
                alsoIn: dirty.has(f.file)
                    ? (this.overlap?.get(f.file) ?? []).filter(
                          (n) => n !== node.branch.name
                      )
                    : [],
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

    /** A one-branch stack is shown as the branch itself — no pointless wrapper. */
    async topLevel(root) {
        const stacks = stacksOf(await status(root))
        const files = await branchFiles(root, stacks)
        this.overlap = overlapMap(files)
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
            if (node?.rows) return node.rows.map((r) => dirtyFileItem(r, true))
            if (node?.group)
                return node.group.files.map((r) => dirtyFileItem(r, false))
            if (node) return []

            const plan = await uncommittedPlan(root, await status(root))
            const anchored = plan.groups.reduce((n, g) => n + g.files.length, 0)
            this.view.description = plan.unanchored.length
                ? `${anchored} anchored, ${plan.unanchored.length} unanchored`
                : `${plan.total} file${plan.total > 1 ? "s" : ""}`
            return [
                ...(plan.unanchored.length
                    ? [unanchoredGroupItem(plan.unanchored)]
                    : []),
                ...plan.groups.map(commitGroupItem),
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
            // thread resolution costs another round trip and only ever changes
            // a circle, so don't hold the rows for it — fill the same PR
            // objects in the background and repaint. `changed.fire()`, not
            // `refresh()`, or the repaint would clear the cache and loop.
            this.threads ??= reviewThreads(root, prs)
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
