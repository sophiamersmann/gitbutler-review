// Every TreeItem the views render. Display only — what a row says and how it
// looks, never how its data was fetched.

const vscode = require("vscode")
const path = require("path")
const { ago, uri } = require("./exec")
const { allReviewed, ciState, entriesIn, folderKey, humanDecision, hunkLine, hunkRange, isDemoted, layoutFor, lineRange, openThreads, reviewOf, rollup, stackName } = require("./model")

const BASE = "butbase" // butbase:/<path>?<ref>    — the file as of a ref, read-only

const FILE = "butfile" // butfile:/<path>?<status> — a file row, for decorations

const PR = "butpr" //     butpr:/<number>?<ci>      — a PR row, for decorations

const DECORATION = {
    A: ["A", "gitDecoration.addedResourceForeground"],
    M: ["M", "gitDecoration.modifiedResourceForeground"],
    D: ["D", "gitDecoration.deletedResourceForeground"],
}

const LETTER = { added: "A", modified: "M", deleted: "D" }

const HUNK_ICON = {
    added: ["diff-added", "gitDecoration.addedResourceForeground"],
    modified: ["diff-modified", "gitDecoration.modifiedResourceForeground"],
    deleted: ["diff-removed", "gitDecoration.deletedResourceForeground"],
}

function unplacedGroupItem(rows) {
    const item = new vscode.TreeItem(
        "Unplaced",
        vscode.TreeItemCollapsibleState.Expanded
    )
    // no description and no icon: the label is the whole fact, and the ⚠️ stays
    // in the file tooltips, attached to something you can act on.
    item.tooltip =
        "Absorb would drop these in the primary lane by default, not because anything depends on them. Place them explicitly with \"Amend Into…\"."
    item.contextValue = "unplacedGroup"
    item.id = "unplaced"
    item.rows = rows
    item.unplaced = true
    return item
}

/** The branch a run of commits belongs to. Same glyph and colour as a branch
 *  row in the Branches view, so one name looks the same in both trees. */
function branchGroupItem(branch) {
    const item = new vscode.TreeItem(
        branch.name,
        vscode.TreeItemCollapsibleState.Expanded
    )
    const n = branch.groups.length
    item.description = `${n} commit${n === 1 ? "" : "s"}  ·  ${branch.files} file${branch.files === 1 ? "" : "s"}`
    item.iconPath = new vscode.ThemeIcon(
        "git-branch",
        new vscode.ThemeColor("butReview.branchIcon")
    )
    item.tooltip = new vscode.MarkdownString(
        [
            `**${branch.name}**`,
            "",
            ...branch.groups.map((g) => `- ${g.commit.commit_summary}`),
        ].join("\n")
    )
    // no menu hangs off this any more; it is what marks a row as a branch
    item.contextValue = "branchGroup"
    item.id = `branch:${branch.name}`
    // every file the branch would absorb, in one list. Which commit each lands
    // in is in the row's own tooltip: the branch is what you place work by, and
    // a commit level above these rows listed every file twice.
    item.rows = branch.groups
        .flatMap((g) => g.files)
        .sort((a, b) => a.path.localeCompare(b.path))
    item.unplaced = false
    item.branch = branch
    return item
}

function dirtyFileItem(row, unplaced) {
    const letter = LETTER[row.change?.changeType] ?? "M"
    // one hunk is the whole file, so its child row would say the same thing twice
    const item = new vscode.TreeItem(
        uri(FILE, row.path, letter),
        row.hunks.length > 1
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None
    )
    // a collapsible row with nothing but a resourceUri gets the icon theme's
    // folder glyph, which a file with two hunks is not
    item.iconPath = vscode.ThemeIcon.File
    // a file whose hunks split across two commits has a row per commit under
    // the branch, and neither of them is the file
    const whole = !row.hunkTotal || row.hunks.length === row.hunkTotal
    // one whole hunk is the file, so name its lines; anything else is a count,
    // since the child rows name the ranges once expanded — and listing them
    // here too pushed the useful part of a long path off the row
    const hunks = !whole
        ? `${row.hunks.length} of ${row.hunkTotal} hunks`
        : row.hunks.length > 1
          ? `${row.hunks.length} hunks`
          : rangeOf(row, 0)
    // where an unplaced change would land is in the tooltip, not the row: the
    // group above it already says the only thing that matters, that no commit
    // asked for it. Churn as the branch view writes it, so a file reads the same
    // in both trees.
    item.description = [hunks, churn(row.hunkMeta)].filter(Boolean).join("  ·  ")
    const ranges = row.hunks
        .map((_, i) => rangeOf(row, i))
        .filter(Boolean)
        .join(", ")
    item.tooltip = new vscode.MarkdownString(
        [
            `\`${row.path}\``,
            unplaced
                ? `⚠️ Nothing depends on this. Absorb would put it on **${row.meta.branch}** simply because that lane is first.`
                : `Absorbs into **${row.commit.commit_summary}**`,
            ranges && `hunks: ${ranges}`,
            whole
                ? ""
                : `Its other ${row.hunkTotal - row.hunks.length} belong elsewhere — discarding here touches only the ${row.hunks.length} above.`,
        ]
            .filter(Boolean)
            .join("  \n")
    )
    item.command = {
        command: "butReview.openDirty",
        title: "Open Changes",
        arguments: [row.change, jumpLine(row, 0)],
    }
    // the whole file when the row is the whole file, its own hunks otherwise —
    // `but` takes several IDs of one kind, so both are one call
    const args = whole
        ? [row.change?.cliId].filter(Boolean)
        : row.hunkMeta.map((h) => h.id).filter(Boolean)
    // nothing addressable, no actions: a button that cannot name its target
    if (args.length)
        item.contextValue = unplaced ? "unplacedFile" : "dirtyFile"
    // VSCode derives an id from the resourceUri when none is given, and a file
    // whose hunks lock to two commits has two rows — same uri, twice in one
    // tree. Explicit and stable, so expansion state survives a reword too.
    item.id = rowId(row, unplaced)
    item.row = row
    item.unplaced = unplaced
    item.target = {
        args,
        // absorb takes one source and routes each hunk itself, so the file ID
        // is both the shortest call and the correct one
        absorb: row.change?.cliId,
        name: path.basename(row.path),
        detail: whole ? row.path : `${row.path} — ${hunks}`,
        commit: row.commit.commit_summary,
    }
    return item
}

/** A hunk of a multi-hunk file: the same three actions as its parent, applied
 *  to one range. `but` addresses hunks as `<file>:<hunk>`, so absorbing or
 *  discarding one is the same call with a longer ID. */
function hunkItem(row, i, unplaced) {
    const meta = row.hunkMeta?.[i] ?? {}
    // a hunk that deletes the file names no lines, because there are none left
    const label = rangeOf(row, i) ?? "whole file"
    const item = new vscode.TreeItem(label)
    // from the hunk's own churn, not the file's status: within one modified file,
    // pure new code and a rewrite are different things to review
    const [glyph, color] = HUNK_ICON[hunkKind(meta)]
    item.iconPath = new vscode.ThemeIcon(glyph, new vscode.ThemeColor(color))
    item.description = churn([meta])
    item.tooltip = new vscode.MarkdownString(
        [
            `\`${row.path}\` — ${label}`,
            unplaced
                ? `⚠️ Nothing depends on this hunk. Absorb would put it on **${row.meta.branch}** simply because that lane is first.`
                : `Absorbs into **${row.commit.commit_summary}**`,
        ].join("  \n")
    )
    item.command = {
        command: "butReview.openDirty",
        title: "Open Changes",
        arguments: [row.change, jumpLine(row, i)],
    }
    if (meta.id) item.contextValue = unplaced ? "unplacedHunk" : "dirtyHunk"
    item.id = `${rowId(row, unplaced)}:${i}`
    // deliberately no `.row`: that is what marks a node as having hunk children,
    // and a hunk row's children would be itself
    item.target = {
        args: [meta.id],
        absorb: meta.id,
        name: `${path.basename(row.path)} ${label.toLowerCase()}`,
        detail: `${row.path}  ${row.hunks[i]}`,
        commit: row.commit.commit_summary,
    }
    return item
}

function stackItem(stack) {
    const item = new vscode.TreeItem(
        stackName(stack),
        vscode.TreeItemCollapsibleState.Collapsed
    )
    item.description = [
        `${stack.branches.length} branches`,
        // already computed for the recency sort
        !stack.demoted && stack.activity && ago(stack.activity),
    ]
        .filter(Boolean)
        .join(" · ")
    item.iconPath = new vscode.ThemeIcon(
        "layers",
        new vscode.ThemeColor("butReview.stackIcon")
    )
    const head = [
        `\`${stack.cliId}\`${stack.primary ? " — unplaced changes absorb here" : ""}`,
        // else the next disagreement between the name and the commits is a
        // puzzle rather than a fact
        stack.label &&
            `Renamed — the commits say \`${stackName({ ...stack, label: undefined })}\`.`,
    ].filter(Boolean)
    item.tooltip = new vscode.MarkdownString(
        [...head, "", ...stack.branches.map((b) => `- ${b.name}`)].join("\n")
    )
    item.contextValue = "stack"
    item.stack = stack
    return item
}

function branchItem(branch, overrides) {
    const item = new vscode.TreeItem(
        branch.name,
        vscode.TreeItemCollapsibleState.Collapsed
    )
    // no CI on this row or in its tooltip: a check's state belongs to the PR, and
    // the Pull Requests view already rolls it into that row's circle
    // a demoted branch is always freshly touched and never the thing you act on,
    // so its age is noise
    item.description =
        (!isDemoted(branch.name) && branch.latest && ago(branch.latest)) || ""
    item.iconPath = new vscode.ThemeIcon(
        "git-branch",
        new vscode.ThemeColor("butReview.branchIcon")
    )
    item.tooltip = new vscode.MarkdownString(
        [
            `**${branch.name}**`,
            branch.fileCount === undefined
                ? ""
                : `${branch.fileCount} file${branch.fileCount === 1 ? "" : "s"} changed`,
            `Compared against \`${branch.base}\``,
            "",
            ...branch.subjects.map((s) => `- ${s}`),
        ]
            .filter(Boolean)
            .join("\n")
    )
    item.contextValue = `branch:${layoutFor(branch, overrides)}`
    item.branch = branch
    return item
}

/** The stack read as one diff, as a row beside its branches rather than a mode
 *  on top of them: it is a lens you want before a push and not otherwise, and a
 *  row cannot be a state you forget you are in — nor does it cost you the
 *  per-branch CI and PR status that the rows below it are there to carry. */
function wholeStackItem(ws, stack, files, overrides) {
    const item = new vscode.TreeItem(
        `All ${stack.branches.length} branches`,
        vscode.TreeItemCollapsibleState.Collapsed
    )
    item.description = `${files} file${files === 1 ? "" : "s"}`
    // the stack's colour, so it reads as belonging to the row above; a compare
    // glyph rather than a branch one, because it is not a branch
    item.iconPath = new vscode.ThemeIcon(
        "git-compare",
        new vscode.ThemeColor("butReview.stackIcon")
    )
    item.tooltip = new vscode.MarkdownString(
        [
            `**Whole stack** — \`${stackName(stack)}\``,
            `${files} file${files === 1 ? "" : "s"} against the merge base — what \`master\` gets once all ${stack.branches.length} branches land.`,
            "",
            "Ticks here are counted apart from the branch rows': a shared file's stack diff is not any one branch's diff of it.",
        ]
            .filter(Boolean)
            .join("  \n")
    )
    // the same contextValue shape as a branch, so the layout toggle applies here
    // too — 88 files flat is exactly when the tree earns its keep
    item.contextValue = `branch:${layoutFor(ws, overrides)}`
    item.branch = ws
    return item
}

/** Expanded, because a branch's files were all on screen the moment you opened
 *  it and a tree that hid them behind clicks would cost more than the folders
 *  are worth. The `id` is what makes a collapse of your own stick: without one
 *  VSCode re-applies the state above on every repaint and the row springs back
 *  open. No parent path in the description — position says that now.
 *
 *  The tick holds no state of its own: it carries the review of every file
 *  beneath it, so one click writes them all, and it reads ticked only while all
 *  of them do. Which is what unticks it when you edit one of them. */
function folderItem(node, branch, reviewed) {
    const item = new vscode.TreeItem(
        node.label,
        vscode.TreeItemCollapsibleState.Expanded
    )
    item.id = folderKey(branch, node.dir)
    item.review = entriesIn(node).map(reviewOf)
    item.checkboxState = allReviewed(item.review, reviewed)
        ? vscode.TreeItemCheckboxState.Checked
        : vscode.TreeItemCheckboxState.Unchecked
    // a checkbox has no third state, so 6 of 7 ticked looks exactly like none
    // of them — and a collapsed folder cannot show you the six either. The
    // count carries what the box can't
    const done = item.review.filter(
        (r) => reviewed?.get(r.key) === r.blob
    ).length
    const files = item.review.length
    item.description = done
        ? `${done}/${files} reviewed`
        : `${files} file${files === 1 ? "" : "s"}`
    item.tooltip = node.dir
    item.iconPath = vscode.ThemeIcon.Folder
    item.contextValue = "folder"
    // one property, and `getChildren` reads it before it reads `branch` — a row
    // carrying a branch that fell through to the branch case would refetch the
    // whole diff on every expand
    item.folder = { node, branch }
    return item
}

function fileItem(entry, reviewed, showDir) {
    const { f, branch, alsoIn, within = [], committed } = entry
    const { above = [], other = [] } = alsoIn ?? {}
    // "!" turns the row's badge to the warning colour, which any foreign hunk
    // earns: it says the pane will hold lines that are not this branch's — which
    // the committed pane, being the branch's own diff, never does
    const foreign = !committed && !!(above.length || other.length)
    const item = new vscode.TreeItem(
        uri(FILE, f.file, f.status + (foreign ? "!" : ""))
    )
    const churn = f.adds === "-" ? "binary" : `+${f.adds} −${f.dels}` // numstat marks binaries with -
    const dir = path.dirname(f.file) // "." for a file at the repo root
    item.description = [
        churn,
        // whole-stack lens only: this file was built in steps, which is where a
        // helper's signature drifts from the calls the branch below it wrote
        within.length > 1 ? `in ${within.length} branches` : "",
        // only another stack is named. A branch above is your own work landing
        // after yours, and in a stack where that is true of every file the note
        // was the same sentence twenty times over — the colour already says it
        other.length ? `⚠ also in ${other.join(", ")}` : "",
        // in tree mode the folder row already says where the file lives, and
        // the repo root has no row and no name worth printing
        !other.length && showDir && dir !== "." ? dir : "",
    ]
        .filter(Boolean)
        .join("  ·  ")
    item.tooltip = new vscode.MarkdownString(
        [
            `\`${f.file}\``,
            `${{ A: "Added", M: "Modified", D: "Deleted" }[f.status] ?? f.status} · ${churn}`,
            other.length
                ? `\n⚠️ Also changed by **${other.join("**, **")}**, in another stack — parallel work on the same lines, which only meet when one of them lands.`
                : "",
            above.length && !committed
                ? `\n↑ Continued by **${above.join("**, **")}** above it in this stack, already rebased onto yours. The right-hand pane is the workspace file, so it shows those lines too.`
                : "",
            within.length > 1
                ? `\n⧉ Built by **${within.join("**, **")}**. The pane shows their net effect, which is the one thing no single branch's review does.`
                : "",
        ]
            .filter(Boolean)
            .join("  \n")
    )
    item.command = {
        command: "butReview.openFile",
        title: "Open Changes",
        arguments: [branch, f, alsoIn],
    }
    item.contextValue = "file"
    item.review = [reviewOf(entry)]
    item.checkboxState = allReviewed(item.review, reviewed)
        ? vscode.TreeItemCheckboxState.Checked
        : vscode.TreeItemCheckboxState.Unchecked
    return item
}

function prStackItem(stack, prs) {
    const item = new vscode.TreeItem(
        stackName(stack),
        vscode.TreeItemCollapsibleState.Expanded
    )
    // the view repaints on save and on window focus, and a rebuilt row without
    // an id is a new row — which would re-expand a stack you just collapsed
    item.id = `pr-stack-${stack.cliId}`
    item.description = `${prs.length} PRs`
    item.iconPath = new vscode.ThemeIcon(
        "layers",
        new vscode.ThemeColor("butReview.stackIcon")
    )
    item.contextValue = "prStack"
    item.prs = prs
    item.stack = stack // for "Rename Stack…", which both views offer
    return item
}

function prItem(row) {
    const { pr, branch } = row
    // not gated on isDraft: a draft with a review request is worth seeing
    const decision = humanDecision(pr)
    const ci = ciState(branch)
    const open = openThreads(pr)
    const [circle, summary] = rollup(ci.state, decision, open, pr.conflicting)

    // branch names are short and scannable; the PR title is the elaboration
    const item = new vscode.TreeItem(branch.name)
    // the circle itself is the badge; the tooltip below is what names it
    item.resourceUri = uri(PR, String(pr.number), circle)
    item.description = pr.title
    // shape and colour both say draft-or-open, GitHub's own convention, so the
    // two are told apart at a glance rather than by squinting at the glyph
    item.iconPath = new vscode.ThemeIcon(
        pr.isDraft ? "git-pull-request-draft" : "git-pull-request",
        new vscode.ThemeColor(
            pr.isDraft ? "butReview.prDraft" : "butReview.prOpen"
        )
    )
    // the row's own legend: name the circle, then the two facts behind it, so a
    // red dot's cause is readable without knowing the ladder
    item.tooltip = new vscode.MarkdownString(
        [
            `[#${pr.number} ${pr.title}](${pr.url})`,
            `on \`${branch.name}\``,
            "",
            `${circle}  **${summary}**`,
            `CI: ${ci.label ?? "no checks"}`,
            `Review: ${decision ?? "none requested"}${pr.isDraft ? " · draft" : ""}${open ? ` · ${open} unresolved thread${open > 1 ? "s" : ""}` : ""}`,
            // otherwise a red dot on a PR with green CI and no changes
            // requested has nothing here that accounts for it
            ...(pr.conflicting ? ["Conflicts with the base branch"] : []),
            ...ci.failing.map((c) => `- ✗ ${c}`),
        ].join("  \n")
    )
    // no item.command: the row's two actions are the inline buttons, which read
    // this off the node
    item.url = pr.url
    item.contextValue = "pr"
    return item
}

/** Unique per row in the tree: a file whose hunks lock to two commits has a row
 *  under the branch for each, and the same path can sit under a branch and under
 *  Unplaced at once — so both the commit and the section are in the id. */
const rowId = (row, unplaced) =>
    `${unplaced ? "u" : "a"}:${row.commit.commit_id}:${row.path}`

/** Pure new code, pure removal, or a rewrite — the distinction the file's own
 *  A/M/D status can't make, since every one of these lives in a modified file. */
const hunkKind = ({ adds, dels }) =>
    adds && !dels ? "added" : dels && !adds ? "deleted" : "modified"

/** What a hunk row calls itself: the lines it edits, falling back to the
 *  header's whole span when `but diff` gave us no body to read. */
const rangeOf = (row, i) => {
    const { from, to } = row.hunkMeta?.[i] ?? {}
    return from ? lineRange(from, to) : hunkRange(row.hunks[i])
}

/** The line a row's click lands on: the first line it actually changes, or the
 *  hunk header's when we have no body to read. */
const jumpLine = (row, i) => row.hunkMeta?.[i]?.from ?? hunkLine(row.hunks[i])

/** "+5 −1" over a row's hunks, written the way the branch view writes a file's.
 *  Blank when `but diff` gave us nothing to count. */
function churn(hunks) {
    const known = (hunks ?? []).filter((h) => h?.adds !== undefined)
    if (!known.length) return ""
    const adds = known.reduce((n, h) => n + h.adds, 0)
    const dels = known.reduce((n, h) => n + h.dels, 0)
    return `+${adds} −${dels}`
}

module.exports = { BASE, FILE, PR, DECORATION, hunkKind, unplacedGroupItem, branchGroupItem, dirtyFileItem, hunkItem, stackItem, branchItem, wholeStackItem, folderItem, fileItem, prStackItem, prItem }
