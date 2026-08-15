const vscode = require("vscode")
const { execFile } = require("child_process")
const path = require("path")

const BASE = "butbase" // butbase:/<path>?<ref>    — the file as of a ref, read-only
const FILE = "butfile" // butfile:/<path>?<status> — a file row, for decorations
const PR = "butpr" //     butpr:/<number>?<ci>      — a PR row, for decorations

// git's empty tree: `git show <it>:anything` fails, so the provider yields "".
// Used as the right-hand side for files that no longer exist.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

const DECORATION = {
    A: ["A", "gitDecoration.addedResourceForeground"],
    M: ["M", "gitDecoration.modifiedResourceForeground"],
    D: ["D", "gitDecoration.deletedResourceForeground"],
}

// One circle summarising the PR, not two independent signals: 🟢 is a surrogate
// pair, so it already fills the 2-character badge budget on its own. Ordered by
// what it asks of you, most demanding first.
const ROLLUP = [
    ["🔴", "needs work", (ci, d) => ci === "failing" || d === "changes requested"],
    ["🟡", "CI running", (ci) => ci === "running"],
    ["🔵", "review requested", (ci, d) => d === "review requested"],
    ["🟢", "approved", (ci, d) => d === "approved"],
    ["⚪", "nothing pending", () => true],
]

const rollup = (ci, decision) =>
    ROLLUP.find(([, , when]) => when(ci, decision))

const CI_COLOR = {
    success: "testing.iconPassed",
    failure: "testing.iconFailed",
    unknown: "testing.iconQueued",
}

const LETTER = { added: "A", modified: "M", deleted: "D" }

function run(cmd, args, cwd) {
    return new Promise((resolve, reject) =>
        execFile(
            cmd,
            args,
            {
                cwd,
                maxBuffer: 64 * 1024 * 1024,
                // a Dock-launched VSCode doesn't get homebrew or /usr/local on PATH
                env: {
                    ...process.env,
                    PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`,
                },
            },
            (err, stdout) => (err ? reject(err) : resolve(stdout))
        )
    )
}

// Resolved per call, not at activation — an activation-time throw would stop the
// commands from ever registering, which looks exactly like "nothing happens".
const repoRoot = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath

const uri = (scheme, file, query) =>
    vscode.Uri.parse(`${scheme}:/${file}?${query}`)

/** Coarse on purpose: "3d ago" is what separates live work from stale, and a
 *  scan never needs more precision than that. */
function ago(iso) {
    const days = Math.round((Date.now() - new Date(iso)) / 86400000)
    if (days < 1) return "today"
    if (days < 30) return `${days}d ago`
    return `${Math.round(days / 30)}mo ago`
}

// Three views ask for status on every refresh and it costs ~230ms, so collapse
// the burst. Short-lived rather than explicitly invalidated: a stale read can
// only ever be a couple of seconds old.
let statusCache = { at: 0, value: undefined }
function status(root) {
    if (Date.now() - statusCache.at > 2000)
        statusCache = {
            at: Date.now(),
            value: run("but", ["status", "--json"], root).then(JSON.parse),
        }
    return statusCache.value
}

const cfg = () => vscode.workspace.getConfiguration("butReview")

/** CI summary with the noisy checks dropped, so one flaky job doesn't colour
 *  the whole branch. Recomputes the conclusion rather than trusting `but`'s,
 *  which counts every check. */
function ciState(branch) {
    const ignored = cfg().get("ignoredChecks", [])
    const keep = (titles) =>
        titles.filter(
            (t) =>
                !ignored.some((p) =>
                    t.toLowerCase().includes(String(p).toLowerCase())
                )
        )
    const failing = keep(branch.failing)
    const pending = keep(branch.pending)
    const passing = keep(branch.passing)
    if (failing.length)
        return {
            state: "failing",
            label: `✗ ${failing.length} failing`,
            color: CI_COLOR.failure,
            failing,
        }
    if (pending.length)
        return {
            state: "running",
            label: `… ${pending.length} running`,
            color: CI_COLOR.unknown,
            failing,
        }
    if (passing.length)
        return { state: "passing", label: "✓ CI", color: CI_COLOR.success, failing }
    return { failing }
}

const isBot = (login) =>
    login.endsWith("[bot]") ||
    cfg()
        .get("botReviewers", [])
        .some((b) => String(b).toLowerCase() === login.toLowerCase())

/** GitHub's own rule: COMMENTED never supersedes a decision, so per reviewer
 *  take their last APPROVED/CHANGES_REQUESTED. `latestReviews` holds only each
 *  reviewer's most recent review, so an approval followed by a comment reads as
 *  unreviewed there. Bots are dropped first. */
function humanDecision(pr) {
    const byAuthor = new Map()
    for (const r of pr.reviews ?? []) {
        const login = r.author?.login ?? ""
        if (isBot(login)) continue
        if (!["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state))
            continue
        byAuthor.set(login, r.state)
    }
    const states = [...byAuthor.values()]
    if (states.includes("CHANGES_REQUESTED")) return "changes requested"
    if (states.includes("APPROVED")) return "approved"
    return (pr.reviewRequests ?? []).length ? "review requested" : undefined
}

/** Applied stacks, each branch paired with the branch below it.
 *  Ordered by most recent commit — `but`'s own order is the app's lane order,
 *  which says nothing about what you are working on. The one thing it did
 *  encode, that lane 0 is where unanchored changes land, becomes a flag so the
 *  fact survives without dictating position.
 *  Branches stay top-first here so `base` keeps referring to the next entry;
 *  views reverse at render time. */
function stacksOf(st) {
    return st.stacks
        .map((stack, lane) => ({
        cliId: stack.cliId,
        primary: lane === 0,
        activity: stack.branches
            .flatMap((b) => b.commits.map((c) => c.createdAt))
            .sort()
            .pop(),
        branches: stack.branches.map((b, i) => ({
            name: b.name,
            base: stack.branches[i + 1]?.name ?? st.mergeBase.commitId,
            pr: b.reviewId?.replace(/[()]/g, ""),
            passing: b.ci?.passingCheckTitles ?? [],
            pending: b.ci?.pendingCheckTitles ?? [],
            failing: b.ci?.failingCheckTitles ?? [],
            subjects: b.commits.map((c) => c.message.split("\n")[0]),
            latest: b.commits[0]?.createdAt,
        })),
    }))
        .map((stack) => ({
            ...stack,
            // a stack of nothing but docs is never the thing you came here for
            demoted: stack.branches.every((b) => isDemoted(b.name)),
        }))
        .sort(
            (a, b) =>
                a.demoted - b.demoted ||
                (b.activity ?? "").localeCompare(a.activity ?? "")
        )
}

/** Matched on hyphen-separated tokens, so "docs" catches `my-docs` and
 *  `docs-cleanup` without catching `docstring-fix`. */
const isDemoted = (name) => {
    const tokens = name.toLowerCase().split("-")
    return cfg()
        .get("demoteBranches", [])
        .some((p) => tokens.includes(String(p).toLowerCase()))
}

const filesOf = async (root, branch) =>
    (
        await run(
            "git",
            ["diff", "--no-ext-diff", "--name-only", "--no-renames", branch.base, branch.name, "--"],
            root
        )
    )
        .split("\n")
        .filter(Boolean)

/** Changed files with their status letter and churn. */
async function changedFiles(root, branch) {
    // --no-renames keeps paths plain in both outputs, so they zip by path
    const args = ["diff", "--no-ext-diff", "--no-renames", branch.base, branch.name, "--"]
    const [numstat, nameStatus] = await Promise.all([
        run("git", [...args.slice(0, -1), "--numstat", "--"], root),
        run("git", [...args.slice(0, -1), "--name-status", "--"], root),
    ])

    const churn = new Map(
        numstat
            .split("\n")
            .filter(Boolean)
            .map((l) => {
                const [adds, dels, file] = l.split("\t")
                return [file, { adds, dels }]
            })
    )
    return nameStatus
        .split("\n")
        .filter(Boolean)
        .map((l) => {
            const [st, file] = l.split("\t")
            return { file, status: st[0], ...churn.get(file) }
        })
}

/** Lines in the workspace copy of a file that this branch did NOT put there —
 *  i.e. everything the other applied branches contribute to the right-hand pane.
 *  Compared against HEAD (the workspace commit) rather than the worktree, so
 *  your own in-progress edits aren't flagged as somebody else's. */
async function foreignRanges(root, branch, file) {
    const out = await run(
        "git",
        ["diff", "--no-ext-diff", "-U0", "--no-renames", branch.name, "HEAD", "--", file],
        root
    )
    const ranges = []
    for (const line of out.split("\n")) {
        const m = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line)
        if (!m) continue
        const start = Number(m[1])
        const count = m[2] === undefined ? 1 : Number(m[2])
        // count 0 is a pure deletion — no line in this pane to decorate
        if (count > 0)
            ranges.push(
                new vscode.Range(start - 1, 0, start + count - 2, Number.MAX_SAFE_INTEGER)
            )
    }
    return ranges
}

/** Files whose workspace copy differs from this branch's tip — precisely what
 *  another applied branch contributes to the right-hand pane. Asking "does some
 *  other branch touch this path" instead over-reports badly: a branch *below*
 *  yours has its changes in the base too, so they cancel out of the diff. */
const contaminated = async (root, branch) =>
    new Set(
        (
            await run(
                "git",
                ["diff", "--no-ext-diff", "--name-only", "--no-renames", branch.name, "HEAD", "--"],
                root
            )
        )
            .split("\n")
            .filter(Boolean)
    )

/** file -> its blob SHA at the branch tip. Keying "reviewed" on the blob means
 *  a tick survives a reload but clears itself the moment the branch's version of
 *  that file changes — which is exactly what absorbing an edit does. */
async function blobShas(root, branch, files) {
    if (!files.length) return new Map()
    const out = await run(
        "git",
        ["ls-tree", "-z", branch.name, "--", ...files],
        root
    )
    return new Map(
        out
            .split("\0")
            .filter(Boolean)
            .map((rec) => {
                const [meta, file] = rec.split("\t")
                return [file, meta.split(/\s+/)[2]]
            })
    )
}

/** branch name -> the files it changes. One pass, reused for both the row's
 *  file count and the cross-branch overlap check. */
async function branchFiles(root, stacks) {
    const all = stacks.flatMap((s) => s.branches)
    return new Map(
        await Promise.all(
            all.map(async (b) => [b.name, await filesOf(root, b)])
        )
    )
}

/** path -> branch names that also change it. The workspace holds every applied
 *  branch at once, so a file touched by two of them shows both sets of hunks in
 *  the diff — this is what makes that visible instead of merely confusing. */
function overlapMap(files) {
    const map = new Map()
    for (const [name, paths] of files)
        for (const p of paths) map.set(p, (map.get(p) ?? []).concat(name))
    return map
}

const absorbPlan = async (root, ...source) =>
    JSON.parse(
        await run("but", ["absorb", "--dry-run", "--json", ...source], root)
    )

/** (file, commit) -> reason. The batch plan reports one reason per commit group,
 *  which a file with no dependency of its own silently inherits — so ask about
 *  each file separately. Proven: README.md reads `hunk_dependency` in the batch
 *  and `default_stack` on its own. */
async function fileReasons(root, changes) {
    const per = await Promise.all(
        changes.map((c) =>
            absorbPlan(root, c.cliId).catch(() => ({ commits: [] }))
        )
    )
    return new Map(
        per.flatMap((plan) =>
            plan.commits.flatMap((k) =>
                k.files.map((f) => [`${f.path}\0${k.commit_id}`, k.reason])
            )
        )
    )
}

/** Splits what absorb would do into commits that genuinely depend on a change,
 *  and changes nothing depends on — which land in the primary lane by default
 *  and so must not be filed under a branch as if they belonged to it. */
async function uncommittedPlan(root, st) {
    const changes = st.uncommittedChanges
    const [batch, reasons] = await Promise.all([
        absorbPlan(root),
        fileReasons(root, changes),
    ])

    const commitMeta = new Map()
    for (const s of st.stacks)
        for (const b of s.branches)
            for (const c of b.commits)
                commitMeta.set(c.commitId, { branch: b.name, cliId: c.cliId })
    const changeOf = new Map(changes.map((c) => [c.filePath, c]))

    // With a single applied branch there is nowhere else a change could go, so
    // "unanchored" would be noise that teaches you to ignore the warning.
    const ambiguous = st.stacks.flatMap((s) => s.branches).length > 1

    const groups = []
    const unanchored = []
    for (const k of batch.commits) {
        const meta = commitMeta.get(k.commit_id) ?? {}
        const files = []
        for (const f of k.files) {
            const row = {
                ...f,
                commit: k,
                meta,
                change: changeOf.get(f.path),
            }
            const reason = reasons.get(`${f.path}\0${k.commit_id}`) ?? k.reason
            if (ambiguous && reason === "default_stack") unanchored.push(row)
            else files.push(row)
        }
        if (files.length) groups.push({ commit: k, meta, files })
    }
    return { groups, unanchored, total: batch.total_files }
}

/** "@531,6 +531,8" -> the line the hunk starts at in the working copy */
const hunkLine = (hunk) => Number(/\+(\d+)/.exec(hunk)?.[1] ?? 1)

class BranchTree {
    constructor(reviewed) {
        this.reviewed = reviewed
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
            if (node.stack) return node.stack.branches.map((b) => branchItem(b))
            if (node.folder) return this.rows(node.folder, 0, false)

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
            return this.rows(buildTree(entries), entries.length)
        } catch (e) {
            vscode.window.showErrorMessage(`but-review: ${e.message}`)
            return []
        }
    }

    /** Folders first, then loose files. `count` only matters at the root, where
     *  it decides list-versus-tree; below that we are already in a tree. */
    rows(node, count, root = true) {
        if (root && layoutFor(count) === "list")
            return descendants(node).map((e) => fileItem(e, this.reviewed, true))
        return [
            ...folders(node).map((d) => folderItem(d, this.reviewed)),
            ...node.files.map((e) => fileItem(e, this.reviewed, false)),
        ]
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
                ? branchItem(stack.branches[0])
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
            this.view.badge = plan.unanchored.length
                ? {
                      value: plan.unanchored.length,
                      tooltip: `${plan.unanchored.length} change${plan.unanchored.length > 1 ? "s need" : " needs"} placing`,
                  }
                : undefined
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

function unanchoredGroupItem(rows) {
    const item = new vscode.TreeItem(
        "Unanchored",
        vscode.TreeItemCollapsibleState.Expanded
    )
    item.description = "no commit depends on these"
    item.iconPath = new vscode.ThemeIcon(
        "warning",
        new vscode.ThemeColor("butReview.foreignHunkBorder")
    )
    item.tooltip =
        "Absorb would drop these in the primary lane by default, not because anything depends on them. Place them explicitly with \"Amend Into…\"."
    item.contextValue = "unanchoredGroup"
    item.rows = rows
    return item
}

function commitGroupItem(group) {
    const item = new vscode.TreeItem(
        group.commit.commit_summary,
        vscode.TreeItemCollapsibleState.Expanded
    )
    item.description = group.meta.branch ?? ""
    item.iconPath = new vscode.ThemeIcon("git-commit")
    item.tooltip = new vscode.MarkdownString(
        [
            `**${group.commit.commit_summary}**`,
            group.meta.branch ? `on \`${group.meta.branch}\`` : "",
            `_${group.commit.reason_description}_`,
        ]
            .filter(Boolean)
            .join("  \n")
    )
    item.contextValue = "commitGroup"
    item.group = group
    return item
}

function dirtyFileItem(row, unanchored) {
    const letter = LETTER[row.change?.changeType] ?? "M"
    const item = new vscode.TreeItem(uri(FILE, row.path, letter))
    item.description = unanchored
        ? `would default to ${row.meta.branch ?? "the primary lane"}`
        : row.hunks.join(", ")
    item.tooltip = new vscode.MarkdownString(
        [
            `\`${row.path}\``,
            unanchored
                ? `⚠️ Nothing depends on this. Absorb would put it on **${row.meta.branch}** simply because that lane is first.`
                : `Absorbs into **${row.commit.commit_summary}**`,
            `hunks: ${row.hunks.join(", ")}`,
        ].join("  \n")
    )
    item.command = {
        command: "butReview.openDirty",
        title: "Open Changes",
        arguments: [row.change, hunkLine(row.hunks[0])],
    }
    item.contextValue = unanchored ? "unanchoredFile" : "dirtyFile"
    item.row = row
    return item
}

/** A stack has no name of its own, so never borrow a member's — least of all
 *  the top branch, which changes every time another is pushed on. Prefer what
 *  the author already wrote, then what the branch names agree on, then admit
 *  there is no name. */
function stackName(stack) {
    const topics = new Map()
    for (const b of stack.branches)
        for (const s of b.subjects) {
            const topic = /^\S+\s*\(([^)]+)\)/.exec(s)?.[1]
            if (topic) topics.set(topic, (topics.get(topic) ?? 0) + 1)
        }
    const commonest = [...topics].sort((a, b) => b[1] - a[1])[0]
    if (commonest) return commonest[0]

    const names = stack.branches.map((b) => b.name)
    let prefix = ""
    for (let i = 0; i < names[0].length; i++) {
        const c = names[0][i]
        if (!names.every((n) => n[i] === c)) break
        prefix += c
    }
    // keep the prefix only if it ends on a word boundary in every name, so
    // reference-entity{,-debug} keeps "reference-entity" rather than "reference"
    const clean = names.every(
        (n) => n.length === prefix.length || n[prefix.length] === "-"
    )
    if (!clean) prefix = prefix.replace(/-?[^-]*$/, "")
    return prefix.length > 2 ? prefix : `Stack of ${names.length}`
}

function stackItem(stack) {
    const item = new vscode.TreeItem(
        stackName(stack),
        vscode.TreeItemCollapsibleState.Collapsed
    )
    item.description = [
        `${stack.branches.length} branches`,
        // already computed for the recency sort
        !stack.demoted && stack.activity && ago(stack.activity),
    ]
        .filter(Boolean)
        .join(" · ")
    item.iconPath = new vscode.ThemeIcon(
        "layers",
        new vscode.ThemeColor("butReview.stackIcon")
    )
    item.tooltip = new vscode.MarkdownString(
        [
            `\`${stack.cliId}\`${stack.primary ? " — unanchored changes absorb here" : ""}`,
            "",
            ...stack.branches.map((b) => `- ${b.name}`),
        ].join("\n")
    )
    item.contextValue = "stack"
    item.stack = stack
    return item
}

function branchItem(branch, primary) {
    const item = new vscode.TreeItem(
        branch.name,
        vscode.TreeItemCollapsibleState.Collapsed
    )
    const ci = ciState(branch)
    item.description = [
        // green is the norm; saying so for ten branches is noise
        ci.state !== "passing" && ci.label,
        // a docs branch is always freshly touched and never the thing you act
        // on, so its age is noise
        !isDemoted(branch.name) && branch.latest && ago(branch.latest),
    ]
        .filter(Boolean)
        .join(" · ")
    item.iconPath = new vscode.ThemeIcon(
        "git-branch",
        new vscode.ThemeColor("butReview.branchIcon")
    )
    item.tooltip = new vscode.MarkdownString(
        [
            `**${branch.name}**`,
            branch.fileCount === undefined
                ? ""
                : `${branch.fileCount} file${branch.fileCount === 1 ? "" : "s"} changed`,
            `Compared against \`${branch.base}\``,
            ci.label ?? "",
            ...ci.failing.map((c) => `- ✗ ${c}`),
            `Compared against \`${branch.base}\``,
            "",
            ...branch.subjects.map((s) => `- ${s}`),
        ]
            .filter(Boolean)
            .join("\n")
    )
    item.contextValue = "branch"
    item.branch = branch
    return item
}

const reviewKey = (branch, file) => `reviewed:${branch.name}:${file}`

const AUTO_TREE_THRESHOLD = 10

/** list | tree, resolving "auto" by size — a three-file branch as a tree is
 *  silly, a sixty-file branch as a flat list is what we started with. */
function layoutFor(count) {
    const setting = cfg().get("fileLayout", "auto")
    if (setting === "list" || setting === "tree") return setting
    return count > AUTO_TREE_THRESHOLD ? "tree" : "list"
}

/** Nested folders keyed by path segment. */
function buildTree(entries) {
    const root = { dirs: new Map(), files: [] }
    for (const e of entries) {
        const parts = e.f.file.split("/")
        parts.pop()
        let node = root
        for (const part of parts) {
            if (!node.dirs.has(part))
                node.dirs.set(part, { dirs: new Map(), files: [] })
            node = node.dirs.get(part)
        }
        node.files.push(e)
    }
    return root
}

/** Folder rows, with single-child chains merged into one — around half the
 *  directories in a monorepo hold a single file, and `a/b/c/d` as four nested
 *  rows is worse than the flat list it replaced. */
function folders(node) {
    return [...node.dirs].map(([name, child]) => {
        let label = name
        let cur = child
        while (cur.files.length === 0 && cur.dirs.size === 1) {
            const [next, grandchild] = [...cur.dirs][0]
            label += `/${next}`
            cur = grandchild
        }
        return { label, node: cur }
    })
}

const descendants = (node) => [
    ...node.files,
    ...[...node.dirs.values()].flatMap(descendants),
]

function folderItem(dir, reviewed) {
    const kids = descendants(dir.node)
    const item = new vscode.TreeItem(
        dir.label,
        vscode.TreeItemCollapsibleState.Collapsed
    )
    item.description = `${kids.length} file${kids.length === 1 ? "" : "s"}`
    item.iconPath = vscode.ThemeIcon.Folder
    item.contextValue = "folder"
    item.folder = dir.node
    // ticking a folder ticks everything under it — the point of the tree on a
    // sixty-file branch is not having to click sixty times
    item.review = kids.map((e) => ({
        key: reviewKey(e.branch, e.f.file),
        blob: e.blob,
    }))
    item.checkboxState = item.review.every((r) => reviewed?.get(r.key) === r.blob)
        ? vscode.TreeItemCheckboxState.Checked
        : vscode.TreeItemCheckboxState.Unchecked
    return item
}

function fileItem(entry, reviewed, showDir) {
    const { f, branch, blob, alsoIn } = entry
    // "!" marks the row as also-changed-elsewhere for the decoration provider
    const item = new vscode.TreeItem(
        uri(FILE, f.file, f.status + (alsoIn.length ? "!" : ""))
    )
    const churn = f.adds === "-" ? "binary" : `+${f.adds} −${f.dels}` // numstat marks binaries with -
    item.description = [
        churn,
        // in tree mode the folder row already says where the file lives
        alsoIn.length
            ? `⚠ also in ${alsoIn.join(", ")}`
            : showDir
              ? path.dirname(f.file)
              : "",
    ]
        .filter(Boolean)
        .join("  ·  ")
    item.tooltip = new vscode.MarkdownString(
        [
            `\`${f.file}\``,
            `${{ A: "Added", M: "Modified", D: "Deleted" }[f.status] ?? f.status} · ${churn}`,
            alsoIn.length
                ? `\n⚠️ Also changed by **${alsoIn.join("**, **")}**. The right-hand pane is the workspace file, so it shows those changes too.`
                : "",
        ]
            .filter(Boolean)
            .join("  \n")
    )
    item.command = {
        command: "butReview.openFile",
        title: "Open Changes",
        arguments: [branch, f, alsoIn],
    }
    item.contextValue = "file"
    const key = reviewKey(branch, f.file)
    item.review = [{ key, blob }]
    item.checkboxState =
        reviewed?.get(key) === blob
            ? vscode.TreeItemCheckboxState.Checked
            : vscode.TreeItemCheckboxState.Unchecked
    return item
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

function prStackItem(stack, prs) {
    const item = new vscode.TreeItem(
        stackName(stack),
        vscode.TreeItemCollapsibleState.Expanded
    )
    item.description = `${prs.length} PRs`
    item.iconPath = new vscode.ThemeIcon(
        "layers",
        new vscode.ThemeColor("butReview.stackIcon")
    )
    item.contextValue = "prStack"
    item.prs = prs
    return item
}

function prItem(row) {
    const { pr, branch } = row
    // not gated on isDraft: a draft with a review request is worth seeing
    const decision = humanDecision(pr)
    const ci = ciState(branch)
    const [circle, summary] = rollup(ci.state, decision)

    // branch names are short and scannable; the PR title is the elaboration
    const item = new vscode.TreeItem(branch.name)
    item.resourceUri = uri(PR, String(pr.number), summary)
    item.description = pr.title
    // shape and colour both say draft-or-open, GitHub's own convention, so the
    // two are told apart at a glance rather than by squinting at the glyph
    item.iconPath = new vscode.ThemeIcon(
        pr.isDraft ? "git-pull-request-draft" : "git-pull-request",
        new vscode.ThemeColor(
            pr.isDraft ? "butReview.prDraft" : "butReview.prOpen"
        )
    )
    // the row's own legend: name the circle, then the two facts behind it, so a
    // red dot's cause is readable without knowing the ladder
    item.tooltip = new vscode.MarkdownString(
        [
            `[#${pr.number} ${pr.title}](${pr.url})`,
            `on \`${branch.name}\``,
            "",
            `${circle}  **${summary}**`,
            `CI: ${ci.label ?? "no checks"}`,
            `Review: ${decision ?? "none requested"}${pr.isDraft ? " · draft" : ""}`,
            ...ci.failing.map((c) => `- ✗ ${c}`),
        ].join("  \n")
    )
    item.command = {
        command: "butReview.openUrl",
        title: "Open Pull Request",
        arguments: [pr.url],
    }
    item.contextValue = "pr"
    return item
}

function activate(context) {
    // workspaceState, so ticks are per-repo and survive a reload
    const reviewed = {
        get: (k) => context.workspaceState.get(k),
        set: (k, v) => context.workspaceState.update(k, v),
    }
    const tree = new BranchTree(reviewed)
    const prs = new PrTree()
    const branchView = vscode.window.createTreeView("butReview.branches", {
        treeDataProvider: tree,
    })
    const dirty = new UncommittedTree()
    const dirtyView = vscode.window.createTreeView("butReview.uncommitted", {
        treeDataProvider: dirty,
    })
    dirty.view = dirtyView // needs the view to set its badge; set after creation
    let saveTimer

    // The view is hidden while the tree is clean, so nothing renders an empty
    // box — which means its own getChildren can't be what discovers the state.
    const syncVisibility = async () => {
        const root = repoRoot()
        const n = root
            ? await status(root)
                  .then((st) => st.uncommittedChanges.length)
                  .catch(() => 0)
            : 0
        vscode.commands.executeCommand(
            "setContext",
            "butReview.hasUncommitted",
            n > 0
        )
        if (!n) dirtyView.badge = undefined
    }

    const openDiff = (left, right, title) =>
        vscode.commands.executeCommand("vscode.diff", left, right, title)

    // The diff editor already owns the background channel, so the marker lives
    // in opacity, a left rail and the ruler instead — see foreignRanges above.
    const foreign = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        opacity: "0.6",
        borderWidth: "0 0 0 2px",
        borderStyle: "solid",
        borderColor: new vscode.ThemeColor("butReview.foreignHunkBorder"),
        overviewRulerLane: vscode.OverviewRulerLane.Right,
        overviewRulerColor: new vscode.ThemeColor("butReview.foreignHunkBorder"),
    })

    /** uri string -> {branch, file, ranges, hover}; kept so open diffs can be
     *  recomputed after an absorb rather than showing stale dimming */
    const marked = new Map()

    const repaintOpen = async () => {
        const root = repoRoot()
        if (!root) return
        await Promise.all(
            [...marked].map(async ([key, m]) => {
                const ranges = await foreignRanges(root, m.branch, m.file).catch(
                    () => []
                )
                if (ranges.length) marked.set(key, { ...m, ranges })
                else marked.delete(key)
            })
        )
        paint()
    }

    const paint = () => {
        for (const editor of vscode.window.visibleTextEditors) {
            const m = marked.get(editor.document.uri.toString())
            if (m)
                editor.setDecorations(
                    foreign,
                    m.ranges.map((range) => ({
                        range,
                        hoverMessage: m.hover,
                    }))
                )
        }
    }

    // "auto" reads as list for the button's purposes: it only resolves per
    // branch, and the title bar has no branch in hand
    const syncLayoutContext = () =>
        vscode.commands.executeCommand(
            "setContext",
            "butReview.layout",
            cfg().get("fileLayout", "auto") === "tree" ? "tree" : "list"
        )

    syncVisibility()
    syncLayoutContext()

    function refreshAll() {
        tree.refresh()
        dirty.refresh()
        syncVisibility()
        repaintOpen()
    }

    context.subscriptions.push(
        // Left pane of every diff: read-only by virtue of being a content
        // provider, so edits typed there can't be silently lost.
        vscode.workspace.registerTextDocumentContentProvider(BASE, {
            provideTextDocumentContent: (u) =>
                run("git", ["show", `${u.query}:${u.path.slice(1)}`], repoRoot())
                    // a file that doesn't exist at that ref reads as empty
                    .catch(() => ""),
        }),

        // Scoped to our own scheme, so the Explorer's decorations are untouched.
        vscode.window.registerFileDecorationProvider({
            provideFileDecoration: (u) => {
                if (u.scheme === PR) {
                    const hit = ROLLUP.find(([, name]) => name === u.query)
                    return hit && { badge: hit[0], tooltip: hit[1] }
                }
                if (u.scheme !== FILE) return
                const [badge, color] = DECORATION[u.query[0]] ?? []
                if (!badge) return
                return {
                    badge,
                    color: new vscode.ThemeColor(
                        u.query.endsWith("!") ? "list.warningForeground" : color
                    ),
                }
            },
        }),

        branchView,
        branchView.onDidChangeCheckboxState(({ items }) => {
            for (const [item, state] of items)
                for (const { key, blob } of item.review ?? [])
                    reviewed.set(
                        key,
                        state === vscode.TreeItemCheckboxState.Checked
                            ? blob
                            : undefined
                    )
            tree.refresh() // a folder tick changes every row beneath it
        }),
        vscode.window.registerTreeDataProvider("butReview.prs", prs),
        dirtyView,

        vscode.commands.registerCommand("butReview.refreshPrs", () =>
            prs.refresh()
        ),

        vscode.commands.registerCommand("butReview.openUrl", (url) =>
            vscode.env.openExternal(vscode.Uri.parse(url))
        ),

        vscode.commands.registerCommand("butReview.refresh", refreshAll),

        ...["tree", "list"].map((mode) =>
            vscode.commands.registerCommand(
                `butReview.viewAs${mode[0].toUpperCase()}${mode.slice(1)}`,
                async () => {
                    await cfg().update(
                        "fileLayout",
                        mode,
                        vscode.ConfigurationTarget.Global
                    )
                    syncLayoutContext()
                    tree.refresh()
                }
            )
        ),

        vscode.window.onDidChangeVisibleTextEditors(paint),

        // The tree reads on demand, so an edit made elsewhere wouldn't show up
        // until you hit refresh. Saving is the cheapest honest trigger.
        vscode.workspace.onDidSaveTextDocument(() => {
            clearTimeout(saveTimer)
            saveTimer = setTimeout(refreshAll, 500)
        }),

        vscode.commands.registerCommand(
            "butReview.openFile",
            async (branch, f, alsoIn = []) => {
                const live = vscode.Uri.file(path.join(repoRoot(), f.file))
                // a deleted file has no workspace side; show it against nothing
                const right =
                    f.status === "D" ? uri(BASE, f.file, EMPTY_TREE) : live

                if (f.status !== "D") {
                    const ranges = await foreignRanges(
                        repoRoot(),
                        branch,
                        f.file
                    ).catch(() => [])
                    if (ranges.length)
                        marked.set(right.toString(), {
                            branch,
                            file: f.file,
                            ranges,
                            hover: new vscode.MarkdownString(
                                `Not part of \`${branch.name}\`${
                                    alsoIn.length
                                        ? ` — also changed by ${alsoIn
                                              .map((b) => `\`${b}\``)
                                              .join(", ")}`
                                        : ""
                                }.`
                            ),
                        })
                }

                await openDiff(
                    uri(BASE, f.file, branch.base),
                    right,
                    `${path.basename(f.file)} — ${branch.name}`
                )
                paint()
            }
        ),

        vscode.commands.registerCommand(
            "butReview.openDirty",
            async (c, line) => {
                const right =
                    c.changeType === "deleted"
                        ? uri(BASE, c.filePath, EMPTY_TREE)
                        : vscode.Uri.file(path.join(repoRoot(), c.filePath))
                await openDiff(
                    uri(BASE, c.filePath, "HEAD"),
                    right,
                    `${path.basename(c.filePath)} — uncommitted`
                )
                if (!line) return
                const editor = vscode.window.visibleTextEditors.find(
                    (e) => e.document.uri.toString() === right.toString()
                )
                const at = new vscode.Range(line - 1, 0, line - 1, 0)
                editor?.revealRange(at, vscode.TextEditorRevealType.InCenter)
                if (editor) editor.selection = new vscode.Selection(at.start, at.start)
            }
        ),

        vscode.commands.registerCommand("butReview.amendInto", async (node) => {
            try {
                const root = repoRoot()
                const st = await status(root)
                // separators rather than a flat list: a workspace with several
                // stacks applied runs to hundreds of commits, and the branch is
                // how you actually find the one you want
                const picks = st.stacks.flatMap((s) =>
                    s.branches.flatMap((b) => [
                        {
                            label: b.name,
                            kind: vscode.QuickPickItemKind.Separator,
                        },
                        ...b.commits.map((c) => ({
                            label: c.message.split("\n")[0],
                            description: b.name,
                            id: c.cliId,
                        })),
                    ])
                )
                const pick = await vscode.window.showQuickPick(picks, {
                    title: `Amend ${path.basename(node.row.path)} into which commit?`,
                    matchOnDescription: true,
                    placeHolder: "Type a branch name to narrow the list",
                })
                if (!pick) return
                await run(
                    "but",
                    ["amend", "-t", pick.id, node.row.change.cliId],
                    root
                )
                refreshAll()
            } catch (e) {
                vscode.window.showErrorMessage(`but-review: ${e.message}`)
            }
        }),

        // From a tree node it gets that branch; from the palette it asks.
        vscode.commands.registerCommand("butReview.absorb", async () => {
            try {
                const root = repoRoot()
                if (!root) throw new Error("no folder open")

                const plan = await uncommittedPlan(root, await status(root))
                if (!plan.total)
                    return vscode.window.showInformationMessage(
                        "Nothing to absorb."
                    )

                // Absorbing the anchored files one at a time would rewrite
                // history between calls and shift the rest, so make the user
                // place these first and keep the real absorb one atomic call.
                if (plan.unanchored.length)
                    return vscode.window.showWarningMessage(
                        `${plan.unanchored.length} change${plan.unanchored.length > 1 ? "s have" : " has"} no commit to absorb into.`,
                        {
                            modal: true,
                            detail: `Place ${plan.unanchored.length > 1 ? "them" : "it"} first with "Amend Into\u2026" on the row.\n\n${plan.unanchored
                                .map(
                                    (r) =>
                                        `    ${r.path}  \u2192  would default to ${r.meta.branch}`
                                )
                                .join("\n")}`,
                        }
                    )

                const files = plan.total
                const commits = plan.groups.length
                await run("but", ["absorb"], root)
                refreshAll()
                vscode.window.showInformationMessage(
                    `Absorbed ${files} file${files > 1 ? "s" : ""} into ${commits} commit${commits > 1 ? "s" : ""}. \`but undo\` reverses it.`
                )
            } catch (e) {
                vscode.window.showErrorMessage(`but-review: ${e.message}`)
            }
        }),

        // From a tree node it gets that branch; from the palette it asks.
        vscode.commands.registerCommand(
            "butReview.reviewBranch",
            async (node) => {
                try {
                    const root = repoRoot()
                    if (!root) throw new Error("no folder open")

                    let branch = node?.branch
                    if (!branch) {
                        const all = stacksOf(await status(root)).flatMap(
                            (s) => s.branches
                        )
                        const pick = await vscode.window.showQuickPick(
                            all.map((b) => ({
                                label: b.name,
                                description: [b.pr, `vs ${short(b.base)}`]
                                    .filter(Boolean)
                                    .join(" · "),
                                b,
                            })),
                            { title: "Review which branch?" }
                        )
                        if (!pick) return
                        branch = pick.b
                    }

                    const files = await changedFiles(root, branch)
                    if (!files.length)
                        return vscode.window.showInformationMessage(
                            `No changes in ${branch.name}.`
                        )

                    await vscode.commands.executeCommand(
                        "vscode.changes",
                        `${branch.name} (${files.length} files)`,
                        files.map((f) => {
                            const live = vscode.Uri.file(path.join(root, f.file))
                            return [
                                live,
                                uri(BASE, f.file, branch.base),
                                f.status === "D"
                                    ? uri(BASE, f.file, EMPTY_TREE)
                                    : live,
                            ]
                        })
                    )
                } catch (e) {
                    // otherwise every failure mode looks identical: nothing happens
                    vscode.window.showErrorMessage(`but-review: ${e.message}`)
                }
            }
        )
    )
}

module.exports = { activate }
