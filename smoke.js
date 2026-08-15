// Builds every tree row against the live workspace with a stubbed `vscode`,
// so runtime-only faults (TDZ, undefined reads) surface without launching VSCode.
const fs = require("fs")
const { execFileSync } = require("child_process")

const stub = {
    TreeItem: class {
        constructor(l, c) {
            this.label = l
            this.collapsibleState = c
        }
    },
    TreeItemCollapsibleState: { Collapsed: 1, Expanded: 2 },
    TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
    ThemeIcon: class {
        constructor(i, c) {
            this.id = i
            this.color = c
        }
    },
    ThemeColor: class {
        constructor(i) {
            this.id = i
        }
    },
    MarkdownString: class {
        constructor(v) {
            this.value = v
        }
    },
    Uri: {
        file: (p) => ({ fsPath: p, toString: () => "file://" + p }),
        parse: (u) => ({ toString: () => u }),
    },
    EventEmitter: class {
        constructor() {
            this.event = () => {}
        }
        fire() {}
    },
    Range: class {},
    Selection: class {},
    OverviewRulerLane: { Right: 2 },
    window: { createTextEditorDecorationType: () => ({}), visibleTextEditors: [] },
    workspace: {
        workspaceFolders: [{ uri: { fsPath: process.cwd() } }],
        getConfiguration: () => ({
            get: (k, d) =>
                ({
                    ignoredChecks: ["site-screenshot"],
                    botReviewers: ["chatgpt-codex-connector", "github-actions"],
                    demoteBranches: ["docs"],
                })[k] ?? d,
        }),
    },
    commands: {},
    env: {},
}

const src = fs.readFileSync(require("path").join(__dirname, "extension.js"), "utf8")
const api = new Function(
    "require",
    "module",
    "exports",
    src +
        ";return {branchItem,stackItem,stacksOf,ciState,prItem,prStackItem,humanDecision,stackName,fileItem,folderItem,blobShas,changedFiles,buildTree,folders,descendants,layoutFor}"
)(
    (r) => (r === "vscode" ? stub : require(r)),
    { exports: {} },
    {}
)

const st = JSON.parse(
    execFileSync("but", ["status", "--json"], { maxBuffer: 1e8 })
)
const stacks = api.stacksOf(st)
// mirror what BranchTree.topLevel attaches before building rows
for (const s of stacks)
    for (const b of s.branches)
        b.fileCount = execFileSync(
            "git",
            ["diff", "--no-ext-diff", "--name-only", "--no-renames", b.base, b.name],
            { maxBuffer: 1e8 }
        ).toString().split("\n").filter(Boolean).length

let branches = 0
let stackRows = 0
for (const s of stacks) {
    if (s.branches.length === 1) {
        api.branchItem(s.branches[0], s.primary)
        branches++
    } else {
        api.stackItem(s)
        stackRows++
        for (const b of s.branches) {
            api.branchItem(b)
            branches++
        }
    }
}
console.log(`ok: ${branches} branch rows, ${stackRows} stack rows`)

// file rows exercise the review checkbox, whose state comes from a blob SHA
;(async () => {
    // the biggest branch, so the row builders get a real workout
    const branch = stacks
        .flatMap((s) => s.branches)
        .reduce((a, b) => ((b.fileCount ?? 0) > (a.fileCount ?? 0) ? b : a))
    const root = process.cwd()
    const files = await api.changedFiles(root, branch)
    const blobs = await api.blobShas(root, branch, files.map((f) => f.file))
    const entries = files.map((f) => ({
        f,
        branch,
        blob: blobs.get(f.file) ?? "gone",
        alsoIn: [],
    }))
    const store = new Map()

    let rows = entries.map((e) => api.fileItem(e, store, true))
    const unchecked = rows.filter((r) => r.checkboxState === 0).length
    for (const r of rows) for (const x of r.review) store.set(x.key, x.blob)
    rows = entries.map((e) => api.fileItem(e, store, true))
    const checked = rows.filter((r) => r.checkboxState === 1).length
    const stale = api.fileItem({ ...entries[0], blob: "0000000" }, store, true)
    console.log(
        `ok: ${rows.length} file rows — ${unchecked} unchecked initially, ${checked} checked after ticking, stale blob reads ${stale.checkboxState === 0 ? "unchecked" : "CHECKED (bug)"}`
    )

    const tree = api.buildTree(entries)
    const top = api.folders(tree)
    const deepest = Math.max(
        ...entries.map((e) => e.f.file.split("/").length - 1)
    )
    const compacted = top.filter((d) => d.label.includes("/")).length
    console.log(
        `ok: tree — ${top.length} top-level rows for ${entries.length} files (paths up to ${deepest} deep), ${compacted} chains compacted`
    )
    console.log(
        `   layout: ${entries.length} files -> ${api.layoutFor(entries.length)}, 3 files -> ${api.layoutFor(3)}`
    )

    // every file must be reachable, and a folder tick must cover its subtree
    const reachable = api.descendants(tree).length
    const folder = api.folderItem(top[0], store)
    const allTicked = folder.checkboxState === 1
    store.clear()
    const noneTicked = api.folderItem(top[0], store).checkboxState === 0
    console.log(
        `ok: ${reachable} files reachable through the tree; folder "${top[0].label}" covers ${folder.review.length}, reads ${allTicked ? "checked" : "UNCHECKED (bug)"} when all ticked and ${noneTicked ? "unchecked" : "CHECKED (bug)"} when none are`
    )
})()

const prs = JSON.parse(
    execFileSync(
        "gh",
        [
            "pr", "list", "--author", "@me", "--limit", "100", "--json",
            "number,title,url,isDraft,reviews,reviewRequests,headRefName",
        ],
        { maxBuffer: 1e8 }
    )
)
const byBranch = new Map(prs.map((p) => [p.headRefName, p]))
let prRows = 0
for (const s of stacks) {
    const rows = s.branches
        .map((b) => ({ branch: b, pr: byBranch.get(b.name) }))
        .filter((r) => r.pr)
    if (!rows.length) continue
    if (rows.length > 1) {
        rows[0].next = true
        api.prStackItem(s, rows)
    }
    for (const r of rows) {
        api.prItem(r)
        prRows++
    }
}
console.log(`ok: ${prRows} pr rows`)

for (const s of stacks) {
    const b = s.branches[s.branches.length - 1]
    const item = api.branchItem(b, s.primary)
    console.log(
        `  ${item.iconPath.id.padEnd(10)} ${String(item.iconPath.color.id).padEnd(22)} ${item.label.padEnd(28)} ${item.description}`
    )
}

console.log("\n▾ PULL REQUESTS")
const BADGE = { fail: "✗", run: "…", next: "»" }
for (const s of stacks) {
    const rows = s.branches
        .map((b) => ({ branch: b, pr: byBranch.get(b.name) }))
        .filter((r) => r.pr)
    if (!rows.length) continue
    if (rows.length > 1) {
        rows[0].next = true
        const si = api.prStackItem(s, rows)
        console.log(`   ${si.label}  [${si.description}]`)
    }
    for (const r of rows) {
        const it = api.prItem(r)
        const CIRCLE = { "needs work": "🔴", "CI running": "🟡", "review requested": "🔵", approved: "🟢", "nothing pending": "⚪" }
        const q = decodeURIComponent(it.resourceUri.toString().split("?")[1] ?? "")
        console.log(
            `     ${CIRCLE[q] ?? "??"}  ${it.label.padEnd(30)} ${String(it.description).slice(0, 40).padEnd(42)} ${it.iconPath.id.replace("git-pull-request", "pr")}`
        )
    }
}

// A quick look at the shape, since "compacted" is easier to check by eye
;(async () => {
    await new Promise((r) => setTimeout(r, 200))
    const branch = stacks
        .flatMap((s) => s.branches)
        .reduce((a, b) => ((b.fileCount ?? 0) > (a.fileCount ?? 0) ? b : a))
    const files = await api.changedFiles(process.cwd(), branch)
    const tree = api.buildTree(
        files.map((f) => ({ f, branch, blob: "x", alsoIn: [] }))
    )
    console.log(`\n▾ ${branch.name} (tree)`)
    const walk = (node, depth) => {
        for (const d of api.folders(node)) {
            console.log(
                `${"  ".repeat(depth + 2)}▸ ${d.label.padEnd(30 - depth * 2)} ${api.descendants(d.node).length} files`
            )
            if (depth < 1) walk(d.node, depth + 1)
        }
        for (const e of node.files)
            console.log(`${"  ".repeat(depth + 2)}  ${e.f.file.split("/").pop()}`)
    }
    walk(tree, 0)
})()
