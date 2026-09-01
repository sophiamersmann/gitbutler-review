# GitButler Review

A VSCode extension for reviewing [GitButler](https://gitbutler.com) stacks. GitButler
applies every active branch to the working tree at once, which the built-in Git tooling
doesn't account for.

It covers four things:

- **Reviewing one branch's diff** against the branch below it in its stack, in a pane you
  can edit. Or the whole stack at once, against the target branch.
- **Placing uncommitted edits**, so you can see where each one will end up before
  committing, and catch the ones that would land somewhere arbitrary.
- **Tracking your pull requests** across stacks, with one status per PR combining CI,
  review decision, and unresolved threads.
- **Finding the plan you are working from**, in a directory the rest of VSCode can't see.

## Why it exists

VSCode can only make a diff editable when one side is a real file on disk. GitLens can
compare any two refs, but those comparisons are read-only, and comparing the working tree
against a base shows every applied branch's changes at once. There's no built-in way to
review one branch's diff and fix what you find in the same pane.

This extension builds that pane: on the left, the file as of the branch's base, read-only;
on the right, the live workspace file. Edits go to your working tree, and `but absorb`
routes them back into the commits they belong to.

## Views

Two activity-bar icons: **GitButler Review** holds Branches, Plans and Changes — the views
you move between while reviewing — and **Pull Requests** is its own icon, since tracking a
PR is a different sitting from reviewing a branch.

### Branches

Applied stacks, sorted by recent activity, with each branch row showing its CI summary
and age. A stack is named from the `(topic)` convention in commit subjects, falling back
to the common prefix of its branch names. Click a file to open the diff, or tick it off
once reviewed.

**A branch opens with its plan**, above the commits and the files: the plan the branch is,
or the phase of one it is, drawn as the Plans view draws it and clicking through to the same
file. A branch that carries two phases gets a row each, in the order its plan lists them. It
comes from the `Branch:` line documented under [Plans](#plans), which is also what
`Link plan…` on the branch row writes for you. Most branches have no plan and get no row.

Ticks are stored per repo and survive a reload, but clear as soon as the branch's version
of a file changes — absorbing an edit into a file you'd already reviewed un-ticks it.

Files are shown as a folder tree, or as a flat list where that reads better, chosen per
branch from an icon on the branch row (`butReview.fileLayout` sets the default). The tree
nests properly, folders
before files at each level, and files at the repo root are the last rows — the level
they're on says where everything lives, so no row has to spell it out.

Folders arrive expanded, since a branch's files were all on screen the moment you opened
it and hiding them behind clicks would cost more than the folders are worth. A directory
whose only child is a directory is one row, `packages/@ourworldindata/grapher/src`, the
way VSCode's explorer compacts them: five clicks to reach a monorepo's source is a tree
being worse than the list it replaced. Collapse what you like — each folder row is
addressed by branch and path, so it stays collapsed across a refresh.

Folders tick too, and ticking one ticks every file under it. The box holds no state of its
own: it reads ticked exactly while all of its files do, so editing any one of them unticks
the folder and every folder above it, for the same reason it unticks the file. A checkbox
has no third state, so a part-reviewed folder says `4/7 reviewed` where it would otherwise
say `7 files` — with the folder collapsed that count is the only thing that can tell you
the other four are still done.

**N commits** and **N files** are what a branch holding more than one commit expands to: its
two readings of the same diff, one open at a time. The files row is the open one to begin
with, and holds exactly what a branch has always held. Open the commits row and the files
row folds — it stays where it is with its count on it, and every file it held is in there,
under the commit that wrote it. Expanding a commit shows the files that commit changed, as a
list or a tree exactly as the branch shows its own; the layout toggle stays on the branch
row and governs both readings. Commits open one at a time too, so a branch's files are never
spread across two of them. A commit's diff runs against the commit below it, so it holds
nothing from any other branch and nothing uncommitted, and its ticks are counted apart from
the branch's: one commit's slice of a file isn't the branch's diff of it. Rows are keyed on
GitButler's change ID rather than the SHA, so a reword or a rebase leaves your ticks and
your open rows where they were. A branch of one commit gets neither row — one commit is one
reading, and its files are the branch's files.

**All N branches** sits above the branches of a multi-branch stack. It's the same review,
but of the stack as a single diff — what the target branch gets once all of it lands,
which per-branch review doesn't show. A helper added in one branch and called three above
it looks fine in both branch diffs; debug code added in the second branch and removed in
the fourth shows up in two branch diffs and in neither of these. Files touched by more
than one branch of the stack are marked `in 3 branches`. Its ticks are kept separate from
the branch rows', since a shared file's stack diff isn't the same as any one branch's
diff of it.

#### Lines from other branches

Because the right-hand pane is the workspace file, other applied branches can contribute
lines to it. Those lines are dimmed with a left rail, and files containing them get the
warning colour in the tree.

Only some are named, because the two cases differ. A branch **above in the same stack** is
your own later work, already rebased onto this branch and landing after it, so the colour
is enough. A branch in **another stack** is parallel work on the same lines, so that row
also says `⚠ also in <branch>`. Either way the tooltip spells it out. A branch *below*
isn't flagged at all: its changes are already in this branch's base, so they don't appear
in the diff.

In files with foreign lines, the overview ruler marks the hunks that belong to the branch
under review, so a painted ruler means the file is shared. **F7** and **Shift+F7** step
through those hunks, skipping the rest and wrapping at either end, with the branch and
position in the status bar (`hunk 3 of 7`). Outside a review diff the keys keep their
built-in meaning. If every line the branch touched has been rewritten above it, the keys
report that instead.

### Plans

The markdown files in `plans/`, the work in flight at the top and the rest newest first. It
exists because that directory is invisible to everything else: `plans/` is gitignored,
VSCode's search skips ignored files by default, so a plan is in neither the Source Control
view nor Ctrl+Shift+F.

Rows are titled by the plan's own `#` heading rather than its filename, so
`2026-08-25-legend-emphasis-props.md` reads "Make emphasis a legend render prop, drop the
observer decorator from the legends". The tooltip carries its opening paragraph, which is
most of what tells two plans on the same topic apart.

**A plan whose branch is applied is pinned to the top**, in the order the Branches view
puts those branches in, and says that branch where it would otherwise say its age. That is
the whole of what the `Branch:` line below buys, and it is derived: a plan is live because a
branch it names is applied right now, so merging a branch unpins its own plan with nothing
to update. Clicking a pinned plan opens the phase you are on rather than line 1 of a
476-line overview.

**Then every other plan, newest first.** The list is flat: how far through a plan is shows
in its `11/13` rather than in which folder it sits under, so nothing has to be filed anywhere
and text search is the way into the tail of it. An applied branch outranks the ordering — a
live plan is pinned whatever its ticks say.

Newest is by mtime, which is not the date in the filename: the convention keeps a plan's
original date across every revision, so the name says when the work started and the mtime
says when you last touched it. A directory plan is dated by the newest file in it, since the
directory's own mtime moves only when a file is added or removed. The hazard is that a copy
resets mtime wholesale — 25 of the 54 plans this was written against share one — so a
freshly copied plan sorts above one you are mid-way through.

**The `Branch:` line is the whole convention.** One line under a plan's title, naming the
GitButler branch the work lands on, comma-separated for more than one:

```markdown
# Bespoke metadata box, optional provenance

Branch: bespoke-metadata-box, share-metadata-box-parts
```

In a plan directory it goes in the **stage file**, under that file's own title, because a
13-phase plan is usually several branches and the phase is the level a branch corresponds
to. The overview needs nothing added. `Branch: … · Base: … · Started: …` on one line works
too, which is what the review-findings plans already write. Nothing guesses: matching a
plan's filename against 890 branch names found 2 that were right and several that were
confidently wrong, so an unlinked plan simply sorts by recency as it always did.

`go` and `gooo` write the line as each phase lands. Otherwise `Link plan…` on a branch row
picks the plan, `Link plan…` on a plan or phase row picks the branch, and `New plan…` on a
branch row starts one already linked. The picker puts the closest filename first under a
separator that says it is a guess.

A **directory is one plan**, not a row per file. It takes its title and its phases from
`overview.md` or `README.md`, where a phase is a `.md` file the overview links to, in the
order it links them, ticked by the `- [x]` that links it:

```markdown
## Phases

- [x] [Phase 1: the `BespokeMetadata` type](phase-1-type.md)
- [ ] [Phase 11: the ETL export step](phase-11-etl-step.md)
```

So `11/13` on the row is the overview's own count, and no convention had to be invented to
read it. Files the overview never links — `testing.md`, `design-fixes.md` — come after the
phases without a tick: documents in the plan rather than phases of it.

A single-file plan writes the same thing as a plain checklist, and expands to it the same
way. A plan that lists no phases has no children at all: its `##`s are the shape of the
document rather than the shape of the work, and a row per section is a table of contents
nobody asked for. Checklists quoted inside fenced code blocks aren't counted either — plans
about plans would otherwise be full of somebody else's phases.

Clicking a plan opens its file **and** its phases. They are half of what the row is for,
and a click that opened only the document left them behind the twistie; the twistie still
closes the row again.

**Delete Plan**, on hover, takes a directory plan as the whole directory. It goes to the trash rather than being unlinked — `plans/` is gitignored,
so no history could give one back — and the trash is why it doesn't stop to ask.

Nothing here writes to your files unless you ask it to, which is why the ticks are icons
rather than checkboxes: ticking one would mean writing `- [x]` back into a file an agent may
be editing in the same second, and for a directory plan, writing to the overview from a row
rendered out of it.

The view is hidden unless the directory exists, and `butReview.plansDirectory` says which
one to look for.

### Changes

Shown only when the tree is dirty, and read top-down as the absorb plan itself: **branch →
file → hunk**. Each top-level row is a branch of yours and under it every file it would
absorb, listed once. Branches are listed in the same order as the Branches view. Clicking
a row opens the diff at the first line it changes.

The branch is the level worth reading, which is why there is no commit level: the branch
row says how many commits its edits split across, and each file row's tooltip names the
one it lands in. A level of commit rows in between listed every file twice — once under
the commit and once under the branch — for a mapping you rarely need.

Rows carry the actions that fit them — **Absorb** to put a change where the plan says,
**Amend Into…** to pick the commit yourself, **Discard** to throw it away. All three are
one `but` call, and all three are one oplog entry, so `but undo` reverses any of them.
Only Absorb is a hover button; the other two are on the right-click menu, since a
destructive action shouldn't sit one pixel from the one you reach for every time.

Each row is addressed by its GitButler CLI ID, so a hunk row acts on exactly that hunk.
The exception is a file whose hunks lock to two different commits: it gets a row per
commit, each saying `2 of 3 hunks`, and those rows act on the hunks they show rather than
on the file — otherwise discard would take changes the row doesn't list.

A file with more than one hunk expands into them, but only when you click the twistie —
clicking the row itself opens the diff and leaves the tree alone. The hunk rows exist for
acting on part of a file, which nothing else in VSCode can do; for reading, the pane the
row opens shows the same hunks and F7 walks them.

Edits that no commit depends on go in an **Unplaced** section at the bottom, with their
files directly under it — they have no branch, which is the whole point of the section.
Left alone they'd be filed under an arbitrary branch, so absorbing the view refuses while
any exist, listing them and pointing at **Amend Into…** — a button that explains itself
beats one that quietly isn't there. With only one branch applied there's nowhere else they
could go, so the section doesn't appear.

### Pull Requests

Its own icon in the activity bar. Your open PRs grouped by stack, bottom-first, since the
branch nearest the target lands next. GitHub's own extension can't group them this way, as
it doesn't know about stacks.

Each row gets one circle, ordered by how much it needs from you:

| | |
| --- | --- |
| 🔴 | CI failing, changes requested, or conflicts with the base |
| 🟠 | approved, but threads still unresolved |
| 🟡 | CI running |
| 🔵 | review requested |
| 🟢 | approved |
| ⚪ | nothing pending |

An approval still counts as one after the reviewer leaves a later comment, which is not
how `gh` reports it by default. Bot reviews don't count, and the unresolved-thread count
ignores bots and your own comments. Conflicts and thread resolution both come from one
GraphQL call, the only place either is exposed; GitHub computes the merge state
asynchronously and says it doesn't know until it has, which reads here as no conflict
rather than reddening a PR you just opened.

PR data is fetched when the view first opens and when you press its refresh button,
nothing else — it's the only part that touches the network. CI status is read locally, so
it also updates when the window regains focus.

## Install

```sh
git clone https://github.com/sophiamersmann/gitbutler-review
ln -s "$PWD/gitbutler-review" ~/.vscode/extensions/but-review
```

Then reload the window. Requires the [`but`](https://docs.gitbutler.com/cli-overview) CLI,
`git`, and `gh` for the pull request view.

**macOS-specific:** a Dock-launched VSCode doesn't inherit your shell `PATH`, so the
extension prepends `/opt/homebrew/bin` and `/usr/local/bin` when spawning subprocesses.
On Linux or Windows that prepend is harmless, but you may need to adjust it if `but` or
`gh` live elsewhere.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `butReview.ignoredChecks` | `[]` | CI checks to exclude from a branch's status, matched as case-insensitive substrings. Useful for a slow or flaky job you never act on. |
| `butReview.botReviewers` | `chatgpt-codex-connector`, `github-actions`, `copilot-pull-request-reviewer` | Reviewers whose approvals and comments don't count. Logins ending in `[bot]` are always ignored; Codex has no such suffix, hence this list. |
| `butReview.fileLayout` | `tree` | `list` or `tree`. Overridable per branch from the branch row. |
| `butReview.plansDirectory` | `plans` | Where plan files live, relative to the repo root. Empty hides the Plans view. |
| `butReview.demoteBranches` | `["docs", "debug"]` | Stacks whose every branch matches one of these hyphen-separated tokens sort to the bottom regardless of activity. |

Seven theme colours are contributed under `butReview.*` for retuning the icons, the
dimming, and the ruler mark.

## Development

```sh
node smoke.js
```

It first cross-checks the manifest against the code: every declared command is
registered, every menu reference resolves, every setting and theme colour read in code is
declared, the container icon exists. None of that is visible to JS testing — a command
declared but never registered renders as a working button bound to nothing.

It then builds every tree row against your live GitButler workspace with a stubbed
`vscode` module. The plans rows are the exception — they build against a temporary fixture,
since they need no workspace and this repo keeps no `plans/` of its own, which is why that
section runs first. This has caught a TDZ crash, a whole view deleted by a bad edit, hunk
parsing broken by `diff.external`, and a dead absorb button, none of which `node --check`
saw. Run it after any change.

There is no build step — it's plain JS loaded directly.

```
extension.js      wiring: providers, decorations, commands
src/exec.js       subprocess plumbing
src/git.js        everything asked of git
src/but.js        everything asked of the `but` and `gh` CLIs
src/plans.js      everything asked of the plans directory
src/model.js      pure derivations — CI, reviews, stack names, layout
src/items.js      every TreeItem the views render
src/trees.js      the three TreeDataProviders
```

Dependencies point one way, `exec` at the bottom and `extension` at the top.

**Reloading:** `Developer: Reload Window` re-reads `extension.js`; the version number
doesn't need bumping. The icon is the exception — Electron caches it by path, so changing
`icon-*.svg` means renaming the file and updating the manifest.

## Licence

MIT
