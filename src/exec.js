// Subprocess plumbing and the handful of helpers everything else needs.

const vscode = require("vscode")
const { execFile } = require("child_process")

function run(cmd, args, cwd) {
    return new Promise((resolve, reject) =>
        execFile(
            cmd,
            args,
            {
                cwd,
                maxBuffer: 64 * 1024 * 1024,
                // a Dock-launched VSCode doesn't get homebrew or /usr/local on PATH
                env: {
                    ...process.env,
                    PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`,
                },
            },
            (err, stdout) => (err ? reject(err) : resolve(stdout))
        )
    )
}

// Resolved per call, not at activation — an activation-time throw would stop the
// commands from ever registering, which looks exactly like "nothing happens".
const repoRoot = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath

const cfg = () => vscode.workspace.getConfiguration("butReview")

// from(), not parse(): a path containing # or ? would otherwise be reparsed as
// a fragment or query, losing both the status letter and the path
const uri = (scheme, file, query) =>
    vscode.Uri.from({ scheme, path: `/${file}`, query })

/** Coarse on purpose: "3d ago" is what separates live work from stale, and a
 *  scan never needs more precision than that. */
function ago(iso) {
    const days = Math.round((Date.now() - new Date(iso)) / 86400000)
    if (days < 1) return "today"
    if (days < 30) return `${days}d ago`
    return `${Math.round(days / 30)}mo ago`
}

module.exports = { run, repoRoot, cfg, uri, ago }
