const resourceUrl = (path) => `/workspace/${path.split("/").map(encodeURIComponent).join("/")}`;
const imagePattern = /\.(png|jpe?g|webp|gif|svg|avif|bmp|ico)$/i;

export function initWorkspaceBrowser({ onLayoutChange = () => {} } = {}) {
  const get = (id) => document.getElementById(id);
  const panel = document.querySelector("workspace-files-panel");
  const list = get("workspace-list"), preview = get("preview-content"), feedback = get("workspace-feedback");
  let currentPath = "", selected = null, sourceMode = false, listRequest = 0, previewRequest = 0;

  async function json(url) {
    const response = await fetch(url, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Unable to load workspace.");
    return data;
  }

  async function showFile(entry, source = false) {
    selected = entry;
    sourceMode = source;
    const request = ++previewRequest;
    preview.replaceChildren();
    feedback.textContent = "";
    get("preview-name").textContent = entry.name;
    get("preview-name").title = entry.path;
    get("preview-download").hidden = false;
    get("preview-download").href = resourceUrl(entry.path);
    get("preview-download").download = entry.name;
    const html = /\.html?$/i.test(entry.name);
    const svg = /\.svg$/i.test(entry.name);
    get("preview-mode").hidden = !html && !svg;
    get("preview-mode").textContent = source ? "Preview" : "Source";
    for (const button of list.querySelectorAll("button")) button.setAttribute("aria-pressed", String(button.dataset.path === entry.path));
    if (!source && imagePattern.test(entry.name)) {
      const img = document.createElement("img");
      img.alt = entry.name;
      img.onload = () => { if (request === previewRequest) feedback.textContent = `${img.naturalWidth} × ${img.naturalHeight}`; };
      img.onerror = () => { if (request === previewRequest) feedback.textContent = "Image could not be displayed. Try downloading it."; };
      img.src = resourceUrl(entry.path);
      preview.append(img);
      return;
    }
    if (!source && html) {
      const frame = document.createElement("iframe");
      frame.title = `Preview of ${entry.name}`;
      frame.setAttribute("sandbox", "");
      frame.referrerPolicy = "no-referrer";
      frame.src = resourceUrl(entry.path);
      preview.append(frame);
      feedback.textContent = "HTML preview · scripts disabled";
      return;
    }
    feedback.textContent = "Loading preview…";
    try {
      const data = await json(`/api/workspace/file?path=${encodeURIComponent(entry.path)}`);
      if (request !== previewRequest) return;
      const pre = document.createElement("pre");
      pre.textContent = data.content;
      preview.replaceChildren(pre);
      feedback.textContent = data.truncated ? "Showing the first 256 KiB. Download for the full file." : "";
    } catch (error) { if (request === previewRequest) feedback.textContent = error.message; }
  }

  async function refresh(path = currentPath) {
    const request = ++listRequest;
    get("workspace-refresh").disabled = true;
    try {
      const data = await json(`/api/workspace?path=${encodeURIComponent(path)}`);
      if (request !== listRequest) return;
      currentPath = data.path;
      get("workspace-path").textContent = `/${currentPath}`;
      get("workspace-path").title = `/${currentPath}`;
      get("workspace-up").disabled = !currentPath;
      const fragment = document.createDocumentFragment();
      for (const entry of data.entries) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "workspace-entry";
        button.dataset.path = entry.path;
        button.title = `${entry.name}${entry.type === "file" ? ` · ${entry.size.toLocaleString()} bytes` : ""}`;
        button.setAttribute("aria-pressed", String(selected?.path === entry.path));
        const kind = document.createElement("span");
        kind.className = "file-kind";
        kind.textContent = entry.type === "directory" ? "DIR" : "FILE";
        const name = document.createElement("span");
        name.textContent = entry.name;
        button.append(kind, name);
        button.addEventListener("click", () => entry.type === "directory" ? refresh(entry.path) : showFile(entry));
        fragment.append(button);
      }
      list.replaceChildren(fragment);
      if (!data.entries.length) list.textContent = "This folder is empty.";
      feedback.textContent = data.truncated ? "Showing the first 1,000 entries." : "";
    } catch (error) { if (request === listRequest) feedback.textContent = error.message; }
    finally { if (request === listRequest) get("workspace-refresh").disabled = false; }
  }

  get("workspace-refresh").addEventListener("click", () => { void refresh(); if (selected) void showFile(selected, sourceMode); });
  get("workspace-root").addEventListener("click", () => refresh(""));
  get("workspace-up").addEventListener("click", () => refresh(currentPath.split("/").slice(0, -1).join("/")));
  get("preview-mode").addEventListener("click", () => selected && showFile(selected, !sourceMode));
  function expand(value) {
    panel.classList.toggle("is-expanded", value);
    get("workspace-expand").textContent = value ? "Restore" : "Expand";
    get("workspace-expand").setAttribute("aria-expanded", String(value));
    onLayoutChange();
  }
  get("workspace-expand").addEventListener("click", () => expand(!panel.classList.contains("is-expanded")));
  panel.querySelector("[data-panel-toggle]").addEventListener("click", () => expand(false));
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") expand(false); });
  void refresh();
  return { refresh };
}
