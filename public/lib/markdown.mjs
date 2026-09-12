import { Marked } from "/vendor/marked.mjs";
import DOMPurify from "/vendor/dompurify.mjs";

const markdown = new Marked({ gfm: true, breaks: true, async: false });

export function renderMarkdown(text) {
  const fragment = DOMPurify.sanitize(markdown.parse(String(text ?? "")), {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: ["p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em", "del",
      "blockquote", "pre", "code", "ul", "ol", "li", "a", "img", "table", "thead", "tbody", "tfoot",
      "tr", "th", "td", "input", "sup", "sub", "details", "summary"],
    ALLOWED_ATTR: ["href", "src", "alt", "title", "align", "colspan", "rowspan", "start", "type", "checked", "disabled"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
  for (const link of fragment.querySelectorAll("a[href]")) {
    try {
      const url = new URL(link.getAttribute("href"), document.baseURI);
      if (!["http:", "https:", "mailto:"].includes(url.protocol)) link.removeAttribute("href");
      else { link.target = "_blank"; link.rel = "noopener noreferrer"; }
    } catch { link.removeAttribute("href"); }
  }
  for (const image of fragment.querySelectorAll("img")) {
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
