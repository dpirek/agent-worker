// A deliberately limited Markdown renderer. Raw HTML is always text, and only
// renderer-owned tags and validated URL attributes can enter the resulting HTML.
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

function safeUrl(value, image = false) {
  try {
    const url = new URL(value, 'https://markdown.invalid/');
    return (image ? ['http:', 'https:'] : ['http:', 'https:', 'mailto:']).includes(url.protocol);
  } catch { return false; }
}

function inline(text, depth = 0, inLink = false) {
  if (depth > 24) return escapeHtml(text);
  let html = '';
  for (let i = 0; i < text.length;) {
    const rest = text.slice(i);
    let match;
    if ((match = /^\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/.exec(rest))) {
      html += escapeHtml(match[1]);
    } else if ((match = /^(`+)([\s\S]*?[^`])\1(?!`)/.exec(rest))) {
      html += `<code>${escapeHtml(match[2].replace(/\n/g, ' '))}</code>`;
    } else if (!inLink && (match = /^(!?)\[([^\]\n]*)\]\(\s*(<[^>\n]*>|(?:[^\s()]|\([^()]*\))*)(?:\s+"([^"]*)")?\s*\)/.exec(rest))) {
      const image = Boolean(match[1]);
      const url = match[3].replace(/^<|>$/g, '');
      const title = match[4] === undefined ? '' : ` title="${escapeHtml(match[4])}"`;
      if (!safeUrl(url, image)) html += escapeHtml(image ? match[2] : match[0]);
      else if (image) html += `<img src="${escapeHtml(url)}" alt="${escapeHtml(match[2])}"${title}>`;
      else html += `<a href="${escapeHtml(url)}"${title}>${inline(match[2], depth + 1, true)}</a>`;
    } else if (!inLink && (match = /^<(https?:\/\/[^\s<>]+|mailto:[^\s<>]+)>/.exec(rest))) {
      html += `<a href="${escapeHtml(match[1])}">${escapeHtml(match[1])}</a>`;
    } else if (!inLink && (match = /^https?:\/\/[^\s<>]+/.exec(rest))) {
      match[0] = match[0].replace(/[.,!?;:]+$/, '');
      while (match[0].endsWith(')') && (match[0].match(/\)/g) || []).length > (match[0].match(/\(/g) || []).length) match[0] = match[0].slice(0, -1);
      html += `<a href="${escapeHtml(match[0])}">${escapeHtml(match[0])}</a>`;
    } else if ((match = /^(\*\*\*|___|\*\*|__|~~|\*|_)(?=\S)([\s\S]*?\S|\S)\1/.exec(rest)) && !(match[1].includes('_') && /\w/.test(text[i - 1] || ''))) {
      const tag = match[1] === '~~' ? 'del' : match[1].length === 1 ? 'em' : 'strong';
      const body = inline(match[2], depth + 1, inLink);
      html += `<${tag}>${match[1].length === 3 ? `<em>${body}</em>` : body}</${tag}>`;
    } else {
      html += text[i] === '\n' ? '<br>' : escapeHtml(text[i]);
      i++;
      continue;
    }
    i += match[0].length;
  }
  return html;
}

const listItem = line => /^( *)([-+*]|\d+[.)])\s+(.*)$/.exec(line);
const rule = line => /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line);
const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim());
const tableDivider = line => cells(line).every(cell => /^:?-{3,}:?$/.test(cell));
const blockStart = line => /^ {0,3}(?:#{1,6}\s|`{3,}|~{3,}|>)/.test(line) || rule(line) || Boolean(listItem(line));

function blocks(lines, depth = 0) {
  if (depth > 24) return `<p>${escapeHtml(lines.join('\n'))}</p>`;
  let html = '';
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    let match;
    if (!line.trim()) { i++; continue; }
    if ((match = /^ {0,3}(`{3,}|~{3,})[^\n]*$/.exec(line))) {
      const fence = match[1];
      const code = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(lines[i])) code.push(lines[i++]);
      if (i < lines.length) i++;
      html += `<pre><code>${escapeHtml(code.join('\n'))}${code.length ? '\n' : ''}</code></pre>`;
    } else if ((match = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line))) {
      html += `<h${match[1].length}>${inline(match[2])}</h${match[1].length}>`;
      i++;
    } else if (i + 1 < lines.length && /^ {0,3}(?:=+|-+)\s*$/.test(lines[i + 1])) {
      const level = lines[i + 1].trim()[0] === '=' ? 1 : 2;
      html += `<h${level}>${inline(line)}</h${level}>`;
      i += 2;
    } else if (rule(line)) {
      html += '<hr>'; i++;
    } else if (/^ {0,3}>/.test(line)) {
      const quote = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) quote.push(lines[i++].replace(/^ {0,3}> ?/, ''));
      html += `<blockquote>${blocks(quote, depth + 1)}</blockquote>`;
    } else if ((match = listItem(line))) {
      const ordered = /^\d/.test(match[2]);
      const indent = match[1].length;
      const tag = ordered ? 'ol' : 'ul';
      html += `<${tag}${ordered ? ` start="${parseInt(match[2], 10)}"` : ''}>`;
      while (i < lines.length) {
        const item = listItem(lines[i]);
        if (!item || item[1].length !== indent || /^\d/.test(item[2]) !== ordered) break;
        const contentIndent = item[0].length - item[3].length;
        const content = [item[3]];
        i++;
        while (i < lines.length) {
          if (!lines[i].trim()) {
            let next = i + 1;
            while (next < lines.length && !lines[next].trim()) next++;
            if (next >= lines.length || lines[next].search(/\S/) < contentIndent) break;
          } else if (lines[i].search(/\S/) < contentIndent) break;
          content.push(lines[i++].slice(contentIndent));
        }
        const task = /^\[([ xX])\]\s+/.exec(content[0]);
        if (task) content[0] = content[0].slice(task[0].length);
        html += `<li>${task ? `<input type="checkbox" disabled${task[1] !== ' ' ? ' checked' : ''}>` : ''}${blocks(content, depth + 1)}</li>`;
      }
      html += `</${tag}>`;
    } else if (line.includes('|') && i + 1 < lines.length && tableDivider(lines[i + 1])) {
      const headers = cells(line);
      const alignment = cells(lines[i + 1]).map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left');
      const row = (values, tag) => `<tr>${headers.map((_, index) => `<${tag} align="${alignment[index] || 'left'}">${inline(values[index] || '')}</${tag}>`).join('')}</tr>`;
      html += `<table><thead>${row(headers, 'th')}</thead><tbody>`;
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() && !blockStart(lines[i])) html += row(cells(lines[i++]), 'td');
      html += '</tbody></table>';
    } else if (/^ {4}/.test(line)) {
      const code = [];
      while (i < lines.length && /^ {4}/.test(lines[i])) code.push(lines[i++].slice(4));
      html += `<pre><code>${escapeHtml(code.join('\n'))}\n</code></pre>`;
    } else {
      const paragraph = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !blockStart(lines[i]) &&
        !(i + 1 < lines.length && (/^ {0,3}(?:=+|-+)\s*$/.test(lines[i + 1]) || (lines[i].includes('|') && tableDivider(lines[i + 1]))))) paragraph.push(lines[i++]);
      html += `<p>${inline(paragraph.join('\n'))}</p>`;
    }
  }
  return html;
}

export function markdownHtml(text) {
  return blocks(String(text ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'));
}
