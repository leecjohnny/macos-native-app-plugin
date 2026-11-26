import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  parseMessage,
  tokens,
  toMarkdown,
  trimQuoted,
  truncate,
} from "../src/markdown.ts";
import { MESSAGES, rfc822 } from "./envelope.ts";

type Row = (typeof MESSAGES)[number];
type Frag = { html: string; words: string[]; data: boolean };

const htmlToMarkdown = (html: string) => toMarkdown({ html, text: null });

const word = fc.stringMatching(/^[a-z]{1,8}$/);
const words = fc.array(word, { minLength: 1, maxLength: 4 });
const gap = fc.constantFrom("", " ", "\n", "&nbsp;", "  \n  ", "\t");

const comment = (s: string) => `<!${"--"} ${s} ${"--"}>`;

const HIDDEN = [
  "<script>var ZQSCRIPT = 1; alert(ZQSCRIPT)</script>",
  "<style>.ZQSTYLE { color: red }</style>",
  '<head><title>ZQTITLE</title><meta charset="utf-8"><link rel="x" href="ZQLINK"></head>',
  '<div style="display:none;max-height:0px;overflow:hidden;">ZQPREHEADER teaser</div>',
  '<div style="DISPLAY: NONE !important">ZQUPPER</div>',
  '<span style="visibility:hidden">ZQVISIBILITY</span>',
  '<span style="max-height: 0 !important">ZQMAXH</span>',
  '<span style="opacity:0">ZQOPACITY</span>',
  "<div hidden>ZQHIDDENATTR</div>",
  '<span style="font-size:0px">ZQFONT</span>',
  '<td style="font-size:0;line-height:0">ZQSPACER</td>',
  "<noscript>ZQNOSCRIPT</noscript>",
  "<template><p>ZQTEMPLATE</p></template>",
  comment("ZQCOMMENT"),
  '<img src="https://t.example/o/ZQPIXEL.gif" width="1" height="1" alt="">',
  '<img src="https://t.example/beacon.gif?u=ZQBEACON">',
  '<img src="https://t.example/ZQSTYLED.gif" style="width:1px;height:1px">',
];

const hiddenLeaf: fc.Arbitrary<Frag> = fc
  .constantFrom(...HIDDEN.filter((h) => !h.startsWith("<td")))
  .map((html) => ({ html, words: [], data: false }));

const text: fc.Arbitrary<Frag> = words.map((w) => ({
  html: w.join(" "),
  words: w,
  data: false,
}));

const link: fc.Arbitrary<Frag> = fc
  .tuple(
    fc.constantFrom(
      "javascript:void(0)",
      "javascript:alert(1)",
      "mailto:editor@news.example",
      "tel:+1555",
      "https://news.example/story?id=1",
      "http://news.example/a/b",
    ),
    words,
  )
  .map(([href, w]) => ({
    html: `<a href="${href}">${w.join(" ")}</a>`,
    words: w,
    data: false,
  }));

const cidImage: fc.Arbitrary<Frag> = fc
  .tuple(
    word,
    fc.option(word, { nil: "" }),
    fc.constantFrom(".png", ".jpg", ""),
  )
  .map(([name, alt, ext]) => ({
    html: `<img src="cid:${name}${ext}@01DA2B" alt="${alt}">`,
    words: [alt || `${name}${ext}`],
    data: false,
  }));

const image: fc.Arbitrary<Frag> = word.map((alt) => ({
  html: `<img src="https://img.example/pic/photo.png" alt="${alt}" width="600">`,
  words: [alt],
  data: false,
}));

const join = (parts: Frag[], seps: string[]): Frag => ({
  html: parts.map((p, i) => `${seps[i] ?? ""}${p.html}`).join(""),
  words: parts.flatMap((p) => p.words),
  data: parts.some((p) => p.data),
});

const seq = (item: fc.Arbitrary<Frag>, max: number) =>
  fc
    .tuple(
      fc.array(item, { minLength: 1, maxLength: max }),
      fc.array(gap, { minLength: max, maxLength: max }),
    )
    .map(([parts, seps]) => join(parts, seps));

const inline: fc.Arbitrary<Frag> = fc.oneof(
  { weight: 4, arbitrary: text },
  { weight: 2, arbitrary: hiddenLeaf },
  { weight: 2, arbitrary: link },
  { weight: 1, arbitrary: cidImage },
  { weight: 1, arbitrary: image },
  {
    weight: 1,
    arbitrary: text.map((t) => ({ ...t, html: `<b>${t.html}</b>` })),
  },
  {
    weight: 1,
    arbitrary: fc.constant<Frag>({ html: "<br>", words: [], data: false }),
  },
);

const wrap = (open: string, close: string) => (f: Frag) => ({
  ...f,
  html: `${open}${f.html}${close}`,
});

const tr = (cells: string[], tag: string) =>
  `<tr>${cells.map((c) => `<${tag}>${c}</${tag}>`).join("")}</tr>`;

const dataTable: fc.Arbitrary<Frag> = fc
  .tuple(
    fc.integer({ min: 1, max: 3 }),
    fc.array(fc.array(word, { minLength: 3, maxLength: 3 }), {
      minLength: 1,
      maxLength: 3,
    }),
  )
  .map(([width, body]) => {
    const head = body[0]?.slice(0, width) ?? [];
    const rows = body.map((r) => r.slice(0, width));
    return {
      html: `<table>${tr(head, "th")}${rows.map((r) => tr(r, "td")).join("")}</table>`,
      words: [...head, ...rows.flat()],
      data: true,
    };
  });

const { block } = fc.letrec<{ block: Frag }>((tie) => ({
  block: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    seq(inline, 4).map(wrap("<p>", "</p>")),
    seq(inline, 3).map(wrap("<div>", "</div>")),
    words.map((w) => ({
      html: `<h2>${w.join(" ")}</h2>`,
      words: w,
      data: false,
    })),
    words.map((w) => ({
      html: `<pre><code>${w.join("\n")}</code></pre>`,
      words: w,
      data: false,
    })),
    dataTable,
    seq(tie("block"), 3).map(wrap("<div>", "</div>")),
    seq(tie("block"), 2).map(wrap("<blockquote>", "</blockquote>")),
    fc
      .tuple(
        fc.constantFrom("ul", "ol"),
        fc.array(seq(inline, 2), { minLength: 1, maxLength: 3 }),
      )
      .map(([tag, items]) => ({
        html: `<${tag}>${items.map((i) => `<li>${i.html}</li>`).join("")}</${tag}>`,
        words: items.flatMap((i) => i.words),
        data: items.some((i) => i.data),
      })),
    fc
      .tuple(
        fc.constantFrom(
          '<table role="presentation" width="100%" cellpadding="0">',
          '<table width="600">',
        ),
        fc.array(seq(tie("block"), 2), { minLength: 1, maxLength: 3 }),
        fc.boolean(),
      )
      .map(([open, cells, spacer]) => ({
        html: `${open}${cells.map((c) => `<tr><td>${c.html}</td></tr>`).join("")}${spacer ? `<tr>${HIDDEN.find((h) => h.startsWith("<td"))}</tr>` : ""}</table>`,
        words: cells.flatMap((c) => c.words),
        data: cells.some((c) => c.data),
      })),
  ),
}));

const document = fc.tuple(seq(block, 5), fc.boolean()).map(([body, full]) => ({
  ...body,
  html: full
    ? `<html><head><title>ZQDOCTITLE</title><style>.ZQHEADSTYLE{}</style></head><body>${body.html}</body></html>`
    : body.html,
}));

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

describe("htmlToMarkdown", () => {
  test("drops hidden content and unsafe urls, keeps visible text, stays tidy", () => {
    fc.assert(
      fc.property(document, (doc) => {
        const md = htmlToMarkdown(doc.html);
        expect(md).not.toContain("ZQ");
        expect(md).not.toMatch(/javascript:|mailto:|tel:|cid:/i);
        expect(md).not.toMatch(/\n{3,}/);
        expect(md).not.toMatch(/[ \t]+$/m);
        expect(md).toBe(md.trim());
        for (const w of doc.words) expect(md).toContain(w);
        expect(md.includes("| ---")).toBe(doc.data);
      }),
      { numRuns: 300 },
    );
  });

  test("cid images become [image: name]", () => {
    fc.assert(
      fc.property(cidImage, (img) => {
        expect(htmlToMarkdown(`<p>${img.html}</p>`)).toBe(
          `[image: ${img.words[0]}]`,
        );
      }),
    );
  });

  test("a link whose text equals its url becomes <url>", () => {
    fc.assert(
      fc.property(
        fc.webUrl({ withQueryParameters: true, withFragments: true }),
        fc.constantFrom("", "/"),
        (url, slash) => {
          const md = htmlToMarkdown(
            `<p><a href="${esc(url)}">${esc(url)}${slash}</a></p>`,
          );
          expect(md).toBe(`<${url}>`);
        },
      ),
    );
  });

  test("arbitrary input yields tidy output", () => {
    const tag = fc.constantFrom(
      "<p>",
      "</p>",
      "<table>",
      "<td>",
      "<tr>",
      "</table>",
      "<a href='javascript:x'>",
      "</a>",
      "<img src='cid:%E0%A4'>",
      "<img src='data:image/png;base64,AAAA'>",
      "<li>",
      "<ol start='x'>",
      "<script>",
      "<style>",
      comment("x"),
      "<div style='font-size:0'>",
      "&nbsp;",
      "\r\n",
    );
    fc.assert(
      fc.property(
        fc.array(fc.oneof(tag, fc.string()), { maxLength: 30 }),
        (parts) => {
          const md = htmlToMarkdown(parts.join(""));
          expect(md).not.toMatch(/\n{3,}/);
          expect(md).not.toMatch(/[ \t]+$/m);
        },
      ),
    );
  });

  test("toMarkdown falls back to text when the html renders empty", () => {
    fc.assert(
      fc.property(
        fc.array(hiddenLeaf, { maxLength: 4 }),
        fc.option(fc.string(), { nil: null }),
        (hidden, plain) => {
          const html = hidden.map((h) => h.html).join(" ");
          expect(toMarkdown({ html, text: plain })).toBe(
            toMarkdown({ html: null, text: plain }),
          );
        },
      ),
    );
  });
});

const numbered = (md: string) =>
  md.split("\n").flatMap((l) => {
    const m = /^(-?\d+)\. (\S+)$/.exec(l);
    return m ? [[Number(m[1]), m[2]] as const] : [];
  });

const ol = (start: string, list: (readonly [string, string])[]) =>
  `<ol start="${esc(start)}">${list.map(([f, w]) => `${f}<li>${w}</li>`).join("")}</ol>`;

describe("ordered lists", () => {
  const filler = fc.constantFrom("", "<span></span>", "<div></div>", " ");
  const items = fc.array(fc.tuple(filler, word), {
    minLength: 1,
    maxLength: 5,
  });

  test("numbering starts at an integer start and counts only items", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -50, max: 1_000_000 }),
        items,
        (n, list) => {
          expect(numbered(htmlToMarkdown(ol(String(n), list)))).toEqual(
            list.map(([, w], i) => [n + i, w]),
          );
        },
      ),
    );
  });

  test("any start attribute yields numbers, never NaN", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.constantFrom("x", "", " ", "NaN", "1e3", "-", "Infinity"),
        ),
        items,
        (start, list) => {
          const md = htmlToMarkdown(ol(start, list));
          expect(md).not.toContain("NaN");
          const nums = numbered(md);
          expect(nums.map(([, w]) => w)).toEqual(list.map(([, w]) => w));
          for (const [i, [k]] of nums.entries())
            expect(k).toBe((nums[0]?.[0] ?? 0) + i);
          if (!/^\s*[-+]?\d/.test(start)) expect(nums[0]?.[0]).toBe(1);
        },
      ),
    );
  });
});

describe("data tables", () => {
  test("empty rows are dropped", () => {
    const row = fc.array(word, { minLength: 2, maxLength: 2 });
    const empty = fc.constantFrom(
      "<tr></tr>",
      "<tr> </tr>",
      "<tr><td></td><td></td></tr>",
      "<tr><th></th></tr>",
    );
    fc.assert(
      fc.property(
        fc.array(row, { minLength: 1, maxLength: 4 }),
        fc.array(fc.tuple(fc.nat(), empty), { minLength: 1, maxLength: 3 }),
        (body, empties) => {
          const full = body.map((r, i) => tr(r, i ? "td" : "th"));
          const padded = [...full];
          for (const [at, e] of empties)
            padded.splice(at % (padded.length + 1), 0, e);
          expect(htmlToMarkdown(`<table>${padded.join("")}</table>`)).toBe(
            htmlToMarkdown(`<table>${full.join("")}</table>`),
          );
        },
      ),
    );
  });
});

const encoded = (u: string) => u.replace(/ /g, "%20");

describe("urls with spaces", () => {
  const spaced = fc
    .array(fc.stringMatching(/^[a-z]{1,4}( [a-z]{1,4}){0,2}$/), {
      minLength: 1,
      maxLength: 3,
    })
    .map((parts) => `https://x.example/${parts.join("/")}`);

  test("hrefs and image sources are encoded", () => {
    fc.assert(
      fc.property(spaced, word, fc.boolean(), (url, alt, same) => {
        const label = same ? url : alt;
        const md = htmlToMarkdown(
          `<p><a href="${url}">${label}</a> <img src="${url}" alt="${alt}"></p>`,
        );
        const anchor = same ? `<${encoded(url)}>` : `[${alt}](${encoded(url)})`;
        expect(md).toBe(`${anchor} ![${alt}](${encoded(url)})`);
      }),
    );
  });
});

const sentence = fc
  .array(word, { minLength: 1, maxLength: 5 })
  .map((w) => w.join(" "));

const reply = fc
  .tuple(
    fc.array(sentence, { minLength: 1, maxLength: 4 }),
    fc.array(fc.constantFrom("\n", "\n\n"), { minLength: 4, maxLength: 4 }),
  )
  .map(([lines, seps]) =>
    lines.map((l, i) => (i ? `${seps[i] ?? "\n"}${l}` : l)).join(""),
  );

const plainQuote = fc.oneof(
  fc.string().map((s) => s.replace(/[\r\n]/g, " ")),
  fc.constantFrom("", "> nested", "On Mon, Bob wrote:", "___"),
);

const markerQuote = fc.oneof(
  plainQuote,
  fc.constantFrom("From: Bob", "Sent: Monday", "-----Original Message-----"),
);

const quoteBlock = (content: fc.Arbitrary<string>) =>
  fc
    .array(fc.tuple(fc.constantFrom(">", "> ", " > ", ">>"), content), {
      minLength: 1,
      maxLength: 6,
    })
    .map((ls) => ls.map(([p, t]) => `${p}${t}`).join("\n"));

const tail = fc.constantFrom("", "\n", "\n\n", "\n \n");

const nasty = fc
  .array(
    fc.oneof(
      fc.string(),
      fc.constantFrom(
        "\n",
        "\n\n",
        "> ",
        "On Mon, Bob wrote:",
        "From: Bob\nSent: Monday",
        "**From:** Bob",
        "-----Original Message-----",
        "________________________________",
        "* * *",
      ),
    ),
    { maxLength: 12 },
  )
  .map((a) => a.join(""));

const dropsQuote = (content: fc.Arbitrary<string>) => () => {
  fc.assert(
    fc.property(
      reply,
      fc.constantFrom("\n", "\n\n"),
      quoteBlock(content),
      tail,
      (r, sep, q, t) => {
        const md = `${r}${sep}${q}${t}`;
        expect(trimQuoted(md)).toEqual({ text: r });
      },
    ),
    { numRuns: 500 },
  );
};

describe("trimQuoted", () => {
  test("result is the input or a non-blank prefix of it", () => {
    fc.assert(
      fc.property(nasty, (md) => {
        const { text: kept } = trimQuoted(md);
        expect(md.startsWith(kept)).toBe(true);
        if (kept !== md) expect(kept.trim()).not.toBe("");
      }),
      { numRuns: 500 },
    );
  });

  test(
    "a trailing quote block is dropped and the reply kept",
    dropsQuote(plainQuote),
  );

  test(
    "a trailing quote block quoting Outlook headers is dropped whole",
    dropsQuote(markerQuote),
  );

  test("attribution lines and Outlook headers start the cut", () => {
    const name = fc.stringMatching(/^[A-Z][a-z]{0,6}( [A-Z][a-z]{0,6})?$/);
    const attribution = fc.oneof(
      name.map((n) => `On 2 Nov 2026, ${n} wrote:`),
      name.map(
        (n) =>
          `On Mon, Nov 2, 2026 at 9:14 AM ${n} <\n${n.toLowerCase().replace(/ /g, "")}@example.com> wrote:`,
      ),
    );
    const outlook = fc
      .tuple(
        fc.constantFrom("", "________________________________\n", "---\n"),
        fc.constantFrom("From: ", "**From:** ", "__From:__ "),
        name,
        fc.constantFrom("Sent: ", "**Sent:** "),
        nasty,
      )
      .map(([rule, f, n, s, rest]) => `${rule}${f}${n}\n${s}Monday\n${rest}`);
    const original = nasty.map((rest) => `-----Original Message-----\n${rest}`);
    fc.assert(
      fc.property(
        reply,
        fc.oneof(
          fc
            .tuple(
              attribution,
              fc.constantFrom("\n", "\n\n"),
              quoteBlock(markerQuote),
            )
            .map(([a, s, q]) => `${a}${s}${q}`),
          outlook,
          original,
        ),
        tail,
        (r, quoted, t) => {
          const md = `${r}\n\n${quoted}${t}`;
          expect(trimQuoted(md)).toEqual({ text: r });
        },
      ),
      { numRuns: 500 },
    );
  });

  test("an attribution with nothing quoted after it is kept", () => {
    const name = fc.stringMatching(/^[A-Z][a-z]{0,6}( [A-Z][a-z]{0,6})?$/);
    fc.assert(
      fc.property(
        reply,
        fc.oneof(
          name.map((n) => `On the board ${n} wrote:`),
          name.map(
            (n) =>
              `On Mon, Nov 2, 2026 ${n} <\n${n.length}@example.com> wrote:`,
          ),
        ),
        tail,
        (r, attribution, t) => {
          const md = `${r}\n\n${attribution}${t}`;
          expect(trimQuoted(md)).toEqual({ text: md });
        },
      ),
    );
  });

  test("trailing quote blocks separated by blank lines are dropped together", () => {
    fc.assert(
      fc.property(
        reply,
        fc.array(
          fc.tuple(
            quoteBlock(plainQuote),
            fc.constantFrom("\n\n", "\n \n", "\n\n\n"),
          ),
          { minLength: 2, maxLength: 4 },
        ),
        tail,
        (r, blocks, t) => {
          const quoted = blocks.map(([q, sep], i) => (i ? `${sep}${q}` : q));
          const md = `${r}\n\n${quoted.join("")}${t}`;
          expect(trimQuoted(md)).toEqual({ text: r });
        },
      ),
      { numRuns: 300 },
    );
  });

  test("inline quotes answered below are kept whole", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(sentence, reply), { minLength: 1, maxLength: 4 }),
        (pairs) => {
          const md = pairs.map(([q, a]) => `> ${q}\n\n${a}`).join("\n\n");
          expect(trimQuoted(md)).toEqual({ text: md });
        },
      ),
    );
  });
});

const longText = fc
  .array(
    fc.oneof(
      fc.string({ unit: "grapheme", maxLength: 20 }),
      fc.constantFrom(" ", "\n", "\n\n", "\u{1f600}", "é", "  \n"),
    ),
    { maxLength: 40 },
  )
  .map((a) => a.join(""));

describe("truncate", () => {
  test("keeps a well-formed prefix within budget and counts what it drops", () => {
    fc.assert(
      fc.property(longText, fc.nat(120), (input, n) => {
        const out = truncate(input, n);
        expect(input.startsWith(out.text)).toBe(true);
        expect(tokens(out.text)).toBeLessThanOrEqual(n);
        expect(out.omitted_tokens).toBe(tokens(input) - tokens(out.text));
        expect(out.text.isWellFormed()).toBe(true);
        if (tokens(input) <= n)
          expect(out).toEqual({ text: input, omitted_tokens: 0 });
        else expect(out.omitted_tokens).toBeGreaterThan(0);
      }),
      { numRuns: 1000 },
    );
  });
});

const person = fc.record({
  name: fc.stringMatching(/^[A-Z][a-z]{0,7}( [A-Z][a-z]{0,7})?$/),
  address: fc
    .tuple(
      fc.stringMatching(/^[a-z][a-z0-9.]{0,8}[a-z0-9]$/),
      fc.stringMatching(/^[a-z]{1,8}$/),
    )
    .filter(([local]) => !local.includes(".."))
    .map(([local, host]) => `${local}@${host}.example`),
});

const bodyLine = fc.oneof(
  fc.constant(""),
  fc.stringMatching(
    /^[A-Za-z0-9.,!?'()-]([A-Za-z0-9 .,!?'()-]{0,30}[A-Za-z0-9.,!?'()-])?$/,
  ),
  fc.constantFrom("café ☃", "\u{1f600} done", "naïve résumé"),
);

const message = fc.record({
  from: person,
  to: fc.array(person, { minLength: 1, maxLength: 3 }),
  cc: fc.array(person, { maxLength: 2 }),
  subject: fc.oneof(
    fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 ,.!?':]{0,30}[A-Za-z0-9.!?]$/),
    fc.constantFrom("Re: Quarterly report", "Fwd: lunch", "café ☃"),
  ),
  date: fc.integer({ min: 0, max: 4_102_444_800 }),
  header: fc.option(
    fc
      .stringMatching(/^[a-z0-9]{1,10}@[a-z]{1,8}\.example$/)
      .map((h) => `<${h}>`),
    { nil: null },
  ),
  body: fc.array(bodyLine, { minLength: 1, maxLength: 8 }),
});

const expectedMarkdown = (lines: string[]) =>
  lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

describe("parseMessage", () => {
  test("recovers the body of generated RFC 822 text", async () => {
    const base = MESSAGES[0];
    if (!base) throw new Error("no fixture row");
    await fc.assert(
      fc.asyncProperty(message, async (m) => {
        const row: Row = { ...base, ...m };
        const raw = rfc822(row, m.body.join("\r\n"));
        const parsed = await parseMessage(raw);
        expect(parsed.html).toBeNull();
        expect(toMarkdown(parsed)).toBe(expectedMarkdown(m.body));
        expect(await parseMessage(new TextEncoder().encode(raw))).toEqual(
          parsed,
        );
      }),
      { numRuns: 150 },
    );
  });
});
