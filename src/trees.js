// The three TreeDataProviders. Each one fetches, then hands rows to items.js.

const vscode = require("vscode")
const { stacksOf, status, uncommittedPlan } = require("./but")
const { repoRoot, run } = require("./exec")
const { blobShas, branchFiles, changedFiles, contaminated, overlapMap } = require("./git")
const { branchItem, commitGroupItem, dirtyFileItem, fileItem, groupItem, prItem, prStackItem, stackItem, unanchoredGroupItem } = require("./items")
const { groupsOf, layoutFor } = require("./model")

class BranchTree {
    constructor(reviewed, overrides) {
        this.reviewed = reviewed
        this.overrides = overrides
        this.changed = new vscode.EventEmitter()
        this.onDidChangeTreeData = this.changed.event
        this.overlap = undefined
    }

    refresh() {
        this.overlap = undefined // recomputed on next expand
        this.changed.fire()
    }

    getTreeItem(node) {
        return node
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
            const blobs = await blobShas(
                root,
                node.branch,
                files.map((f) => f.file)
            )
            const entries = files.map((f) => ({
                f,
                branch: node.branch,
                blob: blobs.get(f.file) ?? "gone",
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
class UncommittedTree {
    constructor(view) {
        this.changed = new vscode.EventEmitter()
        this.onDidChangeTreeData = this.changed.event
        this.view = view
    }

    refresh() {
        this.changed.fire()
    }

    getTreeItem(node) {
        return node
    }

    async getChildren(node) {
        const root = repoRoot()
        if (!root) return []
        try {
            if (node?.rows) return node.rows.map((r) => dirtyFileItem(r, true))
            if (node?.group)
                return node.group.files.map((r) => dirtyFileItem(r, false))
            if (node) return []

            const plan = await uncommittedPlan(root, await status(root))
            this.plan = plan
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
class PrTree {
    constructor() {
        this.changed = new vscode.EventEmitter()
        this.onDidChangeTreeData = this.changed.event
    }

    refresh() {
        this.cache = undefined
        this.changed.fire()
    }

    getTreeItem(node) {
        return node
    }

    async getChildren(node) {
        const root = repoRoot()
        if (!root) return []
        if (node) return node.prs?.map(prItem) ?? []
        try {
            const stacks = stacksOf(await status(root))
            // one call for every PR; per-PR lookups would be ~1s each
            const byBranch = new Map(
                (this.cache ??= JSON.parse(
                    await run(
                        "gh",
                        [
                            "pr", "list", "--author", "@me", "--limit", "100",
                            "--json",
                            "number,title,url,isDraft,reviews,reviewRequests,headRefName",
                        ],
                        root
                    )
                )).map((p) => [p.headRefName, p])
            )

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
            vscode.window.showErrorMessage(
                `but-review: could not list pull requests (${e.message.split("\n")[0]})`
            )
            return []
        }
    }
}

module.exports = { BranchTree, UncommittedTree, PrTree }
