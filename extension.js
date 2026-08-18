// Entry point: wires the providers, decorations and commands together.

const vscode = require("vscode")
const path = require("path")
const { stacksOf, status, uncommittedPlan } = require("./src/but")
const { cfg, repoRoot, run, uri } = require("./src/exec")
const { EMPTY_TREE, hunkOwners, paneRanges } = require("./src/git")
const { BASE, DECORATION, FILE, PR } = require("./src/items")
const { layoutKey, nextHunk } = require("./src/model")
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
    let refreshTimer

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

    const names = (list) => list.map((b) => `\`${b}\``).join(", ")

    // the whole-stack lens borrows its stack's tip as a ref, so `name` would
    // file every one of its files under the top branch alone
    const shown = (branch) => branch.label ?? branch.name

    // A tint over the diff's own green rather than instead of it — the alpha is
    // load-bearing, an opaque colour would erase that the line is an addition at
    // all. The ruler mark below stays the branch's own. The text is faded but
    // not recoloured: it keeps its syntax colours, because a foreign hunk is
    // still code somebody has to read.
    const foreign = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: new vscode.ThemeColor(
            "butReview.foreignHunkBackground"
        ),
        opacity: "0.6",
    })

    // The minimap already shows every change in the file, so the ruler is worth
    // more as the map of the ones that are this branch's — the same hunks F7
    // walks, so a mark is a stop. Ruler only: the pane's own colours are the
    // diff's to give. Painted only where another branch muddies the file: with
    // nothing foreign in it these would mark what the diff already marks, in one
    // flat colour over its green and red, which is worse than leaving it alone.
    const mine = vscode.window.createTextEditorDecorationType({
        overviewRulerLane: vscode.OverviewRulerLane.Full,
        overviewRulerColor: new vscode.ThemeColor("butReview.ownHunkMark"),
    })

    /** uri string -> {branch, candidates, file, ranges, own, notes, hover}; kept
     *  so open diffs can be recomputed after an absorb rather than showing stale
     *  dimming, and so F7 has the branch's own hunks to walk */
    const marked = new Map()

    /** The right-hand sides of the review diffs on screen right now. A mark
     *  belongs to that pane, not to the file: keyed by uri alone it lands in a
     *  plain editor of the same file too, opened hours later for something else
     *  entirely — dimmed lines and a hijacked F7 in a file nobody is reviewing.
     *  Active tabs only, since a backgrounded diff paints nothing. */
    const reviewPanes = () =>
        new Set(
            vscode.window.tabGroups.all
                .map((g) => g.activeTab?.input)
                .filter(
                    (i) =>
                        i instanceof vscode.TabInputTextDiff &&
                        i.original.scheme === BASE
                )
                .map((i) => i.modified.toString())
        )

    /** The review an editor is showing, if it is showing one at all. */
    const reviewFor = (editor) =>
        editor && reviewPanes().has(editor.document.uri.toString())
            ? marked.get(editor.document.uri.toString())
            : undefined

    const syncReviewing = () =>
        vscode.commands.executeCommand(
            "setContext",
            "butReview.reviewing",
            !!reviewFor(vscode.window.activeTextEditor)
        )

    const lensChanged = new vscode.EventEmitter()

    /** Everything the pane's marks are drawn from, in one call: the two hunk
     *  sets, and who put each of them there. */
    const paneState = async (root, branch, candidates, file) => {
        const [r, notes] = await Promise.all([
            paneRanges(root, branch, file).catch(() => ({
                foreign: [],
                own: [],
            })),
            hunkOwners(root, candidates, file).catch(() => []),
        ])
        const shows = [...r.foreign, ...r.own]
        return {
            ranges: r.foreign,
            own: r.own,
            // a branch can undo what one below it did, which leaves it a hunk of
            // its own over lines the pane shows as untouched — and a note there
            // names a change the reader cannot see
            notes: notes.filter((n) =>
                shows.some((x) => x.intersection(n.range))
            ),
        }
    }

    // Every entry, not just the visible ones: a backgrounded diff is painted
    // from `marked` the moment you switch back to its tab.
    const repaintOpen = async () => {
        const root = repoRoot()
        if (!root) return
        await Promise.all(
            [...marked].map(async ([key, m]) =>
                marked.set(key, {
                    ...m,
                    ...(await paneState(root, m.branch, m.candidates, m.file)),
                })
            )
        )
        paint()
    }

    const paint = () => {
        for (const editor of vscode.window.visibleTextEditors) {
            const m = reviewFor(editor)
            // unconditional: an editor that lost its entry has to be cleared
            editor.setDecorations(
                foreign,
                m
                    ? m.ranges.map((range) => ({
                          range,
                          hoverMessage: m.hover,
                      }))
                    : []
            )
            // so an unpainted ruler is itself the answer: nobody else is in here
            editor.setDecorations(mine, m?.ranges.length ? m.own : [])
        }
        // the names come from the same `marked` entries the decorations do, so
        // whatever repainted them has just changed the lenses too
        lensChanged.fire()
    }

    // A lens is invisible in a diff until `diffEditor.codeLens` is on, and it is
    // off by default — so without this the names would simply never appear, and
    // read as a feature that doesn't work. Asked once per machine, and only over
    // a file that actually has names to show.
    const askForLenses = async () => {
        const diffs = vscode.workspace.getConfiguration("diffEditor")
        if (diffs.get("codeLens") || context.globalState.get("askedCodeLens"))
            return
        context.globalState.update("askedCodeLens", true)
        const yes = "Turn it on"
        const pick = await vscode.window.showInformationMessage(
            "Hunks another branch put in this pane can be named by that branch, which VSCode shows in a diff only once `diffEditor.codeLens` is on.",
            yes
        )
        if (pick === yes)
            diffs.update("codeLens", true, vscode.ConfigurationTarget.Global)
    }

    syncVisibility()

    function refreshAll() {
        // every trigger below can arrive right after a `but` write of our own
        status.invalidate()
        tree.refresh()
        dirty.refresh()
        // A PR row's CI circle comes from `but status`, which the two views
        // above just read — so repaint it for free. `changed.fire()`, not
        // `refresh()`: the reviews and threads behind it are network, and
        // refresh() would throw that cache away.
        prs.changed.fire()
        syncVisibility()
        if (marked.size) repaintOpen()
    }

    // Triggers come in bursts — an agent writing twenty files, one `but` command
    // moving refs and index — and every refresh is a `but status`.
    const scheduleRefresh = () => {
        clearTimeout(refreshTimer)
        refreshTimer = setTimeout(refreshAll, 500)
    }

    // The built-in git extension already watches the working tree and `.git`, so
    // its status event is the one signal that covers both halves of stale: what
    // an agent or a terminal changed, and `but` operations, which rewrite the
    // workspace commit.
    async function watchGit() {
        const ext = vscode.extensions.getExtension("vscode.git")
        if (!ext) return
        const api = (await ext.activate()).getAPI(1)
        const hook = (repo) =>
            context.subscriptions.push(repo.state.onDidChange(scheduleRefresh))
        api.repositories.forEach(hook)
        // repositories is empty until git has finished scanning, which usually
        // outlasts our activation
        context.subscriptions.push(api.onDidOpenRepository(hook))
    }

    watchGit()

    context.subscriptions.push(
        // Left pane of every diff: read-only by virtue of being a content
        // provider, so edits typed there can't be silently lost.
        vscode.workspace.registerTextDocumentContentProvider(BASE, {
            provideTextDocumentContent: (u) =>
                run("git", ["show", `${u.query}:${u.path.slice(1)}`], repoRoot())
                    // a file that doesn't exist at that ref reads as empty
                    .catch(() => ""),
        }),

        // Whose hunk this is, in words, at the head of it — the one annotation
        // that gets a line of its own, since a decoration is drawn inside a line
        // box of fixed height and would overlap the code above. Served straight
        // from `marked`, so a file nobody is reviewing costs a map lookup and no
        // pane ever waits on git. A lens belongs to the document rather than the
        // editor, so the tabs are what says whether this file is being reviewed
        // at all — without that the names show in a plain editor of the same
        // file too, for as long as its review is open.
        vscode.languages.registerCodeLensProvider(
            { scheme: "file" },
            {
                onDidChangeCodeLenses: lensChanged.event,
                // A label, not a button: the empty command is what makes VSCode
                // draw it as text rather than a link. There is nothing a click
                // could do that reading the name doesn't already do — and the
                // obvious candidate, opening that branch's own review, changes
                // the title of a pane showing the same worktree file and little
                // else the eye can catch.
                provideCodeLenses: (doc) =>
                    (reviewPanes().has(doc.uri.toString())
                        ? (marked.get(doc.uri.toString())?.notes ?? [])
                        : []
                    ).map((n) => {
                        // An empty range is a deletion, which has no line of its
                        // own to sit on: the pane draws the lines that went as
                        // filler above the line that follows them, and a lens
                        // can only attach to real ones. So it goes on the line
                        // after the gap — directly under the block, rather than
                        // a line above it — and says which way it points, since
                        // that puts it on top of code it does not describe.
                        const gone = n.range.isEmpty
                        const line = Math.min(
                            gone ? n.range.start.line + 1 : n.range.start.line,
                            doc.lineCount - 1
                        )
                        const label = [n.name, n.commit]
                            .filter(Boolean)
                            .join(" · ")
                        return new vscode.CodeLens(
                            new vscode.Range(line, 0, line, 0),
                            {
                                title: gone ? `↑ deleted by ${label}` : label,
                                command: "",
                            }
                        )
                    }),
            }
        ),

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

        vscode.commands.registerCommand("butReview.openUrl", (node) =>
            vscode.env.openExternal(vscode.Uri.parse(node.url))
        ),

        vscode.commands.registerCommand("butReview.copyUrl", (node) =>
            vscode.env.clipboard.writeText(node.url)
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

        // Closing a review diff leaves the plain editor of the same file behind,
        // and it is the same editor: no visible-editor event, so without this
        // its marks would stay until something else repainted.
        vscode.window.tabGroups.onDidChangeTabs(() => {
            paint()
            syncReviewing()
        }),

        // F7 only means "next hunk of this branch" in a pane we know about;
        // everywhere else — including the read-only left pane — it keeps its
        // built-in meaning of "next difference, whoever made it".
        vscode.window.onDidChangeActiveTextEditor(syncReviewing),

        // The minimap can't be dimmed — extensions have no say over what it
        // paints — so the way past a foreign hunk is to jump over it.
        // smoke:registers butReview.nextChange butReview.prevChange
        ...[
            ["next", 1],
            ["prev", -1],
        ].map(([name, step]) =>
            vscode.commands.registerCommand(`butReview.${name}Change`, () => {
                const editor = vscode.window.activeTextEditor
                const m = reviewFor(editor)
                if (!m) return
                // a branch at the bottom of a busy stack can have every line it
                // touched rewritten above it — say so rather than sit there
                if (!m.own.length)
                    return vscode.window.setStatusBarMessage(
                        `${shown(m.branch)} — nothing here is only this branch's`,
                        2000
                    )
                const at = nextHunk(m.own, editor.selection.active.line, step)
                const range = m.own[at]
                editor.selection = new vscode.Selection(range.start, range.start)
                editor.revealRange(range, vscode.TextEditorRevealType.InCenter)
                // the count is the part the minimap was standing in for: how
                // much of this file is left to read
                vscode.window.setStatusBarMessage(
                    `${shown(m.branch)} — hunk ${at + 1} of ${m.own.length}`,
                    2000
                )
            })
        ),

        // Coming back from the app, a terminal or the browser is when you want
        // the truth — and CI is the one fact that moved while you did nothing.
        // Local only; the `gh` half still waits for the refresh button.
        vscode.window.onDidChangeWindowState(
            (state) => state.focused && scheduleRefresh()
        ),

        // Redundant with the git watcher above, but faster: it reacts to the
        // save rather than to the status read that follows it.
        vscode.workspace.onDidSaveTextDocument(scheduleRefresh),

        vscode.commands.registerCommand(
            "butReview.openFile",
            async (branch, f, alsoIn = {}) => {
                const root = repoRoot()
                const live = vscode.Uri.file(path.join(root, f.file))
                // a deleted file has no workspace side; show it against nothing
                const right =
                    f.status === "D" ? uri(BASE, f.file, EMPTY_TREE) : live

                // an entry even when nothing is foreign: `ranges` empty repaints
                // as cleared, and `own` is what F7 walks
                if (f.status !== "D") {
                    // who a note could name. `above` and `other` are who else is
                    // in the pane, so a branch's review names only what isn't
                    // its own; `members` is the whole-stack lens asking for its
                    // own hunks to be named too, which is the one review where
                    // "this is yours" is not the whole answer. A branch below is
                    // in neither list: its work is in the base, so the pane
                    // never shows it.
                    const named = new Set([
                        ...(alsoIn.above ?? []),
                        ...(alsoIn.other ?? []),
                        ...(branch.members ?? []),
                    ])
                    const candidates = stacksOf(await status(root))
                        .flatMap((s) => s.branches)
                        .filter((b) => named.has(b.name))
                    const state = await paneState(
                        root,
                        branch,
                        candidates,
                        f.file
                    )
                    if (state.notes.length) askForLenses()
                    marked.set(right.toString(), {
                        branch,
                        candidates,
                        file: f.file,
                        ...state,
                        // named the way the tree names them, so a grey line and
                        // its row agree on whose work it is
                        hover: new vscode.MarkdownString(
                            [
                                `Not part of \`${shown(branch)}\`.`,
                                alsoIn.other?.length &&
                                    `Also changed by ${names(alsoIn.other)}, in another stack.`,
                                alsoIn.above?.length &&
                                    `Continued by ${names(alsoIn.above)} above it in this stack.`,
                            ]
                                .filter(Boolean)
                                .join(" ")
                        ),
                    })
                }

                await openDiff(
                    uri(BASE, f.file, branch.base),
                    right,
                    `${path.basename(f.file)} — ${shown(branch)}`
                )
                paint()
            }
        ),

        vscode.commands.registerCommand(
            "butReview.openDirty",
            async (c, line, expand) => {
                // A collapsible row with a command runs the command rather than
                // toggling, which left the twistie as the only way to see a
                // file's hunks. The clicked row is the focused one, and it is
                // still focused until the diff opens below — so ask first.
                if (expand)
                    await vscode.commands.executeCommand("list.expand")
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

        // One row's worth of absorb. The row already names the commit it lands
        // in, so there is nothing to ask — and `but undo` reverses it.
        vscode.commands.registerCommand("butReview.absorbOne", async (node) => {
            try {
                await run("but", ["absorb", node.target.absorb], repoRoot())
                refreshAll()
                vscode.window.showInformationMessage(
                    `Absorbed ${node.target.name} into ${node.target.commit}. \`but undo\` reverses it.`
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
                    title: `Amend ${node.target.name} into which commit?`,
                    matchOnDescription: true,
                    placeHolder: "Type a branch name to narrow the list",
                })
                if (!pick) return
                await run(
                    "but",
                    ["amend", "-t", pick.id, ...node.target.args],
                    root
                )
                refreshAll()
            } catch (e) {
                vscode.window.showErrorMessage(`but-review: ${e.message}`)
            }
        }),

        // No confirmation: `but discard` is one oplog entry like the other two,
        // so the toast naming `but undo` is the safety net.
        vscode.commands.registerCommand("butReview.discard", async (node) => {
            try {
                await run("but", ["discard", ...node.target.args], repoRoot())
                refreshAll()
                vscode.window.showInformationMessage(
                    `Discarded ${node.target.name}. \`but undo\` reverses it.`
                )
            } catch (e) {
                vscode.window.showErrorMessage(`but-review: ${e.message}`)
            }
        })
    )
}

module.exports = { activate }
