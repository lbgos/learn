// Ported from learnharness (AGPL-3.0-only) src/core/content-reader.ts, src/core/math-delims.ts @ dc4c398.
/**
 * Display-only recovery for model-authored session text; tool inputs, answers and grading keep
 * the source. Only balanced math outside code is touched, and only for escaping damage with
 * structural evidence. Unknown commands are never invented, and parseable TeX never becomes a
 * parse error. `SessionProse` runs `repairMathForDisplay`, then `transformMathDelimiters`.
 */
import katex from "katex";

type ContentSpan =
  | { kind: "prose" | "code"; raw: string }
  | { kind: "math"; raw: string; open: string; body: string; close: string; display: boolean };
interface Range {
  start: number;
  end: number;
}

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
const BLANK_LINE_RE = /^\r?\n[ \t]*\r?\n/;

/** Is the character at `i` preceded by an odd number of backslashes? */
function escaped(text: string, i: number): boolean {
  let count = 0;
  while (i > 0 && text[--i] === "\\") count++;
  return count % 2 === 1;
}
function runLength(text: string, i: number, char: string): number {
  let count = 0;
  while (text[i + count] === char) count++;
  return count;
}
function blankLineAt(text: string, i: number): boolean {
  return (text[i] === "\n" || text[i] === "\r") && BLANK_LINE_RE.test(text.slice(i));
}

/**
 * Fenced blocks and backtick code spans, which recovery copies verbatim. Upstream reads these
 * ranges with a CommonMark parse; this linear scan covers top-level fences and code spans,
 * which is what tool-authored session text uses.
 */
function literalRanges(text: string): Range[] {
  const ranges: Range[] = [];
  let i = 0;
  while (i < text.length) {
    if (i === 0 || text[i - 1] === "\n") {
      const lineEnd = text.indexOf("\n", i);
      const fence = FENCE_OPEN_RE.exec(text.slice(i, lineEnd < 0 ? text.length : lineEnd));
      if (fence) {
        const marker = fence[1]!;
        const close = new RegExp(`^ {0,3}\\${marker[0]}{${marker.length},}[ \\t]*\\r?$`);
        let end = text.length;
        for (let start = lineEnd; start >= 0;) {
          const next = text.indexOf("\n", start + 1);
          if (close.test(text.slice(start + 1, next < 0 ? text.length : next))) {
            end = next < 0 ? text.length : next;
            break;
          }
          start = next;
        }
        ranges.push({ start: i, end });
        i = end;
        continue;
      }
    }
    if (text[i] === "`") {
      const size = runLength(text, i, "`");
      let j = i + size;
      while (j < text.length && runLength(text, j, "`") !== size) {
        j += Math.max(runLength(text, j, "`"), 1);
      }
      // An unmatched run is literal text, not the start of code.
      if (j < text.length) ranges.push({ start: i, end: j + size });
      i = j < text.length ? j + size : i + size;
      continue;
    }
    i++;
  }
  return ranges;
}

/** Split text into prose, code and math, following micromark's dollar-run rules and the legacy delimiters. */
function readContentSpans(text: string): ContentSpan[] {
  const spans: ContentSpan[] = [];
  const literals = literalRanges(text);
  let literal = 0;
  let i = 0;
  let plain = 0;
  while (i < text.length) {
    while (literal < literals.length && literals[literal]!.end <= i) literal++;
    const barrier = literals[literal]?.start ?? Infinity;
    if (i >= barrier) {
      const end = literals[literal]!.end;
      if (plain < i) spans.push({ kind: "prose", raw: text.slice(plain, i) });
      spans.push({ kind: "code", raw: text.slice(i, end) });
      i = plain = end;
      continue;
    }
    let open = "";
    let close = "";
    let display = false;
    let at = -1;
    let after = -1;
    if (text[i] === "\\" && !escaped(text, i) && (text[i + 1] === "(" || text[i + 1] === "[")) {
      open = text.slice(i, i + 2);
      close = open === "\\(" ? "\\)" : "\\]";
      display = open === "\\[";
      for (let j = i + 2; j < text.length - 1; j++) {
        if (j >= barrier || (!display && blankLineAt(text, j))) break;
        if (text.startsWith(close, j) && !escaped(text, j)) {
          at = j;
          after = j + 2;
          break;
        }
      }
    } else if (text[i] === "$" && !escaped(text, i)) {
      const size = runLength(text, i, "$");
      open = "$".repeat(size);
      const eol = text.indexOf("\n", i + size);
      const before = text.slice(text.lastIndexOf("\n", i - 1) + 1, i);
      display =
        size >= 2 &&
        /^[ \t]{0,3}$/.test(before) &&
        !text.slice(i + size, eol < 0 ? text.length : eol).includes("$");
      if (display) {
        // Flow math closes on its own line with at least as many dollars.
        for (let start = eol; start >= 0 && start < text.length;) {
          start++;
          const next = text.indexOf("\n", start);
          const match = /^([ \t]{0,3})(\$+)[ \t]*\r?$/.exec(
            text.slice(start, next < 0 ? text.length : next),
          );
          if (match && match[2]!.length >= size) {
            at = start + match[1]!.length;
            close = match[2]!;
            after = at + close.length;
            break;
          }
          start = next;
        }
      } else {
        // Inline math closes at an unescaped run of exactly the opener's size.
        for (let j = i + size; j < text.length;) {
          if (j >= barrier || blankLineAt(text, j)) break;
          if (text[j] === "$" && !escaped(text, j)) {
            const count = runLength(text, j, "$");
            if (count === size) {
              at = j;
              close = open;
              after = j + count;
              break;
            }
            j += count;
          } else j++;
        }
      }
    }
    if (at >= 0) {
      if (plain < i) spans.push({ kind: "prose", raw: text.slice(plain, i) });
      spans.push({
        kind: "math",
        raw: text.slice(i, after),
        open,
        body: text.slice(i + open.length, at),
        close,
        display,
      });
      i = plain = after;
    } else i += open.length || 1;
  }
  if (plain < text.length) spans.push({ kind: "prose", raw: text.slice(plain) });
  return spans;
}

function mapMathContent(text: string, transform: (body: string, display: boolean) => string) {
  return readContentSpans(text)
    .map((span) =>
      span.kind === "math" ? span.open + transform(span.body, span.display) + span.close : span.raw,
    )
    .join("");
}

const knownCommands = new Map<string, boolean>();
/** Whether KaTeX defines `\name`. Missing-argument errors still mean the command exists. */
function knownTexCommand(name: string): boolean {
  if (!/^[A-Za-z]+$/.test(name)) return false;
  const cached = knownCommands.get(name);
  if (cached !== undefined) return cached;
  let known = true;
  try {
    katex.renderToString(`\\${name}`, { throwOnError: true, trust: false, strict: false });
  } catch (error) {
    known = !String(error).includes(`Undefined control sequence: \\${name}`);
  }
  knownCommands.set(name, known);
  return known;
}

function canParseTex(body: string, display: boolean): boolean {
  try {
    katex.renderToString(body, {
      throwOnError: true,
      trust: false,
      strict: false,
      displayMode: display,
    });
    return true;
  } catch {
    return false;
  }
}

/** Is the even backslash run before `%` an over-escaped numeric percentage (`60\\%`) rather than a row break plus comment? */
function numericPercentEscape(inner: string, percent: number): boolean {
  let start = percent;
  while (start > 0 && inner[start - 1] === "\\") start--;
  if (
    percent - start < 2 ||
    (percent - start) % 2 !== 0 ||
    !/\d[ \t]*$/.test(inner.slice(0, start))
  )
    return false;
  const tail = inner.slice(percent + 1);
  // A final formatting newline before the closing fence is not a next row.
  if (/^[\s.)\]}]*$/.test(tail)) return true;
  return !/[\r\n]/.test(tail) && !/^[ \t]*[A-Za-z]/.test(tail);
}

interface TexRange extends Range {
  kind: "row" | "encoded" | "comment";
  factor?: number;
}
/**
 * Environment, `\substack` and comment ranges in a math body. A natively written environment is
 * a "row" range whose separators stay literal; a consistently over-escaped one is "encoded" with
 * the escaping factor that decodes both its commands and its rows.
 */
function texRanges(inner: string): TexRange[] {
  const ranges: TexRange[] = [];
  const stack: Array<{ name: string; start: number; factor: number }> = [];
  let i = 0;
  while (i < inner.length) {
    if (inner[i] === "%" && !escaped(inner, i)) {
      let start = i;
      while (start > 0 && inner[start - 1] === "\\") start--;
      const factor =
        stack.at(-1)?.factor ??
        ranges.findLast((r) => r.kind === "encoded" && i >= r.start && i < r.end)?.factor;
      const encodedLiteral =
        factor !== undefined &&
        factor > 1 &&
        (i - start) % factor === 0 &&
        ((i - start) / factor) % 2 === 1;
      const native =
        stack.some((frame) => frame.factor === 1) ||
        ranges.some((r) => r.kind === "row" && i >= r.start && i < r.end);
      if (encodedLiteral || (!native && numericPercentEscape(inner, i))) {
        i++;
        continue;
      }
      const newline = inner.indexOf("\n", i);
      const end = newline < 0 ? inner.length : newline + 1;
      ranges.push({ start: i, end, kind: "comment" });
      i = end;
      continue;
    }
    if (inner[i] !== "\\") {
      i++;
      continue;
    }
    let end = i + 1;
    while (inner[end] === "\\") end++;
    const count = end - i;
    const marker = /^(begin|end)\s*\{([^{}]+)\}/.exec(inner.slice(end));
    if (marker) {
      const factor = count % 2 === 1 ? 1 : count;
      if (marker[1] === "begin") stack.push({ name: marker[2]!, start: i, factor });
      else if (stack.at(-1)?.name === marker[2] && stack.at(-1)?.factor === factor) {
        const open = stack.pop()!;
        ranges.push({
          start: open.start,
          end: end + marker[0].length,
          kind: factor === 1 ? "row" : "encoded",
          factor,
        });
      }
      i = end + marker[0].length;
      continue;
    }
    // KaTeX expands \substack's argument into a subarray, so its \\ are rows too.
    const substack = /^substack\s*\{/.exec(inner.slice(end));
    if (substack) {
      let depth = 1;
      let j = end + substack[0].length;
      for (; j < inner.length && depth > 0; j++) {
        if (inner[j] === "%" && !escaped(inner, j)) {
          const lf = inner.indexOf("\n", j);
          j = lf < 0 ? inner.length : lf;
          continue;
        }
        if (!escaped(inner, j)) {
          if (inner[j] === "{") depth++;
          else if (inner[j] === "}") depth--;
        }
      }
      if (depth === 0)
        ranges.push({
          start: i,
          end: j,
          kind: count % 2 === 1 ? "row" : "encoded",
          factor: count % 2 === 1 ? 1 : count,
        });
    }
    i = end;
  }
  return ranges.sort((a, b) => a.start - b.start);
}

function outsideTexComments(body: string, transform: (part: string) => string): string {
  let from = 0;
  const out: string[] = [];
  for (const range of texRanges(body).filter((r) => r.kind === "comment")) {
    out.push(transform(body.slice(from, range.start)), body.slice(range.start, range.end));
    from = range.end;
  }
  out.push(transform(body.slice(from)));
  return out.join("");
}

/**
 * Decode literal `\n` document escapes when the text shows evidence of JSON over-escaping:
 * repeated candidates, `\n\n`, or a candidate beside an over-escaped known command. Known
 * n-commands (`\nu`, `\nabla`, `\neq`, declared macros), code, TeX comments and paths stay.
 */
function recoverDocumentLayout(text: string): string {
  const spans = readContentSpans(text);
  const candidates = spans
    .filter((span) => span.kind !== "code")
    .map((span) => span.raw)
    .join("\u0000");
  const declared = new Set(
    [
      ...candidates.matchAll(
        /\\(?:newcommand|renewcommand|providecommand)\*?\s*(?:\{\s*)?\\(n[A-Za-z]+)/g,
      ),
      ...candidates.matchAll(/\\(?:def|gdef|edef)\s*\\(n[A-Za-z]+)/g),
    ].map((m) => m[1]!),
  );
  const knownN = (name: string) => declared.has(name) || knownTexCommand(name);
  const evidence = [...candidates.matchAll(/(\\+)(n[A-Za-z]*)/g)].filter(
    (m) => m[1]!.length % 2 === 1 && !knownN(m[2]!),
  );
  const structural =
    evidence.length >= 2 ||
    candidates.includes("\\n\\n") ||
    (evidence.length > 0 &&
      [...candidates.matchAll(/(\\+)([A-Za-z]+)/g)].some(
        (m) => m[1]!.length % 2 === 0 && knownTexCommand(m[2]!),
      ));
  if (!structural) return text;
  const decode = (part: string) =>
    part.replace(/(\\+)(n[A-Za-z]*)/g, (whole, slashes: string, name: string, offset: number) => {
      if (slashes.length % 2 === 0 || knownN(name)) return whole;
      const word = part.slice(0, offset).split(/\s/).at(-1) ?? "";
      if (/^(?:[A-Za-z]:[\\/]|https?:\/\/|\/)/.test(word + whole)) return whole;
      return `${slashes.slice(0, -1)}\n${name.slice(1)}`;
    });
  const projected = spans.map((span) => ({
    span,
    body:
      span.kind === "math"
        ? outsideTexComments(span.body, decode)
        : span.kind === "code"
          ? span.raw
          : decode(span.raw),
  }));
  let out = "";
  for (let i = 0; i < projected.length; i++) {
    const { span, body } = projected[i]!;
    if (span.kind !== "math") {
      out += body;
      continue;
    }
    // A decoded `$$` block needs both fences on their own lines, or Markdown reads the
    // closing dollars as TeX.
    if (/^\${2,}$/.test(span.open) && body !== span.body && body.includes("\n")) {
      if (!/^[ \t]{0,3}$/.test(out.slice(out.lastIndexOf("\n") + 1))) out += "\n\n";
      out += `${span.open}${body.startsWith("\n") ? "" : "\n"}${body}${body.endsWith("\n") ? "" : "\n"}${span.close}`;
      const next = projected[i + 1];
      if (next && !/^[\r\n]/.test(next.span.kind === "math" ? next.span.open : next.body))
        out += "\n\n";
    } else out += span.open + body + span.close;
  }
  return out;
}

/** micromark closes `$...$` at an escaped dollar, so swap `\$` for dollar-free TeX first. */
function replaceEscapedDollars(content: string): string {
  let out = "";
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\\" && content[i + 1] === "$" && !escaped(content, i)) {
      out += "\\text{\\textdollar}";
      i++;
    } else out += content[i];
  }
  return out;
}

/** Indented display math degrades to inline so it stays inside its list item. */
function indented(text: string, i: number): boolean {
  const prefix = text.slice(text.lastIndexOf("\n", i - 1) + 1, i);
  return prefix.length > 0 && /^[ \t]+$/.test(prefix);
}
function blockPosition(text: string, i: number): boolean {
  return /^[ \t]*$/.test(text.slice(text.lastIndexOf("\n", i - 1) + 1, i));
}

/** Rewrite legacy `\(...\)` to `$$...$$` and `\[...\]` to a `$$` block. Dollar math passes through. */
export function transformMathDelimiters(markdown: string): string {
  let offset = 0;
  return readContentSpans(markdown)
    .map((span) => {
      const start = offset;
      offset += span.raw.length;
      if (span.kind !== "math") return span.raw;
      if (span.open === "$") return `$${replaceEscapedDollars(span.body)}${span.close}`;
      if (span.open !== "\\(" && span.open !== "\\[") return span.raw;
      const body = span.body.trim();
      if (!body) return span.raw;
      if (span.open === "\\(") return `$$${body}$$`;
      if (indented(markdown, start)) return `$$${body.replace(/\s*\n\s*/g, " ")}$$`;
      const before = blockPosition(markdown, start) ? "" : "\n\n";
      const end = start + span.raw.length;
      const after = end === markdown.length || markdown[end] === "\n" ? "" : "\n\n";
      return `${before}$$\n${body}\n$$${after}`;
    })
    .join("");
}

const DEBRIS: Record<string, string> = {
  "\b": "\\b",
  "\t": "\\t",
  "\v": "\\v",
  "\f": "\\f",
  "\r": "\\r",
};

/**
 * Restore command prefixes JSON swallowed (`\t` + `o` read as TAB + "o") when the control
 * character plus the following word names a known command. Display math keeps physical
 * newlines; inline math also restores LF + word when `n` + word is a known command (`\nu`).
 */
function restoreMathEscapes(text: string): string {
  if (!/[\b\t\n\v\f\r]/.test(text)) return text;
  return mapMathContent(text, (body, display) =>
    outsideTexComments(body, (part) => {
      const restored = part.replace(/[\b\t\v\f\r]/g, (char, offset: number) => {
        if (char === "\r" && part[offset + 1] === "\n") return char;
        const suffix = /^[A-Za-z]+/.exec(part.slice(offset + 1))?.[0];
        return suffix && knownTexCommand(DEBRIS[char]!.slice(1) + suffix) ? DEBRIS[char]! : char;
      });
      if (display) return restored;
      return restored.replace(/\n([A-Za-z]+)/g, (whole, suffix: string) =>
        knownTexCommand(`n${suffix}`) ? `\\n${suffix}` : whole,
      );
    }),
  );
}

const COMMAND_SYMBOL_RE = /[,;:!|{}%]/;

/**
 * Collapses over-escaped command prefixes by their TeX context. Native rows and comments stay; an
 * encoded environment decodes by its factor. Elsewhere an even run before a known command becomes
 * one backslash, and doubled control spaces collapse only beside one, outside environments.
 */
function recoverCommandRuns(inner: string, display: boolean): string {
  const ranges = texRanges(inner);
  const escapedSpacing =
    !/\\(?:begin|end|substack)\b/.test(inner) &&
    [...inner.matchAll(/(\\+)([A-Za-z]+)/g)].some(
      (m) => m[1]!.length % 2 === 0 && m[2]!.length > 1 && knownTexCommand(m[2]!),
    );
  const recovered = inner.replace(/\\+/g, (run: string, offset: number) => {
    const contexts = ranges.filter((r) => offset >= r.start && offset < r.end);
    if (contexts.some((r) => r.kind === "row" || r.kind === "comment") || run.length % 2 !== 0)
      return run;
    const next = inner[offset + run.length] ?? "";
    const encoded = contexts.findLast((r) => r.kind === "encoded");
    const word = /^[A-Za-z]+/.exec(inner.slice(offset + run.length))?.[0];
    if (encoded) {
      const factor = encoded.factor!;
      const rows = run.length % (2 * factor) === 0;
      const command = word ? knownTexCommand(word) : COMMAND_SYMBOL_RE.test(next);
      if (run.length % factor === 0 && (rows || command)) return "\\".repeat(run.length / factor);
      return run;
    }
    if (next === "%") return numericPercentEscape(inner, offset + run.length) ? "\\" : run;
    if (word) return word.length > 1 && knownTexCommand(word) ? "\\" : run;
    if (next === " ") return escapedSpacing ? "\\" : run;
    return next && COMMAND_SYMBOL_RE.test(next) ? "\\" : run;
  });
  // Structure decides; this only stops a partial recovery from breaking parseable TeX.
  if (recovered !== inner && !canParseTex(recovered, display) && canParseTex(inner, display))
    return inner;
  return recovered;
}

function healOverescapedCommands(text: string): string {
  return text.includes("\\\\") ? mapMathContent(text, recoverCommandRuns) : text;
}

/** Shared display-only repair. Keep raw arguments, answers and model history unchanged. */
export function repairMathForDisplay(text: string): string {
  return healOverescapedCommands(restoreMathEscapes(recoverDocumentLayout(text)));
}
