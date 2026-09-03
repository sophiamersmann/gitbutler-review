// The three TreeDataProviders. Each one fetches, then hands rows to items.js.

const vscode = require("vscode")
const { openPrs, prDetails, stacksOf, status, uncommittedPlan } = require("./but")
const { listPlans } = require("./plans")
const { repoRoot } = require("./exec")
const { branchFiles, changedFiles, contaminated, diffNames, overlapMap } = require("./git")
const { branchGroupItem, branchItem, commitItem, commitsGroupItem, dirtyFileItem, filesGroupItem, fileItem, folderItem, hunkItem, planItem, planLinkItem, planStageItem, planTaskItem, plansGroupItem, prItem, prStackItem, stackItem, unplacedGroupItem, wholeStackItem } = require("./items")
const { byBranch, commitLens, commitsKey, committedMode, filesKey, fileTree, layoutFor, livePlans, parkedPlans, pinnedPlans, planIndex, planRows, positions, rowsOf, splitOverlap, wholeStack } = require("./model")

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
        // which of a branch's two readings is open, which commit within the
        // commits one, and how many times each row has been closed to make room
        // for another. Not in the store: all three describe rows on screen, and
        // a stored one would outlive them
        this.reading = new Map()
        this.openCommit = new Map()
        this.shut = new Map()
        // the branch row, so closing one of its rows repaints that branch alone
        this.rowFor = new Map()
    }

    refresh() {
        this.overlap = undefined // recomputed on next expand
        this.where = undefined
        this.rowFor.clear()
        super.refresh()
    }

    /** A branch reads as its files or as its commits, one at a time: opening
     *  either row folds the other, which stays where it is with its count on it.
     *  Nothing is hidden — the files are in the commits row too, under whichever
     *  commit wrote them. */
    readAs(branch, which) {
        const key = commitsKey(branch)
        if ((this.reading.get(key) ?? "files") === which) return
        this.reading.set(key, which)
        this.close(
            which === "files" ? commitsKey(branch) : filesKey(branch),
            branch
        )
    }

    /** One commit open at a time under a branch, so a branch's files are never
     *  split across two commits on screen. Does nothing when the row is already
     *  in that state — VSCode re-reports a row it has just repainted, and
     *  repainting on the way back in would never settle. */
    openOneCommit(branch, commit, open) {
        const key = commitsKey(branch)
        const was = this.openCommit.get(key)
        if (open === (was === commit.changeId)) return
        if (!open) return void this.openCommit.delete(key)
        this.openCommit.set(key, commit.changeId)
        // the row the reader just opened is already open; only the one being
        // closed needs anything doing to it
        if (was) this.close(was, branch)
    }

    /** Close a row VSCode is holding open. It restores expansion from the id and
     *  offers no way to collapse a row (microsoft/vscode#40179), so the row comes
     *  back under an id it has never seen — which is all the count is for. */
    close(id, branch) {
        this.shut.set(id, (this.shut.get(id) ?? 0) + 1)
        // no row cached means the tree has been rebuilt since — `fire()` with
        // nothing is the whole tree, which is the right answer then
        this.changed.fire(this.rowFor.get(commitsKey(branch)))
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
            if (node.plansOf)
                return node.plansOf.plans.map((link) =>
                    planLinkItem(link, node.plansOf)
                )
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
            if (node.filesOf)
                return await this.filesOf(root, node.filesOf, node.filesOf)
            if (node.commit)
                return await this.filesOf(
                    root,
                    commitLens(node.commit.commit),
                    node.commit.branch
                )

            // the plan comes before the diff, as the whole-stack row comes
            // before the branches it reads — but folded once there is more than
            // one, so the diff is not pushed down the screen by paperwork
            const links = node.branch.plans ?? []
            const plans =
                links.length > 1
                    ? [plansGroupItem(node.branch)]
                    : links.map((link) => planLinkItem(link, node.branch))
            // a branch of one commit is that commit, so a commits row would
            // lead to the file list it sits on, and the file list needs no row
            // of its own to fold against
            if (!(node.branch.commits?.length > 1))
                return [
                    ...plans,
                    ...(await this.filesOf(root, node.branch, node.branch)),
                ]
            const key = commitsKey(node.branch)
            const reading = this.reading.get(key) ?? "files"
            this.rowFor.set(key, node)
            return [
                ...plans,
                commitsGroupItem(
                    node.branch,
                    reading === "commits",
                    this.shut.get(key)
                ),
                filesGroupItem(
                    node.branch,
                    reading === "files",
                    this.shut.get(filesKey(node.branch))
                ),
            ]
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
        // a readdir whose parses are already cached by mtime, so it costs a
        // stat per plan beside a status call that costs 230ms
        const [st, plans] = await Promise.all([status(root), listPlans(root)])
        // the PR titles name the stacks, and `gh` is network: draw with what
        // has arrived and repaint once when the list lands
        const prs = openPrs.arrived()
        if (!prs)
            this.awaitingPrs ??= openPrs(root)
                .then(() => this.changed.fire(), () => {})
                .finally(() => (this.awaitingPrs = undefined))
        const stacks = stacksOf(st, this.overrides, prs)
        const files = await branchFiles(root, stacks)
        this.overlap = overlapMap(files)
        this.where = positions(stacks)
        const links = planIndex(plans)
        for (const s of stacks)
            for (const b of s.branches) {
                b.fileCount = files.get(b.name)?.length
                b.plans = links.get(b.name) ?? []
            }
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
        openPrs.invalidate()
        this.threads = undefined
        super.refresh()
    }

    async getChildren(node) {
        const root = repoRoot()
        if (!root) return []
        if (node) return node.prs?.map(prItem) ?? []
        try {
            const prs = await openPrs(root)
            // threads and conflict state cost another round trip and only ever
            // change a circle, so don't hold the rows for them — fill the same
            // PR objects in the background and repaint. `changed.fire()`, not
            // `refresh()`, or the repaint would clear the cache and loop.
            this.threads ??= prDetails(root, prs)
                .catch(() => {})
                .then(() => this.changed.fire())

            const stacks = stacksOf(await status(root), this.overrides, prs)

            const rows = []
            for (const stack of stacks) {
                // bottom-first: the branch nearest master is the one that lands next
                const prs = stack.branches
                    .map((b) => ({ branch: b, pr: b.pr }))
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

/** Plan documents, newest first. Two of these back the two Plans views: the
 *  pinned one holds the plans pinned by hand and those whose branch is applied
 *  and not unpinned by hand, the other holds the rest. A live plan says its
 *  branch where the others say their age, whichever view it is in. */
class PlanTree extends Tree {
    constructor(pinned, store) {
        super()
        this.pinned = pinned
        this.store = store
        // plan name -> its row, so a click can hand the view the node to expand.
        // Rebuilt with the rows, since a stale one is a row VSCode no longer has
        this.rowFor = new Map()
    }

    refresh() {
        this.rowFor.clear()
        super.refresh()
    }

    // reveal() is the only way to open a row from here, and it needs this. Every
    // plan is a top-level row, and a phase behind one is never revealed
    getParent() {
        return undefined
    }

    async getChildren(node) {
        const root = repoRoot()
        if (!root) return []
        try {
            if (node?.plan) return this.rows(node.plan)
            if (node) return []

            const { plans, live, pinned, parked } = await planListing(root, this.store)
            const inPinned = (p) => pinned.has(p) || (live.has(p) && !parked.has(p))
            return plans
                .filter((p) => inPinned(p) === this.pinned)
                .map((p) => this.row(p, live.get(p)))
        } catch (e) {
            vscode.window.showErrorMessage(`but-review: ${e.message}`)
            return []
        }
    }

    row(plan, live) {
        const item = planItem(plan, { live, pinned: this.pinned })
        this.rowFor.set(plan.name, item)
        return item
    }

    /** Whichever structure the plan has — `planRows` picks it, so the row that
     *  offered a twistie and the rows behind it cannot disagree. */
    rows(plan) {
        return planRows(plan).map((row) =>
            row.stage
                ? planStageItem(row.stage, plan)
                : planTaskItem(row.task, plan)
        )
    }
}

/** Every plan; for each whose branch is applied, what makes it live; and which
 *  are pinned, or as live plans unpinned, by hand. */
async function planListing(root, store) {
    const plans = await listPlans(root)
    const where = await appliedBranches(root)
    const live = new Map(livePlans(plans, where).map((l) => [l.plan, l]))
    return {
        plans,
        live,
        pinned: pinnedPlans(store, plans),
        parked: parkedPlans(store, live, where),
    }
}

/** Where each applied branch sits, which is what says a plan is live. A repo
 *  GitButler does not manage still has plans, so a failed status costs the
 *  live plans their place in the pinned view and nothing more. */
const appliedBranches = (root) =>
    status(root)
        .then((st) => positions(stacksOf(st)))
        .catch(() => new Map())

module.exports = { BranchTree, PlanTree, UncommittedTree, PrTree, planListing }
