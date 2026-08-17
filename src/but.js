// Everything asked of the `but` and `gh` CLIs, plus the shapes derived straight
// from what they return.

const { run } = require("./exec")
const { changedLines, isDemoted } = require("./model")

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

// A write of our own lands inside the TTL, so the refresh that follows it would
// otherwise repaint from the status the write just invalidated.
status.invalidate = () => (statusCache = { at: 0, value: undefined })

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
            // a stack of nothing but docs is never the thing you came here for
            demoted: stack.branches.every((b) => isDemoted(b.name)),
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
                // positional with `subjects`, and what blame has to match to
                // name the commit behind a hunk
                commits: b.commits.map((c) => c.commitId),
                latest: b.commits[0]?.createdAt,
            })),
        }))
        .sort(
            (a, b) =>
                a.demoted - b.demoted ||
                (b.activity ?? "").localeCompare(a.activity ?? "")
        )
}

const absorbPlan = async (root, ...source) =>
    JSON.parse(
        await run("but", ["absorb", "--dry-run", "--json", ...source], root)
    )

/** One file's answers, keyed by the three things that can change it: its own
 *  hunks, the workspace's commits, and the path. Kept between refreshes because
 *  the view refreshes on every save, and each miss is a `but` process — twenty
 *  dirty files meant twenty of them, every time you hit ⌘S. */
const reasonCache = new Map()

/** (file, commit) -> reason. The batch plan reports one reason per commit group,
 *  which a file with no dependency of its own silently inherits — so ask about
 *  each file separately. Proven: README.md reads `hunk_dependency` in the batch
 *  and `default_stack` on its own. */
async function fileReasons(root, changes, hunkSig, commitSig) {
    const keyOf = (c) => `${commitSig}\0${c.filePath}\0${hunkSig.get(c.filePath) ?? ""}`
    await Promise.all(
        changes
            .filter((c) => !reasonCache.has(keyOf(c)))
            .map(async (c) => {
                const plan = await absorbPlan(root, c.cliId).catch(() => ({
                    commits: [],
                }))
                reasonCache.set(
                    keyOf(c),
                    plan.commits.flatMap((k) =>
                        k.files.map((f) => [
                            `${f.path}\0${k.commit_id}`,
                            k.reason,
                        ])
                    )
                )
            })
    )
    const live = new Set(changes.map(keyOf))
    // every stale key is one the workspace can no longer produce, so the cache
    // stays the size of the dirty tree
    for (const k of reasonCache.keys()) if (!live.has(k)) reasonCache.delete(k)
    return new Map(changes.flatMap((c) => reasonCache.get(keyOf(c)) ?? []))
}

// the plan writes a hunk as "@810,7 +810,7", and git drops the ",1" on a
// single-line side — so both halves of the join have to agree on that
const RANGE = /@(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?/
// a whole-file add or delete has one side only, and the plan writes just that
// side — "+1,3" for a new file, "-1,105" for a deleted one — where `but diff`
// still reports both, the absent one at zero length. Unjoined, those rows lost
// their hunk IDs and their churn.
const ONE_SIDED = /^([-+])(\d+)(?:,(\d+))?$/
const rangeKey = (path, hunk) => {
    const [, sign, start, count = "1"] = ONE_SIDED.exec(hunk.trim()) ?? []
    if (sign)
        return sign === "+"
            ? `${path}\0${start},0,${start},${count}`
            : `${path}\0${start},${count},${start},0`
    const [, a, b = "1", c, d = "1"] = RANGE.exec(hunk) ?? []
    return `${path}\0${a},${b},${c},${d}`
}

/** Per-hunk `<file>:<hunk>` CLI IDs and churn, keyed by range. The absorb plan
 *  identifies a hunk by its range alone, and every per-hunk command needs an
 *  ID — `but diff` is the only place they exist. */
async function hunkIds(root) {
    const { changes } = JSON.parse(await run("but", ["diff", "--json"], root))
    const ids = new Map()
    const counts = new Map()
    // a file's ranges, as one string: what tells a cached absorb reason from a
    // stale one without re-asking `but`
    const sig = new Map()
    for (const c of changes)
        for (const h of c.diff?.hunks ?? []) {
            // the header line is the range we keyed on; the rest is churn
            const lines = (h.diff ?? "").split("\n").slice(1)
            ids.set(
                `${c.path}\0${h.oldStart},${h.oldLines},${h.newStart},${h.newLines}`,
                {
                    id: c.id,
                    adds: lines.filter((l) => l.startsWith("+")).length,
                    dels: lines.filter((l) => l.startsWith("-")).length,
                    // the lines it edits, not the range it spans — a hunk's
                    // header points at its first context line. A file deleted
                    // whole leaves no line to point at, so it gets none.
                    ...(h.newLines ? changedLines(h.diff, h.newStart) : {}),
                }
            )
            counts.set(c.path, (counts.get(c.path) ?? 0) + 1)
            sig.set(
                c.path,
                `${sig.get(c.path) ?? ""};${h.oldStart},${h.oldLines},${h.newStart},${h.newLines}`
            )
        }
    return { ids, counts, sig }
}

/** The plan reports one entry per hunk, so a file with three hunks in one commit
 *  arrives as three rows with the same name and nothing but a range to tell them
 *  apart. One row per file, hunks underneath — and the split into anchored and
 *  unanchored happens first, since a file can be both. */
function byPath(rows) {
    const out = new Map()
    for (const r of rows) {
        const prev = out.get(r.path)
        if (!prev) out.set(r.path, r)
        else {
            prev.hunks = [...prev.hunks, ...r.hunks]
            prev.hunkMeta = [...prev.hunkMeta, ...r.hunkMeta]
        }
    }
    return [...out.values()]
}

/** Splits what absorb would do into commits that genuinely depend on a change,
 *  and changes nothing depends on — which land in the primary lane by default
 *  and so must not be filed under a branch as if they belonged to it. */
async function uncommittedPlan(root, st) {
    const changes = st.uncommittedChanges
    // With a single applied branch there is nowhere else a change could go, so
    // "unanchored" would be noise that teaches you to ignore the warning — and
    // the per-file plans that decide it are one `but` process each, so don't
    // ask when the answer can't matter.
    const ambiguous = st.stacks.flatMap((s) => s.branches).length > 1
    // a commit added, amended or rebased can change what a file depends on
    // without the file itself moving, so the reason cache keys on all of them
    const commitSig = st.stacks
        .flatMap((s) => s.branches.flatMap((b) => b.commits.map((c) => c.commitId)))
        .join()
    // the batch runs alongside; the per-file reasons wait on `but diff`, whose
    // ranges are what lets them come from cache
    const [batch, { ids, counts, sig }] = await Promise.all([
        absorbPlan(root),
        // rows still render without IDs; they just carry no actions
        hunkIds(root).catch(() => ({
            ids: new Map(),
            counts: new Map(),
            sig: new Map(),
        })),
    ])
    const reasons = ambiguous
        ? await fileReasons(root, changes, sig, commitSig)
        : new Map()

    const commitMeta = new Map()
    for (const s of st.stacks)
        for (const b of s.branches)
            for (const c of b.commits)
                commitMeta.set(c.commitId, { branch: b.name, cliId: c.cliId })
    const changeOf = new Map(changes.map((c) => [c.filePath, c]))

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
                // positional: hunkMeta[i] belongs to hunks[i]
                hunkMeta: f.hunks.map((h) => ids.get(rangeKey(f.path, h)) ?? {}),
                // how many the file has in all, so a row that holds only some
                // of them knows not to act as if it were the file
                hunkTotal: counts.get(f.path),
            }
            const reason = reasons.get(`${f.path}\0${k.commit_id}`) ?? k.reason
            if (ambiguous && reason === "default_stack") unanchored.push(row)
            else files.push(row)
        }
        if (files.length)
            groups.push({ commit: k, meta, files: byPath(files) })
    }
    const strays = byPath(unanchored)
    return {
        groups,
        unanchored: strays,
        // files, not plan entries — `total_files` counts the latter
        total:
            groups.reduce((n, g) => n + g.files.length, 0) + strays.length,
    }
}

const DETAILS_QUERY =
    "query($ids:[ID!]!){nodes(ids:$ids){... on PullRequest{id mergeable reviewThreads(first:100){nodes{isResolved comments(first:1){nodes{author{login}}}}}}}}"

/** Thread resolution and conflict state, the two review facts `gh pr list
 *  --json` cannot reach — both live only in GraphQL. Asked for by node id, so
 *  no owner/repo lookup is needed. Failure is not fatal: a PR without either
 *  reads as "nothing unresolved, no conflicts", which is what the old behaviour
 *  assumed anyway. Fills the PR objects in place, so a caller that already
 *  rendered them can repaint rather than refetch — see PrTree. */
async function prDetails(root, prs) {
    if (!prs.length) return
    const args = ["api", "graphql", "-f", `query=${DETAILS_QUERY}`]
    for (const p of prs) args.push("-F", `ids[]=${p.id}`)
    const { data } = JSON.parse(await run("gh", args, root))
    const byId = new Map(prs.map((p) => [p.id, p]))
    for (const node of data.nodes ?? [])
        if (byId.has(node.id)) {
            const p = byId.get(node.id)
            // GitHub computes this asynchronously and says UNKNOWN until it
            // has, so only a definite CONFLICTING counts — otherwise every
            // freshly opened PR would go red for its first few seconds
            p.conflicting = node.mergeable === "CONFLICTING"
            p.reviewThreads = node.reviewThreads.nodes.map((t) => ({
                isResolved: t.isResolved,
                login: t.comments.nodes[0]?.author?.login ?? "",
            }))
        }
}

/** Every open PR of yours, in one call — per-branch lookups would be ~1s each.
 *  Network, so the caller decides when. Deliberately does not wait on
 *  `prDetails`: the rows can be drawn without it. */
const listPrs = async (root) =>
    JSON.parse(
        await run(
            "gh",
            [
                "pr", "list", "--author", "@me", "--limit", "100",
                "--json",
                "id,number,title,url,isDraft,author,reviews,reviewRequests,headRefName",
            ],
            root
        )
    )

module.exports = { status, stacksOf, uncommittedPlan, rangeKey, listPrs, prDetails }
