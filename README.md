# GitButler Review

A VSCode extension for reviewing [GitButler](https://gitbutler.com) stacks — because
GitButler's workspace holds every applied branch at once, and VSCode's built-in tools
have no idea that's happening.

It answers three questions the existing tools can't:

- **What does this branch actually change**, versus the branch below it in its stack —
  in a diff you can edit.
- **Where will this uncommitted edit land**, and is that because something depends on it
  or because absorb had to guess.
- **Which of my pull requests can I merge**, given that only the bottom of a stack is
  ever mergeable.

## Why it exists

VSCode can only make a diff editable when one side is a real file on disk. GitLens can
compare any two refs, but those comparisons are read-only, and comparing the working tree
against a base shows every applied branch's changes at once. So there is no built-in way
to review one branch's diff and fix what you find in the same pane.

This extension builds that pane: left is the file as of the branch below (a read-only
content provider), right is the live workspace file. Edits land in your working tree, and
`but absorb` routes them back into the commits they belong to.

## Views

**Branches** — applied stacks, named from the `(topic)` convention in commit subjects and
sorted by recent activity. Click a file for an editable diff, or tick it off once reviewed.

Ticks are stored per repo and keyed on the file's blob SHA at the branch tip, so they
survive a reload but clear themselves as soon as the branch's version of that file
changes — absorbing an edit into a file you had already reviewed un-ticks it.

Files are shown as a flat list, or grouped by directory once there are enough of them to
warrant it. A directory holding a single file stays a plain row rather than becoming a group you
have to expand. Otherwise a group's label is the directory's last segment with the parent
in grey beside it — in a monorepo the part that tells directories apart sits at the end of a long
shared prefix, and the panel clips from the end.

Layout is chosen per branch — an icon on the branch row, or its context menu — so a
sprawling refactor can be grouped while a three-file fix stays a list. `butReview.fileLayout` sets the default
for branches you haven't chosen for.

Because the right-hand pane is the *workspace* file rather than the branch tip, other
applied branches can contribute hunks to it. Those lines are dimmed with a left rail and
ruler marks, and files carrying them are flagged in the tree.

**Uncommitted** — appears only when the tree is dirty. Groups edits by the commit absorb
will amend them into, with a separate **Unanchored** section for changes nothing depends
on. Absorb is blocked until those are placed explicitly, because absorb would otherwise
drop them in the primary lane silently, on whatever branch happens to be first.

**Pull Requests** — grouped by stack, which is the thing GitHub's own extension can't show.
One `gh pr list` call. Review state is computed from the full review history rather than
`latestReviews`, and bot reviews are excluded.

## Install

```sh
git clone https://github.com/sophiamersmann/gitbutler-review
ln -s "$PWD/gitbutler-review" ~/.vscode/extensions/but-review
```

Then reload the window. Requires the [`but`](https://docs.gitbutler.com/cli-overview) CLI,
`git`, and `gh` for the pull request view.

**macOS-specific:** a Dock-launched VSCode doesn't inherit your shell `PATH`, so the
extension prepends `/opt/homebrew/bin` and `/usr/local/bin` when spawning subprocesses.
On Linux or Windows that prepend is harmless but you may need to adjust it if `but`
or `gh` live elsewhere.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `butReview.ignoredChecks` | `[]` | CI checks to exclude from a branch's status, matched as case-insensitive substrings. Useful for a slow or flaky job you never act on. |
| `butReview.botReviewers` | Codex, github-actions, Copilot | Reviewers whose approvals don't count. Logins ending in `[bot]` are always ignored; Codex reviews as `chatgpt-codex-connector`, with no such suffix, which is why this list exists. |
| `butReview.fileLayout` | `auto` | `list`, `group`, or `auto` — a flat list below 10 changed files, grouped by directory above. Overridable per branch from its context menu. |
| `butReview.demoteBranches` | `["docs"]` | Stacks whose every branch matches one of these tokens sort to the bottom regardless of activity. |

Five theme colours are contributed under `butReview.*` if you want to retune the icons or
the dimming.

## Development

```sh
node smoke.js
```

Builds every tree row against your live GitButler workspace with a stubbed `vscode`
module. It has caught two runtime-only faults that `node --check` passed clean, so run it
after touching any of the item builders.

There is no build step — it's plain JS loaded directly.

**Reloading:** `Developer: Reload Window` re-reads `extension.js`; the version number does
not need bumping. The **icon** is the exception — Electron caches it by path, so changing
`icon-*.svg` requires renaming the file and updating the manifest.

## Licence

MIT
