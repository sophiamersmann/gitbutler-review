// Everything asked of git. Each query is one call — the diffs are cheap,
// but a per-file loop over a 64-file branch is not.

const vscode = require("vscode")
const { run } = require("./exec")

// git's empty tree: `git show <it>:anything` fails, so the provider yields "".
// Used as the right-hand side for files that no longer exist.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

// quotePath off: git otherwise prints a non-ASCII path C-quoted ("sub/\303\274"),
// and every path parsed here is used to open a real file.
const git = (root, args) =>
    run("git", ["-c", "core.quotePath=false", ...args], root)

const diffNames = async (root, a, b) =>
    (
        await git(root, [
            "diff",
            "--no-ext-diff",
            "--name-only",
            "--no-renames",
            a,
            b,
            "--",
        ])
    )
        .split("\n")
        .filter(Boolean)

/** Changed files with their status letter, churn, and blob SHA at the branch
 *  tip. One call: --raw carries the status and the blob, --numstat the churn,
 *  and git prints the two sections one after the other. --no-renames keeps the
 *  paths plain, so they zip. Keying "reviewed" on the blob means a tick
 *  survives a reload but clears itself the moment the branch's version of that
 *  file changes — which is exactly what absorbing an edit does. */
async function changedFiles(root, branch) {
    const out = await git(root, [
        "diff",
        "--no-ext-diff",
        "--no-renames",
        "--raw",
        "--abbrev=40",
        "--numstat",
        branch.base,
        branch.name,
        "--",
    ])
    const files = []
    const churn = new Map()
    for (const line of out.split("\n")) {
        if (!line) continue
        if (line[0] === ":") {
            // :<srcmode> <dstmode> <srcsha> <dstsha> <status>\t<path>
            const [meta, file] = line.split("\t")
            const [, , , blob, status] = meta.split(" ")
            // a deleted file's dst sha is all zeros — a stable sentinel, and
            // the tick only ever compares blobs for equality
            files.push({ file, status: status[0], blob })
        } else {
            const [adds, dels, file] = line.split("\t")
            churn.set(file, { adds, dels })
        }
    }
    return files.map((f) => ({ ...f, ...churn.get(f.file) }))
}

/** The hunks of `git diff a b -- file`, as ranges in b's line numbers. A hunk
 *  that only deletes lines has none of its own, so it comes back as an empty
 *  range at the seam it left behind: nothing to decorate, but somewhere to
 *  jump to. */
async function hunkRanges(root, a, b, file) {
    const out = await git(root, [
        "diff",
        "--no-ext-diff",
        "-U0",
        "--no-renames",
        a,
        b,
        "--",
        file,
    ])
    const ranges = []
    for (const line of out.split("\n")) {
        const m = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line)
        if (!m) continue
        const start = Number(m[1])
        const count = m[2] === undefined ? 1 : Number(m[2])
        // "+N,0" is a pure deletion, sitting after line N — and N is 0 when the
        // file's first lines went
        ranges.push(
            count > 0
                ? new vscode.Range(start - 1, 0, start + count - 2, Number.MAX_SAFE_INTEGER)
                : new vscode.Range(Math.max(start - 1, 0), 0, Math.max(start - 1, 0), 0)
        )
    }
    return ranges
}

/** Both sets of hunks the right-hand pane holds, in its line numbers: what this
 *  branch put there, and what the other applied branches contribute. Compared
 *  against HEAD (the workspace commit) rather than the worktree, so your own
 *  in-progress edits aren't attributed to somebody else. A hunk of the whole
 *  base→HEAD diff that overlaps a foreign one isn't ours to claim. */
async function paneRanges(root, branch, file) {
    const [foreign, all] = await Promise.all([
        hunkRanges(root, branch.name, "HEAD", file),
        hunkRanges(root, branch.base, "HEAD", file),
    ])
    // an empty range is a deletion seam: real enough to jump to, but dimming a
    // line nobody touched would be a lie, and subtracting one would swallow the
    // hunk of ours that happens to sit on it
    const dim = foreign.filter((r) => !r.isEmpty)
    return { foreign: dim, own: all.filter((r) => !dim.some((f) => f.intersection(r))) }
}

/** Files whose workspace copy differs from this branch's tip — precisely what
 *  another applied branch contributes to the right-hand pane. Asking "does some
 *  other branch touch this path" instead over-reports badly: a branch *below*
 *  yours has its changes in the base too, so they cancel out of the diff. */
const contaminated = async (root, branch) =>
    new Set(await diffNames(root, branch.name, "HEAD"))

/** branch name -> the files it changes. One pass, reused for both the row's
 *  file count and the cross-branch overlap check. */
async function branchFiles(root, stacks) {
    const all = stacks.flatMap((s) => s.branches)
    return new Map(
        await Promise.all(
            all.map(async (b) => [b.name, await diffNames(root, b.base, b.name)])
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

module.exports = { EMPTY_TREE, diffNames, changedFiles, paneRanges, contaminated, branchFiles, overlapMap }
