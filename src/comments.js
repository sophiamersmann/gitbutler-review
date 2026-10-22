// Line comments in a committed review pane, posted to the branch's pull request.
// The pane shows the local tip, which may be ahead of what was pushed, so every
// line is mapped to the PR's head on the way out and back on the way in.

const vscode = require("vscode")
const { postPrComment, prComments } = require("./but")
const { repoRoot, run } = require("./exec")
const { hunkRanges, spansBetween } = require("./git")
const { mapLine } = require("./model")

const toComment = (c) => ({
    body: new vscode.MarkdownString(c.body),
    mode: vscode.CommentMode.Preview,
    author: { name: c.user.login, iconPath: vscode.Uri.parse(c.user.avatar_url) },
    timestamp: new Date(c.created_at),
})

/** gh puts GitHub's own message on the last line of stderr, after the command
 *  line execFile echoes */
const ghMessage = (err) =>
    err.message.trim().split("\n").pop().replace(/^gh: /, "")

/** The 0-based lines of `range` that exist unchanged at the pushed head, as
 *  ranges of consecutive lines */
function pushedRuns(range, spans) {
    const runs = []
    let from
    for (let line = range.start.line; line <= range.end.line + 1; line++) {
        const pushed =
            line <= range.end.line && mapLine(spans, line + 1, "new", "old")
        if (pushed && from === undefined) from = line
        if (!pushed && from !== undefined) {
            runs.push(new vscode.Range(from, 0, line - 1, Number.MAX_SAFE_INTEGER))
            from = undefined
        }
    }
    return runs
}

function reviewComments() {
    const controller = vscode.comments.createCommentController(
        "butReview",
        "GitHub"
    )
    /** pane uri -> {pr, head, branch, base, file, spans, threads} */
    const panes = new Map()
    /** thread -> the id of the GitHub comment that starts it */
    const rootIds = new WeakMap()

    // Changed lines only: GitHub refuses a comment on a line outside the PR's
    // diff, and a pure deletion has no line on the head's side to hold one.
    // Lines edited since the push don't exist on GitHub at all.
    controller.commentingRangeProvider = {
        provideCommentingRanges: async (doc) => {
            const pane = panes.get(doc.uri.toString())
            if (!pane) return []
            const [ranges, spans] = await Promise.all([
                hunkRanges(repoRoot(), pane.base, pane.branch, pane.file),
                pane.spans,
            ])
            return ranges
                .filter((r) => !r.isEmpty)
                .flatMap((r) => pushedRuns(r, spans))
        },
    }

    const forget = (key) => {
        for (const thread of panes.get(key)?.threads ?? []) thread.dispose()
        panes.delete(key)
    }

    /** Makes `right` commentable against `head` and draws the PR's threads on
     *  it. Threads GitHub has marked outdated, and those on lines edited since
     *  the push, have no line in the pane and are left out. */
    async function attach(right, { pr, head, branch, base, file }) {
        const key = right.toString()
        forget(key)
        const root = repoRoot()
        const pane = {
            pr,
            head,
            branch,
            base,
            file,
            spans: spansBetween(root, head, branch, file).catch(() => []),
            threads: [],
        }
        panes.set(key, pane)
        const [all, spans] = await Promise.all([
            prComments(root, pr).catch(() => []),
            pane.spans,
        ])
        // reopened while the fetch was in flight
        if (panes.get(key) !== pane) return
        const here = all.filter(
            (c) => c.path === file && c.side === "RIGHT" && c.line
        )
        for (const first of here.filter((c) => !c.in_reply_to_id)) {
            const end = mapLine(spans, first.line, "old", "new")
            const start = mapLine(spans, first.start_line ?? first.line, "old", "new")
            if (!start || !end) continue
            const replies = here.filter((c) => c.in_reply_to_id === first.id)
            const thread = controller.createCommentThread(
                right,
                new vscode.Range(start - 1, 0, end - 1, 0),
                [first, ...replies].map(toComment)
            )
            thread.label = `#${pr.number}`
            rootIds.set(thread, first.id)
            pane.threads.push(thread)
        }
    }

    /** The thread's lines at the pushed head, 1-based, or undefined unless
     *  every one of them reads there exactly as it does in the pane. The text
     *  check catches the diff pairing a line with an identical neighbour — a
     *  blank line or a lone brace — which the mapping alone can't see. */
    async function pushedLines(pane, thread) {
        const start = thread.range.start.line + 1
        const end = thread.range.end.line + 1
        const spans = await pane.spans
        const pushedStart = mapLine(spans, start, "new", "old")
        const pushedEnd = mapLine(spans, end, "new", "old")
        if (!pushedStart || pushedEnd - pushedStart !== end - start) return undefined
        const [doc, pushedText] = await Promise.all([
            vscode.workspace.openTextDocument(thread.uri),
            run("git", ["show", `${pane.head}:${pane.file}`], repoRoot()),
        ])
        const pushed = pushedText.split("\n")
        for (let i = 0; i <= end - start; i++)
            if (doc.lineAt(start - 1 + i).text !== pushed[pushedStart - 1 + i])
                return undefined
        return { start: pushedStart, end: pushedEnd }
    }

    /** A new thread or a reply, from the comment box's submit button */
    async function post({ thread, text }) {
        const pane = panes.get(thread.uri.toString())
        if (!pane || !thread.range) return
        const replyTo = rootIds.get(thread)
        // the box has already cleared, so the text is offered back
        const fail = async (message) => {
            const pick = await vscode.window.showErrorMessage(
                `Comment not posted: ${message}`,
                "Copy Comment"
            )
            if (pick) vscode.env.clipboard.writeText(text)
        }
        try {
            const lines = replyTo ? undefined : await pushedLines(pane, thread)
            if (!replyTo && !lines)
                return fail("these lines changed since your last push")
            const posted = await postPrComment(repoRoot(), pane.pr, {
                body: text,
                commit: pane.head,
                file: pane.file,
                line: lines?.end,
                startLine: lines?.start,
                replyTo,
            })
            if (!replyTo) {
                rootIds.set(thread, posted.id)
                thread.label = `#${pane.pr.number}`
                pane.threads.push(thread)
            }
            thread.comments = [...thread.comments, toComment(posted)]
        } catch (err) {
            fail(ghMessage(err))
        }
    }

    return {
        attach,
        forget,
        disposables: [
            controller,
            vscode.commands.registerCommand("butReview.postComment", post),
        ],
    }
}

module.exports = { reviewComments }
