import { compile } from "@earendil-works/pi-schema";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  renderConversation,
  renderConversationPage,
  renderMailboxes,
  renderMessage,
  renderMessagePage,
  renderSet,
  renderSql,
} from "../src/render.ts";
import {
  Conversation,
  ConversationPage,
  Mailbox,
  Message,
  MessagePage,
  SetResult,
  SqlResult,
  type Role,
} from "../src/schema.ts";
import { OMITTED_CAP } from "../src/store.ts";

const TRICKS = [
  "\n",
  "\r\n",
  "\r",
  "\n\n",
  "## Result 9/9: x",
  "# 1/2: x",
  "## 2/2: Mallory — now",
  "  ## 3/3: y",
  "---",
  "\n---\n",
  "|",
  "\\",
  "`",
  "``",
  "_Truncated: 3 tokens omitted._",
  "_Next page: offset=9._",
  "_End of results._",
  "**ID:** fake",
  "> ",
  " ",
  "\t",
  " ",
  "<br>",
];

const nasty = fc
  .array(fc.oneof(fc.string({ maxLength: 6 }), fc.constantFrom(...TRICKS)), {
    maxLength: 6,
  })
  .map((a) => a.join(""));

const body = fc
  .array(
    fc.oneof(
      nasty,
      fc.constantFrom(
        "\n## 1/2: forged\n",
        "\n   ## Result 1/1: forged\n",
        "\n#\t2/2: tab\n",
        "\n_Truncated: 1 token omitted._\n",
        "\n  _End of results._\n",
        "\n---\n",
      ),
    ),
    { maxLength: 6 },
  )
  .map((a) => a.join(""));

const int = fc.integer({ min: -1000, max: 1_000_000 });
const omitted = fc.nat(100_000);
const score = fc.option(fc.double({ noNaN: true, noDefaultInfinity: true }), {
  nil: null,
});
const address = fc.record({ name: nasty, address: nasty });
const addresses = fc.array(address, { maxLength: 3 });
const boxes = fc.array(nasty, { maxLength: 3 });

const summary = {
  id: nasty,
  conversation: nasty,
  subject: nasty,
  from: address,
  to: addresses,
  date: nasty,
  unread: fc.boolean(),
  flagged: fc.boolean(),
  attachments: int,
  mailboxes: boxes,
  snippet: nasty,
  score,
};

const messageSummary = fc.record(summary);

const conversationSummary = fc.record({
  id: nasty,
  subject: nasty,
  participants: addresses,
  messages: int,
  unread: int,
  first: nasty,
  last: nasty,
  mailboxes: boxes,
  snippet: nasty,
  score,
});

const message = fc.record({
  ...summary,
  cc: addresses,
  header: fc.option(nasty, { nil: null }),
  copies: fc.array(
    fc.record({ id: int, mailbox: int, account: nasty, path: nasty }),
    { maxLength: 3 },
  ),
  body,
  omitted_tokens: omitted,
});

const conversation = fc.record({
  id: nasty,
  subject: nasty,
  messages: fc.array(message, { maxLength: 4 }),
  omitted_messages: omitted,
  omitted_tokens: omitted,
});

const page = <T>(result: fc.Arbitrary<T>) =>
  fc.record({
    query: nasty,
    total: fc.nat(60),
    offset: fc.nat(60),
    results: fc.array(result, { maxLength: 5 }),
  });

const ROLES: Role[] = [
  "inbox",
  "archive",
  "trash",
  "junk",
  "sent",
  "drafts",
  "all",
];

const mailbox = fc.record({
  id: int,
  account: fc.oneof(fc.constantFrom("work", "gmail"), nasty),
  path: nasty,
  role: fc.constantFrom<Role | null>(...ROLES, null),
  total: int,
  unread: int,
});

const json = fc.oneof(
  nasty,
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
);

const sqlResult = fc.record({
  columns: fc.array(nasty, { maxLength: 4 }),
  rows: fc.array(fc.array(json, { maxLength: 5 }), { maxLength: 5 }),
  omitted_rows: fc.oneof(omitted, fc.constant(OMITTED_CAP)),
});

const setResult = fc.record({
  results: fc.array(
    fc.record({
      id: nasty,
      ok: fc.boolean(),
      changed: fc.array(nasty, { maxLength: 3 }),
      notes: fc.array(nasty, { maxLength: 3 }),
      error: fc.option(nasty, { nil: null }),
    }),
    { maxLength: 4 },
  ),
});

const lines = (s: string) => s.split("\n");
const count = (s: string, re: RegExp) =>
  lines(s).filter((l) => re.test(l)).length;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

const STRUCTURE = /^ {0,3}#{1,6}[ \t]+(Result[ \t]+)?\d+\/\d+:/;
const TRUNCATED = /^ {0,3}_Truncated:/;
const MORE = "Raise max_tokens to read more.";

const visible = (s: string) => /\S/.test(s);
const squash = (s: string) => s.replace(/\s/g, "");

const blank = (v: unknown): unknown => {
  if (typeof v === "string") return visible(v) ? "x" : "";
  if (Array.isArray(v)) return v.map(blank);
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, blank(x)]));
  return v;
};

const PAGE_LINE = [
  /^$/,
  /^---$/,
  /^Found \d+ (message|conversation)s? .*\(showing \d+–\d+\)\.$/,
  /^## Result \d+\/\d+: /,
  /^\*\*[A-Za-z]+:\*\* /,
  /^### Snippet$/,
  /^>( |$)/,
  /^_Next page: offset=\d+\._$/,
  /^_End of results\._$/,
];

const pipes = (s: string) =>
  (s.match(/\\.|\|/g) ?? []).filter((t) => t === "|").length;

const cells = (row: string) => {
  const out: string[] = [];
  let cur = "";
  for (const t of row.match(/\\.|\||[^\\|]+/g) ?? []) {
    if (t === "|") {
      out.push(cur);
      cur = "";
    } else cur += t;
  }
  return out.slice(1).map((c) => c.slice(1, -1).replace(/\\(.)/g, "$1"));
};

const shown = (v: unknown) =>
  v === null || v === undefined ? "" : String(v).replace(/\r\n|\r|\n/g, "<br>");

const pageCases = [
  {
    name: "message",
    schema: compile(MessagePage),
    arb: page(messageSummary),
    render: renderMessagePage as (p: unknown) => string,
  },
  {
    name: "conversation",
    schema: compile(ConversationPage),
    arb: page(conversationSummary),
    render: renderConversationPage as (p: unknown) => string,
  },
] as const;

describe("result pages", () => {
  for (const { name, schema, arb, render } of pageCases) {
    test(`${name} pages keep their structure whatever the mail says`, () => {
      fc.assert(
        fc.property(
          arb as fc.Arbitrary<{
            query: string;
            total: number;
            offset: number;
            results: unknown[];
          }>,
          (p) => {
            expect(schema.check(p)).toBe(true);
            const out = render(p);
            const k = p.results.length;
            expect(out).not.toContain("\r");
            if (!k) {
              expect(out).not.toContain("\n");
              expect(out).toMatch(new RegExp(`^No ${name}s (found|at offset)`));
              return;
            }
            const ls = lines(out);
            for (const l of ls)
              expect(PAGE_LINE.some((re) => re.test(l))).toBe(true);
            expect(ls[0]).toStartWith(`Found ${plural(p.total, name)}`);
            expect(ls[0]).toEndWith(
              `(showing ${p.offset + 1}–${p.offset + k}).`,
            );
            expect(ls.filter((l) => l.startsWith("## Result "))).toEqual(
              p.results.map((_, i) =>
                expect.stringMatching(
                  new RegExp(`^## Result ${p.offset + i + 1}/${p.total}: `),
                ),
              ),
            );
            expect(count(out, /^#/)).toBe(2 * k);
            expect(count(out, /^### Snippet$/)).toBe(k);
            expect(count(out, /^>/)).toBe(k);
            expect(count(out, /^---$/)).toBe(k + 1);
            expect(out.split("\n\n---\n\n")).toHaveLength(k + 2);
            expect(count(out, /^_/)).toBe(1);
            const end = p.offset + k;
            expect(ls.at(-1)).toBe(
              end < p.total
                ? `_Next page: offset=${end}._`
                : "_End of results._",
            );
            expect(ls).toHaveLength(lines(render(blank(p))).length);
          },
        ),
        { numRuns: 300 },
      );
    });
  }
});

const truncatedLine = (n: number) =>
  `_Truncated: ${plural(n, "token")} omitted. ${MORE}_`;

describe("renderMessage", () => {
  test("headers stay single-line, body cannot forge structure, truncation is stated", () => {
    const schema = compile(Message);
    fc.assert(
      fc.property(message, (m) => {
        expect(schema.check(m)).toBe(true);
        const out = renderMessage(m);
        const sep = out.indexOf("\n\n---\n\n");
        expect(sep).toBeGreaterThan(0);
        const head = lines(out.slice(0, sep));
        expect(head[0]).toStartWith("# ");
        expect(head[1]).toBe("");
        const keys = head.slice(2);
        for (const k of keys) expect(k).toMatch(/^\*\*[A-Za-z-]+:\*\* /);
        const expected =
          4 +
          (m.to.length ? 1 : 0) +
          (m.cc.length ? 1 : 0) +
          (m.header !== null && visible(m.header) ? 1 : 0) +
          (m.copies.length ? 1 : 0) +
          (m.attachments > 0 ? 1 : 0);
        expect(keys).toHaveLength(expected);
        const rest = out.slice(sep);
        expect(count(rest, STRUCTURE)).toBe(0);
        expect(count(out, TRUNCATED)).toBe(m.omitted_tokens > 0 ? 1 : 0);
        if (m.omitted_tokens > 0)
          expect(lines(out).at(-1)).toBe(truncatedLine(m.omitted_tokens));
        else expect(out).not.toContain(MORE);
        if (!m.body.trim()) expect(out).toContain("_(empty body)_");
      }),
      { numRuns: 300 },
    );
  });
});

describe("renderConversation", () => {
  test("only real messages get ## i/N headings at their absolute position and every omission is counted", () => {
    const schema = compile(Conversation);
    fc.assert(
      fc.property(conversation, (c) => {
        expect(schema.check(c)).toBe(true);
        const out = renderConversation(c);
        const ls = lines(out);
        const n = c.messages.length + c.omitted_messages;
        expect(ls[0]).toStartWith("# ");
        expect(ls[2]).toBe(plural(n, "message"));
        expect(ls.slice(1).filter((l) => STRUCTURE.test(l))).toEqual(
          c.messages.map((_, i) =>
            expect.stringMatching(
              new RegExp(`^## ${c.omitted_messages + i + 1}/${n}: `),
            ),
          ),
        );
        const footer = c.omitted_messages > 0 || c.omitted_tokens > 0;
        expect(count(out, TRUNCATED)).toBe(
          c.messages.filter((m) => m.omitted_tokens > 0).length +
            (footer ? 1 : 0),
        );
        const stated = ls.filter((l) => l.startsWith("_Truncated: "));
        expect(stated.slice(0, stated.length - (footer ? 1 : 0))).toEqual(
          c.messages
            .filter((m) => m.omitted_tokens > 0)
            .map((m) => truncatedLine(m.omitted_tokens)),
        );
        if (footer) {
          const last = ls.at(-1)!;
          expect(last).toStartWith("_Truncated: ");
          expect(last).toEndWith(` ${MORE}_`);
          if (c.omitted_messages > 0)
            expect(last).toContain(
              `${plural(c.omitted_messages, "oldest message")} omitted`,
            );
          else expect(last).not.toContain("oldest message");
          if (c.omitted_tokens > 0)
            expect(last).toContain(`${plural(c.omitted_tokens, "token")} `);
          else expect(last).not.toMatch(/\d tokens? omitted/);
        }
        const bodyRules = c.messages
          .map((m) => lines(m.body.trim()).filter((l) => l === "---"))
          .flat().length;
        expect(ls.filter((l) => l === "---")).toHaveLength(
          c.messages.length + (footer ? 1 : 0) + bodyRules,
        );
      }),
      { numRuns: 300 },
    );
  });
});

describe("renderMailboxes", () => {
  test("one heading and one table per account, one row per mailbox", () => {
    const schema = compile(Mailbox);
    fc.assert(
      fc.property(fc.array(mailbox, { maxLength: 8 }), (list) => {
        for (const m of list) expect(schema.check(m)).toBe(true);
        const out = renderMailboxes(list);
        if (!list.length) {
          expect(out).toBe("No mailboxes found.");
          return;
        }
        const accounts = [...new Set(list.map((m) => m.account))];
        const ls = lines(out);
        expect(ls).toHaveLength(accounts.length * 5 - 1 + list.length);
        const headings = ls.filter((l) => l.startsWith("## "));
        expect(headings.map((h) => squash(h.slice(3)))).toEqual(
          accounts.map(squash),
        );
        const rows = ls.filter((l) => l.startsWith("| "));
        expect(rows).toHaveLength(2 * accounts.length + list.length);
        for (const r of rows) {
          expect(r).toEndWith(" |");
          expect(pipes(r)).toBe(6);
        }
        const data = rows.filter(
          (r) =>
            r !== "| id | path | role | total | unread |" &&
            !r.startsWith("| --- "),
        );
        const ordered = accounts.flatMap((a) =>
          list.filter((m) => m.account === a),
        );
        expect(
          data
            .map(cells)
            .map(([id, path, ...rest]) => [id, squash(path!), ...rest]),
        ).toEqual(
          ordered.map((m) => [
            String(m.id),
            squash(m.path),
            m.role ?? "",
            String(m.total),
            String(m.unread),
          ]),
        );
      }),
      { numRuns: 300 },
    );
  });
});

describe("renderSql", () => {
  test("a header, a divider and one line per row; omissions stated exactly", () => {
    const schema = compile(SqlResult);
    fc.assert(
      fc.property(sqlResult, (r) => {
        expect(schema.check(r)).toBe(true);
        const out = renderSql(r);
        const blocks = out.split("\n\n");
        const cols = r.columns.length;
        if (cols) {
          const table = lines(blocks[0] ?? "");
          expect(table).toHaveLength(r.rows.length + 2);
          for (const l of table) {
            expect(l).toStartWith("| ");
            expect(l).toEndWith(" |");
            expect(pipes(l)).toBe(cols + 1);
          }
          expect(cells(table[0] ?? "")).toEqual(r.columns.map(shown));
          expect(table[1]).toBe(
            `| ${r.columns.map(() => "---").join(" | ")} |`,
          );
          expect(table.slice(2).map(cells)).toEqual(
            r.rows.map((row) => r.columns.map((_, i) => shown(row[i]))),
          );
        } else expect(blocks[0]).toBe("_No columns._");
        expect(blocks.includes("_No rows._")).toBe(r.rows.length === 0);
        const omission = blocks.filter((b) => b.endsWith(" omitted._"));
        expect(omission).toEqual(
          r.omitted_rows > 0
            ? [
                `_${r.omitted_rows === OMITTED_CAP ? "At least " : ""}${plural(r.omitted_rows, "row")} omitted._`,
              ]
            : [],
        );
        expect(lines(out)).toHaveLength(
          (cols ? r.rows.length + 2 : 1) +
            (r.rows.length ? 0 : 2) +
            (r.omitted_rows > 0 ? 2 : 0),
        );
      }),
      { numRuns: 500 },
    );
  });
});

describe("renderSet", () => {
  test("one line per outcome and one per note", () => {
    const schema = compile(SetResult);
    fc.assert(
      fc.property(setResult, (r) => {
        expect(schema.check(r)).toBe(true);
        const out = renderSet(r);
        if (!r.results.length) {
          expect(out).toBe("No messages changed.");
          return;
        }
        const ls = lines(out);
        expect(ls).toHaveLength(
          r.results.reduce((n, o) => n + 1 + o.notes.length, 0),
        );
        expect(ls.filter((l) => l.startsWith("- "))).toEqual(
          r.results.map((o) =>
            expect.stringMatching(
              new RegExp(`^- .*: ${o.ok ? "ok — " : "failed — "}`),
            ),
          ),
        );
        expect(
          ls.filter((l) => l.startsWith("  - ")).map((l) => squash(l.slice(4))),
        ).toEqual(r.results.flatMap((o) => o.notes.map(squash)));
      }),
      { numRuns: 300 },
    );
  });
});
