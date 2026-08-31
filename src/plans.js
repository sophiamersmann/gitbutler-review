// Everything asked of the plans directory: which plans are there, what each one
// says, and which of a directory plan's files are its phases. Filesystem only,
// so a fixture is enough to drive it.

const fs = require("fs/promises")
const path = require("path")
const { cfg } = require("./exec")
const { isHeaderLine, planBranches, planName, planPreview, planStages, planTasks, planTitle } = require("./model")

// A plan directory's index, in the order a directory is looked at for one
const OVERVIEW = ["overview.md", "README.md"]

/** file -> {mtimeMs, entry}. Rebuilt from the files a listing actually saw, so
 *  a deleted plan doesn't sit in it for the rest of the session. */
let parsed = new Map()

const plansDir = (root) => {
    const dir = cfg().get("plansDirectory", "plans")
    return dir ? path.join(root, dir) : undefined
}

/** The plans directory, or undefined when there isn't one — which is also what
 *  hides the view. */
async function plansRoot(root) {
    const dir = plansDir(root)
    if (!dir) return undefined
    try {
        return (await fs.stat(dir)).isDirectory() ? dir : undefined
    } catch {
        return undefined
    }
}

/** Every plan, newest first. A markdown file is a plan; so is a directory, as
 *  one plan and not one row per phase. */
async function listPlans(root) {
    const dir = await plansRoot(root)
    if (!dir) return []
    const seen = new Map()
    const entries = await fs.readdir(dir, { withFileTypes: true })
    const plans = await Promise.all(
        entries
            .filter(
                (e) =>
                    !e.name.startsWith(".") &&
                    (e.isDirectory() || e.name.endsWith(".md"))
            )
            .map((e) =>
                e.isDirectory()
                    ? directoryPlan(dir, e.name, seen)
                    : filePlan(dir, e.name, seen)
            )
    )
    parsed = seen
    // mtime, not the date in the name: the convention keeps a plan's original
    // date across every revision, so the name says when it was started
    return plans.filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/** One markdown file, parsed. Re-read only when its mtime moves — a 66KB plan
 *  should not be parsed again because a sibling changed. */
async function read(file, seen) {
    const { mtimeMs } = await fs.stat(file)
    const hit = parsed.get(file)
    const entry = hit?.mtimeMs === mtimeMs ? hit.entry : await parse(file)
    seen.set(file, { mtimeMs, entry })
    const name = path.basename(file)
    return { ...entry, title: entry.heading ?? planName(name), name, file, mtimeMs }
}

async function parse(file) {
    const text = await fs.readFile(file, "utf8")
    return {
        heading: planTitle(text),
        branches: planBranches(text),
        tasks: planTasks(text),
        preview: planPreview(text),
    }
}

// A file that vanished between the listing and the read is not a plan any more,
// and the caller drops what comes back empty
const missing = () => undefined

const filePlan = (dir, name, seen) =>
    read(path.join(dir, name), seen)
        .then((entry) => ({
            ...entry,
            path: entry.file,
            mtime: iso(entry.mtimeMs),
            stages: [],
            docs: [],
        }))
        .catch(missing)

async function directoryPlan(dir, name, seen) {
    try {
        const at = path.join(dir, name)
        const children = (
            await Promise.all(
                (await fs.readdir(at))
                    .filter((f) => f.endsWith(".md"))
                    .map((f) => read(path.join(at, f), seen).catch(missing))
            )
        ).filter(Boolean)
        if (!children.length) return undefined
        const overview =
            OVERVIEW.map((f) => children.find((c) => c.name === f)).find(
                Boolean
            ) ?? children[0]
        // the directory's own mtime moves only when a file is added or removed,
        // so what says a plan was worked on is the newest thing in it
        const mtimeMs = Math.max(...children.map((c) => c.mtimeMs))
        return {
            name,
            file: overview.file,
            // the whole plan on disk, which for a directory is not the file the
            // row opens
            path: at,
            mtimeMs,
            mtime: iso(mtimeMs),
            // the directory names the plan, not whichever file indexes it
            title: overview.heading ?? planName(name),
            branches: overview.branches,
            tasks: overview.tasks,
            preview: overview.preview,
            ...planStages(overview.tasks, children, overview.name),
        }
    } catch {
        return undefined
    }
}

const iso = (ms) => new Date(ms).toISOString()

/** Insert or replace the `Branch:` line under a plan's title. Only the `Branch:`
 *  segment of a one-line `Branch: … · Base: …` header is rewritten, so the rest
 *  of what a review-findings plan puts there survives. */
async function writePlanLink(file, branches) {
    const lines = (await fs.readFile(file, "utf8")).split("\n")
    const line = `Branch: ${branches.join(", ")}`
    const start = headerStart(lines)
    const block = []
    for (let at = start; at < lines.length && lines[at].trim(); at++) block.push(at)
    const header = block.length > 0 && block.every((at) => isHeaderLine(lines[at]))
    const branchAt = header
        ? block.find((at) => lines[at].startsWith("Branch:"))
        : undefined
    if (branchAt !== undefined) {
        const segments = lines[branchAt].split("\u00b7")
        segments[0] = `${line} `
        lines[branchAt] = segments.join("\u00b7").trimEnd()
    } else if (header) lines.splice(start, 0, line)
    else lines.splice(start, 0, line, "")
    await fs.writeFile(file, lines.join("\n"))
}

/** Where a header sits: under the title and the blank line below it, or at the
 *  top of a plan that has no title. */
function headerStart(lines) {
    const title = lines.findIndex((line) => /^#\s+\S/.test(line))
    if (title === -1) return 0
    let at = title + 1
    while (at < lines.length && !lines[at].trim()) at++
    return at
}

/** A plan for a branch, named by its title. Returns the file whether it wrote it
 *  or found it already there, so clicking twice ends with one plan and not with
 *  the first one emptied. */
async function createPlan(root, title, branch) {
    const dir = plansDir(root)
    const day = new Date().toISOString().slice(0, 10)
    const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
    const file = path.join(dir, `${day}-${slug}.md`)
    const body = branch ? `# ${title}\n\nBranch: ${branch}\n` : `# ${title}\n`
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(file, body, { flag: "wx" }).catch((e) => {
        if (e.code !== "EEXIST") throw e
    })
    return file
}

module.exports = { createPlan, listPlans, plansRoot, writePlanLink }
