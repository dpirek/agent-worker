import fs from "node:fs/promises";
import path from "node:path";

const TEXT_LIMIT = 256 * 1024;
const fail = (message, statusCode) => Object.assign(new Error(message), { statusCode });

async function resolveWorkspaceEntry(root, requested = "") {
  if (requested.includes("\0") || requested.includes("\\") || path.isAbsolute(requested)
    || requested.split("/").includes("..")) throw fail("Invalid workspace path.", 403);
  const realRoot = await fs.realpath(root);
  let target;
  try { target = await fs.realpath(path.join(realRoot, requested)); }
  catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) throw fail("File not found.", 404);
    throw error;
  }
  const relative = path.relative(realRoot, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw fail("Path is outside the workspace.", 403);
  }
  return target;
}

export async function listWorkspace(root, requested = "") {
  const target = await resolveWorkspaceEntry(root, requested);
  if (!(await fs.stat(target)).isDirectory()) throw fail("Not a folder.", 400);
  const entries = [];
  // Bound the response and avoid following symlinks in the directory listing.
  const directory = await fs.opendir(target);
  let truncated = false;
  for await (const entry of directory) {
    if (!entry.isDirectory() && !entry.isFile()) continue;
    if (entries.length === 1000) { truncated = true; break; }
    const relative = path.posix.join(requested, entry.name);
    try {
      const stat = await fs.stat(path.join(target, entry.name));
      entries.push({ name: entry.name, path: relative, type: entry.isDirectory() ? "directory" : "file",
        size: entry.isFile() ? stat.size : null, modifiedAt: stat.mtime.toISOString() });
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.type === "directory" ? -1 : 1));
  return { ok: true, path: requested, entries, truncated };
}

export async function readWorkspaceText(root, requested) {
  const target = await resolveWorkspaceEntry(root, requested);
  const handle = await fs.open(target, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw fail("Not a file.", 400);
    const buffer = Buffer.alloc(Math.min(stat.size, TEXT_LIMIT));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) throw fail("This binary file has no text preview. Download it to open locally.", 415);
    return { ok: true, path: requested, content: bytes.toString("utf8"), truncated: stat.size > TEXT_LIMIT };
  } finally { await handle.close(); }
}
