import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import PostalMime from "postal-mime";
import TurndownService from "turndown";

type Copy = { id: number; account: string; path: string };

const PARTIAL = ".partial.emlx";

const digitDirs = (id: number): string[] => {
  const n = Math.floor(id / 1000);
  return n === 0 ? [] : String(n).split("").toReversed();
};

const mboxDir = (versionDir: string, copy: Copy) =>
  join(
    versionDir,
    copy.account,
    ...copy.path.split("/").map((part) => `${part}.mbox`),
  );

const isFile = async (file: string) =>
  (await stat(file).catch(() => null))?.isFile() ?? false;

const stores = async (dir: string) =>
  (await readdir(dir, { withFileTypes: true }).catch(() => []))
    .filter(
      (e) =>
        e.isDirectory() && !e.name.startsWith(".") && !e.name.endsWith(".mbox"),
    )
    .map((e) => e.name)
    .toSorted();

async function findEmlx(
  versionDir: string,
  copy: Copy,
): Promise<string | null> {
  const dir = mboxDir(versionDir, copy);
  const messages = (await stores(dir)).map((store) =>
    join(dir, store, "Data", ...digitDirs(copy.id), "Messages"),
  );
  for (const suffix of [".emlx", PARTIAL])
    for (const m of messages) {
      const file = join(m, `${copy.id}${suffix}`);
      if (await isFile(file)) return file;
    }
  return null;
}

export async function findBest(
  versionDir: string,
  copies: Copy[],
): Promise<string | null> {
  const found = await Promise.all(copies.map((c) => findEmlx(versionDir, c)));
  return (
    found.find((f) => f && !f.endsWith(PARTIAL)) ??
    found.find((f) => f !== null) ??
    null
  );
}

function sliceEmlx(bytes: Uint8Array): Uint8Array {
  let i = 0;
  while (i < bytes.length && (bytes[i] === 32 || bytes[i] === 9)) i++;
  const start = i;
  while (i < bytes.length && bytes[i]! >= 48 && bytes[i]! <= 57) i++;
  if (i === start) throw new Error("emlx: missing byte count");
  const n = Number(new TextDecoder().decode(bytes.subarray(start, i)));
  while (i < bytes.length && bytes[i] !== 10) i++;
  const body = i + 1;
  if (body > bytes.length) throw new Error("emlx: missing message");
  return bytes.slice(body, Math.min(body + n, bytes.length));
}

export async function readEmlx(file: string): Promise<Uint8Array> {
  return sliceEmlx(await Bun.file(file).bytes());
}

type Body = { html: string | null; text: string | null };

export async function parseMessage(raw: Uint8Array | string): Promise<Body> {
  const m = await PostalMime.parse(raw);
  return { html: m.html ?? null, text: m.text ?? null };
}

type El = {
  tagName: string;
  innerHTML: string;
  textContent: string | null;
  children: ArrayLike<El>;
  getAttribute(name: string): string | null;
  querySelector(selector: string): El | null | undefined;
  querySelectorAll(selector: string): ArrayLike<El>;
  closest(selector: string): El | null;
};

const asEl = (node: unknown) => node as El;

const styles = (style: string) =>
  new Map(
    style
      .split(";")
      .map((d) => d.split(":"))
      .filter((p) => p.length >= 2)
      .map(([k, ...v]) => [
        (k ?? "").trim().toLowerCase(),
        v
          .join(":")
          .replace(/!important/i, "")
          .trim()
          .toLowerCase(),
      ]),
  );

const zero = (v: string | undefined) =>
  v !== undefined && /^-?0*\.?0*(px|em|rem|pt|%)?$/.test(v) && /0/.test(v);

const hidden = (style: string) => {
  const s = styles(style);
  return (
    s.get("display") === "none" ||
    s.get("visibility") === "hidden" ||
    zero(s.get("max-height")) ||
    zero(s.get("opacity"))
  );
};

const fontSize = (el: El) =>
  styles(el.getAttribute("style") ?? "").get("font-size");

const fontHidden = (el: El) =>
  zero(fontSize(el)) &&
  !Array.from(el.querySelectorAll("[style]")).some((d) => {
    const size = fontSize(d);
    return size !== undefined && !zero(size);
  });

const tiny = (v: string | null | undefined) =>
  v != null && /^\s*[01](px)?\s*$/i.test(v);

const TRACKER = /[/._-](?:pixel|beacon|track|tracking|openrate)(?:[/._?=-]|$)/i;

const tracking = (el: { getAttribute(name: string): string | null }) => {
  const s = styles(el.getAttribute("style") ?? "");
  const w = el.getAttribute("width") ?? s.get("width");
  const h = el.getAttribute("height") ?? s.get("height");
  return (
    (tiny(w) && tiny(h)) ||
    TRACKER.test(el.getAttribute("src") ?? "") ||
    hidden(el.getAttribute("style") ?? "")
  );
};

function clean(html: string): string {
  return new HTMLRewriter()
    .on("script, style, head, title, meta, link, noscript, template", {
      element: (e) => void e.remove(),
    })
    .on("[style]", {
      element: (e) => {
        if (hidden(e.getAttribute("style") ?? "")) e.remove();
      },
    })
    .on("[hidden]", { element: (e) => void e.remove() })
    .on("img", {
      element: (e) => {
        if (tracking(e)) e.remove();
      },
    })
    .onDocument({ comments: (c) => void c.remove() })
    .transform(html);
}

const BLOCK =
  "p, div, table, ul, ol, h1, h2, h3, h4, h5, h6, blockquote, pre, hr, img, center, section, article";

const cellHasBlock = (cell: El) => Boolean(cell.querySelector(BLOCK));

const isLayout = (table: El) =>
  table.getAttribute("role") === "presentation" ||
  Boolean(table.querySelector("table")) ||
  Boolean(table.querySelector("[colspan], [rowspan]")) ||
  (!table.querySelector("th") &&
    Array.from(table.querySelectorAll("td")).some(cellHasBlock));

const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

const imageName = (src: string, alt: string) =>
  alt.trim() || safeDecode(src.slice(4)).replace(/@.*$/, "").trim() || "inline";

const escapeAlt = (s: string) => s.replace(/[[\]]/g, "\\$&");

const rows = (table: El) =>
  Array.from(table.querySelectorAll("tr")).filter(
    (tr) => tr.closest("table") === table,
  );

const bare = (s: string) => s.replace(/\/+$/, "");

const url = (s: string) => s.replace(/[()\s]/g, encodeURIComponent);

const listStart = (ol: El) => {
  const n = Number.parseInt(ol.getAttribute("start") ?? "", 10);
  return Number.isNaN(n) ? 1 : n;
};

const turndown = (() => {
  const t = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    hr: "---",
  });
  const cell = (el: El) =>
    t
      .turndown(el.innerHTML)
      .replace(/\s*\n+\s*/g, " ")
      .replace(/\|/g, "\\|")
      .trim();
  t.addRule("image", {
    filter: "img",
    replacement: (_content, node) => {
      const src = asEl(node).getAttribute("src") ?? "";
      const alt = (asEl(node).getAttribute("alt") ?? "").replace(/\s+/g, " ");
      if (/^cid:/i.test(src)) return `[image: ${imageName(src, alt)}]`;
      if (/^data:/i.test(src))
        return `![${escapeAlt(alt)}](${src.split(",")[0]?.slice(0, 64)}...)`;
      if (!src) return alt ? `[image: ${alt}]` : "";
      return `![${escapeAlt(alt)}](${url(src)})`;
    },
  });
  t.addRule("link", {
    filter: "a",
    replacement: (content, node) => {
      const href = (asEl(node).getAttribute("href") ?? "").trim();
      if (!/^https?:\/\//i.test(href)) return content;
      const text = (node.textContent ?? "").trim();
      if (!content.trim()) return "";
      if (bare(text) === bare(href)) return `<${url(href)}>`;
      return `[${content}](${url(href)})`;
    },
  });
  t.addRule("table", {
    filter: "table",
    replacement: (content, node) => {
      const table = asEl(node);
      if (isLayout(table)) return `\n\n${content}\n\n`;
      const grid = rows(table)
        .map((tr) =>
          Array.from(tr.children)
            .filter((c) => c.tagName === "TD" || c.tagName === "TH")
            .map(cell),
        )
        .filter((r) => r.some(Boolean));
      const width = Math.max(0, ...grid.map((r) => r.length));
      if (width === 0) return `\n\n${content}\n\n`;
      const line = (r: string[]) =>
        `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
      const [head = [], ...body] = grid;
      return `\n\n${[line(head), line(Array(width).fill("---")), ...body.map(line)].join("\n")}\n\n`;
    },
  });
  t.addRule("listItem", {
    filter: "li",
    replacement: (content, node) => {
      const li = asEl(node) as El & { parentNode: El; nextSibling: unknown };
      const parent = li.parentNode;
      const prefix =
        parent.tagName === "OL"
          ? `${
              listStart(parent) +
              Array.from(parent.children)
                .filter((c) => c.tagName === "LI")
                .indexOf(li)
            }. `
          : "- ";
      const para = content.endsWith("\n");
      const body = content.replace(/^\n+|\n+$/g, "") + (para ? "\n" : "");
      const text = body.replace(/\n/g, `\n${" ".repeat(prefix.length)}`);
      return `${prefix}${text}${li.nextSibling ? "\n" : ""}`;
    },
  });
  t.addRule("hidden", {
    filter: (node) =>
      asEl(node).getAttribute("style") !== null && fontHidden(asEl(node)),
    replacement: () => "",
  });
  return t;
})();

const tidy = (s: string) =>
  s
    .replace(/\r\n?/g, "\n")
    .replace(/ /g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

function htmlToMarkdown(html: string): string {
  return tidy(turndown.turndown(clean(html)));
}

export function toMarkdown(parsed: Body): string {
  if (parsed.html) {
    try {
      const md = htmlToMarkdown(parsed.html);
      if (md) return md;
    } catch {}
  }
  return parsed.text ? tidy(parsed.text) : "";
}

const lines = (s: string) => s.split("\n");

const ATTRIBUTION = /^(?:[>\s]*)On\b.*\bwrote:\s*$/;
const ORIGINAL = /^[>\s*_]*-{2,}\s*Original Message\s*-{2,}[\s*_]*$/i;
const FROM = /^[>\s]*(?:\*\*|__)?From:(?:\*\*|__)?\s/;
const SENT = /^[>\s]*(?:\*\*|__)?Sent:(?:\*\*|__)?\s/;
const SEPARATOR = /^\s*(?:_{3,}|-{3,}|\*\s\*\s\*|\*{3,})\s*$/;
const QUOTE = /^\s*>/;

const quotedTail = (ls: string[], from: number) => {
  const tail = ls.slice(from);
  return (
    tail.some((l) => QUOTE.test(l)) &&
    tail.every((l) => !l.trim() || QUOTE.test(l))
  );
};

const cutIndex = (ls: string[]): number | null => {
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i] ?? "";
    const joined = `${l} ${ls[i + 1] ?? ""}`;
    if (QUOTE.test(l)) continue;
    if (ORIGINAL.test(l)) return i;
    if (FROM.test(l) && ls.slice(i + 1, i + 5).some((n) => SENT.test(n)))
      return i;
    if (/^\s*On\b/.test(l)) {
      if (ATTRIBUTION.test(l) && quotedTail(ls, i + 1)) return i;
      if (ATTRIBUTION.test(joined) && quotedTail(ls, i + 2)) return i;
    }
  }
  let end = ls.length;
  while (end > 0 && !(ls[end - 1] ?? "").trim()) end--;
  let start = end;
  for (let i = end; i > 0; i--) {
    const l = ls[i - 1] ?? "";
    if (QUOTE.test(l)) start = i - 1;
    else if (l.trim()) break;
  }
  return start < end ? start : null;
};

export function trimQuoted(markdown: string): { text: string } {
  const ls = lines(markdown);
  const cut = cutIndex(ls);
  if (cut === null) return { text: markdown };
  const kept = ls.slice(0, cut);
  while (kept.length && (!kept.at(-1)?.trim() || SEPARATOR.test(kept.at(-1)!)))
    kept.pop();
  const text = kept.join("\n").trimEnd();
  return { text: text || markdown };
}

export const tokens = (s: string) => Math.ceil(s.length / 4);

const boundary = (text: string, budget: number) => {
  const head = text.slice(0, budget + 1);
  for (const sep of ["\n\n", "\n", " "]) {
    const at = head.lastIndexOf(sep);
    if (at >= budget / 2 && at <= budget) return at;
  }
  const code = text.charCodeAt(budget - 1);
  return code >= 0xd800 && code <= 0xdbff ? budget - 1 : budget;
};

export function truncate(
  text: string,
  maxTokens: number,
): { text: string; omitted_tokens: number } {
  const total = tokens(text);
  if (total <= maxTokens) return { text, omitted_tokens: 0 };
  const budget = Math.max(0, Math.floor(maxTokens) * 4);
  const kept = text.slice(0, boundary(text, budget)).trimEnd();
  return { text: kept, omitted_tokens: total - tokens(kept) };
}
