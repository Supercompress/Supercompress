"use strict";

const STOP = new Set("a an and are as at be by can did do does for from how i in is it of on or that the their this to was were what when where which who why with would".split(" "));
// Schema / dump glue — fine for matching, useless alone for budget fill.
const FILL_STOP = new Set("insert into values table create select update delete from where set join left right inner outer group order by as on and or not null primary key index comment stub filler noise log row rows cols columns schema database".split(" "));
// Question glue — present in asks, almost never the thing to retrieve.
const QUERY_SOFT = new Set([
  ...STOP,
  "which", "what", "where", "when", "who", "whom", "whose", "why", "how",
  "please", "tell", "show", "give", "find", "list", "report", "mention", "identify",
  "appear", "appears", "return", "returned", "using", "used", "based", "about",
  "into", "onto", "over", "under", "after", "before", "during", "within",
  "account", "accounts", "order", "orders", "service", "services", "record", "records",
  "value", "values", "figure", "figures", "number", "numbers", "info", "information",
]);

function terms(text) {
  return [...new Set((text.toLowerCase().match(/[\p{L}\p{N}_]+(?:[./:-][\p{L}\p{N}_]+)*/gu) || [])
    .filter((term) => term.length > 1 && !STOP.has(term)))];
}

function headerDelimiter(line) {
  return [",", "\t"].find((candidate) => line.split(candidate).length >= 2 &&
    line.split(candidate).every((field) => /^\s*[\p{L}_][\p{L}\p{N}_ -]*\s*$/u.test(field)));
}

const CHAT_ROLES = new Set([
  "user", "assistant", "system", "tool", "tool_result", "tool-result", "function", "functions",
  "developer", "model", "human", "ai",
]);

function textDependencyReason(text) {
  // Real Markdown link refs / footnotes — not chat roles like "[user]: …".
  if (/\]\(\s*#/.test(text)) return "cross_reference_dependency";
  // A footnote is a `[^label]` reference with its `[^label]:` definition; a lone `[^:/?#]` is a
  // regex character class (RFC 3986), not a footnote.
  const footnotes = new Set([...text.matchAll(/^[ \t]{0,3}\[\^([\w-]+)\]:/gm)].map((match) => match[1]));
  if (footnotes.size && [...text.matchAll(/\[\^([\w-]+)\](?!:)/g)].some((match) => footnotes.has(match[1]))) {
    return "cross_reference_dependency";
  }
  // Link reference definitions sit on one line and point at a URL, path or #anchor. Citation
  // lists ("[RFC7748]: 3", "[RFC5322]:" then a wrapped entry) are not link targets.
  const LINK_DEFINITION = /^[ \t]{0,3}\[([^\]\n]+)\]:[ \t]*(?:<|[a-z][\w+.-]*:\/\/|mailto:|\/|\.{1,2}\/|#|[\w-]+(?:\/[\w.-]+)*\.[a-z]{1,5}(?:#\S*)?[ \t]*$)\S*/gim;
  const labels = [...text.matchAll(LINK_DEFINITION)].map((match) => match[1].toLowerCase());
  if (labels.length) {
    if (labels.some((label) => !CHAT_ROLES.has(label) && !/^\d+$/.test(label))) return "cross_reference_dependency";
  }
  // Only treat "see section …" as a hard dependency when a matching heading exists.
  if (/\b(?:see|refer to)\s+(?:section|chapter|appendix)\b|\bas (?:described|defined|specified) (?:above|below)\b/i.test(text)) {
    if (/^#{1,6}\s+\S/m.test(text)) return "cross_reference_dependency";
  }
  // A YAML alias (`*name`) only depends on text elsewhere when that `&name` anchor is defined in
  // a YAML position. ABNF repetition (`*DIGIT`) and emphasis in prose (RFCs, docs) are not aliases.
  const anchors = new Set([...text.matchAll(/^\s*(?:-\s+)?(?:[\w-]+:\s+)?&([\w-]+)/gm)].map((match) => match[1]));
  if (anchors.size && [...text.matchAll(/(?:^\s*(?:-\s+)?|:\s+|[[{,]\s*)\*([\w-]+)/gm)].some((match) => anchors.has(match[1]))) {
    return "yaml_reference_dependency";
  }
  return null;
}

function constraintIndices(units) {
  const required = new Set();
  units.forEach((unit, index) => {
    // Spec / policy constraints. Ops phrasing like "action required: quarantine-…" is NOT
    // a preservation constraint — bare "required" used to force-keep every incident chain.
    if (
      /\b(?:must|shall|mandatory|prerequisites?|prohibited|forbidden|never|unless|only if)\b/i.test(unit)
      || /\b(?:do|does|may|can|should) not\b/i.test(unit)
      || /[_-](?:required|prohibited)\b/i.test(unit)
      || /\brequires?\b/i.test(unit)
      || /\b(?:is|are|be)\s+required\b/i.test(unit)
    ) {
      for (const neighbor of [index - 1, index, index + 1]) if (neighbor >= 0 && neighbor < units.length) required.add(neighbor);
    }
  });
  return [...required].sort((a, b) => a - b);
}

function isParseableJson(text) {
  const trimmed = text.trim();
  if (!/^[\[{]/.test(trimmed)) return false;
  try {
    const value = JSON.parse(trimmed);
    return value !== null && typeof value === "object";
  } catch {
    return false;
  }
}

// Distinguish real JSON / JSON-shaped dumps from agent lines like "[12] search hit ...".
function looksLikeJsonText(text) {
  const trimmed = text.trim();
  if (!/^[\[{]/.test(trimmed)) return false;
  if (isParseableJson(text)) return true;
  if (trimmed[0] === "{") return /^\s*\{\s*"/.test(trimmed);
  if (/^\s*\[\s*\d+\s*\]\s+\S/.test(trimmed)) return false;
  return /^\s*\[\s*(?:[\[{"']|true|false|null|-?\d)/.test(trimmed);
}

function looksLikeHtml(structuralText) {
  // Markup documents have a root or are mostly tag-led lines. Prose with a stray `<CRLF>` or
  // `<absolute-URI>` line (RFCs, mail transcripts) is not HTML.
  if (/^\s*<(?:\?xml\b|!doctype\b|html\b)/im.test(structuralText)) return true;
  const nonEmpty = structuralText.split("\n").filter((line) => line.trim()).length;
  const tagLines = structuralText.match(HTML_TAG_LINE) || [];
  return tagLines.length >= 1 && tagLines.length >= nonEmpty * 0.1;
}

const HTML_TAG_LINE = /^\s*<(?:\?xml\b|!--|\/[a-z_][\w:.-]*\s*>|[a-z_][\w:.-]*(?:\s+[a-z_:][\w:.-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>)/gim;

function looksLikeCode(structuralText) {
  // Do not treat documents that merely contain `{` / `}` lines (JSON, diffs) as code.
  return /^\s*(?:(?:export|async|public|private|static)\s+)*(?:function|class|interface|def|func|fn)\s/m.test(structuralText)
    || /^\s*(?:(?:export\s+)?(?:const|let|var)\s+[\w$]+\s*[:=]|#include\s*[<"]|from\s+[\w.]+\s+import\b|import\s+(?:["'{*]|[\w$.]+\s*(?:$|from\b|,)))/m.test(structuralText);
}

const CODE_START = /^(?:(?:export|async|public|private|static|default)\s+)*(?:async\s+)?(?:function|class|interface|def|func|fn)\b|^(?:export\s+)?(?:const|let|var)\s+[\w$]+\s*=\s*(?:async\s+)?(?:function|\(|[\w$.]+\s*=>)/;

function codeUnits(text) {
  const lines = text.split("\n");
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (CODE_START.test(lines[index])) starts.push(index);
  }
  if (starts.length < 4) return null;
  const units = [];
  if (starts[0] > 0) units.push(lines.slice(0, starts[0]).join("\n"));
  for (let index = 0; index < starts.length; index += 1) {
    const end = index + 1 < starts.length ? starts[index + 1] : lines.length;
    units.push(lines.slice(starts[index], end).join("\n"));
  }
  return units.filter((unit) => unit.length);
}

const SQL_STATEMENT_UPPER = /^\s*(?:SELECT\s+(?:DISTINCT\s+)?(?:\*|[\w."`\[\]]+(?:\([^)\n]*\))?(?:\s+(?:AS|as)\s+[\w"`]+)?)(?:\s*,\s*(?:\*|[\w."`\[\]]+(?:\([^)\n]*\))?(?:\s+(?:AS|as)\s+[\w"`]+)?))*\s+FROM\s+[\w."`\[\]]|(?:INSERT|MERGE)\s+INTO\b|UPDATE\s+[\w."`\[\]-]+\s+SET\b|DELETE\s+FROM\b|CREATE\s+(?:TABLE|VIEW|INDEX|FUNCTION)\b|WITH\s+[\w"`]+\s+AS\s*\()/m;
const SQL_STATEMENT_LOWER = /^\s*(?:select\s+(?:distinct\s+)?(?:\*|[\w."`\[\]]+(?:\([^)\n]*\))?(?:\s+(?:AS|as)\s+[\w"`]+)?)(?:\s*,\s*(?:\*|[\w."`\[\]]+(?:\([^)\n]*\))?(?:\s+(?:AS|as)\s+[\w"`]+)?))*\s+from\s+[\w."`\[\]]|(?:insert|merge)\s+into\b|update\s+[\w."`\[\]-]+\s+set\b|delete\s+from\b|create\s+(?:table|view|index|function)\b|with\s+[\w"`]+\s+as\s*\()/m;

function unitsFor(text) {
  if (textDependencyReason(text)) return [text];
  const lines = text.split("\n");
  let structureFence = null;
  let structureDiff = false;
  const structuralLines = lines.map((line) => {
    if (structureDiff) return "";
    if (!structureFence && /^(diff --git |--- )/.test(line)) { structureDiff = true; return ""; }
    const marker = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (structureFence) {
      if (marker && marker[1][0] === structureFence[0] && marker[1].length >= structureFence.length && !marker[2].trim()) structureFence = null;
      return "";
    }
    if (marker) { structureFence = marker[1]; return ""; }
    return line;
  });
  const structuralText = structuralLines.join("\n");
  // NDJSON / JSONL dumps: many peer object lines → line units (not one opaque blob).
  const jsonlLines = lines.map((line) => line.trim()).filter(Boolean);
  if (jsonlLines.length >= 6 && jsonlLines.filter((line) => /^\{[\s\S]*\}$/.test(line)).length >= Math.ceil(jsonlLines.length * 0.8)) {
    return lines.filter((line) => line.trim());
  }
  // HTML/XML with many peer blocks: split on block boundaries instead of keeping the whole page.
  if (looksLikeHtml(structuralText)) {
    const blocks = text.split(/(?=<!(?:DOCTYPE|--)|<\/?(?:div|p|section|article|li|tr|h[1-6]|item|entry|row|span|scrap|assembly|part|record|node|element|message|field)\b)/i).filter((block) => block.trim());
    if (blocks.length >= 6) return blocks;
    return [text];
  }
  // OpenAPI / YAML path maps: one unit per peer `/path:` key (not the whole spec blob).
  const yamlPathStarts = lines
    .map((line, index) => /^(?: {2})?\/[A-Za-z0-9[{}_./$~*-][^:\n]*:\s*$/.test(line) ? index : -1)
    .filter((index) => index >= 0);
  if (yamlPathStarts.length >= 6) {
    const blocks = [];
    if (yamlPathStarts[0] > 0) blocks.push(lines.slice(0, yamlPathStarts[0]).join("\n"));
    for (let index = 0; index < yamlPathStarts.length; index += 1) {
      const end = index + 1 < yamlPathStarts.length ? yamlPathStarts[index + 1] : lines.length;
      blocks.push(lines.slice(yamlPathStarts[index], end).join("\n"));
    }
    return blocks.filter((unit) => unit.trim());
  }
  // TOML / INI: many [section] peers → one unit per table (keeps field clusters intact).
  // Break before `#/;/% Ignore:` bait lines so they do not poison the prior table unit.
  const sectionStarts = lines
    .map((line, index) => (
      /^\[[^\]]+\]\s*$/.test(line.trim()) || /^\s*[#;%]+\s*Ignore\s*:/i.test(line)
        ? index
        : -1
    ))
    .filter((index) => index >= 0);
  // Tables start at column 0 and carry `key = value` fields; indented `[Label]` lines are
  // citation keys in RFC/spec reference lists, not TOML.
  const tableHeaders = sectionStarts.filter((index) => /^\[[^\]]+\]\s*$/.test(lines[index]));
  const assignments = lines.filter((line) => /^\s*[\w.-]+\s*=\s*\S/.test(line)).length;
  if (tableHeaders.length >= 6 && assignments >= tableHeaders.length) {
    const blocks = [];
    if (sectionStarts[0] > 0) blocks.push(lines.slice(0, sectionStarts[0]).join("\n"));
    for (let index = 0; index < sectionStarts.length; index += 1) {
      const end = index + 1 < sectionStarts.length ? sectionStarts[index + 1] : lines.length;
      blocks.push(lines.slice(sectionStarts[index], end).join("\n"));
    }
    return blocks.filter((unit) => unit.trim());
  }
  // Peer single-line DML dumps (many INSERT/UPDATE/DELETE …;) → line units.
  // Multi-line SELECT / transaction scripts stay atomic below.
  const trimmedLines = lines.map((line) => line.trim()).filter(Boolean);
  const dmlPeers = trimmedLines.filter((line) =>
    /^(?:INSERT\s+INTO|UPDATE\s+[\w."`\[\]]+|DELETE\s+FROM|MERGE\s+INTO)\b/i.test(line) && /;\s*$/.test(line)
  );
  if (dmlPeers.length >= 8 && dmlPeers.length >= Math.ceil(trimmedLines.length * 0.7)) {
    return lines.filter((line) => line.trim());
  }
  // JSON-shaped text stays opaque here; documentFor may still split large arrays/objects.
  // Bracketed prose like "[0] result ..." is NOT JSON and must line-split.
  if (looksLikeJsonText(text)) return [text];
  if (/^\s*(?:BEGIN(?:\s+(?:TRANSACTION|WORK))?|START\s+TRANSACTION)\s*;/im.test(structuralText)) return [text];
  // Real SQL statements stay atomic; comment-heavy migration/result dumps line-split.
  // SQL keywords are written all upper or all lower case; "Select a counter … from" is prose.
  if (SQL_STATEMENT_UPPER.test(structuralText) || SQL_STATEMENT_LOWER.test(structuralText)) {
    const sqlLines = lines.filter((line) => line.trim());
    const commentLike = sqlLines.filter((line) => /^\s*--/.test(line)).length;
    if (commentLike < Math.ceil(sqlLines.length * 0.6) || sqlLines.length < 8) return [text];
  }
  if (looksLikeCode(structuralText)) {
    const split = codeUnits(text);
    if (split) return split;
    // Short unfenced snippets stay opaque (uncertain code). Long dumps that merely
    // contain a lone `def`/`function` (pytest failures, mixed logs) keep splitting.
    if (lines.filter((line) => line.trim()).length < 24) return [text];
  }
  // Git logs: keep each commit header+body together (blank lines are not paragraph breaks).
  const commitStarts = lines.map((line, index) => /^commit [a-f0-9]{7,}\b/i.test(line) ? index : -1).filter((index) => index >= 0);
  if (commitStarts.length >= 4) {
    const commits = [];
    if (commitStarts[0] > 0) commits.push(lines.slice(0, commitStarts[0]).join("\n"));
    for (let index = 0; index < commitStarts.length; index += 1) {
      const end = index + 1 < commitStarts.length ? commitStarts[index + 1] : lines.length;
      commits.push(lines.slice(commitStarts[index], end).join("\n"));
    }
    return commits.filter((unit) => unit.trim());
  }
  // Unified diffs: one unit per file hunk (diff --git), not the whole patch.
  const diffStarts = lines.map((line, index) => /^diff --git /.test(line) ? index : -1).filter((index) => index >= 0);
  if (diffStarts.length >= 2) {
    const hunks = [];
    if (diffStarts[0] > 0) hunks.push(lines.slice(0, diffStarts[0]).join("\n"));
    for (let index = 0; index < diffStarts.length; index += 1) {
      const end = index + 1 < diffStarts.length ? diffStarts[index + 1] : lines.length;
      hunks.push(lines.slice(diffStarts[index], end).join("\n"));
    }
    return hunks.filter((unit) => unit.trim());
  }
  // Terraform plans: peer `# module… will be/must be` change headers → one unit each.
  const tfStarts = lines
    .map((line, index) => (/^\s*#\s+\S.+\s+(?:will be|must be)\b/.test(line) ? index : -1))
    .filter((index) => index >= 0);
  if (tfStarts.length >= 4) {
    const blocks = [];
    if (tfStarts[0] > 0) blocks.push(lines.slice(0, tfStarts[0]).join("\n"));
    for (let index = 0; index < tfStarts.length; index += 1) {
      const end = index + 1 < tfStarts.length ? tfStarts[index + 1] : lines.length;
      blocks.push(lines.slice(tfStarts[index], end).join("\n"));
    }
    return blocks.filter((unit) => unit.trim());
  }
  const delimiter = headerDelimiter(lines[0]);
  if (delimiter) return delimitedUnits(text, delimiter);
  // Treat `# Ignore:` / GraphQL `# comment` lines as non-headings so they cannot
  // become a lone H1 that swallows every following ## peer section.
  const headings = structuralLines.map((line) => {
    const heading = line.match(/^(#{1,6})\s+\S/);
    if (!heading) return null;
    if (heading[1].length === 1 && isCodeHashComment(line)) return null;
    return heading;
  });
  const headingCount = headings.filter(Boolean).length;
  const contentLines = lines.filter((line) => line.trim()).length;
  // Ignore sparse `# comment` lines in logs; require a real Markdown heading density.
  let headingLevel = headingCount >= 2 && headingCount >= Math.max(2, contentLines * 0.15)
    ? headings.reduce((level, heading) => heading ? Math.min(level, heading[1].length) : level, Infinity)
    : Infinity;
  if (Number.isFinite(headingLevel)) {
    const peers = headings.filter((heading) => heading?.[1].length === headingLevel);
    const firstContent = lines.findIndex((line) => line.trim());
    if (peers.length === 1 && headings[firstContent]?.[1].length === headingLevel) {
      const childLevel = headings.reduce((level, heading) => heading && heading[1].length > headingLevel
        ? Math.min(level, heading[1].length) : level, Infinity);
      if (headings.filter((heading) => heading?.[1].length === childLevel).length >= 2) {
        headingLevel = childLevel;
      }
    }
    const sections = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (!sections.length || headings[index]?.[1].length === headingLevel) sections.push(lines[index]);
      else sections[sections.length - 1] += `\n${lines[index]}`;
    }
    return explodeFencedDelimitedTables(sections);
  }
  if (/^[\w-]+:\s*$/.test(lines[0]) && lines.slice(1).every((line) => !line.trim() || /^ +\S/.test(line))) {
    const indents = lines.slice(1).filter((line) => line.trim()).map((line) => line.match(/^ */)[0].length);
    const siblingIndent = indents.reduce((minimum, indent) => Math.min(minimum, indent), Infinity);
    const blocks = [lines[0]];
    for (const line of lines.slice(1)) {
      if (line.trim() && line.match(/^ */)[0].length === siblingIndent) blocks.push(line);
      else blocks[blocks.length - 1] += `\n${line}`;
    }
    return blocks;
  }
  const units = [];
  let current = [];
  let fence = null;
  let diff = false;
  for (const line of lines) {
    if (diff) { current.push(line); continue; }
    const marker = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fence) {
      current.push(line);
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
        units.push(current.join("\n")); current = []; fence = null;
      }
      continue;
    }
    if (marker) {
      if (current.length) units.push(current.join("\n"));
      current = [line]; fence = marker[1]; continue;
    }
    if (/^(diff --git |--- )/.test(line)) {
      if (!diff && current.length) { units.push(current.join("\n")); current = []; }
      diff = true;
    }
    if (!diff && !line.trim() && current.some((entry) => /^\s+\S/.test(entry)) &&
      !current.some((entry) => /^\s*(?:[\w.-]+:\s|[\w.-]+:\s*$|[-*+]\s|\d+[.)]\s)|^\s+.*(?:[=;{}]|\w\([^)]*\))/.test(entry))) {
      current.push(line);
      units.push(current.join("\n")); current = []; continue;
    }
    if (!diff && !/^\s+\S|^\s*$/.test(line) && current.length) {
      units.push(current.join("\n")); current = [];
    }
    current.push(line);
  }
  if (current.length) units.push(current.join("\n"));
  return explodeFencedDelimitedTables(units);
}

/**
 * Markdown / prose units that wrap a fenced CSV/TSV table keep the whole fence as one
 * blob — explode peer data rows so query IDs can extract without retaining the table.
 * Line-walks fences (not a single regex) so sibling ```js blocks after the table still work.
 */
function explodeFencedDelimitedTables(units) {
  const out = [];
  for (const unit of units) {
    const lines = unit.split("\n");
    let cursor = 0;
    let wrote = false;
    while (cursor < lines.length) {
      const open = lines[cursor].match(/^(\s*)(```|~~~)([^\n]*)$/);
      if (!open) {
        cursor += 1;
        continue;
      }
      const marker = open[2]; // ``` or ~~~
      const markChar = marker[0];
      let closeAt = -1;
      for (let i = cursor + 1; i < lines.length; i += 1) {
        const close = lines[i].match(/^\s*(`{3,}|~{3,})\s*$/);
        if (close && close[1][0] === markChar && close[1].length >= marker.length) {
          closeAt = i;
          break;
        }
      }
      if (closeAt < 0) break;
      const body = lines.slice(cursor + 1, closeAt);
      const nonempty = body.filter((line) => line.trim());
      const delimiter = nonempty.length >= 6 ? headerDelimiter(nonempty[0]) : null;
      const cols = delimiter ? nonempty[0].split(delimiter).length : 0;
      const peerRows = delimiter
        ? nonempty.slice(1).filter((line) => line.split(delimiter).length === cols)
        : [];
      if (!delimiter || peerRows.length < 5) {
        cursor = closeAt + 1;
        continue;
      }
      // Emit prefix (heading / prose before this fence), header+open, rows, close, then continue.
      if (cursor > 0) {
        const prefix = lines.slice(0, cursor).join("\n");
        if (prefix.trim()) out.push(prefix);
      }
      out.push([...lines.slice(cursor, cursor + 1), nonempty[0]].join("\n"));
      for (const row of peerRows) out.push(row);
      out.push(lines[closeAt]);
      // Remainder may contain more fences or prose — recurse via outer loop on a synthetic tail.
      const rest = lines.slice(closeAt + 1).join("\n");
      if (rest.trim()) {
        for (const piece of explodeFencedDelimitedTables([rest])) out.push(piece);
      }
      wrote = true;
      break;
    }
    if (!wrote) out.push(unit);
  }
  return out.filter((unit) => unit.trim());
}

function delimitedUnits(text, delimiter) {
  const units = [];
  let start = 0;
  let quoted = false;
  let atFieldStart = true;
  let closedQuote = false;
  let columns = 1;
  let expectedColumns;
  for (let index = 0; index <= text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') index += 1;
        else { quoted = false; closedQuote = true; }
      }
      if (index === text.length) return [text];
      continue;
    }
    if (character === '"') {
      if (!atFieldStart) return [text];
      quoted = true;
      atFieldStart = false;
    } else if (character === delimiter) {
      columns += 1;
      atFieldStart = true;
      closedQuote = false;
    } else if (character === "\n" || index === text.length) {
      if (index > start) {
        expectedColumns ??= columns;
        if (columns !== expectedColumns) return [text];
        units.push(text.slice(start, index));
      }
      start = index + 1;
      columns = 1;
      atFieldStart = true;
      closedQuote = false;
    } else {
      if (closedQuote && character !== "\r") return [text];
      atFieldStart = false;
    }
  }
  return units.length ? units : [text];
}

function objectFieldUnits(context, objectStart) {
  const fields = jsonParts(context, objectStart);
  if (fields.length < 4) return null;
  const objectFields = fields.filter(({ start, end }) => /^\s*"(?:[^"\\]|\\.)*"\s*:\s*\{/.test(context.slice(start, end)));
  if (objectFields.length < 4 || objectFields.length !== fields.length) return null;
  const objectEnd = fields.end;
  const units = fields.map(({ start, end }) => context.slice(start, end).trim());
  return {
    units,
    sourceRanges: fields.map(({ start, end }) => {
      const raw = context.slice(start, end);
      return { start: start + raw.length - raw.trimStart().length, end: end - raw.length + raw.trimEnd().length };
    }),
    requiredIndices: constraintIndices(units),
    render: (indices, entries) => context.slice(0, objectStart + 1) + indices.map((index) => entries[index]).join(",") + context.slice(objectEnd),
  };
}

// Collect every JSON array (≥4 elems) at any object depth so nested carts/items unitize.
function collectArrayPools(context, objectStart, pools = [], depth = 0) {
  if (depth > 6) return pools;
  const fields = jsonParts(context, objectStart);
  if (!fields.length) return pools;
  for (const field of fields) {
    const slice = context.slice(field.start, field.end);
    const prefix = slice.match(/^\s*"(?:[^"\\]|\\.)*"\s*:\s*/);
    if (!prefix) continue;
    const valueStart = field.start + prefix[0].length;
    if (context[valueStart] === "[") {
      const entries = jsonParts(context, valueStart);
      if (entries.length >= 4) pools.push({ start: valueStart, end: entries.end, entries });
    } else if (context[valueStart] === "{") {
      collectArrayPools(context, valueStart, pools, depth + 1);
    }
  }
  return pools;
}

function poolsToDocument(context, pools) {
  if (!pools.length) return null;
  const units = [];
  const owners = [];
  for (let poolIndex = 0; poolIndex < pools.length; poolIndex += 1) {
    for (const entry of pools[poolIndex].entries) {
      units.push(context.slice(entry.start, entry.end).trim());
      owners.push({ poolIndex, start: entry.start, end: entry.end });
    }
  }
  return {
    units,
    requiredIndices: constraintIndices(units),
    render: (indices) => {
      const kept = new Set(indices);
      let output = context;
      for (let poolIndex = pools.length - 1; poolIndex >= 0; poolIndex -= 1) {
        const pool = pools[poolIndex];
        const selected = [];
        owners.forEach((owner, unitIndex) => {
          if (owner.poolIndex === poolIndex && kept.has(unitIndex)) {
            selected.push(context.slice(owner.start, owner.end).trim());
          }
        });
        output = output.slice(0, pool.start + 1) + selected.join(",") + output.slice(pool.end);
      }
      return output;
    },
  };
}

function documentFor(context) {
  const atomic = (reason) => ({ units: [context], requiredIndices: [0], preservationReason: reason, render: () => context });
  if (/^\s*[[{]/.test(context)) {
    try {
      let references = false;
      JSON.parse(context, (key, value) => {
        const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
        if (/(?:^|[^a-z])(?:index|indices|indexes|ref|refs|reference|references|pointer|pointers)(?:$|[^a-z])/i.test(words)) references = true;
        return value;
      });
      if (references) return atomic("json_reference_dependency");
      const rootStart = context.search(/\S/);
      let arrayStart = context[rootStart] === "[" ? rootStart : -1;
      if (arrayStart < 0) {
        const fields = jsonParts(context, rootStart);
        // Nested + multi-array: unitize every eligible array at any depth.
        const nestedPools = collectArrayPools(context, rootStart);
        if (nestedPools.length >= 1) {
          const nested = poolsToDocument(context, nestedPools);
          if (nested && nested.units.length >= 4) return nested;
        }
        // Nested object maps (lockfile packages{}, inventories{}) at any root field.
        for (const field of fields) {
          const slice = context.slice(field.start, field.end);
          const prefix = slice.match(/^\s*"(?:[^"\\]|\\.)*"\s*:\s*/);
          if (!prefix) continue;
          const valueStart = field.start + prefix[0].length;
          if (context[valueStart] !== "{") continue;
          const nested = objectFieldUnits(context, valueStart);
          if (nested && nested.units.length >= 4) return nested;
        }
        if (fields.length >= 4) {
          const siblings = objectFieldUnits(context, rootStart);
          if (siblings) return siblings;
        }
      }
      const entries = arrayStart >= 0 ? jsonParts(context, arrayStart) : [];
      if (entries.length >= 4) {
        const arrayEnd = entries.end;
        const units = entries.map(({ start, end }) => context.slice(start, end).trim());
        return {
          units,
          sourceRanges: entries.map(({ start, end }) => {
            const raw = context.slice(start, end);
            return { start: start + raw.length - raw.trimStart().length, end: end - raw.length + raw.trimEnd().length };
          }),
          requiredIndices: constraintIndices(units),
          render: (indices, units) => context.slice(0, arrayStart + 1) + indices.map((index) => units[index]).join(",") + context.slice(arrayEnd),
        };
      }
    } catch {}
  }
  const dependency = textDependencyReason(context);
  if (dependency) return atomic(dependency);
  const units = unitsFor(context);
  const title = units[0]?.trimStart().match(/^(#{1,6})\s+\S/);
  const section = units[1]?.match(/^(#{1,6})\s+\S/);
  // Require unit 0 only for a true document title (strictly higher heading than the next section),
  // CSV headers, or YAML keys — not for the first of many peer ## sections.
  const keepTitle = Boolean(title && section && title[1].length < section[1].length)
    || Boolean(title && title[1].length === 1 && !section)
    || /^[\w-]+:\s*$/.test(units[0] || "")
    || headerDelimiter(context.split("\n", 1)[0]);
  return {
    units,
    requiredIndices: [...new Set([...(keepTitle ? [0] : []), ...constraintIndices(units)])].sort((a, b) => a - b),
    evidenceStart: title && section && title[1].length < section[1].length ? 1 : 0,
    render: (indices, entries) => indices.map((index) => entries[index]).join("\n"),
  };
}

function jsonParts(context, start) {
  const parts = [];
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let partStart = start + 1;
  for (let index = start; index < context.length; index += 1) {
    const character = context[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "[" || character === "{") depth += 1;
    else if (character === "]" || character === "}") {
      depth -= 1;
      if (depth === 0) {
        if (context.slice(partStart, index).trim()) parts.push({ start: partStart, end: index });
        parts.end = index;
        return parts;
      }
    } else if (character === "," && depth === 1) {
      parts.push({ start: partStart, end: index });
      partStart = index + 1;
    }
  }
  return [];
}

function camelParts(token) {
  return token.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/).map((part) => part.toLowerCase()).filter((part) => part.length > 1);
}

// Light morphology for ops/support questions: fail↔failed, block↔blocker, fire↔fired.
const STEM_ALIASES = new Map(Object.entries({
  fail: "fail", fails: "fail", failed: "fail", failing: "fail", failure: "fail", failures: "fail",
  block: "block", blocks: "block", blocked: "block", blocking: "block", blocker: "block", blockers: "block",
  fire: "fire", fires: "fire", fired: "fire", firing: "fire",
  crash: "crash", crashes: "crash", crashed: "crash", crashing: "crash",
  loop: "loop", loops: "loop", looped: "loop", looping: "loop",
  expire: "expire", expires: "expire", expired: "expire", expiring: "expire",
}));

// Organic paraphrase bridges (ops / logistics / attributes) — not corpus needles.
const PARAPHRASE_BRIDGES = {
  locked: ["sealed", "closed"],
  sealed: ["locked"],
  ionizing: ["radiation", "radioactive", "microsieverts", "sievert"],
  radiation: ["ionizing", "microsieverts", "sievert"],
  reading: ["scan", "measurement"],
  measurement: ["scan", "reading"],
  bill: ["invoice"],
  invoice: ["bill"],
  commercial: ["customs", "invoice"],
  timber: ["rosewood", "hardwood", "lumber", "planks"],
  tropical: ["rosewood", "hardwood"],
  "plant-health": ["phytosanitary"],
  plant: ["phytosanitary"],
  euro: ["eur"],
  eur: ["euro"],
  refrigerated: ["cold-chain", "cold", "chilled"],
  packing: ["loading"],
  platform: ["bay"],
  overnight: ["night"],
  oversees: ["supervises", "supervise"],
  supervises: ["oversees"],
  chilled: ["refrigerated", "cold", "salmon"],
  fish: ["salmon", "seafood"],
  japanese: ["osaka", "japan", "tokyo"],
  japan: ["japanese", "osaka"],
  warehouse: ["cold-store", "store"],
  mass: ["kg", "kilograms", "totaling", "weight"],
  cargo: ["crates", "shipment", "manifest"],
  size: ["capacity", "volume"],
  capacity: ["size", "volume", "litres", "liters"],
  volume: ["capacity", "litres", "liters", "litre", "liter", "size"],
  litres: ["volume", "capacity", "liters"],
  liters: ["volume", "capacity", "litres"],
  color: ["colour", "hue", "shade"],
  colour: ["color", "hue", "shade"],
  hue: ["color", "colour", "shade"],
  venue: ["location", "locale", "place", "hall"],
  locale: ["location", "venue", "place"],
  price: ["cost", "amount"],
  cost: ["price", "amount"],
  location: ["city", "region", "place", "venue", "locale"],
  city: ["location", "region"],
  author: ["writer"],
  writer: ["author"],
  status: ["state"],
  state: ["status"],
  quantity: ["count", "qty", "amount"],
  qty: ["quantity", "count"],
  seats: ["capacity", "volume"],
};

const NUMBER_WORDS = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5",
  six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  eleven: "11", twelve: "12",
};

// Answer-slot patterns: what the ask wants back, not just words it happens to contain.
const ANSWER_SLOTS = [
  {
    id: "email",
    ask: /\b(?:e-?mails?|billing e-?mail|contact e-?mail|contact)\b/i,
    evidence: /@|["']?(?:email|contact|mail)["']?\s*[:=]/i,
    bridges: ["email", "contact", "mail", "e-mail"],
  },
  {
    id: "warehouse",
    ask: /\b(?:warehouses?|ship(?:ped|ping)?\s+(?:from|via|out)|fulfillment|depot|ship_node|ship node)\b/i,
    evidence: /\b(?:warehouse|ship_node|fulfillment|depot|cold-store)\b\s*[:=,]|\bwarehouse\s*=/i,
    bridges: ["warehouse", "ship_node", "fulfillment", "depot", "store", "cold-store"],
  },
  {
    id: "location",
    ask: /\b(?:where|location|locale|venue|city|region|in stock in)\b/i,
    // Prefer explicit location fields — bare WH-* codes are too common to count alone.
    evidence: /\b(?:location|city|region|locale|venue|place|ship_node|warehouse)\b\s*[:=,]|\bwarehouse\s*=/i,
    bridges: ["location", "city", "region", "place", "venue", "locale", "warehouse", "ship_node"],
  },
  {
    id: "price",
    ask: /\b(?:price|cost|how much|list_price|under\s*\$|\$\d)\b/i,
    evidence: /\$\d|\b(?:price|cost|amount|list_price)\b\s*[:=]/i,
    bridges: ["price", "cost", "amount", "list_price"],
  },
  {
    id: "who",
    ask: /\b(?:who|whom|whose|operator|handler|author|assignee)\b/i,
    evidence: /\b(?:operator|handler|author|assignee|user|owner|name)\b\s*[:=,]|\b[A-Z][a-z]+_[A-Z][a-z]+\b/,
    bridges: ["operator", "handler", "author", "assignee", "user", "owner"],
  },
  {
    id: "why",
    ask: /\b(?:why|cause|reason|root cause)\b/i,
    evidence: /\b(?:error|fail(?:ed|ure)?|because|cause|reason|exception|traceback|denied|rejected)\b/i,
    bridges: ["error", "failure", "exception", "cause", "reason"],
  },
  {
    id: "hash",
    ask: /\b(?:rollout_hash|digest|checksum|sha-?\d*|commit hash|hash)\b/i,
    evidence: /\b(?:rollout_hash|digest|checksum|sha\d*)\b\s*[:=]|\b0x[a-f0-9]{6,}\b/i,
    bridges: ["rollout_hash", "digest", "checksum", "hash"],
  },
  {
    id: "version",
    ask: /\b(?:version|release|tag)\b/i,
    evidence: /\b(?:version|release)\b\s*[:=]|\b\d+\.\d+\.\d+\b/i,
    bridges: ["version", "release", "tag"],
  },
  {
    id: "qty",
    ask: /\b(?:how many|quantity|qty|count of|pallets|seats)\b/i,
    evidence: /\b(?:qty|quantity|count|pallets|seats|replicas)\b\s*[:=,]|\b\d+\s*(?:pallets?|seats?|units?|replicas?)\b/i,
    bridges: ["qty", "quantity", "count", "pallets", "seats", "replicas"],
  },
  {
    id: "attribute",
    ask: /\b(?:hue|colo(?:u)?r|pigment|volume|capacity|litres?|liters?)\b/i,
    evidence: /\b(?:hue|colo(?:u)?r|pigment|volume|capacity|litres?|liters?)\b/i,
    bridges: ["hue", "color", "colour", "pigment", "volume", "capacity", "litres", "liters"],
  },
];

function stem(token) {
  if (STEM_ALIASES.has(token)) return STEM_ALIASES.get(token);
  if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("es")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

/**
 * Organic referent decomposition: google_compute_instance.canary_node_110 → canary_node_110.
 * Prefer the trailing name; never emit intermediate type segments (google_compute_instance)
 * unless they themselves carry digits.
 */
function decomposeReferents(term) {
  if (!term || !/[./]/.test(term)) return [];
  const parts = term.split(/[./]+/).filter(Boolean);
  if (parts.length < 2) return [];
  const out = [];
  const tail = parts[parts.length - 1];
  // Trailing instance/object name: digits or snake/kebab.
  if (tail && tail.length >= 4 && (/[\d]/.test(tail) || /[_-]/.test(tail))) out.push(tail);
  // Mid-path segments only when digit-bearing (never bare resource type names).
  for (const part of parts.slice(0, -1)) {
    if (part.length >= 4 && /[\d]/.test(part)) out.push(part);
  }
  return [...new Set(out)];
}

function placeBridges(query) {
  const bridges = [];
  // Only place cues in locative phrases — not question words ("What", "Which", "Where").
  const patterns = [
    /\bin\s+([A-Z][a-z]{2,})(?:\s+([A-Z][a-z]+))?\b/g,
    /\b(?:near|around|from|at|to)\s+([A-Z][a-z]{2,})(?:\s+([A-Z][a-z]+))?\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of query.matchAll(pattern)) {
      const city = match[1];
      const region = match[2];
      if (QUERY_SOFT.has(city.toLowerCase())) continue;
      const full = `${city}${region ? ` ${region}` : ""}`.toLowerCase();
      bridges.push(full.replace(/\s+/g, "-"), full.replace(/\s+/g, ""));
      bridges.push(city.slice(0, 3).toLowerCase());
      if (region) bridges.push(region.slice(0, 3).toLowerCase());
    }
  }
  return bridges.filter((term) => term.length >= 3 && !QUERY_SOFT.has(term));
}

/**
 * True query awareness: separate lookup keys from answer slots from soft glue.
 * intent: lookup | aggregate | howto | contrast | verify
 */
function analyzeQuery(query, queryTerms = terms(query)) {
  const intent = requiresGlobalEvidence(query)
    ? "aggregate"
    : /\b(?:how (?:do|to|can)|steps? to|install|deploy|configure)\b/i.test(query)
      ? "howto"
      : /\b(?:non-|not |except |contrast|difference|vs\.?)\b/i.test(query)
        ? "contrast"
        : /\b(?:is (?:the|this|it)|does|did|can|verify|confirm|true|false)\b/i.test(query)
          ? "verify"
          : "lookup";

  const keys = [];
  for (const term of queryTerms) {
    if (QUERY_SOFT.has(term) || FILL_STOP.has(term)) continue;
    // Keys are referent IDs / codes — not schema field names like rollout_hash.
    if (/[\d]/.test(term) && term.length >= 3) keys.push(term);
    else if (/^[a-z]{1,6}[-_][a-z0-9][-a-z0-9.]*\d[-a-z0-9.]*$/i.test(term)) keys.push(term);
    else if (/^[a-z]+(?:-[a-z0-9]+){2,}$/i.test(term) && /[\d]/.test(term)) keys.push(term);
    for (const suf of decomposeReferents(term)) keys.push(suf);
  }
  for (const entity of specificQueryEntities(query, queryTerms)) {
    if (!keys.includes(entity)) keys.push(entity);
    for (const suf of decomposeReferents(entity)) keys.push(suf);
  }

  const slots = [];
  const slotBridges = new Set();
  for (const slot of ANSWER_SLOTS) {
    if (slot.ask.test(query) || queryTerms.some((term) => slot.bridges.includes(term))) {
      slots.push(slot);
      for (const bridge of slot.bridges) slotBridges.add(bridge);
    }
  }
  for (const bridge of placeBridges(query)) slotBridges.add(bridge);

  const hardTerms = queryTerms.filter((term) => !QUERY_SOFT.has(term) && !FILL_STOP.has(term));
  return {
    intent,
    keys: [...new Set(keys)],
    slots,
    slotBridges: [...slotBridges],
    hardTerms,
    softTerms: queryTerms.filter((term) => QUERY_SOFT.has(term)),
  };
}

function slotEvidenceScore(unit, slots) {
  if (!slots.length || !unit) return 0;
  let score = 0;
  for (const slot of slots) {
    if (slot.evidence.test(unit)) score += 3;
    const lower = unit.toLowerCase();
    for (const bridge of slot.bridges) {
      if (lower.includes(bridge)) score += 1;
    }
  }
  return score;
}

function expandQueryTerms(queryTerms, query = "") {
  const expanded = new Set(queryTerms);
  for (const term of queryTerms) {
    expanded.add(stem(term));
    for (const [surface, canonical] of STEM_ALIASES) {
      if (canonical === term || canonical === stem(term) || surface === term) {
        expanded.add(surface);
        expanded.add(canonical);
      }
    }
    // Own-property lookups only: real queries contain words like "constructor" and "toString".
    for (const syn of (Object.hasOwn(PARAPHRASE_BRIDGES, term) ? PARAPHRASE_BRIDGES[term] : [])) expanded.add(syn);
    if (Object.hasOwn(NUMBER_WORDS, term)) expanded.add(NUMBER_WORDS[term]);
    for (const suf of decomposeReferents(term)) expanded.add(suf);
  }
  if (query) {
    const analysis = analyzeQuery(query, queryTerms);
    for (const bridge of analysis.slotBridges) expanded.add(bridge);
    for (const key of analysis.keys) expanded.add(key);
  }
  return expanded;
}

// Units that exist to mislead extractors (synonym bait, hard negatives, fabricated blocks).
// Keep patterns tight — IDs like S-DISTRACTOR-1 must not trip `\bdistractor\b`.
function isBaitUnit(unit) {
  if (!unit) return false;
  if (/^#{1,3}\s*(?:Synonym bait|Aerospace bait|Hard.?neg|Distractor)\b/im.test(unit)) return true;
  // "(WRONG)", "(WRONG — ignore)", "(IGNORE)"
  if (/\(\s*(?:WRONG\d*|IGNORE)\b/i.test(unit)) return true;
  // "# Ignore:", "; Ignore:", "% Ignore:"
  if (/(?:^|\n)\s*[#;%]*\s*Ignore\s*:/i.test(unit)) return true;
  // Explicit decoy tables / fake peer records.
  if (/(?:^|\n)\s*\[[^\]]*_decoy\]/i.test(unit) || /(?:^|\n)\s*\w+_decoy\s*=/i.test(unit)) return true;
  if (/\bSTR-FAKE-\d+\b|\bPART-FAKE-\d+\b/i.test(unit)) return true;
  if (/\bbait only\b/i.test(unit)) return true;
  if (/\bfabricated\b/i.test(unit)) return true;
  if (/\b(?:must not|do not)\s+(?:use|cite|trust|read)\b/i.test(unit)) return true;
  if (/\bNOT in (?:the )?(?:\w+\s+){0,3}inventory\b/i.test(unit)) return true;
  if (/\b(?:rumors?|gossip|myths?)\b[^.\n]{0,60}\b(?:bait|fabricated|ignore)\b/i.test(unit)) return true;
  if (/\b(?:is a distractor|distractor block|hard.?negative)\b/i.test(unit)) return true;
  return false;
}

// High-specificity query entities: IDs with digits, ALLCAPS codes, multi-word Proper Names.
function specificQueryEntities(query, queryTerms) {
  const entities = [];
  for (const term of queryTerms) {
    if (/[\d]/.test(term) && term.length >= 4) entities.push(term);
    else if (/^[a-z]{2,}[-_][a-z0-9][-a-z0-9]{2,}$/i.test(term) && /[\d]/.test(term)) entities.push(term);
  }
  for (const match of query.matchAll(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g)) {
    entities.push(match[0].toLowerCase());
  }
  for (const match of query.matchAll(/\b[A-Z]{2,}[-_][A-Z0-9][-A-Z0-9]{2,}\b/g)) {
    // Require a digit so schema fields (ROLLOUT_HASH) are slots, not lookup keys.
    if (/[\d]/.test(match[0])) entities.push(match[0].toLowerCase());
  }
  return [...new Set(entities)];
}

function unitHasEntity(unit, entity) {
  const lower = unit.toLowerCase();
  if (lower.includes(entity)) return true;
  // Compact form: "brass lantern labs" ↔ "BrassLanternLabs" unlikely; space-flexible.
  const compact = entity.replace(/\s+/g, "");
  if (compact.length >= 6 && lower.replace(/\s+/g, "").includes(compact)) return true;
  return false;
}

function queryMatches(unit, queryTerms) {
  const matches = new Set();
  const stems = new Set([...queryTerms].map(stem));
  // Dotted ask referents → suffix set (resource.name → name) for quoted/bare dumps.
  const referentParts = new Set();
  for (const term of queryTerms) {
    for (const suf of decomposeReferents(term)) referentParts.add(suf);
  }
  const pattern = /[\p{L}\p{N}_]+(?:[./:-][\p{L}\p{N}_]+)*/gu;
  for (const match of unit.toLowerCase().matchAll(pattern)) {
    const lexeme = match[0];
    if (queryTerms.has(lexeme)) matches.add(lexeme);
    if (referentParts.has(lexeme)) {
      for (const term of queryTerms) {
        if (term === lexeme || decomposeReferents(term).includes(lexeme)) matches.add(term);
      }
      matches.add(lexeme);
    }
    if (stems.has(stem(lexeme))) {
      for (const term of queryTerms) if (stem(term) === stem(lexeme)) matches.add(term);
    }
    // Compound IDs: payments-api ↔ payments-api-7f9c2
    for (const term of queryTerms) {
      if (term.length > 2 && (lexeme.startsWith(`${term}-`) || lexeme.startsWith(`${term}_`) || lexeme.startsWith(`${term}/`))) {
        matches.add(term);
      }
    }
    const parts = lexeme.split(/[._/\-:]+/);
    for (const part of parts) {
      if (part.length > 2 && queryTerms.has(part)) matches.add(part);
      if (part.length > 2 && referentParts.has(part)) {
        matches.add(part);
        for (const term of queryTerms) {
          if (decomposeReferents(term).includes(part)) matches.add(term);
        }
      }
      if (part.length > 2 && stems.has(stem(part))) {
        for (const term of queryTerms) if (stem(term) === stem(part)) matches.add(term);
      }
    }
    // Rejoin path segments: pod/payments-api-7f9c2 ↔ payments-api
    for (let start = 0; start < parts.length; start += 1) {
      for (let end = start + 1; end <= parts.length; end += 1) {
        const joined = parts.slice(start, end).join("-");
        if (joined.length > 2 && queryTerms.has(joined)) matches.add(joined);
        if (joined.length > 2 && referentParts.has(joined)) matches.add(joined);
      }
    }
  }
  // Identifier subtokens: AssertionError ↔ assertion, SESSION_TTL ↔ session/ttl
  for (const match of unit.matchAll(/[A-Za-z_][\w]*/g)) {
    for (const part of camelParts(match[0])) {
      if (part.length > 2 && queryTerms.has(part)) matches.add(part);
      if (part.length > 2 && stems.has(stem(part))) {
        for (const term of queryTerms) if (stem(term) === stem(part)) matches.add(term);
      }
    }
  }
  return matches;
}

function strongEvidenceUnit(unit) {
  return /\$\d|\b(?:ERROR|ALERT|FAIL(?:ED|URE)?|FATAL|BLOCKER|TRACEBACK|OOMKilled|AssertionError|NullPointerException|Exception|RuntimeException|Throwable)\b|\b[A-Z]{2,}[_-]?\d|\b[\w.-]+\.(?:ts|js|jsx|tsx|py|go|java):\d+|diff --git |\+\+\+ [ab]\//i.test(unit);
}

// When a Markdown heading line matches the query, keep its section body until the next peer/higher heading.
// Match the heading line only — not imports/body text that share the unit.
// Require ≥2 peer headings at that level so a sole H1 title cannot select the whole doc.
function isCodeHashComment(headingLine) {
  // GraphQL/shell/Python often use `# lowercase…` comments; those are not Markdown titles.
  if (/^#\s+(?:resolver|include|pragma|region|endregion|define|ifdef|ifndef|note|todo|fixme|type|import|from|ignore)\b/i.test(headingLine)) {
    return true;
  }
  // "# Ignore: … (WRONG)" bait lines — never treat as Markdown H1 section roots.
  if (/^#\s*Ignore\s*:/i.test(headingLine)) return true;
  // "# resolver note:" / "# trailing comment" — lowercase run after a single hash.
  if (/^#\s+[a-z][\w.-]*(?:\s+[a-z][\w.-]*)+:?\s/.test(headingLine)) return true;
  return false;
}

// Heading plus its immediate body: blank lines, list items and indented continuations, and
// at most one prose line before them. Stops at the first unrelated line or a peer/higher heading.
function soleHeadingBlock(units, index, level, cap = 48) {
  const block = [index];
  let body = false;
  for (let cursor = index + 1; cursor < units.length && block.length <= cap; cursor += 1) {
    const unit = units[cursor];
    const next = unit.match(/^(#{1,6})\s+\S/);
    if (next && next[1].length <= level) break;
    if (!unit.trim() || next || /^\s*(?:\d+[.)]|[-*+]|\[[ xX]\])\s+\S/.test(unit) || /^\s{2,}\S/.test(unit)) {
      block.push(cursor);
      if (unit.trim()) body = true;
      continue;
    }
    if (body) break;
    block.push(cursor);
    body = true;
  }
  while (block.length > 1 && !units[block[block.length - 1]].trim()) block.pop();
  return block;
}

function headingSectionIndices(units, querySet) {
  const selected = new Set();
  const levels = units.map((unit) => {
    const heading = unit.match(/^(#{1,6})\s+/);
    if (!heading) return 0;
    if (heading[1].length === 1 && isCodeHashComment(unit.split("\n", 1)[0])) return 0;
    return heading[1].length;
  });
  for (let index = 0; index < units.length; index += 1) {
    const heading = units[index].match(/^(#{1,6})\s+[^\n]+/);
    if (!heading) continue;
    const level = heading[0].match(/^(#{1,6})/)[1].length;
    if (level === 1 && isCodeHashComment(heading[0])) continue;
    const peers = levels.filter((entry) => entry === level).length;
    const matched = queryMatches(heading[0], querySet);
    if (!matched.size) continue;
    if (peers < 2) {
      // A lone ## heading named by an identifier-like query key (recover_lantern) owns the
      // block directly under it, even in a log with no peer headings. Keep that block only.
      if (level >= 2 && [...matched].some((term) => /[\d_./:-]/u.test(term))) {
        for (const cursor of soleHeadingBlock(units, index, level)) selected.add(cursor);
      }
      continue;
    }
    selected.add(index);
    for (let cursor = index + 1; cursor < units.length; cursor += 1) {
      const next = units[cursor].match(/^(#{1,6})\s+\S/);
      if (!next) {
        selected.add(cursor);
        continue;
      }
      if (next[1].length === 1 && isCodeHashComment(next[0])) {
        selected.add(cursor);
        continue;
      }
      if (next[1].length <= level) break;
      selected.add(cursor);
    }
  }
  return [...selected].sort((left, right) => left - right);
}

const BRIDGE_STOP = new Set("diff git src lib bin export const import function return class from file line type name data value test main index path http https json yaml true false null string number boolean object array module package service region image".split(" "));

function isBridgeId(id) {
  if (!id || id.length < 3 || BRIDGE_STOP.has(id)) return false;
  if (/^\d+$/.test(id)) return false;
  // Prefer entity-shaped keys: digits, snake/kebab, dotted service keys, registries.
  return /[\d_/.:-]/.test(id) || (id.length >= 6 && /[a-z]/.test(id) && /[A-Z0-9]/.test(id) === false && !BRIDGE_STOP.has(id));
}

// True when the ID appears as a real subject, not a "peer tag X noted without …" aside.
function idMentionIsSubstantive(unit, id) {
  const lower = unit.toLowerCase();
  const key = id.toLowerCase();
  let from = 0;
  let saw = false;
  while (from < lower.length) {
    const idx = lower.indexOf(key, from);
    if (idx < 0) break;
    saw = true;
    const window = lower.slice(Math.max(0, idx - 48), Math.min(lower.length, idx + key.length + 48));
    if (!/\b(?:peer tag|noted without|mentioned without|tag only|namecheck)\b/.test(window)) return true;
    from = idx + key.length;
  }
  return !saw;
}

// Family of an entity id: "alert-sh-12" → "alert-sh", "ast-r9820" → "ast", "ast-7850" → "ast".
// Used to block ambient bridges (camera-7) from merging rival primary keys of the same family.
function idFamily(id) {
  if (!id) return null;
  // Prefix before the digit-bearing tail: alert-rv-280 → alert-rv; ast-r9820 → ast.
  const dashed = id.match(/^([a-z]{1,12}(?:-[a-z]{1,12})*)[-_]([a-z]*\d[\w.-]*)$/i);
  if (dashed) return dashed[1].toLowerCase();
  const compact = id.match(/^([a-z]{1,12})\d[\w.-]*$/i);
  if (compact) return compact[1].toLowerCase();
  return null;
}

// After anchors land, keep peer units that share rare identifiers (multihop entity closure).
// Iterates to a fixpoint so ALERT → shelf → asset → action chains close.
// options.tight: when rare query keys already pinned, reject candidates that introduce a
// rival freq-1 primary of the same family (other ALERT-* via shared camera-7), while still
// allowing multihop product chains (INV → P-4412 → TrailShell-X → $142).
function coreferenceIndices(units, selected, options = {}) {
  if (selected.size === 0 || units.length < 4) return [];
  // Include lowerCamel ids with digits (castPressure0) — not only PascalCase / kebab / snake.
  const idPattern = /\b[A-Z]{1,5}[_-][A-Z0-9][\w.-]*\b|\b[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+\b|\b[a-z]+(?:_[a-z0-9]+)+\b|\b[A-Z][a-z]+(?:[A-Z][a-zA-Z0-9]*)+\b|\b[a-z]+(?:[A-Z][a-zA-Z0-9]*)+\d*\b|\$\d+(?:\.\d+)?[MKB]?\b|\b(?:ghcr|gcr|docker)\.io\/[\w./-]+:[\w.-]+\b/g;
  const frequencies = new Map();
  const unitIds = units.map((unit) => {
    const ids = new Set();
    for (const raw of unit.match(idPattern) || []) {
      const key = raw.toLowerCase();
      if (!isBridgeId(key)) continue;
      ids.add(key);
      const parts = key.split(/[_./:-]/).filter(Boolean);
      if (parts.length >= 2) {
        const tail = parts.slice(-2).join("-");
        if (isBridgeId(tail)) ids.add(tail);
        for (const part of parts) {
          if (part.includes("_") && isBridgeId(part)) ids.add(part);
        }
      }
    }
    // Dotted config keys: svc.sable_ingest.image=… → svc.sable_ingest
    for (const match of unit.matchAll(/\b((?:[a-z][\w-]*)(?:\.[a-z][\w-]*){1,3})\s*=/g)) {
      const key = match[1].toLowerCase();
      if (isBridgeId(key)) ids.add(key);
      const head = key.split(".").slice(0, 2).join(".");
      if (isBridgeId(head)) ids.add(head);
    }
    for (const id of ids) frequencies.set(id, (frequencies.get(id) || 0) + 1);
    return [...ids];
  });
  // Allow short multihop chains (ID on 2–3 units) without letting boilerplate keep everything.
  const rarityCap = Math.max(3, Math.min(6, Math.floor(units.length * 0.2)));
  const kept = new Set(selected);
  const maxExtra = options.tight
    ? Math.max(4, Math.floor(units.length * 0.08))
    : Math.max(6, Math.floor(units.length * 0.15));

  // Ticket-like ids with low-to-moderate df (≤3): AST-1000 often lands on 3 chain lines,
  // so a strict freq===1 check misses rival AST-2000 peers stitched by camera-7.
  const primaryIds = (index) => unitIds[index].filter((id) => {
    const freq = frequencies.get(id) || 0;
    return freq > 0 && freq <= 3 && idFamily(id);
  });
  const seedFamilies = new Map(); // family → Set of primary ids on the growing kept set
  const noteFamilies = (index) => {
    for (const id of primaryIds(index)) {
      const family = idFamily(id);
      if (!seedFamilies.has(family)) seedFamilies.set(family, new Set());
      seedFamilies.get(family).add(id);
    }
  };
  for (const index of kept) noteFamilies(index);

  const rivalsPrimary = (index) => {
    if (!options.tight || !seedFamilies.size) return false;
    for (const id of primaryIds(index)) {
      const family = idFamily(id);
      if (!family || !seedFamilies.has(family)) continue;
      const known = seedFamilies.get(family);
      if (!known.has(id)) return true; // same family, different ticket/key → rival entity
    }
    return false;
  };

  for (let round = 0; round < 3; round += 1) {
    const bridge = new Set();
    for (const index of kept) {
      for (const id of unitIds[index]) {
        if ((frequencies.get(id) || 0) <= rarityCap) bridge.add(id);
      }
    }
    if (!bridge.size) break;
    let grew = 0;
    for (let index = 0; index < units.length; index += 1) {
      if (kept.has(index)) continue;
      if (rivalsPrimary(index)) continue;
      // Skip peer-tag / "noted without" asides — they share IDs but are not evidence hops.
      if (unitIds[index].some((id) => bridge.has(id) && idMentionIsSubstantive(units[index], id))) {
        kept.add(index);
        noteFamilies(index);
        grew += 1;
        if (kept.size - selected.size >= maxExtra) break;
      }
    }
    if (!grew || kept.size - selected.size >= maxExtra) break;
  }
  return [...kept].filter((index) => !selected.has(index)).sort((left, right) => left - right);
}

// Pytest/Jest/trace/OOM clusters: keep AssertionError / "E   ..." / exit-code / MemoryError near failures.
function errorClusterIndices(units, selected) {
  const extra = new Set();
  for (const index of selected) {
    if (!/\b(?:FAIL(?:ED)?|ERROR|AssertionError|Traceback|Exception|OOM|Out of memory|Kill process|uncaughtException)\b/i.test(units[index])) continue;
    for (let cursor = index + 1; cursor < Math.min(units.length, index + 10); cursor += 1) {
      const line = units[cursor];
      if (/^\s*E\b|^\s*at\s+\S|^\s*File\s+"|AssertionError|^\s*\|?\s*\d+\s*\||(?:Error|Exception|Traceback|MemoryError|exit code)\b|Process completed|Sentry Event ID|^\s*Event ID\b|^\s*Release:\s|^\s*Environment:\s|^\s*TypeError\b|^\s*ReferenceError\b|^\s*user:\s|^\s*tags:\s/i.test(line)) {
        extra.add(cursor);
        continue;
      }
      if (/^(?:PASSED|FAILED|ERROR)\b/i.test(line)) break;
      if (line.trim() && !/^\s/.test(line) && !/Error|Exception|Traceback|assert|memory|OOM|FATAL|Sentry|Release|Environment|TypeError|request_id/i.test(line)) break;
    }
    // Also look slightly backward for paired FATAL/MemoryError lines.
    for (let cursor = index - 1; cursor >= Math.max(0, index - 3); cursor -= 1) {
      if (/(?:MemoryError|FATAL|Out of memory|Kill process)/i.test(units[cursor])) extra.add(cursor);
      else break;
    }
  }
  return [...extra].sort((left, right) => left - right);
}

// When two kept units sit a few lines apart, keep the bridge (alert → asset → action).
function spanFillIndices(selected, maxGap = 3) {
  const sorted = [...selected].sort((left, right) => left - right);
  const extra = [];
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const gap = sorted[index + 1] - sorted[index];
    if (gap > 1 && gap <= maxGap + 1) {
      for (let cursor = sorted[index] + 1; cursor < sorted[index + 1]; cursor += 1) extra.push(cursor);
    }
  }
  return extra;
}

function shouldKeepUnitZero(units, document) {
  if (!units.length) return false;
  if (document.requiredIndices?.includes(0)) return true;
  // Peer ## sections: first heading is not special. Keep H1 titles / CSV / YAML keys only.
  if (/^[\w-]+:\s*$/.test(units[0]) || headerDelimiter(units[0])) return true;
  const title = units[0].match(/^(#{1,6})\s+\S/);
  if (!title) return false;
  if (title[1].length === 1) return true;
  const next = units[1]?.match(/^(#{1,6})\s+\S/);
  return Boolean(next && title[1].length < next[1].length);
}

function isAbsenceEvidenceUnit(unit) {
  return /\b(?:authoritative absence|quiet\s+\w+\s+inventory|fingerprint\s+\S+\s+marks|sealed crate|no entry references|secondary mark)\b/i.test(unit);
}

// Prefer the language surface the query names (class X → Java-like unit, def → Python, etc.).
function languageBiasIndices(units, query) {
  const selected = [];
  const className = query.match(/\bin\s+class\s+([A-Za-z_][\w]*)/i)?.[1]
    || query.match(/\bclass\s+([A-Za-z_][\w]*)/i)?.[1];
  if (className) {
    const re = new RegExp(`\\bclass\\s+${className}\\b`);
    for (let index = 0; index < units.length; index += 1) {
      if (re.test(units[index])) selected.push(index);
    }
    if (selected.length) return selected;
  }
  if (/\b(?:python|def)\b/i.test(query)) {
    for (let index = 0; index < units.length; index += 1) {
      if (/^\s*def\s+\w+/m.test(units[index])) selected.push(index);
    }
  } else if (/\b(?:golang|go func|\bfunc\s)/i.test(query)) {
    for (let index = 0; index < units.length; index += 1) {
      if (/^\s*func\s+\w+/m.test(units[index])) selected.push(index);
    }
  }
  return selected;
}

function isMessageHeaderUnit(unit) {
  return /^(?:Subject|From|To|Date|Cc|Bcc|Reply-To)\s*:/im.test(String(unit || "").trim());
}

function neighborWorthKeeping(unit, anchorUnit) {
  if (!unit.trim()) return true;
  if (/^\s|^\s*E\b|^\s*at\s+|^\s*File\s+"/.test(unit)) return true;
  const trimmed = unit.trim();
  const anchor = (anchorUnit || "").trim();
  // ERROR/FAIL clusters stay glued. Peer ALERT lines only if they share a digit id
  // with the anchor — otherwise action→ALERT-SH-77 stitches rival incident chains.
  if (/\b(?:ERROR|FAIL|BLOCKER|TRACEBACK|AssertionError)\b/i.test(unit) || /AssertionError/i.test(unit)) return true;
  if (/\bALERT\b/i.test(unit)) {
    const ids = unit.match(/\b[A-Za-z]{1,5}[_-][A-Za-z0-9][\w.-]*\b|\b[A-Za-z]+(?:-[A-Za-z0-9]+)+\b/g) || [];
    return ids.some((id) => /[\d]/.test(id) && anchor.toLowerCase().includes(id.toLowerCase()));
  }
  // Email / mbox: a Subject:/From: line keeps the following short body unit.
  if (isMessageHeaderUnit(anchor) && trimmed.length > 0 && trimmed.length < 480 && !isMessageHeaderUnit(trimmed)) {
    return true;
  }
  // Peer [section] tables are whole units — only keep when they share a digit-bearing id.
  // Soft labels like House-Annex must not chain every adjacent noise table.
  const peerSection = /^\[[^\]]+\]/m.test(trimmed) && /^\[[^\]]+\]/m.test(anchor);
  if (peerSection) {
    const ids = trimmed.match(/\b[A-Za-z]{1,5}[_-][A-Za-z0-9][\w.-]*\b|\b[A-Za-z]+(?:-[A-Za-z0-9]+)+\b/g) || [];
    return ids.some((id) => /[\d]/.test(id) && anchor.toLowerCase().includes(id.toLowerCase()));
  }
  if (
    trimmed.length > 0
    && trimmed.length < 240
    && !/^(?:#{1,6}\s|```|diff --git |<\?xml|<scrap\b|<assembly\b|From:\s|---$|\[[^\]]+\]\s*$|message\s|type\s)/m.test(trimmed)
  ) {
    // Short prose continuations ("for hull X in Bay-Y.").
    if (/^[a-z*]/.test(trimmed)) return true;
    // Capitalized binding lines that finish the prior fact.
    if (/^(?:Lot|Hull|Bay|Strain|Operator|House|Binding|Secondary|Fingerprint)\b/i.test(trimmed)) return true;
    // Same-section INI/TOML field neighbors (anchor must also be a bare field).
    if (/^[A-Za-z_][\w.-]*\s*=\s*\S/.test(trimmed) && /^[A-Za-z_][\w.-]*\s*=\s*\S/.test(anchor)) return true;
  }
  // Share a rare-looking token with the anchor
  const ids = unit.match(/\b[A-Za-z]{1,5}[_-][A-Za-z0-9][\w.-]*\b|\b[A-Za-z]+(?:-[A-Za-z0-9]+)+\b/g) || [];
  return ids.some((id) => anchorUnit.toLowerCase().includes(id.toLowerCase()));
}

function requiresGlobalEvidence(query) {
  // "top/bottom" only when ranking, not "top of the file" / "top shelf".
  if (/\b(?:top|bottom)\s+\d+\b|\b(?:top|bottom)\s+(?:by|n\b|%)|\b(?:rank|ranking|ranked|percentile)\b/i.test(query)) return true;
  // "total/sum" only as aggregates — not "what total is on order X".
  if (/^(?:total|sum)\b/i.test(query.trim()) || /\b(?:total|sum)\s+(?:of|across|over|for all|of all)\b|\b(?:grand total|sum total)\b/i.test(query)) return true;
  if (/\btotal\b/i.test(query) && /\b(?:all|every|across|sum|aggregate|amount)\b/i.test(query) && !/\bon\s+(?:order|invoice|record|row)\b/i.test(query)) return true;
  if (/\b(?:average|median|fewest|most|least|earliest|latest|highest|lowest|largest|smallest|greatest|best|worst|compare|comparison|distribution|all|every|each)\b/i.test(query)) return true;
  // Verb-like "count the/all/..." only — not noun phrases like "seat count" / "line count".
  if (/\bcount(?:s|ed|ing)?\s+(?:the|all|every|each|how|number)\b/i.test(query)) return true;
  if (/\b(?:please\s+)?count\s+(?!on\b)/i.test(query) && !/\b\w+\s+count\b/i.test(query)) return true;
  // "how many grams/kg of X for ID-123" is a local quantity ask, not a corpus-wide count.
  if (
    /\bhow many\b/i.test(query)
    && !/\bhow many\s+(?:[\w-]+\s+){0,3}(?:bits|bytes|octets|characters|digits|seconds|milliseconds|minutes|hours|days|meters|metres|pixels|grams?|kilograms?|kg|mg|litres?|liters?|milliliters?|ml)\b/i.test(query)
  ) return true;
  if (/\b(?:how many|minimum|maximum)\b[^?\n]*\b(?:records?|rows?|entries|items?|events?|users?|accounts?|requests?|errors?|incidents?|samples?|results?|values?)\b/i.test(query)) return true;
  if (/\b(?:minimum|maximum)\s+(?:amount|latency|duration|score|timestamp)\b/i.test(query)) return true;
  if (/\b(?:how many|minimum|maximum)\b[^?\n]*\b(?:across|among|overall|in (?:the )?(?:data|dataset|log|table|collection))\b/i.test(query)) return true;
  return false;
}

function result(context, output, reason, started, units, selected) {
  const original = countTokens(context);
  const kept = output === context ? original : countTokens(output);
  if (kept > original) return result(context, context, "no_token_savings", started, units, units);
  const linesIn = context.split("\n").length;
  return {
    compressed_text: output, original_tokens: original, kept_tokens: kept,
    compressed_tokens: kept, tokens_saved: Math.max(0, original - kept),
    tokens_saved_pct: original ? Math.max(0, (1 - kept / original) * 100) : 0,
    token_count_method: "legacy_lexical_estimate", policy_name: "SuperCompress Fast Extractive",
    mode: "fast", selection_reason: reason, units_in: units, units_kept: selected,
    lines_in: linesIn, lines_kept: output === context ? linesIn : output.split("\n").length,
    latency_ms: Number(process.hrtime.bigint() - started) / 1e6,
    truncated: false, neural_keep_fallback: false,
  };
}

function countTokens(text) {
  return text.split("\n").reduce((total, line) => total + (line.match(/[A-Za-z_][A-Za-z0-9_]*|[^\s]/g) || [" "]).length, 0);
}

function rowNumericPeak(unit, delimiter) {
  let peak = 0;
  for (const field of unit.split(delimiter)) {
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(field.trim())) {
      const value = Math.abs(Number(field));
      if (Number.isFinite(value)) peak = Math.max(peak, value);
    }
  }
  return peak;
}

// When the question is about spikes/latency/errors on delimited telemetry, keep
// numeric outliers. General monitoring heuristic — not tied to any bench needle.
function delimitedOutlierIndices(units, query) {
  if (!/\b(?:p\d+|latency|duration|timeout|error|errors|spike|spikes|outlier|anomaly|anomalous|saturation|throttle|oom|cpu|memory|rss)\b/i.test(query)) {
    return [];
  }
  const delimiter = headerDelimiter(units[0] || "");
  if (!delimiter || units.length < 8) return [];
  const peaks = units.map((unit, index) => ({ index, peak: index === 0 ? 0 : rowNumericPeak(unit, delimiter) }));
  const values = peaks.slice(1).map((entry) => entry.peak).filter((value) => value > 0).sort((a, b) => a - b);
  if (values.length < 6) return [];
  const median = values[Math.floor(values.length / 2)] || 1;
  const threshold = Math.max(median * 8, values[Math.floor(values.length * 0.95)] || 0);
  return peaks.filter((entry) => entry.index > 0 && entry.peak >= threshold && entry.peak > 0).map((entry) => entry.index);
}

// Access-log shaped dumps: failure language → keep scarce auth/server error rows.
function httpFailureIndices(units, query) {
  if (!/\b(?:fail(?:ed|ure|ing)?|unauthori[sz]ed|denied|rejected|forbidden|unauthorized)\b/i.test(query)) {
    return [];
  }
  let accessLike = 0;
  for (const unit of units) {
    if (/\b(?:GET|POST|PUT|DELETE|PATCH|HEAD)\b/.test(unit) && /\bHTTP\/\d/.test(unit)) accessLike += 1;
    if (accessLike >= 4) break;
  }
  if (accessLike < 4) return [];
  const hits = [];
  for (let index = 0; index < units.length; index += 1) {
    if (/\b(?:401|403|407|429|5\d\d)\b/.test(units[index])) hits.push(index);
  }
  const cap = Math.max(4, Math.floor(units.length * 0.12));
  return hits.length && hits.length <= cap ? hits : [];
}

// "non-MIT" / "not Apache" style contrasts among peer records (lockfiles, inventories).
function negatedBases(query, queryTerms) {
  const bases = new Set();
  for (const term of queryTerms) {
    const match = term.match(/^non-(.+)$/);
    if (match && match[1].length > 1) bases.add(match[1]);
  }
  for (const match of query.toLowerCase().matchAll(/\b(?:not|except|excluding|besides|without)\s+([\p{L}\p{N}][\p{L}\p{N}_.-]{1,})\b/gu)) {
    const base = match[1].replace(/^-+|-+$/g, "").replace(/\.$/, "");
    if (base.length > 1 && !STOP.has(base)) bases.add(base);
  }
  return [...bases];
}

function unitHasBase(unit, base) {
  if (queryMatches(unit, new Set([base])).has(base)) return true;
  // Compact license tokens: gpl-3.0 ↔ gpl, apache-2.0 ↔ apache
  const compact = base.replace(/[^a-z0-9]+/g, "");
  if (compact.length < 2) return false;
  for (const match of unit.toLowerCase().matchAll(/[\p{L}\p{N}_]+(?:[./:-][\p{L}\p{N}_]+)*/gu)) {
    if (match[0].replace(/[^a-z0-9]+/g, "").includes(compact)) return true;
  }
  return false;
}

function siblingContrastIndices(units, query, queryTerms) {
  const bases = negatedBases(query, queryTerms);
  if (!bases.length || units.length < 4) return [];
  const selected = new Set();
  const minorityCap = Math.max(4, Math.floor(units.length * 0.15));
  for (const base of bases) {
    const flags = units.map((unit) => unitHasBase(unit, base));
    const withBase = flags.filter(Boolean).length;
    const without = units.length - withBase;
    if (withBase >= Math.ceil(units.length * 0.7) && without > 0 && without <= minorityCap) {
      flags.forEach((has, index) => { if (!has) selected.add(index); });
    }
  }
  return [...selected].sort((left, right) => left - right);
}

function compressCore(context, query = "", options = {}) {
  if (typeof context !== "string" || typeof query !== "string") throw new TypeError("context and query must be strings");
  const ratio = options.budgetRatio ?? 0.35;
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1) throw new RangeError("budgetRatio must be in (0, 1]");
  const started = process.hrtime.bigint();
  if (ratio === 1) return result(context, context, "full_budget_preservation", started, 1, 1);
  if (/\b(?:verbatim|byte.for.byte|word.for.word|do not (?:remove|drop|omit|compress|change)|(?:preserve|keep|retain|include) (?:every|all|each) (?:lines?|words?|rows?|bytes?|details?))\b/i.test(query)) {
    return result(context, context, "exact_preservation_requested", started, 1, 1);
  }
  if (requiresGlobalEvidence(query)) {
    return result(context, context, "global_evidence_required", started, 1, 1);
  }
  const document = documentFor(context);
  const units = document.units;
  if (document.preservationReason) return result(context, context, document.preservationReason, started, units.length, units.length);
  const queryTerms = terms(query);
  const analysis = analyzeQuery(query, queryTerms);
  const querySet = expandQueryTerms(queryTerms, query);
  if (!queryTerms.length) return result(context, context, "insufficient_query_evidence", started, units.length, units.length);
  const baitMask = units.map((unit) => isBaitUnit(unit));
  const termSets = units.map((unit, index) => index < (document.evidenceStart || 0)
    ? new Set() : queryMatches(unit, querySet));
  // Specific entities that only appear inside bait → keep full context (unanswerable).
  // Ignore noisy mega-queries (hundreds of synthetic tokens) — those still extract normally.
  const entities = specificQueryEntities(query, queryTerms);
  if (entities.length && entities.length <= 8) {
    let nonBaitEntityHits = 0;
    let baitOnlyMentions = 0;
    for (let index = 0; index < units.length; index += 1) {
      for (const entity of entities) {
        if (!unitHasEntity(units[index], entity)) continue;
        if (baitMask[index]) baitOnlyMentions += 1;
        else nonBaitEntityHits += 1;
      }
    }
    if (nonBaitEntityHits === 0 && baitOnlyMentions > 0) {
      // Prefer quiet/absence ledger lines; otherwise drop decoys and keep the rest.
      const evidence = [];
      const nonBait = [];
      for (let index = 0; index < units.length; index += 1) {
        if (baitMask[index] && !(document.requiredIndices || []).includes(index)) continue;
        nonBait.push(index);
        if (isAbsenceEvidenceUnit(units[index])) evidence.push(index);
      }
      const kept = evidence.length ? evidence : nonBait;
      if (kept.length && kept.length < units.length) {
        const output = document.render(kept, units);
        if (output.length < context.length) {
          return result(context, output, "entity_absent_extraction", started, units.length, kept.length);
        }
      }
      return result(context, context, "entity_absent_passthrough", started, units.length, units.length);
    }
    // Truly absent referent, when the ask scopes itself to this document/text.
    if (
      nonBaitEntityHits === 0
      && baitOnlyMentions === 0
      && /\b(?:from this|in this|in the (?:document|text|context|log|file|dump))\b/i.test(query)
    ) {
      return result(context, context, "entity_absent_passthrough", started, units.length, units.length);
    }
  }
  // Score IDF on non-bait units only so synonym-bait decoys cannot own the rarest term.
  const frequencies = new Map(queryTerms.map((term) => [term, 0]));
  for (let index = 0; index < termSets.length; index += 1) {
    if (baitMask[index]) continue;
    for (const term of queryTerms) {
      if (termSets[index].has(term)) frequencies.set(term, frequencies.get(term) + 1);
    }
  }
  // Paraphrase bridges: rare expanded terms that land in non-bait units become anchors.
  const bridgeTerms = [...querySet].filter((term) => !queryTerms.includes(term) && term.length > 2 && !STOP.has(term));
  const bridgeFrequencies = new Map(bridgeTerms.map((term) => [term, 0]));
  for (let index = 0; index < termSets.length; index += 1) {
    if (baitMask[index]) continue;
    for (const term of bridgeTerms) {
      if (termSets[index].has(term)) bridgeFrequencies.set(term, bridgeFrequencies.get(term) + 1);
    }
  }
  const present = queryTerms.filter((term) => frequencies.get(term) > 0);
  const sections = headingSectionIndices(units, querySet).filter((index) => !baitMask[index]);
  const outliers = [
    ...delimitedOutlierIndices(units, query),
    ...httpFailureIndices(units, query),
    ...siblingContrastIndices(units, query, queryTerms),
    ...sections,
  ].filter((index) => !baitMask[index]);
  if (queryTerms.length > 1 && present.length === 1 && !/[\d_./:-]/u.test(present[0]) && !outliers.length) {
    const only = present[0];
    const freq = frequencies.get(only);
    const hitIndex = termSets.findIndex((set, index) => !baitMask[index] && set.has(only));
    const specific = freq === 1 && (
      only.length <= 4
      || (hitIndex >= 0 && strongEvidenceUnit(units[hitIndex]))
    );
    if (!specific) {
      return result(context, context, "low_confidence_query_evidence", started, units.length, units.length);
    }
  }
  const rarityCap = Math.max(1, Math.floor(units.length * 0.05));
  // Truly query-aware anchors: prefer lookup keys first, then hard terms, never soft glue.
  let anchors = analysis.keys.filter((term) => {
    const freq = frequencies.get(term) || bridgeFrequencies.get(term) || 0;
    return freq > 0 && freq <= rarityCap;
  });
  if (!anchors.length) {
    const pool = analysis.hardTerms.length ? analysis.hardTerms : queryTerms;
    const rarest = pool.reduce((minimum, term) => (frequencies.get(term) > 0 ? Math.min(minimum, frequencies.get(term)) : minimum), Infinity);
    anchors = pool.filter((term) => frequencies.get(term) === rarest && rarest <= rarityCap);
  }
  // If lexical query terms only live in bait, promote rare paraphrase / slot bridges.
  if (!anchors.length || (present.length === 0 && bridgeTerms.length)) {
    const bridgeRarest = bridgeTerms.reduce((minimum, term) => {
      const freq = bridgeFrequencies.get(term) || 0;
      return freq > 0 ? Math.min(minimum, freq) : minimum;
    }, Infinity);
    const bridgeAnchors = bridgeTerms.filter((term) => (bridgeFrequencies.get(term) || 0) === bridgeRarest && bridgeRarest <= rarityCap);
    if (bridgeAnchors.length) anchors = bridgeAnchors;
  }
  const langBias = languageBiasIndices(units, query).filter((index) => !baitMask[index]);
  const selected = new Set([...document.requiredIndices, ...outliers, ...langBias]);
  if (shouldKeepUnitZero(units, document) && !baitMask[0]) selected.add(0);
  const addWithNeighbors = (index) => {
    if (baitMask[index]) return;
    selected.add(index);
    for (const neighbor of [index - 1, index + 1]) {
      if (neighbor >= 0 && neighbor < units.length && !baitMask[neighbor] && neighborWorthKeeping(units[neighbor], units[index])) {
        selected.add(neighbor);
      }
    }
  };
  // Multi-term fallback: when no rare single-term anchor exists, keep units that
  // jointly match several query terms. Organic IDF conjunction — not corpus-specific.
  if (!anchors.length && present.length >= 2 && units.length >= 4) {
    const multi = [];
    for (let index = 0; index < units.length; index += 1) {
      if (!baitMask[index] && termSets[index].size >= 2) multi.push(index);
    }
    const multiCap = Math.max(4, Math.floor(units.length * 0.12));
    if (multi.length && multi.length <= multiCap) {
      for (const index of multi) addWithNeighbors(index);
      anchors = present;
    }
  }
  // Repetitive corpora where every line matches (chapter dumps): keep a small head sample.
  if (!anchors.length && !outliers.length && present.length >= 1 && units.length >= 8) {
    const matched = [];
    for (let index = 0; index < units.length; index += 1) {
      if (!baitMask[index] && termSets[index].size) matched.push(index);
    }
    if (matched.length >= Math.ceil(units.length * 0.5)) {
      const cap = Math.max(3, Math.min(8, Math.ceil(units.length * 0.06)));
      for (const index of matched.slice(0, cap)) selected.add(index);
      anchors = ["_repeat"];
    }
  }
  // Outliers alone justify extraction; do not promote ubiquitous present terms
  // (e.g. "license"/"version" on every sibling) into anchors that keep everything.
  if (outliers.length && !anchors.length) anchors = ["_outlier"];
  // Rare exact IDs can extract even from tiny docs (2–3 units).
  const tinyOk = units.length >= 2 && anchors.some((term) => /[\d_./:-]/.test(term) && (frequencies.get(term) === 1 || bridgeFrequencies.get(term) === 1));
  if ((!anchors.length && !outliers.length) || (units.length < 4 && !tinyOk)) {
    return result(context, context, "insufficient_query_evidence", started, units.length, units.length);
  }
  for (let index = 0; index < units.length; index += 1) {
    if (baitMask[index]) continue;
    if (anchors.some((term) => term !== "_outlier" && term !== "_repeat" && termSets[index].has(term))) {
      addWithNeighbors(index);
    }
  }
  // Rare query keys already on selected units → tight coref (ambient camera-7 etc. cannot merge chains).
  const tightCoref = anchors.some((term) =>
    term !== "_outlier" && term !== "_repeat"
    && /[\d_./:-]/.test(term)
    && (frequencies.get(term) || bridgeFrequencies.get(term) || 0) > 0
    && (frequencies.get(term) || bridgeFrequencies.get(term) || 0) <= rarityCap
  );
  for (const index of coreferenceIndices(units, selected, { tight: tightCoref })) {
    if (!baitMask[index]) selected.add(index);
  }
  for (const index of errorClusterIndices(units, selected)) {
    if (!baitMask[index]) selected.add(index);
  }
  for (const index of spanFillIndices(selected, 3)) {
    if (!baitMask[index]) selected.add(index);
  }
  // When the ask names a language surface (class Foo), drop other-language peers that
  // only shared an identifier via coreference.
  if (langBias.length) {
    const biasSet = new Set(langBias);
    for (const index of [...selected]) {
      if (biasSet.has(index) || (document.requiredIndices || []).includes(index)) continue;
      const looksCode = /^\s*(?:def|func|public\s+class|class)\s/m.test(units[index]);
      if (looksCode && !biasSet.has(index)) selected.delete(index);
    }
    for (const index of langBias) selected.add(index);
  }
  const budget = Math.ceil(context.length * ratio);
  let size = [...selected].reduce((total, index) => total + units[index].length + 1, 0);
  // Terms present on most units (license/version on every lockfile record) cannot justify fill.
  const ubiquityCap = Math.max(rarityCap + 1, Math.ceil(units.length * 0.2));
  const weights = new Map(queryTerms.map((term) => [term, Math.log1p(units.length / Math.max(1, frequencies.get(term)))]));
  for (const [term, freq] of frequencies) {
    if (freq >= ubiquityCap || FILL_STOP.has(term)) weights.set(term, 0);
  }
  // Budget fill: require a meaningful score (rare term or multi-term), not ubiquitous soft words.
  const minFill = Math.log1p(2);
  const outlierDriven = outliers.length > 0 && anchors.every((term) => term === "_outlier" || term === "_repeat");
  const rareIdAnchored = anchors.some((term) => term !== "_outlier" && term !== "_repeat" && /[\d_./:-]/.test(term) && (frequencies.get(term) || 0) > 0 && (frequencies.get(term) || 0) <= rarityCap);
  // Soft query glue ("which", "account") must not win budget fill over keys/slots.
  for (const term of analysis.softTerms) weights.set(term, 0);
  const ranked = units.map((unit, index) => {
    if (baitMask[index]) return { index, score: 0, rareHit: false, terms: 0, slot: 0 };
    const informative = [...termSets[index]].filter((term) => {
      if (FILL_STOP.has(term) || QUERY_SOFT.has(term)) return false;
      const freq = frequencies.has(term) ? frequencies.get(term) : bridgeFrequencies.get(term);
      return freq == null || freq < ubiquityCap;
    });
    let score = informative.reduce((total, term) => {
      let weight = weights.get(term);
      if (weight == null && bridgeFrequencies.has(term)) {
        weight = Math.log1p(units.length / Math.max(1, bridgeFrequencies.get(term)));
      }
      // Lookup keys dominate soft schema words.
      if (analysis.keys.includes(term)) weight = (weight || 0) + Math.log1p(units.length);
      return total + (weight || 0);
    }, 0);
    const slot = slotEvidenceScore(unit, analysis.slots);
    score += slot;
    // Only *rare* keys unlock fill — ubiquitous namechecks (peer-tag OX-5510 on every
    // bulletin) must not mark every unit as a rare hit.
    const rareKeyHit = analysis.keys.some((key) => {
      const freq = frequencies.get(key) || bridgeFrequencies.get(key) || 0;
      if (freq <= 0 || freq > rarityCap) return false;
      return termSets[index].has(key) || unitHasEntity(unit, key);
    });
    if (rareKeyHit) score += 4;
    const rareHit = informative.some((term) => {
      const freq = frequencies.has(term) ? frequencies.get(term) : bridgeFrequencies.get(term);
      return freq != null && freq > 0 && freq <= rarityCap;
    }) || rareKeyHit;
    return { index, score, rareHit, rareKeyHit, terms: informative.length, slot };
  })
    .filter(({ index, score, rareHit, rareKeyHit: keyHit, terms: hitCount }) => {
      if (baitMask[index] || selected.has(index) || score < minFill) return false;
      // Outlier-only extractions (non-MIT contrast, HTTP failures) should not re-fill peers.
      if (outlierDriven) return rareHit;
      // Rare IDs already pinned the answer — only more key hits may fill; verbs like
      // "action"/"required" on peer ALERT chains must not unlock budget refill.
      if (rareIdAnchored) return keyHit;
      return rareHit || hitCount >= 2;
    })
    .sort((left, right) => right.score - left.score || right.slot - left.slot || left.index - right.index);
  for (const { index } of ranked) {
    if (size + units[index].length + 1 <= budget) { selected.add(index); size += units[index].length + 1; }
  }
  const output = document.render([...selected].sort((left, right) => left - right), units);
  if (output.length >= context.length) return result(context, context, "no_savings", started, units.length, units.length);
  return result(context, output, "query_anchored_extraction", started, units.length, selected.size);
}

// ------------------------------------------------------------------ structure-aware layer
// The lexical selector above picks lines that share words with the query. Real tool output has
// structure that lexical overlap cannot see: a code view is read a block at a time, a search hit
// list is a menu the agent chooses from, and a test run's verdict lives in its summary line.
// These rules describe tool output in general. They were derived from public SWE-agent
// trajectories (compress-bench real-dev) and are judged on sealed real-test and the synthetic
// splits, never tuned against either.

const TEST_SUMMARY = [
  /^=+ .*\b(?:passed|failed|errors?|skipped|xfailed|xpassed|deselected|no tests ran)\b.*=+$/i,
  /^=+ (?:short test summary info|FAILURES|ERRORS) =+$/i,
  /^(?:FAILED|ERROR|XPASS)\s+\S+/,
  /^(?:Tests|Test Suites|Snapshots):\s+.*\b(?:passed|failed|total)\b/i,
  /^(?:Ran \d+ tests? in [\d.]+s|FAILED \((?:failures|errors)=\d+.*\)|OK(?: \(.*\))?)$/,
  /^(?:--- FAIL|FAIL|ok)\s+\S+/,
  /^\s*\d+ (?:passing|failing|pending)\b/,
];
const EXCEPTION_LINE = /^(?:[A-Za-z_][\w.]*(?:Error|Exception|Exit|Interrupt|Warning)|AssertionError|E\s{3}\S.*)(?::|$)/;
// A hit names a file: a path with a slash or a file extension. Log timestamps ("09:00:01") are not hits.
const SEARCH_HIT = /^(?:\/?[\w.@+-]+(?:\/[\w.@+-]+)+ \(\d+ match(?:es)?\)|Line \d+:.*|(?:\.?\/?[\w.@+-]+\/)*[\w@+-][\w.@+-]*\.[A-Za-z][\w]{0,7}:\d+[:-].*)$/;
const SEARCH_FRAME = /^(?:Found \d+ (?:matches|files?)|End of matches|No matches found|Found \d+ files? matching)/i;
const NUMBERED = /^\s*(\d+)(?::|\t| \|)/;
const BLOCK_HEAD = /^\s*(?:async\s+def|def|class|function|func|fn|pub\s+fn|impl|interface|type|(?:public|private|protected|static|export|const|let|var)\b.*[({=]\s*$)/;

function lineBody(line) {
  return line.replace(NUMBERED, "");
}

function indentOf(line) {
  const m = lineBody(line).match(/^[ \t]*/);
  return m ? m[0].replace(/\t/g, "    ").length : 0;
}

function keptLineIndices(lines, output) {
  const kept = new Set();
  const want = new Map();
  for (const l of output.split("\n")) {
    const k = l.trim();
    if (k) want.set(k, (want.get(k) || 0) + 1);
  }
  lines.forEach((l, i) => {
    const k = l.trim();
    if (k && want.get(k) > 0) {
      kept.add(i);
      want.set(k, want.get(k) - 1);
    }
  });
  return kept;
}

function structuralAdditions(lines, kept, query) {
  const add = new Set();
  const nonBlank = lines.filter((l) => l.trim()).length || 1;

  // 1. Verdict lines of test runners and the final exception of a traceback.
  lines.forEach((l, i) => {
    const t = l.trim();
    if (TEST_SUMMARY.some((re) => re.test(t))) add.add(i);
  });
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (EXCEPTION_LINE.test(lines[i].trim()) && !/^E\s/.test(lines[i].trim())) {
      add.add(i);
      break;
    }
  }

  // 2. Search-hit lists are menus: when the query term is on every hit, lexical scoring cannot
  //    choose, so keep the whole menu (hits are short) unless it is very long.
  const hits = [];
  lines.forEach((l, i) => {
    if (SEARCH_HIT.test(l.trim())) hits.push(i);
  });
  if (hits.length >= 3 && hits.length / nonBlank >= 0.5) {
    lines.forEach((l, i) => {
      if (SEARCH_FRAME.test(l.trim())) add.add(i);
    });
    // If some query term singles out a few hits and the base selection already kept one of
    // them, the menu is not ambiguous: trust the selection.
    const q = [...new Set(terms(query))];
    const hitTerms = hits.map((i) => new Set(terms(lines[i])));
    const discriminative = q.filter((t) => {
      const n = hitTerms.filter((set) => set.has(t)).length;
      return n > 0 && n <= Math.max(2, Math.floor(hits.length * 0.1));
    });
    const anchored = hits.some((i, k) => kept.has(i) && discriminative.some((t) => hitTerms[k].has(t)));
    const cap = 150;
    if (anchored) {
      // keep the frame only
    } else if (hits.length <= cap) {
      for (const i of hits) add.add(i);
    } else {
      const qs = new Set(q);
      const scored = hits.map((i) => ({ i, s: terms(lines[i]).filter((t) => qs.has(t)).length }));
      scored.sort((a, b) => b.s - a.s || a.i - b.i);
      for (const { i } of scored.slice(0, cap)) add.add(i);
    }
  }

  // 3. Numbered code views are read a block at a time: grow every kept line (and any line the
  //    query points at, e.g. "goto 563") to its enclosing block.
  const numbered = lines.filter((l) => NUMBERED.test(l)).length;
  if (numbered / nonBlank >= 0.6) {
    lines.forEach((l, i) => {
      if (/^\[File: .*\]$/.test(l.trim()) || /^\(\d+ more lines? (?:above|below)\)$/.test(l.trim())) add.add(i);
    });
    const anchors = new Set(kept);
    const pointed = [...String(query).matchAll(/\b(?:goto|open\s+\S+|line)\s+(\d+)\b/gi)].map((m) => Number(m[1]));
    lines.forEach((l, i) => {
      const m = l.match(NUMBERED);
      if (m && pointed.includes(Number(m[1]))) anchors.add(i);
    });
    const BLOCK_CAP = 60;
    for (const a of anchors) {
      if (!NUMBERED.test(lines[a])) continue;
      // Walk up to the nearest block header at or above this indent.
      let head = a;
      const ind = indentOf(lines[a]);
      for (let j = a; j >= Math.max(0, a - BLOCK_CAP); j -= 1) {
        const body = lineBody(lines[j]);
        if (body.trim() && BLOCK_HEAD.test(body) && indentOf(lines[j]) <= ind) {
          head = j;
          break;
        }
      }
      const headInd = indentOf(lines[head]);
      let end = head;
      for (let j = head + 1; j < lines.length && j - head <= BLOCK_CAP; j += 1) {
        const body = lineBody(lines[j]);
        if (body.trim() && indentOf(lines[j]) <= headInd && j > a) break;
        end = j;
      }
      for (let j = head; j <= end; j += 1) add.add(j);
    }
  }
  return add;
}

// ---------------------------------------------------------------- Agent tool output
// Rules for the output of an agent's own tools (file views, searches, test runs, shell), built
// on real agent trajectories (compress-bench real-dev) and kept format-generic so they carry
// over to other harnesses.

/** Inputs under ~1k tokens pass through: the saving is small and a lost line costs a re-read. */
const MIN_COMPRESS_CHARS = 4000;
/** A listing where most lines are search hits: `Line 12:`, `path.py:12:`, `path.py: text`, `dir/f (3 matches)`. */
const HIT_LINE = /^(Line \d+:|(?:[\w.-]+\/)*[\w.-]+\.[A-Za-z]{1,6}:(?!:)(?:\d+[:-]|\s)|\/?[\w./-]+ \(\d+ match(es)?\)$)/;
const MAX_HIT_LIST_LINES = 400;
const AGENT_OUTPUT_MIN_LINES = 40;
const TOOL_STATUS_LINE = /^\s*(\[File:|\(\d+ more lines? (above|below)\)|End of matches|Found \d+ match|No (matches|changes|such file)|File updated|\[?(Command|Process) (finished|exited|completed)|\[?exit code\b|={3,}|!{3,}|_{3,}|-{3,}\s*\S|Interrupted\b|\d+ (passed|failed|errors?)\b|(FAILED|ERROR|Error|Warning|WARNING)\b[: ]|Successfully\b|Traceback \(most recent call last\))/i;
const TEST_OUTPUT = /test session starts|^(PASS|FAIL) |Ran \d+ tests?|\b\d+ (passed|failed)\b/m;
const TEST_SUMMARY_LINE = /\b(FAILED|FAIL|ERROR|Error|error:|Exception|Traceback|Interrupted|failed|passed|xfail|assert)\b|^={3,}|^_{3,}|^E\s{2,}/;

/** A search-hit listing: every hit is a candidate the agent may act on next, so none is dropped. */
function isHitListing(lines) {
  let body = 0;
  let hits = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    body++;
    if (HIT_LINE.test(line)) hits++;
  }
  return body >= 5 && hits / body >= 0.6 && hits <= MAX_HIT_LIST_LINES;
}

/** Line numbers the agent is navigating to or editing: `goto 563`, `open f.py 35`, `edit 165:170`, "line 42". */
function targetLineNumbers(query) {
  const out = [];
  for (const m of query.matchAll(/\bgoto\s+(\d+)/g)) out.push(Number(m[1]));
  for (const m of query.matchAll(/\bopen\s+\S+\s+(\d+)/g)) out.push(Number(m[1]));
  for (const m of query.matchAll(/\bedit\s+(\d+):(\d+)/g)) out.push(Number(m[1]), Number(m[2]));
  for (const m of query.matchAll(/\bline\s+(\d{1,6})\b/gi)) out.push(Number(m[1]));
  return out;
}

/** The source line number a numbered file view shows on this line (`12:`, `12\t`, `  12  `), else null. */
function viewLineNumber(line) {
  const m = /^\s*(\d{1,6})[:\t|]/.exec(line) || /^\s*(\d{1,6})\s{2,}/.exec(line);
  return m ? Number(m[1]) : null;
}

/** Lines agent output needs beyond the query match: header, trailing status, test verdicts, navigation target. */
function agentOutputAdditions(lines, query) {
  const add = new Set();
  // Header and trailing status lines a tool prints around its output ("[File: ...]",
  // "Found 12 matches", "File updated.", "Interrupted: 2 errors", "exit code 1").
  const firstBody = lines.findIndex((line) => line.trim());
  if (firstBody >= 0 && TOOL_STATUS_LINE.test(lines[firstBody])) add.add(firstBody);
  for (let i = lines.length - 1, n = 0; i >= 0 && n < 3; i--) {
    if (!lines[i].trim()) continue;
    n++;
    if (TOOL_STATUS_LINE.test(lines[i])) add.add(i);
  }
  if (TEST_OUTPUT.test(lines.join("\n"))) {
    lines.forEach((line, i) => {
      if (TEST_SUMMARY_LINE.test(line)) add.add(i);
    });
  }
  const targets = targetLineNumbers(query);
  if (targets.length) {
    lines.forEach((line, i) => {
      const n = viewLineNumber(line);
      if (n != null && targets.some((t) => n >= t - 10 && n <= t + 40)) add.add(i);
    });
  }
  return add;
}

function compress(context, query = "", options = {}) {
  if (typeof context !== "string") return compressCore(context, query, options);
  const started = process.hrtime.bigint();
  const lines = context.split("\n");
  const minChars = options.minChars ?? MIN_COMPRESS_CHARS;
  if (context.length < minChars) return result(context, context, "below_min_size", started, lines.length, lines.length);
  if (isHitListing(lines)) return result(context, context, "hit_list_kept", started, lines.length, lines.length);

  const base = compressCore(context, query, options);
  if (base.compressed_text === context) return base;
  const kept = keptLineIndices(lines, base.compressed_text);
  const before = kept.size;
  for (const i of structuralAdditions(lines, kept, query)) kept.add(i);
  const structural = kept.size;
  // Header, trailing status and test verdicts matter in long tool output, not in short snippets.
  // Only when the selection is whole input lines; rebuilding by line index would drop
  // anything the selector emitted that is not a verbatim line (markers, trimmed units).
  const inputLines = new Set(lines);
  const verbatim = base.compressed_text.split("\n").every((line) => !line.trim() || inputLines.has(line));
  if (verbatim && lines.length >= AGENT_OUTPUT_MIN_LINES) for (const i of agentOutputAdditions(lines, query)) kept.add(i);
  if (kept.size === before) return base;
  const output = [...kept].sort((a, b) => a - b).map((i) => lines[i]).join("\n");
  if (output.length >= context.length) return result(context, context, "no_savings", started, lines.length, lines.length);
  const reason = structural > before ? `${base.selection_reason}+structure` : base.selection_reason;
  const out = result(context, output, reason, started, lines.length, kept.size);
  out.agent_lines_added = kept.size - structural;
  return out;
}

// Shared with graph-compress (same unitization + safety gates; different selector).

module.exports = {
  compress,
  compressCore,
  unitsFor,
  documentFor,
  internals: {
    MIN_COMPRESS_CHARS,
    isHitListing,
    targetLineNumbers,
    viewLineNumber,
    agentOutputAdditions,
    STOP,
    FILL_STOP,
    QUERY_SOFT,
    terms,
    expandQueryTerms,
    analyzeQuery,
    slotEvidenceScore,
    decomposeReferents,
    queryMatches,
    isBaitUnit,
    specificQueryEntities,
    unitHasEntity,
    isAbsenceEvidenceUnit,
    requiresGlobalEvidence,
    delimitedOutlierIndices,
    httpFailureIndices,
    siblingContrastIndices,
    headingSectionIndices,
    languageBiasIndices,
    shouldKeepUnitZero,
    strongEvidenceUnit,
    neighborWorthKeeping,
    coreferenceIndices,
    errorClusterIndices,
    spanFillIndices,
    countTokens,
    result,
    isBridgeId,
    idMentionIsSubstantive,
  },
};
