import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/plugin.ts";
import { OMITTED_CAP } from "../src/store.ts";
import { TOOLS } from "../src/tools.ts";
import { DAY, emlxPath, GMAIL, ICLOUD, NOW, WORK } from "./envelope.ts";
import {
  type Harness,
  harness,
  LONG,
  outputErrors,
  QUOTED,
  remove,
  rewrite,
  row,
} from "./harness.ts";

let h: Harness;

beforeAll(async () => {
  h = await harness((root) => {
    rewrite(root, 107, LONG);
    rewrite(root, 103, QUOTED);
  });
});
afterAll(() => h.close());

const ids = async (query: string, ...flags: string[]): Promise<string[]> =>
  (
    await h.json("search_messages", query, "--limit", "100", ...flags)
  ).results.map((r: { id: string }) => r.id);
const sorted = async (query: string) => (await ids(query)).toSorted();
const sql = async (text: string, maxRows = 100) =>
  h.json("execute_sql", text, "--max-rows", String(maxRows));

const ymd = (at: number) => {
  const d = new Date(at * 1000);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
};

describe("store through the CLI", () => {
  test("copies fold into one message per Message-ID", async () => {
    expect(await sorted("")).toEqual([
      "m9001",
      "m9002",
      "m9003",
      "m9004",
      "m9006",
      "r105",
      "r106",
    ]);
    const m = await h.json("fetch_message", "m9001");
    expect(m).toMatchObject({
      unread: true,
      flagged: true,
      attachments: 1,
      mailboxes: ["INBOX", "[Gmail]/All Mail"],
      date: new Date((NOW - 3 * DAY) * 1000).toISOString(),
      conversation: "c1",
      to: [{ name: "Me", address: "me@example.com" }],
      cc: [{ name: "Bob Builder", address: "bob@example.org" }],
      header: "<report-1@example.com>",
      omitted_tokens: 0,
    });
    expect(m.copies).toEqual([
      { id: 101, mailbox: 1, account: GMAIL, path: "[Gmail]/All Mail" },
      { id: 102, mailbox: 6, account: ICLOUD, path: "INBOX" },
      { id: 110, mailbox: 10, account: WORK, path: "INBOX" },
    ]);
    expect(m.body).toBe("Numbers for the quarter are attached");
  });

  test("message_id 0 rows are separate and deleted rows never appear", async () => {
    const r105 = await h.json("fetch_message", "r105");
    expect(r105.header).toBeNull();
    expect(r105.unread).toBe(true);
    expect((await h.json("fetch_message", "r106")).unread).toBe(false);
    for (const id of ["m9005", "nope"]) {
      const r = await h.cli("fetch_message", id);
      expect(r.code).toBe(1);
      expect(r.err).toContain(`No message with id "${id}"`);
    }
    expect(await ids("deleted")).toEqual([]);
    expect(
      (await sql("SELECT count(*) FROM copy WHERE id = 108")).rows,
    ).toEqual([[0]]);
  });

  test("raw sender names survive in JSON and are flattened in markdown", async () => {
    expect((await h.json("fetch_message", "m9003")).from).toEqual({
      name: "Carol\nInjected",
      address: "carol@example.net",
    });
    const r = await h.cli("search_messages", "invoice");
    expect(r.out).toContain("**From:** Carol Injected <carol@example.net>");
  });

  test("conversations group de-duplicated messages oldest first", async () => {
    const c1 = await h.json("fetch_conversation", "c1");
    expect(c1.messages.map((m: { id: string }) => m.id)).toEqual([
      "m9001",
      "m9002",
    ]);
    const c3 = await h.json("fetch_conversation", "c3");
    expect(c3.messages.map((m: { id: string }) => m.id)).toEqual([
      "r105",
      "r106",
    ]);
    const gone = await h.cli("fetch_conversation", "c5");
    expect(gone.code).toBe(1);
    expect(gone.err).toContain("No conversation");
    const page = await h.json("search_conversations", "--limit", "100");
    expect(page.total).toBe(5);
    const c = page.results.find((x: { id: string }) => x.id === "c1");
    expect(c).toMatchObject({
      subject: "Quarterly report",
      messages: 2,
      unread: 1,
      participants: [
        { name: "Alice Example", address: "alice@example.com" },
        { name: "Bob Builder", address: "bob@example.org" },
      ],
      mailboxes: ["INBOX", "Receipts", "[Gmail]/All Mail"],
      snippet: "Looks good, one question on revenue",
      score: null,
    });
    expect(c.first < c.last).toBe(true);
    expect(page.results.map((x: { id: string }) => x.id)).toEqual([
      "c3",
      "c1",
      "c6",
      "c2",
      "c4",
    ]);
  });

  test("BM25 ranks quarterly matches and excludes others", async () => {
    const page = await h.json("search_messages", "quarterly");
    expect(page.total).toBe(3);
    const got = page.results.map((r: { id: string }) => r.id);
    expect(got.toSorted()).toEqual(["m9001", "m9002", "m9004"]);
    const scores = page.results.map((r: { score: number }) => r.score);
    expect(scores.every((s: number) => s > 0)).toBe(true);
    expect(scores).toEqual(scores.toSorted((a: number, b: number) => b - a));
    expect(got.at(-1)).toBe("m9004");
    const conv = await h.json("search_conversations", "quarterly");
    expect(conv.results.map((x: { id: string }) => x.id)).toEqual(["c1", "c4"]);
    expect(conv.results[0].score).toBe(page.results[0].score);
    const twice = await h.json("search_messages", "-(-quarterly)");
    expect(twice.results.map((r: { id: string }) => r.id)).toEqual(got);
    expect(
      twice.results.every((r: { score: number | null }) => r.score !== null),
    ).toBe(true);
  });

  test("text: negation, phrases, digits, sender and injection", async () => {
    expect(await ids("quarterly -earnings")).not.toContain("m9004");
    expect(await ids('"quarter are"')).toEqual(["m9001"]);
    expect(
      (await h.json("search_messages", '"quarter are"')).results[0].score,
    ).toBeNull();
    expect(await ids("numbers for the quarter")).toEqual(["m9001"]);
    expect(await ids("one question on revenue")).toEqual(["m9002"]);
    expect(await ids("42")).toEqual(["m9003"]);
    expect(await ids("carol")).toEqual(["m9003"]);
    expect(await ids("zzzz")).toEqual([]);
    expect(
      await ids(`"x'); DROP TABLE message; " subject:"'; DROP TABLE message;"`),
    ).toEqual([]);
    expect((await sql("SELECT count(*) FROM message")).rows).toEqual([[7]]);
  });

  test("field operators", async () => {
    expect(await sorted("from:ALICE")).toEqual(["m9001"]);
    expect(await sorted("from:bob@example")).toEqual(["m9002", "m9006"]);
    expect(await ids("to:alice")).toEqual(["m9002"]);
    expect(await ids("cc:builder")).toEqual(["m9001"]);
    expect(await ids("subject:invoice")).toEqual(["m9003"]);
    expect(await ids("subject:%")).toEqual([]);
  });

  test("is, has, date and OR operators", async () => {
    expect(await sorted("is:unread")).toEqual(["m9001", "r105"]);
    expect(await ids("is:read")).not.toContain("m9001");
    expect(await sorted("is:flagged")).toEqual(["m9001", "m9002"]);
    expect(await sorted("is:starred")).toEqual(["m9001", "m9002"]);
    expect(await ids("has:attachment")).toEqual(["m9001"]);
    expect(await ids(`before:${ymd(NOW - 100 * DAY)}`)).toEqual(["m9004"]);
    expect(await sorted(`after:${ymd(NOW - 2 * DAY)}`)).toEqual([
      "m9002",
      "r105",
      "r106",
    ]);
    expect(await ids("subject:invoice OR has:attachment")).toEqual([
      "m9001",
      "m9003",
    ]);
    expect(await sorted("from:alice OR (to:alice revenue)")).toEqual([
      "m9001",
      "m9002",
    ]);
    expect(await sorted("older_than:1y")).toEqual(["m9004"]);
    expect(await sorted("older_than:5d")).toEqual(["m9003", "m9004", "m9006"]);
    expect(await sorted("newer_than:2w")).toEqual([
      "m9001",
      "m9002",
      "m9006",
      "r105",
      "r106",
    ]);
    expect(await sorted("newer_than:3m")).toEqual([
      "m9001",
      "m9002",
      "m9003",
      "m9006",
      "r105",
      "r106",
    ]);
    expect(await sorted("newer_than:3d")).toEqual([
      "m9001",
      "m9002",
      "r105",
      "r106",
    ]);
  });

  test("in: spans Gmail labels, iCloud INBOX, roles and leaves", async () => {
    expect(await sorted("in:inbox")).toEqual([
      "m9001",
      "m9002",
      "m9004",
      "r105",
      "r106",
    ]);
    expect(await ids("in:receipts")).toEqual(["m9002"]);
    expect(await ids("in:trash")).toEqual(["m9006"]);
    expect(await ids("in:archive")).toEqual(["m9003"]);
    expect(await ids("in:spam")).toEqual([]);
    expect(await ids("in:junk")).toEqual([]);
    expect(await sorted("in:all")).toEqual(["m9001", "m9002"]);
    expect(await ids("in:[gmail]/trash")).toEqual(["m9006"]);
    expect(await ids("in:inbox -in:receipts")).not.toContain("m9002");
    for (const name of ["constructor", "__proto__", "toString", "valueOf"])
      expect(await ids(`in:${name}`)).toEqual([]);
  });

  test("pagination keeps total and order", async () => {
    const all = await ids("");
    expect(all[0]).toBe("r106");
    const page = await h.json(
      "search_messages",
      "--limit",
      "2",
      "--offset",
      "2",
    );
    expect(page).toMatchObject({ query: "", total: 7, offset: 2 });
    expect(page.results.map((r: { id: string }) => r.id)).toEqual(
      all.slice(2, 4),
    );
    expect(
      (await h.json("search_messages", "--limit", "5", "--offset", "50")).total,
    ).toBe(7);
    const tail = await h.json(
      "search_conversations",
      "--limit",
      "2",
      "--offset",
      "4",
    );
    expect(tail.results).toHaveLength(1);
    const md = await h.cli("search_messages", "--limit", "2", "--offset", "2");
    expect(md.out).toContain("Found 7 messages (showing 3–4).");
    expect(md.out).toContain("_Next page: offset=4._");
  });

  test("fetch_mailboxes carries roles and de-duplicated counts", async () => {
    const boxes = (await h.json("fetch_mailboxes")).mailboxes;
    expect(boxes).toHaveLength(11);
    expect(
      boxes.map((b: { id: number; total: number; unread: number }) => [
        b.id,
        b.total,
        b.unread,
      ]),
    ).toEqual(
      expect.arrayContaining([
        [1, 2, 1],
        [2, 2, 1],
        [3, 1, 0],
        [4, 1, 0],
        [5, 0, 0],
        [6, 3, 2],
        [7, 1, 0],
        [8, 0, 0],
        [9, 0, 0],
        [10, 2, 1],
        [11, 0, 0],
      ]),
    );
    const by = (id: number) => boxes.find((b: { id: number }) => b.id === id);
    expect(by(1)).toEqual({
      id: 1,
      account: GMAIL,
      path: "[Gmail]/All Mail",
      role: "all",
      total: 2,
      unread: 1,
    });
    expect(by(2).role).toBe("inbox");
    expect(by(4).role).toBeNull();
    expect(by(5).role).toBe("junk");
    expect(by(6)).toMatchObject({ role: "inbox", total: 3, unread: 2 });
    expect(by(7).role).toBe("archive");
    expect(by(8).role).toBe("trash");
    expect(by(9).role).toBe("junk");
    expect(by(11)).toMatchObject({ path: "Archives/2026", role: "archive" });
    const md = await h.cli("fetch_mailboxes");
    expect(md.out).toContain(`## ${GMAIL}`);
    expect(md.out).toContain("| 11 | Archives/2026 | archive |");
  });

  test("execute_sql returns JSON scalars and caps rows honestly", async () => {
    const r = await sql(
      "SELECT id, received, unread, to_list FROM message ORDER BY id",
      3,
    );
    expect(r.columns).toEqual(["id", "received", "unread", "to_list"]);
    expect(r.rows).toHaveLength(3);
    expect(r.omitted_rows).toBe(4);
    expect(r.rows[0]).toEqual([
      "m9001",
      NOW - 3 * DAY,
      true,
      '[{"name":"Me","address":"me@example.com"}]',
    ]);
    const big = await sql(
      "SELECT 9007199254740993::BIGINT AS b, TIMESTAMP '2026-01-02 03:04:05' AS t, 5::BIGINT AS n, 18446744073709551616::HUGEINT AS h, NULL AS z, {'a': 1::BIGINT} AS s",
      1,
    );
    expect(big.rows).toEqual([
      [
        "9007199254740993",
        "2026-01-02T03:04:05.000Z",
        5,
        "18446744073709551616",
        null,
        '{"a":1}',
      ],
    ]);
    expect((await sql("SELECT count(*) FROM mail.messages")).rows).toEqual([
      [10],
    ]);
    expect((await sql("SELECT count(*) FROM conversation")).rows).toEqual([
      [5],
    ]);
    expect(await sql("SELECT * FROM range(1000)", 2)).toMatchObject({
      columns: ["range"],
      rows: [[0], [1]],
      omitted_rows: 998,
    });
    expect((await sql("SELECT * FROM range(1500000)", 1)).omitted_rows).toBe(
      OMITTED_CAP,
    );
    expect((await sql("SELECT 1 WHERE false", 5)).rows).toEqual([]);
    const md = await h.cli(
      "execute_sql",
      "SELECT id FROM message ORDER BY id",
      "--max-rows",
      "2",
    );
    expect(md.out).toContain("| m9001 |");
    expect(md.out).toContain("_5 rows omitted._");
    const capped = await h.cli(
      "execute_sql",
      "SELECT * FROM range(1500000)",
      "--max-rows",
      "1",
    );
    expect(capped.out).toContain(`_At least ${OMITTED_CAP} rows omitted._`);
  });

  test("execute_sql lockdown errors surface as tool errors", async () => {
    for (const text of [
      "SELECT * FROM read_csv('/etc/hosts')",
      "SELECT * FROM read_text('/etc/hosts')",
      "SELECT * FROM glob('/*')",
    ]) {
      const r = await h.cli("execute_sql", text);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/disabled by configuration/);
    }
    for (const text of [
      `ATTACH '${h.db}' AS again`,
      "COPY message TO '/tmp/macos-mail-leak.csv'",
      "INSTALL json",
      "SET enable_external_access = true",
      "CREATE TABLE x AS SELECT 1",
      "DROP TABLE message",
      "DETACH mail",
      "SELECT 1; SELECT 2",
    ]) {
      const r = await h.mcp("execute_sql", { sql: text });
      expect(r.isError).toBe(true);
      expect(r.text).toStartWith("Error in execute_sql:");
      expect(r.structured).toBeUndefined();
    }
    expect((await sql("SELECT count(*) FROM message", 1)).rows).toEqual([[7]]);
  });
});

describe("fetch tools", () => {
  test("fetch_message renders the emlx body as markdown", async () => {
    const r = await h.cli("fetch_message", "m9001");
    expect(r.code).toBe(0);
    expect(r.out).toStartWith("# Quarterly report\n");
    expect(r.out).toContain("**ID:** m9001");
    expect(r.out).toContain("**Message-ID:** <report-1@example.com>");
    expect(r.out).toContain(`**Copies:** 101 in ${GMAIL}/[Gmail]/All Mail`);
    expect(r.out).toContain("Numbers for the quarter are attached");
    expect(r.out).not.toContain("_Truncated");
  });

  test("fetch_message states truncation with a small max_tokens", async () => {
    const full = await h.json("fetch_message", "m9004");
    expect(full.body).toBe(LONG);
    expect(full.omitted_tokens).toBe(0);
    const m = await h.json("fetch_message", "m9004", "--max-tokens", "64");
    expect(m.body.length).toBeLessThanOrEqual(256);
    expect(m.body).toStartWith("Paragraph 0 about markets");
    expect(m.omitted_tokens).toBe(
      Math.ceil(LONG.length / 4) - Math.ceil(m.body.length / 4),
    );
    const md = await h.cli("fetch_message", "m9004", "--max_tokens=64");
    expect(md.out).toContain(
      `_Truncated: ${m.omitted_tokens} tokens omitted. Raise max_tokens to read more._`,
    );
  });

  test("fetch_conversation keeps quotes when it fits, trims them first when not", async () => {
    const roomy = await h.json("fetch_conversation", "c1");
    expect(roomy).toMatchObject({
      id: "c1",
      subject: "Quarterly report",
      omitted_messages: 0,
      omitted_tokens: 0,
    });
    expect(roomy.messages[1].body).toBe(QUOTED);
    const tight = await h.json(
      "fetch_conversation",
      "c1",
      "--max-tokens",
      "128",
    );
    expect(tight.omitted_messages).toBe(0);
    expect(tight.messages[0].body).toBe("Numbers for the quarter are attached");
    expect(tight.messages[1].body).toBe("Looks good, one question on revenue");
    expect(tight.messages[1].omitted_tokens).toBe(
      Math.ceil(QUOTED.length / 4) -
        Math.ceil("Looks good, one question on revenue".length / 4),
    );
    const small = await h.json(
      "fetch_conversation",
      "c1",
      "--max-tokens",
      "64",
    );
    expect(small.messages.map((m: { id: string }) => m.id)).toEqual([
      "m9001",
      "m9002",
    ]);
    expect(small.omitted_messages).toBe(0);
    expect(small.messages[1].body).toBe("Looks good, one question on revenue");
    expect(small.omitted_tokens).toBe(small.messages[1].omitted_tokens);
    const md = await h.cli("fetch_conversation", "c1", "--max-tokens", "64");
    expect(md.out).toContain("## 1/2: ");
    expect(md.out).toContain(
      `_Truncated: ${small.omitted_tokens} tokens omitted in all, counting omitted messages and cuts.`,
    );
  });

  test("fetch_conversation omits the oldest messages only when trimmed bodies still do not fit", async () => {
    const p = await harness((root) => {
      rewrite(root, 101, LONG);
      rewrite(root, 103, LONG);
    });
    try {
      const one = await p.json(
        "fetch_conversation",
        "c1",
        "--max-tokens",
        "64",
      );
      expect(one.messages.map((m: { id: string }) => m.id)).toEqual(["m9002"]);
      expect(one.omitted_messages).toBe(1);
      expect(one.omitted_tokens).toBe(
        Math.ceil(LONG.length / 4) + one.messages[0].omitted_tokens,
      );
      const md = await p.cli("fetch_conversation", "c1", "--max-tokens", "64");
      expect(md.out).toContain("## 2/2: ");
      expect(md.out).not.toContain("## 1/2: ");
      expect(md.out).toContain(
        `_Truncated: 1 oldest message omitted, ${one.omitted_tokens} tokens omitted in all`,
      );
      const both = await p.json(
        "fetch_conversation",
        "c1",
        "--max-tokens",
        "128",
      );
      expect(both.omitted_messages).toBe(0);
    } finally {
      await p.close();
    }
  });

  test("an unreadable .emlx falls back to the next copy", async () => {
    const p = await harness((root) => {
      for (const id of [101, 110])
        writeFileSync(emlxPath(root, row(id)), "not an emlx");
    });
    try {
      const m = await p.json("fetch_message", "m9001");
      expect(m.body).toStartWith(
        "Numbers for the quarter are attached\n\n_Only a partial download",
      );
    } finally {
      await p.close();
    }
  });

  test("partial-only copies and missing bodies fall back with a note", async () => {
    const p = await harness((root) => remove(root, 101, 110, 104));
    try {
      const m = await p.json("fetch_message", "m9001");
      expect(m.body).toStartWith(
        "Numbers for the quarter are attached\n\n_Only a partial download",
      );
      const s = await p.json("fetch_message", "m9003");
      expect(s.body).toBe(
        "Payment due in thirty days\n\n_The message body is not on disk; this is Mail's summary of it._",
      );
    } finally {
      await p.close();
    }
  });
});

describe("set_messages", () => {
  test("archive moves each account's inbox copy through the runner", async () => {
    h.calls.length = 0;
    const r = await h.json(
      "set_messages",
      "m9001",
      "--mailbox",
      "archive",
      "--read",
    );
    expect(h.calls).toEqual([
      ["read", GMAIL, "[Gmail]/All Mail", "true", "101"],
      ["read", ICLOUD, "INBOX", "true", "102"],
      ["read", WORK, "INBOX", "true", "110"],
      ["move", GMAIL, "INBOX", "[Gmail]/All Mail", "101"],
      ["move", ICLOUD, "INBOX", "Archive", "102"],
      ["move", WORK, "INBOX", "Archives/2026", "110"],
    ]);
    expect(r.results).toHaveLength(1);
    expect(r.results[0]).toMatchObject({ id: "m9001", ok: true, error: null });
  });

  test("mailbox ids resolve through fetch_mailboxes and unknown ids fail", async () => {
    h.calls.length = 0;
    const r = await h.json(
      "set_messages",
      "--ids",
      "m9002,nope",
      "--ids",
      "m9006",
      "--mailbox",
      "4",
    );
    expect(h.calls).toEqual([
      ["move", GMAIL, "[Gmail]/Trash", "Receipts", "109"],
    ]);
    expect(
      r.results.map((o: { id: string; ok: boolean }) => [o.id, o.ok]),
    ).toEqual([
      ["m9002", true],
      ["nope", false],
      ["m9006", true],
    ]);
    const md = await h.cli(
      "set_messages",
      "--ids",
      "nope",
      "--flagged",
      "true",
    );
    expect(md.code).toBe(0);
    expect(md.out).toStartWith("- nope: failed — ");
  });
});

describe("CLI", () => {
  test("help lists every tool and describes one", async () => {
    let out = "";
    expect(
      await main(["help"], { stdout: (s) => (out += s), stderr: () => {} }),
    ).toBe(0);
    for (const t of TOOLS) expect(out).toContain(t.name);
    out = "";
    expect(
      await main(["--help"], { stdout: (s) => (out += s), stderr: () => {} }),
    ).toBe(0);
    expect(out).toContain("Usage: macos-native-app mail");
    const one = await h.cli("help", "fetch-message");
    expect(one.out).toContain("--max-tokens <integer> (default 2048)");
    expect(one.out).toContain("--id <string> [positional]");
    expect((await h.cli("search_messages", "--help")).out).toContain("Gmail");
    let err = "";
    expect(
      await main([], { stdout: () => {}, stderr: (s) => (err += s) }),
    ).toBe(1);
    expect(err).toContain("Usage:");
  });

  test("input errors exit 1 with a clear message", async () => {
    const cases: [string[], string][] = [
      [["search_messages", "--limit", "0"], "- /limit:"],
      [["search_messages", "--bogus", "1"], "- /bogus: unknown field"],
      [["search_messages", "foo:bar"], "unknown operator 'foo:'"],
      [["search_messages", '"open'], "unterminated quote"],
      [["set_messages", "--read"], "- /ids: missing"],
      [["fetch_message", "--max-tokens", "lots", "m9001"], "- /max_tokens:"],
      [["no_such_tool"], 'Unknown tool "no_such_tool"'],
      [
        ["fetch_mailboxes", "extra"],
        "fetch_mailboxes takes no positional value",
      ],
      [["fetch_message", "--id"], "--id needs a value"],
    ];
    for (const [argv, message] of cases) {
      const r = await h.cli(...argv);
      expect(r.code).toBe(1);
      expect(r.out).toBe("");
      expect(r.err).toContain(message);
    }
  });

  test("runs without a shared context, building the store from MACOS_MAIL_ROOT", async () => {
    let out = "";
    const code = await main(["search-messages", "from:carol", "--json"], {
      stdout: (s) => (out += s),
      stderr: () => {},
      env: { MACOS_MAIL_ROOT: h.root },
    });
    expect(code).toBe(0);
    expect(JSON.parse(out).results.map((r: { id: string }) => r.id)).toEqual([
      "m9003",
    ]);
  });
});

describe("MCP", () => {
  test("lists every tool with its schemas and annotations", async () => {
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name)).toEqual(
      TOOLS.map((t) => "mail_" + t.name),
    );
    for (const t of tools) {
      const def = TOOLS.find((x) => "mail_" + x.name === t.name)!;
      expect(t.inputSchema).toEqual(JSON.parse(JSON.stringify(def.input)));
      expect(t.outputSchema).toEqual(JSON.parse(JSON.stringify(def.output)));
      expect(t.description?.length).toBeGreaterThan(50);
      expect(t.annotations?.readOnlyHint).toBe(t.name !== "mail_set_messages");
      expect(t.annotations?.idempotentHint).toBe(true);
      expect(t.annotations?.destructiveHint).toBe(
        t.name === "mail_set_messages",
      );
    }
  });

  test("structuredContent matches the output schema and the CLI's --json", async () => {
    const cases: [string, Record<string, unknown>, string[]][] = [
      [
        "search_messages",
        { query: "quarterly", limit: 2 },
        ["quarterly", "--limit", "2"],
      ],
      ["search_conversations", {}, []],
      [
        "fetch_message",
        { id: "m9004", max_tokens: 100 },
        ["m9004", "--max-tokens", "100"],
      ],
      [
        "fetch_conversation",
        { id: "c1", max_tokens: 128 },
        ["c1", "--max-tokens", "128"],
      ],
      ["fetch_mailboxes", {}, []],
      [
        "execute_sql",
        { sql: "SELECT id FROM message ORDER BY id", max_rows: 2 },
        ["SELECT id FROM message ORDER BY id", "--max-rows", "2"],
      ],
      [
        "set_messages",
        { ids: ["m9006"], flagged: true },
        ["m9006", "--flagged"],
      ],
    ];
    for (const [name, args, argv] of cases) {
      const r = await h.mcp(name, args);
      expect(r.isError).toBe(false);
      expect(outputErrors(name, r.structured)).toEqual([]);
      expect(r.structured).toEqual(await h.json(name, ...argv));
      expect(r.text).toBe((await h.cli(name, ...argv)).out.trimEnd());
    }
  });

  test("bad input is a tool error listing schema paths", async () => {
    const r = await h.mcp("search_messages", { limit: 500, extra: true });
    expect(r.isError).toBe(true);
    expect(r.structured).toBeUndefined();
    expect(r.text).toContain("Input error for search_messages:");
    expect(r.text).toContain("- /limit:");
    expect(r.text).toContain("- /extra: unknown field");
    const q = await h.mcp("search_conversations", { query: "in:" });
    expect(q.isError).toBe(true);
    expect(q.text).toContain("empty value for 'in:'");
    const u = await h.mcp("nope");
    expect(u.isError).toBe(true);
    expect(u.text).toContain("Unknown tool");
    const coerced = await h.mcp("search_messages", { limit: "1" });
    expect(coerced.isError).toBe(false);
    expect((coerced.structured!.results as unknown[]).length).toBe(1);
  });

  test("refresh picks up a changed Envelope Index and accounts", async () => {
    const r = await harness();
    try {
      expect([...r.ctx.store.accounts.keys()].toSorted()).toEqual([
        GMAIL,
        ICLOUD,
        WORK,
      ]);
      const extra = "DDDDDDDD-0000-4000-8000-000000000004";
      mkdirSync(join(r.root, "V10", extra));
      copyFileSync(
        join(r.root, "V10", ICLOUD, ".mboxCache.plist"),
        join(r.root, "V10", extra, ".mboxCache.plist"),
      );
      const before = await r.mcp("search_messages", {});
      expect(before.structured?.total).toBe(7);
      const db = new Database(r.db);
      db.run(
        "INSERT INTO messages (ROWID, message_id, global_message_id, sender, subject, summary, date_received, mailbox, conversation_id) VALUES (111, 9100, 1, 1, 1, 1, ?, 6, 9)",
        [NOW],
      );
      db.close();
      const at = new Date(Date.now() + 60_000);
      utimesSync(r.db, at, at);
      const after = await r.mcp("search_messages", {});
      expect(after.structured?.total).toBe(8);
      expect((after.structured!.results as { id: string }[])[0]?.id).toBe(
        "m9100",
      );
      expect(r.ctx.store.accounts.has(extra)).toBe(true);
      const c9 = await r.mcp("fetch_conversation", { id: "c9" });
      expect(
        (c9.structured!.messages as { id: string }[]).map((m) => m.id),
      ).toEqual(["m9100"]);
    } finally {
      await r.close();
    }
  });
});

describe("unusual store contents", () => {
  let u: Harness;
  beforeAll(async () => {
    u = await harness((root) => {
      const db = new Database(join(root, "V10", "MailData", "Envelope Index"));
      const boxes: [number, string, number][] = [
        [12, `imap://${GMAIL}/constructor`, 99],
        [13, `imap://${ICLOUD}/__proto__`, 99],
        [14, `imap://${WORK}/Trailing/`, 99],
      ];
      for (const [id, url, n] of boxes)
        db.run(
          "INSERT INTO mailboxes (ROWID, url, total_count, unread_count) VALUES (?, ?, ?, ?)",
          [id, url, n, n],
        );
      const copies: [number, number, number, number][] = [
        [201, 9200, 12, 0],
        [202, 9200, 13, 1],
        [203, 9201, 12, 1],
        [204, 0, 14, 1],
      ];
      for (const [rowid, messageId, mailbox, read] of copies)
        db.run(
          "INSERT INTO messages (ROWID, message_id, global_message_id, sender, subject, summary, date_received, mailbox, read, conversation_id) VALUES (?, ?, 1, 1, 1, 1, ?, ?, ?, 0)",
          [rowid, messageId, NOW - rowid, mailbox, read],
        );
      db.close();
    });
  });
  afterAll(() => u.close());

  test("prototype-named mailboxes are plain mailboxes", async () => {
    const boxes = (await u.json("fetch_mailboxes")).mailboxes;
    const by = (id: number) => boxes.find((b: { id: number }) => b.id === id);
    expect(by(12)).toEqual({
      id: 12,
      account: GMAIL,
      path: "constructor",
      role: null,
      total: 2,
      unread: 1,
    });
    expect(by(13)).toMatchObject({ path: "__proto__", role: null, total: 1 });
    expect(by(14)).toMatchObject({ path: "Trailing", total: 1, unread: 0 });
    const hits = async (q: string) =>
      (await u.json("search_messages", q)).results
        .map((r: { id: string }) => r.id)
        .toSorted();
    expect(await hits("in:constructor")).toEqual(["m9200", "m9201"]);
    expect(await hits("in:__proto__")).toEqual(["m9200"]);
    expect(await hits("in:trailing")).toEqual(["r204"]);
    expect(await hits("in:toString")).toEqual([]);
  });

  test("unthreaded messages are conversations of their own", async () => {
    const page = await u.json("search_conversations", "--limit", "100");
    expect(page.total).toBe(8);
    const own = page.results
      .map((c: { id: string }) => c.id)
      .filter((id: string) => !/^c\d+$/.test(id))
      .toSorted();
    expect(own).toEqual(["cm9200", "cm9201", "cr204"]);
    for (const [id, message] of [
      ["cm9200", "m9200"],
      ["cm9201", "m9201"],
      ["cr204", "r204"],
    ] as const) {
      expect((await u.json("fetch_message", message)).conversation).toBe(id);
      const c = await u.json("fetch_conversation", id);
      expect(c.messages.map((m: { id: string }) => m.id)).toEqual([message]);
    }
    expect((await u.cli("fetch_conversation", "c0")).code).toBe(1);
  });
});
