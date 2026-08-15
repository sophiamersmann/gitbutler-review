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
        ";return {branchItem,stackItem,stacksOf,ciState,prItem,prStackItem,humanDecision,stackName}"
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
