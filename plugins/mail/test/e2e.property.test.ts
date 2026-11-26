import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  type Harness,
  harness,
  LONG,
  outputErrors,
  QUOTED,
  remove,
  rewrite,
} from "./harness.ts";

let h: Harness;

beforeAll(async () => {
  h = await harness((root) => {
    rewrite(root, 107, LONG);
    rewrite(root, 103, QUOTED);
  });
});
afterAll(() => h.close());

const RUNS = { numRuns: 60 };
const TIMEOUT = 60_000;

const WORDS = [
  "quarterly",
  "report",
  "42",
  "lunch",
  "from:alice",
  "from:bob",
  "to:me",
  "cc:builder",
  "subject:invoice",
  "in:inbox",
  "in:receipts",
  "in:trash",
  "in:all",
  "is:unread",
  "is:read",
  "is:flagged",
  "has:attachment",
  "after:2026/1/1",
  "before:2026/11/1",
  "newer_than:1y",
  "older_than:2w",
  '"quarter are"',
  "OR",
  "-",
  "(",
  ")",
  "foo:bar",
  '"',
  "in:",
];

const tokenQuery = fc
  .array(fc.constantFrom(...WORDS), { maxLength: 8 })
  .map((ws) => ws.join(" "));
const anyQuery = fc.oneof(tokenQuery, fc.string({ maxLength: 40 }));

type Page = {
  total: number;
  offset: number;
  results: { id: string; conversation?: string }[];
};

test(
  "any query yields a valid page or an input error, with unique ids",
  async () => {
    await fc.assert(
      fc.asyncProperty(
        anyQuery,
        fc.constantFrom("search_messages", "search_conversations"),
        async (query, name) => {
          const r = await h.mcp(name, { query, limit: 100 });
          if (r.isError) {
            expect(r.text).toStartWith(`Input error for ${name}:`);
            expect(r.structured).toBeUndefined();
            return;
          }
          expect(outputErrors(name, r.structured)).toEqual([]);
          const page = r.structured as unknown as Page;
          const ids = page.results.map((x) => x.id);
          expect(new Set(ids).size).toBe(ids.length);
          expect(page.total).toBe(ids.length);
        },
      ),
      RUNS,
    );
  },
  TIMEOUT,
);

test(
  "conversations of a query are exactly the conversations of its messages",
  async () => {
    await fc.assert(
      fc.asyncProperty(tokenQuery, async (query) => {
        const m = await h.mcp("search_messages", { query, limit: 100 });
        const c = await h.mcp("search_conversations", { query, limit: 100 });
        expect(c.isError).toBe(m.isError);
        if (m.isError) return;
        const fromMessages = new Set(
          (m.structured as unknown as Page).results.map((x) => x.conversation),
        );
        const conversations = (c.structured as unknown as Page).results.map(
          (x) => x.id,
        );
        expect(conversations.toSorted()).toEqual(
          [...fromMessages].toSorted() as string[],
        );
      }),
      RUNS,
    );
  },
  TIMEOUT,
);

test(
  "pages tile the full result list for any limit and offset",
  async () => {
    const all = (await h.json("search_messages", "--limit", "100")).results.map(
      (r: { id: string }) => r.id,
    );
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 0, max: 12 }),
        async (limit, offset) => {
          const r = await h.mcp("search_messages", { limit, offset });
          const page = r.structured as unknown as Page;
          expect(page.total).toBe(all.length);
          expect(page.results.map((x) => x.id)).toEqual(
            all.slice(offset, offset + limit),
          );
        },
      ),
      RUNS,
    );
  },
  TIMEOUT,
);

const tokens = (s: string) => Math.ceil(s.length / 4);

type Fetched = { id: string; body: string; omitted_tokens: number };
type Thread = {
  messages: Fetched[];
  omitted_messages: number;
  omitted_tokens: number;
};

const NOTE =
  /\n\n(_Only a partial download[^\n]*_|_The message body is not on disk[^\n]*_)$|^(_Only a partial download[^\n]*_|_The message body is not on disk[^\n]*_)$/;

const split = (body: string) => {
  const m = NOTE.exec(body);
  return m
    ? { text: body.slice(0, m.index), note: m[1] ?? m[2]! }
    : { text: body, note: "" };
};

const checkMessage = (got: Fetched, full: Fetched, max: number) => {
  expect(tokens(got.body)).toBeLessThanOrEqual(max);
  const a = split(got.body);
  const b = split(full.body);
  expect(a.note).toBe(b.note);
  expect(b.text.startsWith(a.text)).toBe(true);
  expect(got.omitted_tokens > 0).toBe(a.text !== b.text);
  if (a.text !== b.text)
    expect(got.omitted_tokens).toBe(
      Math.max(1, tokens(b.text) - tokens(a.text)),
    );
};

const headings = (md: string) =>
  md
    .split("\n")
    .filter((l) => /^## \d+\/\d+: /.test(l))
    .map((l) => l.slice(3, l.indexOf(":")));

const checkThread = async (
  x: Harness,
  id: string,
  max: number,
  originals: Fetched[],
) => {
  const r = await x.mcp("fetch_conversation", { id, max_tokens: max });
  expect(r.isError).toBe(false);
  expect(outputErrors("fetch_conversation", r.structured)).toEqual([]);
  const c = r.structured as unknown as Thread;
  const n = originals.length;
  expect(c.messages.length).toBeGreaterThanOrEqual(1);
  expect(c.messages.length + c.omitted_messages).toBe(n);
  expect(c.messages.map((m) => m.id)).toEqual(
    originals.slice(c.omitted_messages).map((m) => m.id),
  );
  expect(sum(c.messages.map((m) => tokens(m.body)))).toBeLessThanOrEqual(max);
  const whole = sum(originals.map((m) => tokens(m.body)));
  if (whole <= max) {
    expect(c.omitted_messages).toBe(0);
    expect(c.omitted_tokens).toBe(0);
    expect(c.messages.map((m) => m.body)).toEqual(originals.map((m) => m.body));
  }
  const cut = c.messages.some((m, i) => {
    const o = originals[c.omitted_messages + i]!;
    return split(m.body).text !== split(o.body).text;
  });
  for (const m of c.messages)
    expect(m.omitted_tokens > 0).toBe(
      split(m.body).text !==
        split(originals.find((o) => o.id === m.id)!.body).text,
    );
  expect(c.omitted_tokens).toBe(
    sum(
      originals
        .slice(0, c.omitted_messages)
        .map((m) => tokens(split(m.body).text)),
    ) + sum(c.messages.map((m) => m.omitted_tokens)),
  );
  expect(c.omitted_tokens > 0).toBe(cut || c.omitted_messages > 0);
  const md = await x.cli("fetch_conversation", id, "--max-tokens", String(max));
  expect(md.code).toBe(0);
  expect(md.out.trimEnd()).toBe(r.text);
  expect(headings(md.out)).toEqual(
    c.messages.map((_, i) => `${c.omitted_messages + i + 1}/${n}`),
  );
  expect(
    md.out.includes("tokens omitted in all") ||
      md.out.includes("token omitted in all"),
  ).toBe(c.omitted_tokens > 0);
  expect(md.out.includes("oldest message")).toBe(c.omitted_messages > 0);
  return c;
};

const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);

const originals = async (x: Harness, id: string) => {
  const c = await x.json("fetch_conversation", id, "--max-tokens", "100000");
  return c.messages as Fetched[];
};

const MAX = fc.integer({ min: 64, max: 2400 });

test(
  "fetch_message never exceeds max_tokens and counts what it cut",
  async () => {
    const full = await h.json(
      "fetch_message",
      "m9004",
      "--max-tokens",
      "100000",
    );
    expect(full.body).toBe(LONG);
    await fc.assert(
      fc.asyncProperty(MAX, async (max) => {
        const r = await h.mcp("fetch_message", {
          id: "m9004",
          max_tokens: max,
        });
        expect(outputErrors("fetch_message", r.structured)).toEqual([]);
        checkMessage(r.structured as unknown as Fetched, full, max);
      }),
      RUNS,
    );
  },
  TIMEOUT,
);

test(
  "fetch_conversation keeps every message that fits, numbers them absolutely and counts every cut",
  async () => {
    const c1 = await originals(h, "c1");
    expect(c1.map((m) => m.body)).toEqual([
      "Numbers for the quarter are attached",
      QUOTED,
    ]);
    await fc.assert(
      fc.asyncProperty(MAX, async (max) => {
        const c = await checkThread(h, "c1", max, c1);
        expect(c.omitted_messages).toBe(0);
      }),
      RUNS,
    );
  },
  TIMEOUT,
);

describe("long threads and bodies that are not fully on disk", () => {
  let x: Harness;
  beforeAll(async () => {
    x = await harness((root) => {
      rewrite(root, 103, LONG);
      rewrite(root, 102, LONG);
      remove(root, 101, 110, 104);
    });
  });
  afterAll(() => x.close());

  test(
    "partial and summary bodies keep their note inside max_tokens",
    async () => {
      const partial = await x.json(
        "fetch_message",
        "m9001",
        "--max-tokens",
        "100000",
      );
      expect(split(partial.body)).toMatchObject({ text: LONG });
      expect(split(partial.body).note).toStartWith("_Only a partial download");
      const summary = await x.json(
        "fetch_message",
        "m9003",
        "--max-tokens",
        "100000",
      );
      expect(split(summary.body).note).toStartWith(
        "_The message body is not on disk",
      );
      await fc.assert(
        fc.asyncProperty(MAX, async (max) => {
          for (const [id, full] of [
            ["m9001", partial],
            ["m9003", summary],
          ] as const) {
            const r = await x.mcp("fetch_message", { id, max_tokens: max });
            expect(outputErrors("fetch_message", r.structured)).toEqual([]);
            checkMessage(r.structured as unknown as Fetched, full, max);
          }
        }),
        RUNS,
      );
    },
    TIMEOUT,
  );

  test(
    "fetch_conversation drops only the oldest messages and only when needed",
    async () => {
      const c1 = await originals(x, "c1");
      expect(c1).toHaveLength(2);
      const ids = (
        await x.json("search_conversations", "--limit", "100")
      ).results.map((r: { id: string }) => r.id) as string[];
      const all = await Promise.all(
        ids.map(async (id) => [id, await originals(x, id)] as const),
      );
      await fc.assert(
        fc.asyncProperty(MAX, fc.constantFrom(...all), async (max, [id, o]) => {
          await checkThread(x, id, max, o);
        }),
        RUNS,
      );
      const small = await checkThread(x, "c1", 64, c1);
      expect(small.omitted_messages).toBe(1);
    },
    TIMEOUT,
  );
});

test(
  "CLI flags and MCP arguments produce the same structured result",
  async () => {
    await fc.assert(
      fc.asyncProperty(
        tokenQuery,
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 0, max: 8 }),
        async (query, limit, offset) => {
          const r = await h.mcp("search_messages", { query, limit, offset });
          const cli = await h.cli(
            "search-messages",
            "--query",
            query,
            "--limit",
            String(limit),
            "--offset",
            String(offset),
            "--json",
          );
          expect(cli.code).toBe(r.isError ? 1 : 0);
          if (r.isError) expect(cli.err.trimEnd()).toBe(r.text);
          else expect(JSON.parse(cli.out)).toEqual(r.structured);
        },
      ),
      RUNS,
    );
  },
  TIMEOUT,
);
