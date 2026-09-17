import { workspaceLink } from "./workspace-links.mjs";
import { markdownHtml } from "./markdown-parser.mjs";

export function renderMarkdown(text) {
  const template = document.createElement("template");
  template.innerHTML = markdownHtml(text);
  const fragment = template.content;
  for (const link of fragment.querySelectorAll("a[href]")) {
    try {
      const original = link.getAttribute("href");
      const rewritten = workspaceLink(original, location.origin);
      const url = new URL(rewritten, document.baseURI);
      if (!["http:", "https:", "mailto:"].includes(url.protocol)) link.removeAttribute("href");
      else {
        link.setAttribute("href", rewritten);
        if (rewritten !== original && link.textContent === original) link.textContent = rewritten;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      }
    } catch { link.removeAttribute("href"); }
  }
  for (const image of fragment.querySelectorAll("img")) {
    if (image.hasAttribute("src")) image.setAttribute("src", workspaceLink(image.getAttribute("src"), location.origin));
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
  }
  for (const checkbox of fragment.querySelectorAll("input")) {
    checkbox.type = "checkbox";
    checkbox.disabled = true;
  }
  for (const table of fragment.querySelectorAll("table")) {
    const scroll = document.createElement("div");
    scroll.className = "markdown-table-scroll";
    scroll.tabIndex = 0;
    scroll.setAttribute("role", "region");
    scroll.setAttribute("aria-label", "Message table");
    table.replaceWith(scroll);
    scroll.append(table);
  }
  return fragment;
}
