// Everything asked of git. Each query is one call — the diffs are cheap,
// but a per-file loop over a 64-file branch is not.

const vscode = require("vscode")
const { run } = require("./exec")

// git's empty tree: `git show <it>:anything` fails, so the provider yields "".
// Used as the right-hand side for files that no longer exist.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

const filesOf = async (root, branch) =>
    (
        await run(
            "git",
            ["diff", "--no-ext-diff", "--name-only", "--no-renames", branch.base, branch.name, "--"],
            root
        )
    )
        .split("\n")
        .filter(Boolean)

/** Changed files with their status letter and churn. */
async function changedFiles(root, branch) {
    // --no-renames keeps paths plain in both outputs, so they zip by path
    const args = ["diff", "--no-ext-diff", "--no-renames", branch.base, branch.name, "--"]
    const [numstat, nameStatus] = await Promise.all([
        run("git", [...args.slice(0, -1), "--numstat", "--"], root),
        run("git", [...args.slice(0, -1), "--name-status", "--"], root),
    ])

    const churn = new Map(
        numstat
            .split("\n")
            .filter(Boolean)
            .map((l) => {
                const [adds, dels, file] = l.split("\t")
                return [file, { adds, dels }]
            })
    )
    return nameStatus
        .split("\n")
        .filter(Boolean)
        .map((l) => {
            const [st, file] = l.split("\t")
            return { file, status: st[0], ...churn.get(file) }
        })
}

/** Lines in the workspace copy of a file that this branch did NOT put there —
 *  i.e. everything the other applied branches contribute to the right-hand pane.
 *  Compared against HEAD (the workspace commit) rather than the worktree, so
 *  your own in-progress edits aren't flagged as somebody else's. */
async function foreignRanges(root, branch, file) {
    const out = await run(
        "git",
        ["diff", "--no-ext-diff", "-U0", "--no-renames", branch.name, "HEAD", "--", file],
        root
    )
    const ranges = []
    for (const line of out.split("\n")) {
        const m = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line)
        if (!m) continue
        const start = Number(m[1])
        const count = m[2] === undefined ? 1 : Number(m[2])
        // count 0 is a pure deletion — no line in this pane to decorate
        if (count > 0)
            ranges.push(
                new vscode.Range(start - 1, 0, start + count - 2, Number.MAX_SAFE_INTEGER)
            )
    }
    return ranges
}

/** Files whose workspace copy differs from this branch's tip — precisely what
 *  another applied branch contributes to the right-hand pane. Asking "does some
 *  other branch touch this path" instead over-reports badly: a branch *below*
 *  yours has its changes in the base too, so they cancel out of the diff. */
const contaminated = async (root, branch) =>
    new Set(
        (
            await run(
                "git",
                ["diff", "--no-ext-diff", "--name-only", "--no-renames", branch.name, "HEAD", "--"],
                root
            )
        )
            .split("\n")
            .filter(Boolean)
    )

/** file -> its blob SHA at the branch tip. Keying "reviewed" on the blob means
 *  a tick survives a reload but clears itself the moment the branch's version of
 *  that file changes — which is exactly what absorbing an edit does. */
async function blobShas(root, branch, files) {
    if (!files.length) return new Map()
    const out = await run(
        "git",
        ["ls-tree", "-z", branch.name, "--", ...files],
        root
    )
    return new Map(
        out
            .split("\0")
            .filter(Boolean)
            .map((rec) => {
                const [meta, file] = rec.split("\t")
                return [file, meta.split(/\s+/)[2]]
            })
    )
}

/** branch name -> the files it changes. One pass, reused for both the row's
 *  file count and the cross-branch overlap check. */
async function branchFiles(root, stacks) {
    const all = stacks.flatMap((s) => s.branches)
    return new Map(
        await Promise.all(
            all.map(async (b) => [b.name, await filesOf(root, b)])
        )
    )
}

/** path -> branch names that also change it. The workspace holds every applied
 *  branch at once, so a file touched by two of them shows both sets of hunks in
 *  the diff — this is what makes that visible instead of merely confusing. */
function overlapMap(files) {
    const map = new Map()
    for (const [name, paths] of files)
        for (const p of paths) map.set(p, (map.get(p) ?? []).concat(name))
    return map
}

module.exports = { EMPTY_TREE, filesOf, changedFiles, foreignRanges, contaminated, blobShas, branchFiles, overlapMap }
