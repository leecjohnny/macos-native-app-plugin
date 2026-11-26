export const SEP = "\n\n---\n\n";
export const line = (s: string): string => s.replace(/\s+/g, " ").trim();

export const code = (s: string): string => {
  const q = line(s);
  const ticks = "`".repeat(
    Math.max(0, ...(q.match(/`+/g) ?? []).map((t) => t.length)) + 1,
  );
  const pad = q.startsWith("`") || q.endsWith("`") ? " " : "";
  return `${ticks}${pad}${q}${pad}${ticks}`;
};

export const cell = (v: unknown): string =>
  v === null
    ? ""
    : String(v)
        .replace(/\\/g, "\\\\")
        .replace(/\|/g, "\\|")
        .replace(/\r\n|\r|\n/g, "<br>");

const STRUCTURE =
  /^( {0,3})(#{1,6}[ \t]+(Result[ \t]+)?\d+\/\d+:|_(Truncated:|End of results\.|Next page:))/;

export const guard = (body: string): string =>
  body
    .split("\n")
    .map((l) => l.replace(STRUCTURE, "$1\\$2"))
    .join("\n");

export const table = (head: string[], rows: string[][]): string =>
  [head, head.map(() => "---"), ...rows]
    .map((r) => `| ${r.join(" | ")} |`)
    .join("\n");

export const plural = (n: number, word: string): string =>
  `${n} ${word}${n === 1 ? "" : "s"}`;

export const page = (
  noun: string,
  p: { query: string; total: number; offset: number },
  blocks: string[],
): string => {
  const scope = line(p.query) ? ` for ${code(p.query)}` : "";
  if (!blocks.length)
    return p.total > p.offset || p.total === 0
      ? `No ${noun}s found${scope}.`
      : `No ${noun}s at offset=${p.offset}${scope}; there are ${p.total}.`;
  const end = p.offset + blocks.length;
  const head = `Found ${plural(p.total, noun)}${scope} (showing ${p.offset + 1}–${end}).`;
  const meta =
    end < p.total ? `_Next page: offset=${end}._` : "_End of results._";
  return [head, ...blocks, meta].join(SEP);
};
