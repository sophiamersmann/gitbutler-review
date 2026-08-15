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

// --- manifest vs code -------------------------------------------------------
// The seam JS testing can't see: a command declared but never registered renders
// as a working button bound to nothing, which is how the absorb button sat dead
// for four commits. Cheap, needs no repo, so it runs first.
const sources = [
    path.join(__dirname, "extension.js"),
    ...fs
        .readdirSync(path.join(__dirname, "src"))
        .map((f) => path.join(__dirname, "src", f)),
]
const src = sources.map((f) => fs.readFileSync(f, "utf8")).join("\n")
const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, "package.json"), "utf8")
)
const contributes = manifest.contributes
const problems = []
const gripe = (what, set) => {
    if (set.size) problems.push(`${what}: ${[...set].join(", ")}`)
}
const missing = (used, declared) =>
    new Set([...used].filter((x) => !declared.has(x)))

const declaredCommands = new Set(contributes.commands.map((c) => c.command))
const registered = new Set([
    ...[...src.matchAll(/registerCommand\(\s*"([^"]+)"/g)].map((m) => m[1]),
    // commands built from a template, tagged at the call site
    ...[...src.matchAll(/smoke:registers ([^\n]+)/g)].flatMap((m) =>
        m[1].trim().split(/\s+/)
    ),
])
gripe("declared but never registered", missing(declaredCommands, registered))
gripe("registered but not declared", missing(registered, declaredCommands))

const menuCommands = new Set(
    Object.values(contributes.menus).flatMap((ms) => ms.map((m) => m.command))
)
gripe("used by a menu but not declared", missing(menuCommands, declaredCommands))

const views = new Set(
    Object.values(contributes.views).flatMap((vs) => vs.map((v) => v.id))
)
const menuViews = new Set(
    Object.values(contributes.menus)
        .flatMap((ms) => ms.map((m) => m.when ?? ""))
        .flatMap((w) => [...w.matchAll(/view == ([\w.]+)/g)].map((m) => m[1]))
)
gripe("named in a when-clause but not a view", missing(menuViews, views))

const declaredSettings = new Set(
    Object.keys(contributes.configuration.properties)
)
const usedSettings = new Set(
    [...src.matchAll(/cfg\(\)\s*\n?\s*\.?\s*get\(\s*"([^"]+)"/g)].map(
        (m) => `butReview.${m[1]}`
    )
)
gripe("read in code but not declared", missing(usedSettings, declaredSettings))

const declaredColors = new Set(contributes.colors.map((c) => c.id))
const usedColors = new Set(
    [...src.matchAll(/ThemeColor\("(butReview\.[^"]+)"\)/g)].map((m) => m[1])
)
gripe("used as a colour but not declared", missing(usedColors, declaredColors))

const icon = contributes.viewsContainers.activitybar[0].icon
if (!fs.existsSync(path.join(__dirname, icon)))
    problems.push(`container icon missing: ${icon}`)

if (problems.length) {
    for (const p of problems) console.log(`PROBLEM  ${p}`)
    process.exitCode = 1
} else {
    console.log(
        `ok: manifest — ${declaredCommands.size} commands, ${menuCommands.size} menu refs, ${declaredSettings.size} settings, ${declaredColors.size} colours all resolve`
    )
}

const Module = require("module")
const load = Module._load
Module._load = function (request, ...rest) {
    return request === "vscode" ? stub : load.call(this, request, ...rest)
}

const api = {
    ...require("./src/but"),
    ...require("./src/git"),
    ...require("./src/model"),
    ...require("./src/items"),
}

const root = process.cwd()
const st = JSON.parse(
    execFileSync("but", ["status", "--json"], { maxBuffer: 1e8 })
)
const stacks = api.stacksOf(st)
const overrides = new Map()
;(async () => {
// mirror what BranchTree.topLevel attaches before building rows
const fileMap = await api.branchFiles(root, stacks)
for (const s of stacks)
    for (const b of s.branches) b.fileCount = fileMap.get(b.name)?.length

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

const prs = await api.listPrs(root)
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

// the biggest branch, so the row builders get a real workout
const branch = stacks
    .flatMap((s) => s.branches)
    .reduce((a, b) => (b.fileCount > a.fileCount ? b : a))
const entries = (await api.changedFiles(root, branch)).map((f) => ({
    f,
    branch,
    blob: f.blob,
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
const groupRows = groups.filter((g) => g.files.length > 1).map(api.groupItem)
const covered =
    groupRows.reduce((n, r) => n + r.group.length, 0) + singles.length
console.log(
    `ok: ${groupRows.length} groups + ${singles.length} promoted singletons covering ${covered}/${entries.length} files; groups carry no checkbox (${groupRows[0].checkboxState === undefined ? "confirmed" : "STILL SET (bug)"})`
)

// a per-branch override beats the setting; nothing else has a say
const a = { name: "a" }
const b = { name: "b" }
const dflt = [api.layoutFor(a, overrides), api.layoutFor(b, overrides)]
overrides.set(api.layoutKey(a), "group")
const overridden = [api.layoutFor(a, overrides), api.layoutFor(b, overrides)]
console.log(
    `ok: layout — default gives ${dflt.join("/")}, override gives ${overridden.join("/")}`
)

console.log(`\n▾ ${branch.name} — grouped`)
for (const r of groupRows.slice(0, 8))
    console.log(`     ${String(r.label).padEnd(18)} ${r.description}`)
if (groupRows.length > 8) console.log(`     … ${groupRows.length - 8} more`)
})()
