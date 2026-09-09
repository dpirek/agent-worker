function syntaxError(lineNumber, message) {
  return new Error(`Invalid YAML at line ${lineNumber}: ${message}`);
}

function stripComment(value) {
  let quote = "";
  let escaped = false;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) { escaped = false; continue; }
    if (quote === '"' && character === "\\") { escaped = true; continue; }
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === "[" || character === "{") depth += 1;
    if (character === "]" || character === "}") depth -= 1;
    if (character === "#" && depth === 0 && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value.trimEnd();
}

function splitFlow(value, separator) {
  const parts = [];
  let quote = "";
  let escaped = false;
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) { escaped = false; continue; }
    if (quote === '"' && character === "\\") { escaped = true; continue; }
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === "[" || character === "{") depth += 1;
    if (character === "]" || character === "}") depth -= 1;
    if (character === separator && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts;
}

function mappingSeparator(value) {
  let quote = "";
  let escaped = false;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) { escaped = false; continue; }
    if (quote === '"' && character === "\\") { escaped = true; continue; }
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === "[" || character === "{") depth += 1;
    if (character === "]" || character === "}") depth -= 1;
    if (character === ":" && depth === 0 && (index === value.length - 1 || /\s/.test(value[index + 1]))) return index;
  }
  return -1;
}

function parseQuoted(value, lineNumber) {
  if (value[0] === '"') {
    try { return JSON.parse(value); } catch { throw syntaxError(lineNumber, "invalid double-quoted string."); }
  }
  if (value.at(-1) !== "'") throw syntaxError(lineNumber, "unterminated single-quoted string.");
  return value.slice(1, -1).replaceAll("''", "'");
}

function parseScalar(value, lineNumber) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed[0] === '"' || trimmed[0] === "'") return parseQuoted(trimmed, lineNumber);
  if (trimmed === "[]") return [];
  if (trimmed === "{}") return {};
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    return inner ? splitFlow(inner, ",").map((part) => parseScalar(part, lineNumber)) : [];
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const result = {};
    const inner = trimmed.slice(1, -1).trim();
    for (const entry of inner ? splitFlow(inner, ",") : []) {
      const separator = mappingSeparator(entry);
      if (separator < 0) throw syntaxError(lineNumber, "invalid inline mapping.");
      const key = String(parseScalar(entry.slice(0, separator), lineNumber));
      if (Object.hasOwn(result, key)) throw syntaxError(lineNumber, `duplicate key "${key}".`);
      result[key] = parseScalar(entry.slice(separator + 1), lineNumber);
    }
    return result;
  }
  if (/^(?:null|~)$/i.test(trimmed)) return null;
  if (/^(?:true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === "true";
  if (/^[-+]?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[-+]?\d+)?$/i.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function tokenize(source) {
  const tokens = [];
  const lines = String(source).replace(/^\uFEFF/, "").replaceAll("\r\n", "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (/^\s*\t/.test(raw)) throw syntaxError(index + 1, "tabs are not allowed for indentation.");
    const indent = raw.match(/^ */)[0].length;
    const content = stripComment(raw.slice(indent));
    if (!content.trim() || ["---", "..."].includes(content.trim())) continue;
    tokens.push({ indent, content: content.trimEnd(), lineNumber: index + 1 });
  }
  return tokens;
}

function parseYaml(source) {
  const tokens = tokenize(source);
  if (tokens.length === 0) return null;
  if (tokens[0].indent !== 0) throw syntaxError(tokens[0].lineNumber, "the document root must not be indented.");

  function parseBlock(start, indent) {
    const sequence = tokens[start].content === "-" || tokens[start].content.startsWith("- ");
    const result = sequence ? [] : {};
    let index = start;
    while (index < tokens.length) {
      const token = tokens[index];
      if (token.indent < indent) break;
      if (token.indent > indent) throw syntaxError(token.lineNumber, "unexpected indentation.");

      if (sequence) {
        if (!(token.content === "-" || token.content.startsWith("- "))) throw syntaxError(token.lineNumber, "cannot mix list and mapping entries at one indentation level.");
        const content = token.content.slice(1).trimStart();
        if (!content) {
          if (!tokens[index + 1] || tokens[index + 1].indent <= indent) result.push(null);
          else {
            const nested = parseBlock(index + 1, tokens[index + 1].indent);
            result.push(nested.value);
            index = nested.index - 1;
          }
        } else {
          result.push(parseScalar(content, token.lineNumber));
        }
        index += 1;
        continue;
      }

      const separator = mappingSeparator(token.content);
      if (separator < 1) throw syntaxError(token.lineNumber, "expected a key followed by a colon.");
      const keyValue = token.content.slice(0, separator).trim();
      const key = keyValue[0] === '"' || keyValue[0] === "'"
        ? String(parseQuoted(keyValue, token.lineNumber))
        : keyValue;
      if (Object.hasOwn(result, key)) throw syntaxError(token.lineNumber, `duplicate key "${key}".`);
      const remainder = token.content.slice(separator + 1).trim();
      if (remainder) {
        result[key] = parseScalar(remainder, token.lineNumber);
      } else if (tokens[index + 1] && tokens[index + 1].indent > indent) {
        const nested = parseBlock(index + 1, tokens[index + 1].indent);
        result[key] = nested.value;
        index = nested.index - 1;
      } else {
        result[key] = null;
      }
      index += 1;
    }
    return { value: result, index };
  }

  const parsed = parseBlock(0, 0);
  if (parsed.index !== tokens.length) throw syntaxError(tokens[parsed.index].lineNumber, "unable to parse document.");
  return parsed.value;
}

export { parseYaml };
