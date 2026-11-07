export function toSpeakable(markdown: string): string {
  return (
    markdown
      .replace(/(^|\n) {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n {0,3}\2[^\n]*(?=\n|$)|$)/g, "$1")
      .replace(/^(?: {4}|\t).*$/gm, "")
      .replace(
        /\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|(?<!\\)\$(?!\s)(?:\\.|[^$\n])+?\$/g,
        ", ",
      )
      // A table row reads as its cells, one sentence per row; the delimiter row is silent.
      .replace(/^ {0,3}\|?(?: *:?-+:? *\|)+ *(?::?-+:? *)?$/gm, "")
      .replace(/^ {0,3}\|(.*)$/gm, (_, row: string) => {
        const line = row
          .split(/(?<!\\)\|/)
          .map((cell) => cell.trim())
          .filter((cell) => cell !== "" && cell !== ",")
          .join(", ");
        return line === "" || /[.!?:]$/.test(line) ? line : `${line}.`;
      })
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)|\[([^\]]+)\]\[[^\]]*\]/g, "$1$2")
      .replace(/^\s*\[[^\]]+\]:.*$/gm, "")
      .replace(/<[^>]+>/g, "")
      .replace(/^\s*(?:#{1,6}\s+|>\s*|[-+*]\s+|\d+[.)]\s+)(?:\[[ xX]\]\s*)?/gm, "")
      .replace(/^\s*(?:[-*_]\s*){3,}$/gm, "")
      .replace(/[`*_~]/g, "")
      .replace(/\\([\\`*{}[\]()#+.!_$>|-])/g, "$1")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .replace(/(?:,\s*){2,}/g, ", ")
      .trim()
  );
}

export function isLikelyEnglish(text: string): boolean {
  return !/[\p{Script=Cyrillic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
    text,
  );
}
