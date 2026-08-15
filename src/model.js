// Pure derivations: no subprocesses, no vscode. The rules about CI, reviews,
// stack names and layout live here so they can be reasoned about in isolation.

const path = require("path")
const { cfg } = require("./exec")

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

const reviewKey = (branch, file) => `reviewed:${branch.name}:${file}`

const layoutKey = (branch) => `layout:${branch.name}`

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

/** "@531,6 +531,8" -> the line the hunk starts at in the working copy */
const hunkLine = (hunk) => Number(/\+(\d+)/.exec(hunk)?.[1] ?? 1)

module.exports = { rollup, ciState, humanDecision, isDemoted, stackName, reviewKey, layoutKey, layoutFor, groupsOf, hunkLine }
