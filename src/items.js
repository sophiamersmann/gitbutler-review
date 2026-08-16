// Every TreeItem the views render. Display only — what a row says and how it
// looks, never how its data was fetched.

const vscode = require("vscode")
const path = require("path")
const { ago, uri } = require("./exec")
const { ciState, humanDecision, hunkLine, isDemoted, layoutFor, openThreads, reviewKey, rollup, stackName } = require("./model")

const BASE = "butbase" // butbase:/<path>?<ref>    — the file as of a ref, read-only

const FILE = "butfile" // butfile:/<path>?<status> — a file row, for decorations

const PR = "butpr" //     butpr:/<number>?<ci>      — a PR row, for decorations

const DECORATION = {
    A: ["A", "gitDecoration.addedResourceForeground"],
    M: ["M", "gitDecoration.modifiedResourceForeground"],
    D: ["D", "gitDecoration.deletedResourceForeground"],
}

const LETTER = { added: "A", modified: "M", deleted: "D" }

function unanchoredGroupItem(rows) {
    const item = new vscode.TreeItem(
        "Unanchored",
        vscode.TreeItemCollapsibleState.Expanded
    )
    item.description = "no commit depends on these"
    item.iconPath = new vscode.ThemeIcon(
        "warning",
        new vscode.ThemeColor("butReview.foreignHunkBorder")
    )
    item.tooltip =
        "Absorb would drop these in the primary lane by default, not because anything depends on them. Place them explicitly with \"Amend Into…\"."
    item.contextValue = "unanchoredGroup"
    item.rows = rows
    return item
}

function commitGroupItem(group) {
    const item = new vscode.TreeItem(
        group.commit.commit_summary,
        vscode.TreeItemCollapsibleState.Expanded
    )
    item.description = group.meta.branch ?? ""
    item.iconPath = new vscode.ThemeIcon("git-commit")
    item.tooltip = new vscode.MarkdownString(
        [
            `**${group.commit.commit_summary}**`,
            group.meta.branch ? `on \`${group.meta.branch}\`` : "",
            `_${group.commit.reason_description}_`,
        ]
            .filter(Boolean)
            .join("  \n")
    )
    item.contextValue = "commitGroup"
    item.group = group
    return item
}

function dirtyFileItem(row, unanchored) {
    const letter = LETTER[row.change?.changeType] ?? "M"
    const item = new vscode.TreeItem(uri(FILE, row.path, letter))
    item.description = unanchored
        ? `would default to ${row.meta.branch ?? "the primary lane"}`
        : row.hunks.join(", ")
    item.tooltip = new vscode.MarkdownString(
        [
            `\`${row.path}\``,
            unanchored
                ? `⚠️ Nothing depends on this. Absorb would put it on **${row.meta.branch}** simply because that lane is first.`
                : `Absorbs into **${row.commit.commit_summary}**`,
            `hunks: ${row.hunks.join(", ")}`,
        ].join("  \n")
    )
    item.command = {
        command: "butReview.openDirty",
        title: "Open Changes",
        arguments: [row.change, hunkLine(row.hunks[0])],
    }
    item.contextValue = unanchored ? "unanchoredFile" : "dirtyFile"
    item.row = row
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
    item.tooltip = new vscode.MarkdownString(
        [
            `\`${stack.cliId}\`${stack.primary ? " — unanchored changes absorb here" : ""}`,
            "",
            ...stack.branches.map((b) => `- ${b.name}`),
        ].join("\n")
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
    const ci = ciState(branch)
    item.description = [
        // green is the norm; saying so for ten branches is noise
        ci.state !== "passing" && ci.label,
        // a docs branch is always freshly touched and never the thing you act
        // on, so its age is noise
        !isDemoted(branch.name) && branch.latest && ago(branch.latest),
    ]
        .filter(Boolean)
        .join(" · ")
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
            ci.label ?? "",
            ...ci.failing.map((c) => `- ✗ ${c}`),
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

function groupItem(group) {
    const parent = path.dirname(group.dir)
    const item = new vscode.TreeItem(
        path.basename(group.dir) || group.dir,
        vscode.TreeItemCollapsibleState.Collapsed
    )
    item.description = [
        parent === "." ? "" : parent,
        `${group.files.length} file${group.files.length === 1 ? "" : "s"}`,
    ]
        .filter(Boolean)
        .join("  ·  ")
    item.tooltip = group.dir
    item.iconPath = vscode.ThemeIcon.Folder
    item.contextValue = "group"
    item.group = group.files
    return item
}

function fileItem(entry, reviewed, showDir) {
    const { f, branch, blob, alsoIn } = entry
    const { above = [], other = [] } = alsoIn ?? {}
    // "!" turns the row's badge to the warning colour, which any foreign hunk
    // earns: it says the pane will hold lines that are not this branch's
    const item = new vscode.TreeItem(
        uri(FILE, f.file, f.status + (above.length || other.length ? "!" : ""))
    )
    const churn = f.adds === "-" ? "binary" : `+${f.adds} −${f.dels}` // numstat marks binaries with -
    item.description = [
        churn,
        // only another stack is named. A branch above is your own work landing
        // after yours, and in a stack where that is true of every file the note
        // was the same sentence twenty times over — the colour already says it
        other.length ? `⚠ also in ${other.join(", ")}` : "",
        // in tree mode the folder row already says where the file lives
        !other.length && showDir ? path.dirname(f.file) : "",
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
            above.length
                ? `\n↑ Continued by **${above.join("**, **")}** above it in this stack, already rebased onto yours. The right-hand pane is the workspace file, so it shows those lines too.`
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
    const key = reviewKey(branch, f.file)
    item.review = [{ key, blob }]
    item.checkboxState =
        reviewed?.get(key) === blob
            ? vscode.TreeItemCheckboxState.Checked
            : vscode.TreeItemCheckboxState.Unchecked
    return item
}

function prStackItem(stack, prs) {
    const item = new vscode.TreeItem(
        stackName(stack),
        vscode.TreeItemCollapsibleState.Expanded
    )
    item.description = `${prs.length} PRs`
    item.iconPath = new vscode.ThemeIcon(
        "layers",
        new vscode.ThemeColor("butReview.stackIcon")
    )
    item.contextValue = "prStack"
    item.prs = prs
    return item
}

function prItem(row) {
    const { pr, branch } = row
    // not gated on isDraft: a draft with a review request is worth seeing
    const decision = humanDecision(pr)
    const ci = ciState(branch)
    const open = openThreads(pr)
    const [circle, summary] = rollup(ci.state, decision, open)

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
            ...ci.failing.map((c) => `- ✗ ${c}`),
        ].join("  \n")
    )
    item.command = {
        command: "butReview.openUrl",
        title: "Open Pull Request",
        arguments: [pr.url],
    }
    item.contextValue = "pr"
    return item
}

module.exports = { BASE, FILE, PR, DECORATION, unanchoredGroupItem, commitGroupItem, dirtyFileItem, stackItem, branchItem, groupItem, fileItem, prStackItem, prItem }
