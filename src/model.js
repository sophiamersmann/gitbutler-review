// Pure derivations: no subprocesses, no vscode. The rules about CI, reviews,
// stack names and layout live here so they can be reasoned about in isolation.

const { cfg } = require("./exec")

// One circle summarising the PR, not two independent signals: 🟢 is a surrogate
// pair, so it already fills the 2-character badge budget on its own. Ordered by
// what it asks of you, most demanding first.
const ROLLUP = [
    // conflicts belong here rather than on a colour of their own: the rung is
    // "work that is yours", and a conflict with the base is exactly that
    ["🔴", "needs work", (ci, d, open, conflicting) => ci === "failing" || d === "changes requested" || conflicting],
    // an approval with threads still open is a to-do of yours, so it outranks
    // CI: the tick on GitHub says done, the threads say otherwise
    ["🟠", "approved, comments unresolved", (ci, d, open) => d === "approved" && open > 0],
    ["🟡", "CI running", (ci) => ci === "running"],
    ["🔵", "review requested", (ci, d) => d === "review requested"],
    ["🟢", "approved", (ci, d) => d === "approved"],
    ["⚪", "nothing pending", () => true],
]

const rollup = (ci, decision, open = 0, conflicting = false) =>
    ROLLUP.find(([, , when]) => when(ci, decision, open, conflicting))

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
        return { state: "failing", label: `✗ ${failing.length} failing`, failing }
    if (pending.length)
        return { state: "running", label: `… ${pending.length} running`, failing }
    if (passing.length) return { state: "passing", label: "✓ CI", failing }
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

/** Open review threads worth acting on: not bots, and not your own — every PR
 *  here is authored by you, so the PR author is the one login to skip, and no
 *  extra "who am I" call is needed. Missing data (older cache, GraphQL
 *  failure) means none. */
const openThreads = (pr) =>
    (pr.reviewThreads ?? []).filter(
        (t) =>
            !t.isResolved && !isBot(t.login) && t.login !== pr.author?.login
    ).length

/** Matched on hyphen-separated tokens, so "docs" catches `my-docs` and
 *  `docs-cleanup` without catching `docstring-fix`. */
const isDemoted = (name) => {
    const tokens = name.toLowerCase().split("-")
    return cfg()
        .get("demoteBranches", [])
        .some((p) => tokens.includes(String(p).toLowerCase()))
}

/** A stack has no name of its own, so never borrow a member's — least of all
 *  the top branch, which changes every time another is pushed on. Prefer what
 *  the author already wrote, then what the branch names agree on, then admit
 *  there is no name. */
function stackName(stack) {
    // an explicit name beats any reading of the commits, which is the whole
    // point of setting one
    if (stack.label) return stack.label
    // One vote per branch, not per commit: a branch that took seven commits is
    // not seven times more what the stack is about than one that took two. By
    // commits, a six-branch stack read as the topic of its busiest branch long
    // after the work had moved on.
    const topics = new Map()
    for (const b of stack.branches) {
        const mine = new Map()
        for (const { subject } of b.commits) {
            const topic = /^\S+\s*\(([^)]+)\)/.exec(subject)?.[1]
            if (topic) mine.set(topic, (mine.get(topic) ?? 0) + 1)
        }
        // a branch whose own commits disagree still gets the one vote, cast for
        // whichever topic it says most — newest first, so a fresh topic wins the
        // branch's own tie
        const own = [...mine].sort((a, b) => b[1] - a[1])[0]
        if (own) topics.set(own[0], (topics.get(own[0]) ?? 0) + 1)
    }
    // branches come top-first and sort is stable, so a tie goes to the topic
    // nearest the top of the stack — the work being done now
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

/** A stack read as one diff: merge base to stack tip, which is what the target
 *  branch gets once the whole thing lands — a question per-branch review cannot
 *  ask, since a helper added in one branch and used three above it is correct in
 *  both diffs and wrong in neither.
 *
 *  Shaped as a branch so the whole file path takes it unchanged. `name` stays a
 *  real ref because git is handed it; `label` is what the diff title says, since
 *  the top branch's name would file the whole stack under it; `key` keeps the
 *  ticks apart, because a shared file's stack diff is not any one branch's diff
 *  of it. Keyed on the bottom branch — the top changes every time another is
 *  pushed on, the bottom only when the stack lands. */
function wholeStack(stack) {
    const bottom = stack.branches.at(-1)
    return {
        name: stack.branches[0].name,
        base: bottom.base,
        label: `${stackName(stack)} (whole stack)`,
        key: `stack:${bottom.name}`,
        // an array, not a Set: a tree item's command arguments round-trip
        // through the UI, and a Set comes back as {}
        members: stack.branches.map((b) => b.name),
    }
}

/** One commit as a branch-shaped lens: `base..name` is its own diff, which is
 *  what every file row, tree and tick below it is built from. It carries no
 *  layout of its own — `layoutFor` is asked about the branch, so one toggle
 *  governs the files under a branch and the files under its commits alike. */
const commitLens = (commit) => ({
    name: commit.sha,
    base: commit.base,
    label: commit.subject,
    // `changeId`, because a reword or a rebase gives the same change a new SHA,
    // and a key on the SHA would drop the row's ticks and its open state
    key: `commit:${commit.changeId}`,
    committed: true,
})

// `key` is the whole-stack lens asking not to be confused with its own tip; the
// committed lens is a different pane over the same file, so its ticks are its
// own too — otherwise ticking in one mode would overwrite the other's
const reviewKey = (branch, file, committed) =>
    `reviewed:${committed ? "commit:" : ""}${branch.key ?? branch.name}:${file}`

/** What a tick on one entry writes: the key it is filed under and the blob it
 *  was reviewed at. A folder row carries one of these per file beneath it, so
 *  the two kinds of row cannot drift on how a tick is keyed — and the lens comes
 *  off the entry, which is what keeps the committed and whole-stack panes right. */
const reviewOf = (entry) => ({
    key: reviewKey(entry.branch, entry.f.file, entry.committed),
    blob: entry.blob,
})

/** A tick is pinned to the blob it was given at, so a file that has changed
 *  since reads unticked without anything having to notice the edit. Which is
 *  also how a folder unticks itself: one file below it is enough. */
const allReviewed = (reviews, reviewed) =>
    reviews.length > 0 && reviews.every((r) => reviewed?.get(r.key) === r.blob)

const layoutKey = (branch) => `layout:${branch.key ?? branch.name}`

const commitsKey = (branch) => `commits:${branch.key ?? branch.name}`

const filesKey = (branch) => `files:${branch.key ?? branch.name}`

// a folder row's identity, so VSCode remembers a collapse across a refresh.
// Namespaced like the others: the whole-stack lens shows the same directories
// as its own tip branch, and the two must not share a row
const folderKey = (branch, dir) =>
    `folder:${branch.key ?? branch.name}:${dir}`

/** Where a stack's given name is kept. A stack has no id of its own — `cliId`
 *  is handed out afresh by every `but status` — so the name hangs off a branch,
 *  and the bottom one is written to: the top changes every time you push
 *  another branch on. But the bottom lands long before the stack is done, so
 *  the name is looked for on every branch still in the stack, bottom-first. */
const stackKeys = (stack) => stack.branches.map((b) => `stackName:${b.name}`)

const stackKey = (stack) => stackKeys(stack).at(-1)

const stackLabel = (stack, overrides) =>
    overrides &&
    [...stackKeys(stack)].reverse().map((k) => overrides.get(k)).find(Boolean)

/** Does the right-hand pane show the branch tip rather than the workspace? Per
 *  repo, else the setting — the whole point of this view is reviewing while the
 *  tree is dirty, and the whole point of the other mode is that sometimes it
 *  isn't what you want to see. */
const committedMode = (store) =>
    (store?.get("diffAgainst") ?? cfg().get("diffAgainst", "workspace")) ===
    "commit"

/** A per-branch choice, else the setting. No size heuristic: guessing was one
 *  mechanism too many next to a toggle that takes one click. "group" is what
 *  the tree layout used to be called, and a stored override still says it —
 *  read as-is it would render a tree while the toggle offered to switch to one. */
function layoutFor(branch, overrides) {
    const mode =
        overrides?.get(layoutKey(branch)) ?? cfg().get("fileLayout", "tree")
    return mode === "group" ? "tree" : mode
}

/** entries -> nested directory nodes. `dirs` is keyed by segment so a path
 *  walks straight in; `dir` is the full path, which is what identifies the row.
 *  Chains are compacted on the way out — see `compact`. */
function fileTree(entries) {
    const node = (dir, label) => ({ dir, label, dirs: new Map(), files: [] })
    const root = node("", "")
    for (const e of entries) {
        const segs = e.f.file.split("/")
        let at = root
        for (const seg of segs.slice(0, -1)) {
            if (!at.dirs.has(seg))
                at.dirs.set(seg, node(at.dir ? `${at.dir}/${seg}` : seg, seg))
            at = at.dirs.get(seg)
        }
        at.files.push(e)
    }
    return compact(root)
}

/** A directory whose only child is a directory, and which holds no file of its
 *  own, is one row reading `a/b/c` — what VSCode's explorer does with
 *  `explorer.compactFolders`. Without it a monorepo costs five clicks to reach
 *  source, which is a tree being worse than the list it replaced. The root is
 *  never merged into: its children are the branch's own rows. */
function compact(root) {
    const merge = (n) => {
        const label = [n.label]
        while (n.dirs.size === 1 && !n.files.length) {
            n = [...n.dirs.values()][0]
            label.push(n.label)
        }
        return {
            ...n,
            label: label.join("/"),
            dirs: new Map([...n.dirs].map(([seg, d]) => [seg, merge(d)])),
        }
    }
    return {
        ...root,
        dirs: new Map([...root.dirs].map(([seg, d]) => [seg, merge(d)])),
    }
}

/** A directory's rows: its sub-directories, then its own files, each in name
 *  order — the arrangement every file manager uses, and the one a flat list
 *  could not give. Files at the repo root are the root node's own, so they sit
 *  below the top-level folders and need no rule of their own. */
const rowsOf = (node) => [
    ...[...node.dirs.values()]
        .sort((a, b) => a.label.localeCompare(b.label))
        .map((folder) => ({ folder })),
    ...[...node.files]
        .sort((a, b) => a.f.file.localeCompare(b.f.file))
        .map((file) => ({ file })),
]

/** Every entry the subtree holds. A folder row counts these and ticks them all,
 *  which is the whole of what a folder tick is. */
const entriesIn = (node) => [
    ...node.files,
    ...[...node.dirs.values()].flatMap(entriesIn),
]

/** The absorb plan as branches rather than a flat list of commits: two commits
 *  on one branch belong together, and the branch was being repeated as every
 *  commit row's description anyway.
 *
 *  Ordered by `where`, the same map the Branches view sorts on, so the two trees
 *  list branches alike. A commit on no applied branch can't be placed in that
 *  order and sits last — it shouldn't happen, but a row that vanishes would be
 *  worse than one out of order. */
function byBranch(groups, where) {
    const rank = (name) => {
        const at = where.get(name)
        return at ? at.stack * 1000 + at.depth : Number.MAX_SAFE_INTEGER
    }
    return [...Map.groupBy(groups, (g) => g.meta.branch ?? "no branch")]
        .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
        .map(([name, gs]) => ({
            name,
            groups: gs,
            files: gs.reduce((n, g) => n + g.files.length, 0),
        }))
}

/** branch name -> which stack it is in and how far below that stack's top.
 *  `stacksOf` keeps branches top-first, so a smaller depth is further up. */
const positions = (stacks) =>
    new Map(
        stacks.flatMap((s, stack) =>
            s.branches.map((b, depth) => [b.name, { stack, depth }])
        )
    )

/** The other branches changing a file, split by what that costs you. One above
 *  in the same stack is your own later work, already rebased onto yours and
 *  landing after it; one in another stack is parallel work on the same lines,
 *  and the two only meet when either of them lands. A branch *below* is dropped
 *  outright: its changes are in this branch's base, so they cancel out of the
 *  diff and naming it sends you hunting for lines that aren't there.
 *
 *  The whole-stack lens needs no case of its own: it sits at its stack's tip, so
 *  every member is below it and drops out, leaving only the other stacks — which
 *  is exactly what is foreign to a diff that spans the whole stack. */
function splitOverlap(branch, names, where) {
    const me = where.get(branch.name)
    const above = []
    const other = []
    for (const name of names) {
        const it = where.get(name)
        if (!it || !me) continue
        if (it.stack !== me.stack) other.push(name)
        else if (it.depth < me.depth) above.push(name)
    }
    return { above, other }
}

/** "@531,6 +531,8" -> the line the hunk starts at in the working copy */
const hunkLine = (hunk) => Number(/\+(\d+)/.exec(hunk)?.[1] ?? 1)

/** "L531" or "L531–538" — GitHub's permalink notation, short enough to leave the
 *  row to its churn. Working-copy lines, so it reads the same as the ruler in
 *  the pane it opens. */
const lineRange = (from, to) => (to > from ? `L${from}–${to}` : `L${from}`)

/** The lines a hunk actually changes, which is not its range: a hunk carries
 *  three lines of context either side, so "@1,3 +1,5" is two edited lines
 *  wearing a five-line header. Walks the patch body in working-copy
 *  coordinates — context and added lines advance it, removed lines don't
 *  occupy one, so a deletion is named by the line that closed over it.
 *
 *  Numbers, not a label: the row's name and the line its click lands on have to
 *  be the same answer. */
function changedLines(diff, newStart) {
    let line = newStart
    let from
    let to
    for (const l of (diff ?? "").split("\n").slice(1)) {
        if (l.startsWith("\\")) continue // "\ No newline at end of file"
        else if (l.startsWith("+")) {
            from ??= line
            to = line
            line++
        } else if (l.startsWith("-")) {
            from ??= line
            to ??= line
        } else line++
    }
    return from === undefined ? undefined : { from, to }
}

/** Fallback for a hunk whose patch body we never got: the header's whole span,
 *  context and all. */
function hunkRange(hunk) {
    const [, start, count = "1"] = /\+(\d+)(?:,(\d+))?/.exec(hunk) ?? []
    // a whole-file deletion reads "-1,105" and has no working-copy lines to
    // name; the row leaves the slot empty rather than echoing the header at you
    if (!start) return undefined
    return lineRange(Number(start), Number(start) + Number(count) - 1)
}

/** Which hunk F7 lands on from `line`, wrapping at either end — past the last
 *  one the useful answer is the first, not a dead key. */
function nextHunk(ranges, line, step) {
    const i =
        step > 0
            ? ranges.findIndex((r) => r.start.line > line)
            : ranges.findLastIndex((r) => r.start.line < line)
    return i !== -1 ? i : step > 0 ? 0 : ranges.length - 1
}

module.exports = { commitLens, commitsKey, committedMode, filesKey, stackKey, stackKeys, stackLabel, rollup, ciState, humanDecision, openThreads, isDemoted, stackName, wholeStack, reviewKey, reviewOf, layoutKey, layoutFor, byBranch, changedLines, allReviewed, entriesIn, fileTree, folderKey, hunkLine, hunkRange, lineRange, nextHunk, positions, rowsOf, splitOverlap }
