// Saved messages may contain the worker's local listen address. Workspace
// resources in this console should use the origin the reader can reach.
export function workspaceLink(value, currentOrigin) {
  try {
    const url = new URL(value, currentOrigin);
    const local = ["localhost", "0.0.0.0", "[::1]", "[::]"].includes(url.hostname)
      || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
    if (!local || !["http:", "https:"].includes(url.protocol) || url.username || url.password
      || !(url.pathname === "/workspace" || url.pathname.startsWith("/workspace/"))) return value;
    return new URL(`${url.pathname}${url.search}${url.hash}`, currentOrigin).href;
  } catch { return value; }
}
