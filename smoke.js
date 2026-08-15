// Builds every tree row against the live GitButler workspace with a stubbed
// `vscode` module, so runtime-only faults surface without launching VSCode.
// It has caught a TDZ crash, a whole view silently deleted by a bad edit, and
// hunk parsing broken by `diff.external` — all of which `node --check` passed.
const fs = require("fs")
const path = require("path")
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
        static Folder = { id: "folder" }
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
                    ignoredChecks: [],
                    botReviewers: ["chatgpt-codex-connector", "github-actions"],
                    demoteBranches: ["docs"],
                })[k] ?? d,
        }),
    },
    commands: {},
    env: {},
}

const api = new Function(
    "require",
    "module",
    "exports",
    fs.readFileSync(path.join(__dirname, "extension.js"), "utf8") +
        ";return {branchItem,stackItem,stacksOf,prItem,prStackItem,fileItem," +
        "groupItem,groupsOf,blobShas,changedFiles,layoutFor,layoutKey}"
)((r) => (r === "vscode" ? stub : require(r)), { exports: {} }, {})

const git = (...args) => execFileSync("git", args, { maxBuffer: 1e8 }).toString()

const root = process.cwd()
const st = JSON.parse(
    execFileSync("but", ["status", "--json"], { maxBuffer: 1e8 })
)
const stacks = api.stacksOf(st)

// mirror what BranchTree.topLevel attaches before building rows
for (const s of stacks)
    for (const b of s.branches)
        b.fileCount = git(
            "diff",
            "--no-ext-diff",
            "--name-only",
            "--no-renames",
            b.base,
            b.name,
            "--"
        )
            .split("\n")
            .filter(Boolean).length

const overrides = new Map()
let branches = 0
let stackRows = 0
for (const s of stacks) {
    if (s.branches.length === 1) {
        api.branchItem(s.branches[0], overrides)
        branches++
    } else {
        api.stackItem(s)
        stackRows++
        for (const b of s.branches) {
            api.branchItem(b, overrides)
            branches++
        }
    }
}
console.log(`ok: ${branches} branch rows, ${stackRows} stack rows`)

const prs = JSON.parse(
    execFileSync(
        "gh",
        [
            "pr",
            "list",
            "--author",
            "@me",
            "--limit",
            "100",
            "--json",
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
    if (rows.length > 1) api.prStackItem(s, rows)
    for (const r of rows) {
        api.prItem(r)
        prRows++
    }
}
console.log(`ok: ${prRows} pr rows`)
;(async () => {
    // the biggest branch, so the row builders get a real workout
    const branch = stacks
        .flatMap((s) => s.branches)
        .reduce((a, b) => (b.fileCount > a.fileCount ? b : a))
    const files = await api.changedFiles(root, branch)
    const blobs = await api.blobShas(
        root,
        branch,
        files.map((f) => f.file)
    )
    const entries = files.map((f) => ({
        f,
        branch,
        blob: blobs.get(f.file) ?? "gone",
        alsoIn: [],
    }))

    // review ticks key on the blob, so a changed file must clear its own tick
    const store = new Map()
    let rows = entries.map((e) => api.fileItem(e, store, true))
    const unchecked = rows.filter((r) => r.checkboxState === 0).length
    for (const r of rows) for (const x of r.review) store.set(x.key, x.blob)
    rows = entries.map((e) => api.fileItem(e, store, true))
    const checked = rows.filter((r) => r.checkboxState === 1).length
    const stale = api.fileItem({ ...entries[0], blob: "0000" }, store, true)
    console.log(
        `ok: ${rows.length} file rows — ${unchecked} unchecked, ${checked} checked after ticking, stale blob reads ${stale.checkboxState === 0 ? "unchecked" : "CHECKED (bug)"}`
    )

    const groups = api.groupsOf(entries)
    const singles = groups.filter((g) => g.files.length === 1)
    const groupRows = groups
        .filter((g) => g.files.length > 1)
        .map(api.groupItem)
    const covered =
        groupRows.reduce((n, r) => n + r.group.length, 0) + singles.length
    const longestLabel = Math.max(...groupRows.map((r) => r.label.length))
    const longestPath = Math.max(...groups.map((g) => g.dir.length))
    console.log(
        `ok: ${groupRows.length} groups + ${singles.length} promoted singletons covering ${covered}/${entries.length} files; longest label ${longestLabel} chars vs longest path ${longestPath}; groups carry no checkbox (${groupRows[0].checkboxState === undefined ? "confirmed" : "STILL SET (bug)"})`
    )

    // per-branch override beats the setting, which beats size
    const big = { name: "big", fileCount: 64 }
    const small = { name: "small", fileCount: 3 }
    const auto = [api.layoutFor(big, overrides), api.layoutFor(small, overrides)]
    overrides.set(api.layoutKey(big), "list")
    overrides.set(api.layoutKey(small), "group")
    const forced = [
        api.layoutFor(big, overrides),
        api.layoutFor(small, overrides),
    ]
    console.log(
        `ok: layout — auto gives ${auto.join("/")} for 64/3 files, overrides give ${forced.join("/")}`
    )

    console.log(`\n▾ ${branch.name} — grouped`)
    for (const r of groupRows.slice(0, 8))
        console.log(`     ${String(r.label).padEnd(18)} ${r.description}`)
    if (groupRows.length > 8) console.log(`     … ${groupRows.length - 8} more`)
})()
