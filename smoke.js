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
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
    ThemeIcon: class {
        constructor(i, c) {
            this.id = i
            this.color = c
        }
        static Folder = { id: "folder" }
        static File = { id: "file" }
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
        from: ({ scheme, path, query }) => ({
            scheme,
            path,
            query,
            toString: () => `${scheme}:${path}?${query}`,
        }),
    },
    EventEmitter: class {
        constructor() {
            this.event = () => {}
        }
        fire() {}
    },
    // real enough for paneRanges: it subtracts ranges, so a hollow stub would
    // make every hunk look like the branch's own
    Range: class Range {
        constructor(a, b, c, d) {
            this.start = { line: a, character: b }
            this.end = { line: c, character: d }
        }
        get isEmpty() {
            return (
                this.start.line === this.end.line &&
                this.start.character === this.end.character
            )
        }
        intersection(o) {
            const line = Math.max(this.start.line, o.start.line)
            const end = Math.min(this.end.line, o.end.line)
            return line <= end ? new Range(line, 0, end, 0) : undefined
        }
    },
    Selection: class {},
    OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
    window: {
        createTextEditorDecorationType: () => ({}),
        visibleTextEditors: [],
        // the providers swallow their own errors into this, which without a
        // stub crashes the run with the wrong message entirely
        showErrorMessage: (m) => {
            console.log(`PROBLEM  ${m}`)
            process.exitCode = 1
        },
    },
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
    commands: { executeCommand: () => {} }, // setContext, nothing to observe here
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

// green only when every thread is settled — the one rule the circle encodes
// that GitHub's own approval tick does not
{
    const thread = (isResolved, login) => ({ isResolved, login })
    const open = (...threads) =>
        api.openThreads({
            author: { login: "me" },
            reviewThreads: threads,
        })
    const circle = (...threads) =>
        api.rollup(undefined, "approved", open(...threads))[0]
    const cases = [
        [circle(), "🟢", "approved, no threads"],
        [circle(thread(true, "reviewer")), "🟢", "all resolved"],
        [circle(thread(false, "reviewer")), "🟠", "one open"],
        [circle(thread(false, "codex[bot]")), "🟢", "bot threads don't count"],
        [circle(thread(false, "me")), "🟢", "your own threads don't count"],
        [api.rollup(undefined, undefined, 2)[0], "⚪", "unreviewed stays as-is"],
        [String(open(thread(false, "a"), thread(false, "b"))), "2", "counted"],
        // a conflict is work of yours however healthy the rest of the PR looks,
        // and UNKNOWN — which is what GitHub says until it has computed the
        // answer — must not redden a PR that has only just been opened
        [api.rollup("passing", "approved", 0, true)[0], "🔴", "conflicting beats approved"],
        [api.rollup("passing", "approved", 0, false)[0], "🟢", "not conflicting is left alone"],
        [api.rollup("passing", "approved", 0)[0], "🟢", "no conflict data yet reads as none"],
    ]
    const bad = cases.filter(([got, want]) => got !== want)
    for (const [got, want, what] of bad)
        console.log(`PROBLEM  rollup: ${what} gave ${got}, want ${want}`)
    // the rows above were built before this resolved, exactly as the panel
    // does it — so this also proves prItem survives a PR with no detail data
    await api.prDetails(root, prs)
    if (prs.some((p) => p.reviewThreads === undefined || p.conflicting === undefined))
        console.log("PROBLEM  prDetails: some PRs came back unfilled")
    if (bad.length) process.exitCode = 1
    const withThreads = prs.filter((p) => p.reviewThreads?.length).length
    const conflicting = prs.filter((p) => p.conflicting).length
    console.log(`ok: ${cases.length} rollup cases, ${withThreads} live PRs with threads, ${conflicting} conflicting`)
}

// the biggest branch, so the row builders get a real workout
const branch = stacks
    .flatMap((s) => s.branches)
    .reduce((a, b) => (b.fileCount > a.fileCount ? b : a))
const entries = (await api.changedFiles(root, branch)).map((f) => ({
    f,
    branch,
    blob: f.blob,
    alsoIn: { above: [], other: [] },
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

// who else changes a file, and which of them is worth a warning. A branch below
// is in this one's base already, so its hunks cancel out of the diff — naming it
// would send you looking for lines that are not in the pane.
{
    const stack = (...names) => ({ branches: names.map((name) => ({ name })) })
    const where = api.positions([stack("top", "middle", "bottom"), stack("solo")])
    const split = (me, ...names) =>
        api.splitOverlap({ name: me }, names, where)
    const row = (alsoIn) =>
        api.fileItem(
            { f: { file: "a.ts", status: "M", adds: "1", dels: "0" }, branch: { name: "middle" }, blob: "x", alsoIn },
            new Map(),
            false
        )
    const warns = (alsoIn) => String(row(alsoIn).label).endsWith("!")
    const named = (alsoIn) => row(alsoIn).description.includes("also in")
    const cases = [
        [split("middle", "top").above.join(), "top", "a branch above is found"],
        [split("middle", "bottom").above.join(), "", "a branch below is dropped"],
        [split("middle", "bottom").other.join(), "", "and is not another stack either"],
        [split("middle", "solo").other.join(), "solo", "another stack is found"],
        [warns({ other: ["solo"] }), true, "another stack colours the row"],
        [warns({ above: ["top"] }), true, "so does a branch above"],
        [warns({ above: [], other: [] }), false, "a clean file does not"],
        [named({ other: ["solo"] }), true, "another stack is named in the row"],
        [named({ above: ["top"] }), false, "a branch above is left to the colour"],
    ].filter(([got, want]) => got !== want)
    for (const [got, want, what] of cases)
        console.log(`PROBLEM  overlap: ${what} gave ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
    if (cases.length) process.exitCode = 1
    console.log("ok: 9 overlap cases — below dropped, any foreign hunk colours the row, only another stack is named")
}

// what F7 walks. Parsed from a diff, so it is the part that `diff.external`
// once broke; a file whose hunks all belong to branches above it is legitimate,
// a branch with no own hunks anywhere is the parser having failed.
{
    const sample = entries.filter((e) => e.f.status !== "D").slice(0, 12)
    const ranges = await Promise.all(
        sample.map((e) => api.paneRanges(root, branch, e.f.file))
    )
    const own = ranges.reduce((n, r) => n + r.own.length, 0)
    const foreign = ranges.reduce((n, r) => n + r.foreign.length, 0)
    const unsorted = ranges.filter((r) =>
        r.own.some((x, i) => i && x.start.line < r.own[i - 1].start.line)
    ).length
    if (!own) console.log("PROBLEM  paneRanges: no own hunks in any sampled file")
    if (unsorted) console.log(`PROBLEM  paneRanges: ${unsorted} files out of order`)
    if (!own || unsorted) process.exitCode = 1
    // F7 walking those hunks: both ends wrap, and the cursor sitting on a hunk
    // must not count as having reached it
    const hunks = [10, 20, 30].map((l) => ({ start: { line: l } }))
    const walk = [
        [api.nextHunk(hunks, 0, 1), 0, "forward from the top"],
        [api.nextHunk(hunks, 20, 1), 2, "forward off the current hunk"],
        [api.nextHunk(hunks, 30, 1), 0, "forward past the last wraps"],
        [api.nextHunk(hunks, 20, -1), 0, "backward off the current hunk"],
        [api.nextHunk(hunks, 10, -1), 2, "backward past the first wraps"],
    ].filter(([got, want]) => got !== want)
    for (const [got, want, what] of walk)
        console.log(`PROBLEM  nextHunk: ${what} gave ${got}, want ${want}`)
    if (walk.length) process.exitCode = 1
    console.log(
        `ok: ${own} own hunks, ${foreign} foreign across ${sample.length} files, all ascending; 5 F7 walk cases`
    )

    // The pane is the file on disk, so the ranges have to be in its line
    // numbers. Measured against HEAD they were as many lines high as the
    // uncommitted work above them — invisible while the tree is clean, which is
    // why this only means anything when a sampled file is dirty.
    const dirty = new Set(
        execFileSync("git", ["diff", "--name-only", "HEAD"], { encoding: "utf8" })
            .split("\n")
            .filter(Boolean)
    )
    const probe = sample.find((e) => dirty.has(e.f.file))
    if (!probe)
        console.log("ok: pane coordinates — skipped, no dirty file in the sample")
    else {
        const { own: mine } = await api.paneRanges(root, branch, probe.f.file)
        const truth = new Set(
            [
                ...execFileSync(
                    "git",
                    ["diff", "--no-ext-diff", "-U0", "--no-renames", branch.base, "--", probe.f.file],
                    { encoding: "utf8", maxBuffer: 1e8 }
                ).matchAll(/^@@ -\S+ \+(\d+)/gm),
            ].map((m) => Number(m[1]))
        )
        const stray = mine.filter((r) => !truth.has(r.start.line + 1))
        if (stray.length) {
            console.log(`PROBLEM  pane coordinates: ${stray.length} of ${mine.length} ranges in ${probe.f.file} are not where the worktree has them`)
            process.exitCode = 1
        } else
            console.log(`ok: pane coordinates — ${mine.length} ranges land on the worktree's own lines (${probe.f.file} is dirty)`)
    }
}

// the whole-stack lens: one diff over the stack, which must hold at least what
// its biggest branch holds, and must not share a tick key with its own tip —
// the two are different diffs of the same file
{
    const stack = stacks.find((s) => s.branches.length > 1)
    if (!stack) console.log("ok: whole stack — skipped, no multi-branch stack")
    else {
        const ws = api.wholeStack(stack)
        const wsFiles = await api.changedFiles(root, ws)
        const biggest = Math.max(
            ...stack.branches.map((b) => fileMap.get(b.name)?.length ?? 0)
        )
        const overlap = api.overlapMap(fileMap)
        const rows = wsFiles.map((f) =>
            api.fileItem(
                {
                    f,
                    branch: ws,
                    blob: f.blob,
                    alsoIn: { above: [], other: [] },
                    within: ws.members.filter((n) =>
                        overlap.get(f.file)?.includes(n)
                    ),
                },
                new Map(),
                true
            )
        )
        const multi = rows.filter((r) =>
            r.description.includes(" branches")
        ).length
        // through the provider, so the wiring is covered and not just the row:
        // the lens sits above the branches it reads, and counts them the same
        const { BranchTree } = require("./src/trees")
        const tree = new BranchTree(new Map())
        tree.overlap = overlap
        const kids = await tree.stackChildren(root, stack)
        const row = kids[0]
        // a branch below the tip is not "above" it, so the lens has no false
        // foreign warnings of its own — only other stacks
        const where = api.positions(stacks)
        const foreign = api.splitOverlap(ws, ws.members, where)
        const cases = [
            [wsFiles.length >= biggest, true, "holds at least its biggest branch"],
            [
                api.reviewKey(ws, "a.ts") === api.reviewKey(stack.branches[0], "a.ts"),
                false,
                "tick keys differ from the tip's",
            ],
            [api.layoutKey(ws) === api.layoutKey(stack.branches[0]), false, "so do layout keys"],
            [foreign.above.length + foreign.other.length, 0, "no member is foreign to it"],
            [row.contextValue, "branch:list", "carries the layout toggle"],
            [kids.length, stack.branches.length + 1, "one row above the branches"],
            [row.description, `${wsFiles.length} files`, "the provider counts what the rows do"],
        ].filter(([got, want]) => got !== want)
        for (const [got, want, what] of cases)
            console.log(`PROBLEM  whole stack: ${what} gave ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
        if (cases.length) process.exitCode = 1
        console.log(
            `ok: whole stack "${row.label}" — ${wsFiles.length} files vs ${biggest} in its biggest branch, ${multi} built by several branches, ${7 - cases.length}/7 cases`
        )
    }
}

// Which branch a note names. The whole-stack lens is where the rule bites: its
// own hunks are its members' hunks, so every one of them has to find a claimant
// — a hunk with no name in a review that promises one is the failure worth
// catching, and it is what a boundary mismatch between the two diffs looks like.
{
    const stack = stacks.find((s) => s.branches.length > 1)
    const overlap = api.overlapMap(fileMap)
    // an uncommitted hunk is ahead of every branch and so is claimed by none of
    // them, which a dirty file cannot tell apart from a hunk gone unattributed
    const dirtyPaths = new Set(
        execFileSync("git", ["diff", "--name-only", "HEAD"], { encoding: "utf8" })
            .split("\n")
            .filter(Boolean)
    )
    const ws = stack && api.wholeStack(stack)
    const built = (p) =>
        (overlap.get(p) ?? []).filter((n) => ws.members.includes(n)).length
    const clean =
        ws &&
        (await api.diffNames(root, ws.base, ws.name)).filter(
            (p) => !dirtyPaths.has(p) && built(p)
        )
    // a file several members build first: one owner proves nothing about a join
    const file = clean && (clean.find((p) => built(p) > 1) ?? clean[0])
    if (!file)
        console.log("ok: hunk owners — skipped, no clean file in a multi-branch stack")
    else {
        const claims = await api.hunkOwners(root, stack.branches, file)
        const { own } = await api.paneRanges(root, ws, file)
        const uncovered = own.filter(
            (r) => !claims.some((c) => c.range.intersection(r))
        )
        // the commit behind a hunk is parsed out of blame's porcelain, which is
        // the same kind of seam `diff.external` once broke: one header per line,
        // so a miss here is silent and the names simply stop appearing
        const { byLine } = await api.blameLines(root, file)
        const lines = fs.readFileSync(path.join(root, file), "utf8").split("\n")
        const cases = [
            [claims.length > 0, true, "the hunks are claimed at all"],
            [
                byLine.size,
                // a trailing newline leaves a last element that is not a line
                lines.at(-1) === "" ? lines.length - 1 : lines.length,
                "blame accounts for every line of the file",
            ],
            [
                claims.every((c) => ws.members.includes(c.name)),
                true,
                "every claim names a member of the stack",
            ],
            [uncovered.length, 0, "no hunk of the lens is left unnamed"],
        ].filter(([got, want]) => got !== want)
        for (const [got, want, what] of cases)
            console.log(`PROBLEM  hunk owners: ${what} gave ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
        if (cases.length) process.exitCode = 1
        console.log(
            `ok: hunk owners — ${claims.length} claims by ${new Set(claims.map((c) => c.name)).size} of ${built(file)} branches over ${own.length} hunks of ${file}, ${claims.filter((c) => c.commit).length} naming a commit, ${4 - cases.length}/4 cases`
        )
    }
}

// The Changes view, through its provider. The part worth checking is the join
// behind a hunk row: the absorb plan names a hunk by range, `but diff` names it
// by CLI ID, and a miss renders as a row whose buttons are all gone.
{
    const { UncommittedTree } = require("./src/trees")
    const dirty = new UncommittedTree()
    const kids = async (nodes) =>
        (await Promise.all(nodes.map((n) => dirty.getChildren(n)))).flat()
    // the two halves of the top level sit at different depths: a branch holds
    // commits, the strays hold their files directly
    const top = await dirty.getChildren()
    const branches = top.filter((n) => n.contextValue === "branchGroup")
    const strayGroup = top.filter((n) => n.contextValue === "unanchoredGroup")
    // a branch holds its commits and, unless it has only one, a summary row
    // listing everything the branch absorbs
    const under = await kids(branches)
    const groups = under.filter((n) => n.contextValue === "commitGroup")
    const summaries = under.filter((n) => n.contextValue === "branchFiles")
    // every file row, not just the expandable ones — a single-hunk file still
    // has to resolve its ID, and this is the only place that proves it
    const anchored = await kids(groups)
    const summarised = await kids(summaries)
    const files = [...anchored, ...summarised, ...(await kids(strayGroup))]
    const hunks = await kids(files)
    const rows = [...top, ...under, ...files, ...hunks]
    const strays = top.findIndex((n) => n.contextValue === "unanchoredGroup")
    const fmt = (r) => (r ? api.lineRange(r.from, r.to) : undefined)
    const cases = [
        [hunks.filter((h) => !h.contextValue).length, 0, "every hunk row resolved a CLI ID"],
        // one id twice in a tree is VSCode's problem, not ours to discover later
        [new Set(rows.map((r) => r.id)).size, rows.length, "every row id is unique"],
        [rows.filter((r) => !r.id).length, 0, "and every row has one"],
        // the label and the cursor come from one number, so a row that says L814
        // and opens on 811 is the bug this catches
        [hunks.every((h) => h.command.arguments[1] === Number(/\d+/.exec(h.label)[0])), true, "a hunk row opens on the line it names"],
        [files.filter((f) => f.row.hunkMeta[0]?.from).every((f) => f.command.arguments[1] === f.row.hunkMeta[0].from), true, "a file row opens on its first changed line"],
        [files.filter((f) => !f.target.args.length).length, 0, "so did every file row"],
        [strays === -1 || strays === top.length - 1, true, "unanchored sits last"],
        // a commit under the wrong branch row would be a lie about where the
        // change lands, which is the one thing this view exists to say
        [branches.every((b) => b.commits.every((g) => (g.meta.branch ?? "no branch") === b.label)), true, "every commit sits under its own branch"],
        [branches.reduce((n, b) => n + b.commits.reduce((m, g) => m + g.files.length, 0), 0), anchored.length, "the branch rows hold every anchored file"],
        // the summary row is the branch's files and nothing else: short, and it
        // would be a lie the moment a commit's files stopped reaching it
        [branches.filter((b) => b.commits.length > 1).reduce((n, b) => n + b.commits.reduce((m, g) => m + g.files.length, 0), 0), summarised.length, "and a summary row holds its branch's again"],
        [summaries.length, branches.filter((b) => b.commits.length > 1).length, "one summary per branch that has more than one commit"],
        [api.hunkRange("@531,6 +531,8"), "L531–538", "a bodyless hunk falls back to its span"],
        [api.hunkRange("@1,3 +7"), "L7", "a one-line hunk names one line"],
        // the span is not the edit: git pads a hunk with three lines of context
        // either side, which is how "@1,3 +1,5" came out as L1–5 for two lines
        // added at the end of a three-line file
        [fmt(api.changedLines("@@ -1,3 +1,5 @@\n a\n b\n c\n+d\n+e\n", 1)), "L4–5", "context before the change is dropped"],
        [fmt(api.changedLines("@@ -1,6 +1,7 @@\n a\n b\n c\n+d\n e\n f\n g\n", 1)), "L4", "context after it too"],
        [fmt(api.changedLines("@@ -810,7 +810,7 @@\n a\n b\n c\n-old\n+new\n e\n f\n g\n", 810)), "L813", "a replaced line is one line"],
        [fmt(api.changedLines("@@ -1,4 +1,3 @@\n a\n b\n-gone\n c\n", 1)), "L3", "a deletion is named by the line that closed over it"],
        [fmt(api.changedLines("@@ -1,3 +1,3 @@\n a\n b\n c\n", 1)), undefined, "a hunk with no edits has no range"],
        // a whole-file add or delete: the plan writes one side, `but diff` both,
        // and an unjoined row loses its hunk IDs and its churn
        [api.rangeKey("new.md", "+1,3"), "new.md\u00001,0,1,3", "a new file joins on its empty old side"],
        [api.rangeKey("gone.md", "-1,105"), "gone.md\u00001,105,1,0", "a deleted one on its empty new side"],
        [api.hunkRange("-1,105"), undefined, "and names no working-copy lines"],
        // the icon is the one thing on a hunk row that isn't in the label
        [api.hunkKind({ adds: 2, dels: 0 }), "added", "pure new code reads as added"],
        [api.hunkKind({ adds: 0, dels: 3 }), "deleted", "pure removal reads as deleted"],
        [api.hunkKind({ adds: 1, dels: 1 }), "modified", "a rewrite reads as modified"],
        [api.hunkKind({}), "modified", "so does a hunk we have no counts for"],
    ].filter(([got, want]) => got !== want)
    for (const [got, want, what] of cases)
        console.log(`PROBLEM  changes: ${what} gave ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
    if (cases.length) process.exitCode = 1
    console.log(
        `ok: changes — ${branches.length} branches, ${groups.length} commits, ${summaries.length} summary rows, ${files.length} file rows, ${hunks.length} hunk rows, all addressable`
    )
}

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
