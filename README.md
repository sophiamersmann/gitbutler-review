# GitButler Review

A VSCode extension for reviewing [GitButler](https://gitbutler.com) stacks. GitButler
applies every active branch to the working tree at once, which the built-in Git tooling
doesn't account for.

It covers three things:

- **Reviewing one branch's diff** against the branch below it in its stack, in a pane you
  can edit. Or the whole stack at once, against the target branch.
- **Placing uncommitted edits**, so you can see where each one will end up before
  committing, and catch the ones that would land somewhere arbitrary.
- **Tracking your pull requests** across stacks, with one status per PR combining CI,
  review decision, and unresolved threads.

## Why it exists

VSCode can only make a diff editable when one side is a real file on disk. GitLens can
compare any two refs, but those comparisons are read-only, and comparing the working tree
against a base shows every applied branch's changes at once. There's no built-in way to
review one branch's diff and fix what you find in the same pane.

This extension builds that pane: on the left, the file as of the branch's base, read-only;
on the right, the live workspace file. Edits go to your working tree, and `but absorb`
routes them back into the commits they belong to.

## Views

### Branches

Applied stacks, sorted by recent activity, with each branch row showing its CI summary
and age. A stack is named from the `(topic)` convention in commit subjects, falling back
to the common prefix of its branch names. Click a file to open the diff, or tick it off
once reviewed.

Ticks are stored per repo and survive a reload, but clear as soon as the branch's version
of a file changes — absorbing an edit into a file you'd already reviewed un-ticks it.

Files are shown as a flat list or grouped by directory, chosen per branch from an icon on
the branch row (`butReview.fileLayout` sets the default). A directory holding a single
file stays a plain row instead of a group you have to expand, and so do files at the repo
root — they sort above the folders rather than hiding under one called `.`.

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

Your open PRs grouped by stack, bottom-first, since the branch nearest the target lands
next. GitHub's own extension can't group them this way, as it doesn't know about stacks.

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
| `butReview.fileLayout` | `list` | `list` or `group`. Overridable per branch from the branch row. |
| `butReview.demoteBranches` | `["docs"]` | Stacks whose every branch matches one of these hyphen-separated tokens sort to the bottom regardless of activity. |

Six theme colours are contributed under `butReview.*` for retuning the icons, the
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
`vscode` module. This has caught a TDZ crash, a whole view deleted by a bad edit, hunk
parsing broken by `diff.external`, and a dead absorb button, none of which `node --check`
saw. Run it after any change.

There is no build step — it's plain JS loaded directly.

```
extension.js      wiring: providers, decorations, commands
src/exec.js       subprocess plumbing
src/git.js        everything asked of git
src/but.js        everything asked of the `but` and `gh` CLIs
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
