// Pure derivations: no subprocesses, no vscode. The rules about CI, reviews,
// stack names and layout live here so they can be reasoned about in isolation.

const path = require("path")
const { cfg } = require("./exec")

// One circle summarising the PR, not two independent signals: 🟢 is a surrogate
// pair, so it already fills the 2-character badge budget on its own. Ordered by
// what it asks of you, most demanding first.
const ROLLUP = [
    ["🔴", "needs work", (ci, d) => ci === "failing" || d === "changes requested"],
    // an approval with threads still open is a to-do of yours, so it outranks
    // CI: the tick on GitHub says done, the threads say otherwise
    ["🟠", "approved, comments unresolved", (ci, d, open) => d === "approved" && open > 0],
    ["🟡", "CI running", (ci) => ci === "running"],
    ["🔵", "review requested", (ci, d) => d === "review requested"],
    ["🟢", "approved", (ci, d) => d === "approved"],
    ["⚪", "nothing pending", () => true],
]

const rollup = (ci, decision, open = 0) =>
    ROLLUP.find(([, , when]) => when(ci, decision, open))

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

// `key` is the whole-stack lens asking not to be confused with its own tip
const reviewKey = (branch, file) => `reviewed:${branch.key ?? branch.name}:${file}`

const layoutKey = (branch) => `layout:${branch.key ?? branch.name}`

/** A per-branch choice, else the setting. No size heuristic: guessing was one
 *  mechanism too many next to a toggle that takes one click. */
function layoutFor(branch, overrides) {
    return overrides?.get(layoutKey(branch)) ?? cfg().get("fileLayout", "list")
}

/** One row per directory, sorted by full path so siblings stay adjacent. The
 *  label is the last segment and the description carries the parent, because in
 *  a monorepo the discriminating segment sits at the end of a long shared prefix
 *  — and the panel clips from the end. */
function groupsOf(entries) {
    return [...Map.groupBy(entries, (e) => path.dirname(e.f.file))]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([dir, files]) => ({ dir, files }))
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

/** Which hunk F7 lands on from `line`, wrapping at either end — past the last
 *  one the useful answer is the first, not a dead key. */
function nextHunk(ranges, line, step) {
    const i =
        step > 0
            ? ranges.findIndex((r) => r.start.line > line)
            : ranges.findLastIndex((r) => r.start.line < line)
    return i !== -1 ? i : step > 0 ? 0 : ranges.length - 1
}

module.exports = { rollup, ciState, humanDecision, openThreads, isDemoted, stackName, wholeStack, reviewKey, layoutKey, layoutFor, groupsOf, hunkLine, nextHunk, positions, splitOverlap }
