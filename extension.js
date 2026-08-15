// Entry point: wires the providers, decorations and commands together.

const vscode = require("vscode")
const path = require("path")
const { status, uncommittedPlan } = require("./src/but")
const { cfg, repoRoot, run, uri } = require("./src/exec")
const { EMPTY_TREE, foreignRanges } = require("./src/git")
const { BASE, DECORATION, FILE, PR } = require("./src/items")
const { layoutKey } = require("./src/model")
const { BranchTree, PrTree, UncommittedTree } = require("./src/trees")

function activate(context) {
    // workspaceState, so ticks and layout overrides are per-repo and survive a
    // reload
    const store = {
        get: (k) => context.workspaceState.get(k),
        set: (k, v) => context.workspaceState.update(k, v),
    }
    const tree = new BranchTree(store)
    const prs = new PrTree()
    const branchView = vscode.window.createTreeView("butReview.branches", {
        treeDataProvider: tree,
    })
    const dirty = new UncommittedTree()
    const dirtyView = vscode.window.createTreeView("butReview.uncommitted", {
        treeDataProvider: dirty,
    })
    dirty.view = dirtyView // needs the view for its description; set after creation
    let saveTimer

    // The view is hidden while the tree is clean, so nothing renders an empty
    // box — which means its own getChildren can't be what discovers the state.
    const syncVisibility = async () => {
        const root = repoRoot()
        const n = root
            ? await status(root)
                  .then((st) => st.uncommittedChanges.length)
                  .catch(() => 0)
            : 0
        vscode.commands.executeCommand(
            "setContext",
            "butReview.hasUncommitted",
            n > 0
        )
    }

    const openDiff = (left, right, title, opts) =>
        vscode.commands.executeCommand("vscode.diff", left, right, title, opts)

    // The diff editor already owns the background channel, so the marker lives
    // in opacity, a left rail and the ruler instead — see foreignRanges above.
    const foreign = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        opacity: "0.6",
        borderWidth: "0 0 0 2px",
        borderStyle: "solid",
        borderColor: new vscode.ThemeColor("butReview.foreignHunkBorder"),
        overviewRulerLane: vscode.OverviewRulerLane.Right,
        overviewRulerColor: new vscode.ThemeColor("butReview.foreignHunkBorder"),
    })

    /** uri string -> {branch, file, ranges, hover}; kept so open diffs can be
     *  recomputed after an absorb rather than showing stale dimming */
    const marked = new Map()

    // Only what's on screen: paint() can't use the rest, and `marked` keeps
    // every diff opened this session.
    const repaintOpen = async () => {
        const root = repoRoot()
        if (!root) return
        const visible = new Set(
            vscode.window.visibleTextEditors.map((e) =>
                e.document.uri.toString()
            )
        )
        const onScreen = [...marked].filter(([key]) => visible.has(key))
        await Promise.all(
            onScreen.map(async ([key, m]) => {
                const ranges = await foreignRanges(root, m.branch, m.file).catch(
                    () => []
                )
                if (ranges.length) marked.set(key, { ...m, ranges })
                else marked.delete(key)
            })
        )
        paint()
    }

    const paint = () => {
        for (const editor of vscode.window.visibleTextEditors) {
            const m = marked.get(editor.document.uri.toString())
            if (m)
                editor.setDecorations(
                    foreign,
                    m.ranges.map((range) => ({
                        range,
                        hoverMessage: m.hover,
                    }))
                )
        }
    }

    syncVisibility()

    function refreshAll() {
        tree.refresh()
        dirty.refresh()
        syncVisibility()
        repaintOpen()
    }

    context.subscriptions.push(
        // Left pane of every diff: read-only by virtue of being a content
        // provider, so edits typed there can't be silently lost.
        vscode.workspace.registerTextDocumentContentProvider(BASE, {
            provideTextDocumentContent: (u) =>
                run("git", ["show", `${u.query}:${u.path.slice(1)}`], repoRoot())
                    // a file that doesn't exist at that ref reads as empty
                    .catch(() => ""),
        }),

        // Scoped to our own scheme, so the Explorer's decorations are untouched.
        vscode.window.registerFileDecorationProvider({
            provideFileDecoration: (u) => {
                // the PR row carries its own circle; its tooltip names it
                if (u.scheme === PR) return { badge: u.query }
                if (u.scheme !== FILE) return
                const [badge, color] = DECORATION[u.query[0]] ?? []
                if (!badge) return
                return {
                    badge,
                    color: new vscode.ThemeColor(
                        u.query.endsWith("!") ? "list.warningForeground" : color
                    ),
                }
            },
        }),

        branchView,
        branchView.onDidChangeCheckboxState(({ items }) => {
            for (const [item, state] of items)
                for (const { key, blob } of item.review ?? [])
                    store.set(
                        key,
                        state === vscode.TreeItemCheckboxState.Checked
                            ? blob
                            : undefined
                    )
            tree.refresh() // a folder tick changes every row beneath it
        }),
        vscode.window.registerTreeDataProvider("butReview.prs", prs),
        dirtyView,

        vscode.commands.registerCommand("butReview.openUrl", (url) =>
            vscode.env.openExternal(vscode.Uri.parse(url))
        ),

        // local state and GitHub refresh separately: one is a handful of git
        // calls, the other a network round trip
        vscode.commands.registerCommand("butReview.refresh", refreshAll),

        vscode.commands.registerCommand("butReview.refreshPrs", () =>
            prs.refresh()
        ),

        // per branch, not global: layout is a property of how big a branch is,
        // and a title-bar button could only ever mean "all of them"
        // smoke:registers butReview.viewAsList butReview.viewAsGroup
        ...["list", "group"].map((mode) =>
            vscode.commands.registerCommand(
                `butReview.viewAs${mode[0].toUpperCase()}${mode.slice(1)}`,
                (node) => {
                    // toggling back to the setting's value clears the override
                    // rather than pinning the branch to it
                    const isDefault = mode === cfg().get("fileLayout", "list")
                    store.set(
                        layoutKey(node.branch),
                        isDefault ? undefined : mode
                    )
                    tree.refresh()
                }
            )
        ),

        vscode.window.onDidChangeVisibleTextEditors(paint),

        // The tree reads on demand, so an edit made elsewhere wouldn't show up
        // until you hit refresh. Saving is the cheapest honest trigger.
        vscode.workspace.onDidSaveTextDocument(() => {
            clearTimeout(saveTimer)
            saveTimer = setTimeout(refreshAll, 500)
        }),

        vscode.commands.registerCommand(
            "butReview.openFile",
            async (branch, f, alsoIn = []) => {
                const live = vscode.Uri.file(path.join(repoRoot(), f.file))
                // a deleted file has no workspace side; show it against nothing
                const right =
                    f.status === "D" ? uri(BASE, f.file, EMPTY_TREE) : live

                if (f.status !== "D") {
                    const ranges = await foreignRanges(
                        repoRoot(),
                        branch,
                        f.file
                    ).catch(() => [])
                    if (ranges.length)
                        marked.set(right.toString(), {
                            branch,
                            file: f.file,
                            ranges,
                            hover: new vscode.MarkdownString(
                                `Not part of \`${branch.name}\`${
                                    alsoIn.length
                                        ? ` — also changed by ${alsoIn
                                              .map((b) => `\`${b}\``)
                                              .join(", ")}`
                                        : ""
                                }.`
                            ),
                        })
                }

                await openDiff(
                    uri(BASE, f.file, branch.base),
                    right,
                    `${path.basename(f.file)} — ${branch.name}`
                )
                paint()
            }
        ),

        vscode.commands.registerCommand(
            "butReview.openDirty",
            async (c, line) => {
                const right =
                    c.changeType === "deleted"
                        ? uri(BASE, c.filePath, EMPTY_TREE)
                        : vscode.Uri.file(path.join(repoRoot(), c.filePath))
                // vscode.diff takes TextDocumentShowOptions, and a selection
                // both scrolls the pane there and puts the cursor on it
                await openDiff(
                    uri(BASE, c.filePath, "HEAD"),
                    right,
                    `${path.basename(c.filePath)} — uncommitted`,
                    line
                        ? { selection: new vscode.Range(line - 1, 0, line - 1, 0) }
                        : undefined
                )
            }
        ),

        vscode.commands.registerCommand("butReview.absorb", async () => {
            try {
                const root = repoRoot()
                if (!root) throw new Error("no folder open")

                const plan = await uncommittedPlan(root, await status(root))
                if (!plan.total)
                    return vscode.window.showInformationMessage(
                        "Nothing to absorb."
                    )

                // Absorbing the anchored files one at a time would rewrite
                // history between calls and shift the rest, so make the user
                // place these first and keep the real absorb one atomic call.
                if (plan.unanchored.length)
                    return vscode.window.showWarningMessage(
                        `${plan.unanchored.length} change${plan.unanchored.length > 1 ? "s have" : " has"} no commit to absorb into.`,
                        {
                            modal: true,
                            detail: `Place ${plan.unanchored.length > 1 ? "them" : "it"} first with "Amend Into\u2026" on the row.\n\n${plan.unanchored
                                .map(
                                    (r) =>
                                        `    ${r.path}  \u2192  would default to ${r.meta.branch}`
                                )
                                .join("\n")}`,
                        }
                    )

                const files = plan.total
                const commits = plan.groups.length
                await run("but", ["absorb"], root)
                refreshAll()
                vscode.window.showInformationMessage(
                    `Absorbed ${files} file${files > 1 ? "s" : ""} into ${commits} commit${commits > 1 ? "s" : ""}. \`but undo\` reverses it.`
                )
            } catch (e) {
                vscode.window.showErrorMessage(`but-review: ${e.message}`)
            }
        }),

        vscode.commands.registerCommand("butReview.amendInto", async (node) => {
            try {
                const root = repoRoot()
                const st = await status(root)
                // separators rather than a flat list: a workspace with several
                // stacks applied runs to hundreds of commits, and the branch is
                // how you actually find the one you want
                const picks = st.stacks.flatMap((s) =>
                    s.branches.flatMap((b) => [
                        {
                            label: b.name,
                            kind: vscode.QuickPickItemKind.Separator,
                        },
                        ...b.commits.map((c) => ({
                            label: c.message.split("\n")[0],
                            description: b.name,
                            id: c.cliId,
                        })),
                    ])
                )
                const pick = await vscode.window.showQuickPick(picks, {
                    title: `Amend ${path.basename(node.row.path)} into which commit?`,
                    matchOnDescription: true,
                    placeHolder: "Type a branch name to narrow the list",
                })
                if (!pick) return
                await run(
                    "but",
                    ["amend", "-t", pick.id, node.row.change.cliId],
                    root
                )
                refreshAll()
            } catch (e) {
                vscode.window.showErrorMessage(`but-review: ${e.message}`)
            }
        })
    )
}

module.exports = { activate }
