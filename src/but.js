// Everything asked of the `but` and `gh` CLIs, plus the shapes derived straight
// from what they return.

const { run } = require("./exec")
const { isDemoted } = require("./model")

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
    // With a single applied branch there is nowhere else a change could go, so
    // "unanchored" would be noise that teaches you to ignore the warning — and
    // the per-file plans that decide it are one `but` process each, so don't
    // ask when the answer can't matter.
    const ambiguous = st.stacks.flatMap((s) => s.branches).length > 1
    const [batch, reasons] = await Promise.all([
        absorbPlan(root),
        ambiguous ? fileReasons(root, changes) : new Map(),
    ])

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
            }
            const reason = reasons.get(`${f.path}\0${k.commit_id}`) ?? k.reason
            if (ambiguous && reason === "default_stack") unanchored.push(row)
            else files.push(row)
        }
        if (files.length) groups.push({ commit: k, meta, files })
    }
    return { groups, unanchored, total: batch.total_files }
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

module.exports = { status, stacksOf, uncommittedPlan, listPrs, prDetails }
