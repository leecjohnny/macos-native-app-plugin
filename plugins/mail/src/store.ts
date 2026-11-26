import {
  DuckDbSnapshotStore,
  snapshot,
} from "@macos-native-app/core/runners/duckdb";
export { jsonValue, OMITTED_CAP } from "@macos-native-app/core/runners/duckdb";
import {
  DuckDBInstance,
  type DuckDBConnection,
  type DuckDBValue,
} from "@duckdb/node-api";
import { statSync } from "node:fs";
import { join } from "node:path";
import { type Account, readAccounts, role, versionDir } from "./accounts.ts";
import { compile, FTS, type Node } from "./query.ts";
import type {
  Address,
  ConversationPage,
  ConversationSummary,
  Mailbox,
  MessagePage,
  MessageSummary,
  SqlResult,
} from "./schema.ts";

export type CopyRef = {
  id: number;
  mailbox: number;
  account: string;
  path: string;
  labels: string[];
};

export type MessageDetail = {
  summary: MessageSummary;
  cc: Address[];
  header: string | null;
  copies: CopyRef[];
};

export type Store = {
  readonly accounts: Map<string, Account>;
  searchMessages(
    node: Node,
    query: string,
    limit: number,
    offset: number,
  ): Promise<MessagePage>;
  searchConversations(
    node: Node,
    query: string,
    limit: number,
    offset: number,
  ): Promise<ConversationPage>;
  message(id: string): Promise<MessageDetail | null>;
  conversation(id: string): Promise<string[] | null>;
  mailboxes(): Promise<Mailbox[]>;
  sql(text: string, maxRows: number): Promise<SqlResult>;
  refresh(): Promise<boolean>;
  close(): void;
};

type Row = Record<string, unknown>;

const ADDR = "STRUCT(name VARCHAR, address VARCHAR)[]";

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function parseUrl(url: string): { account: string; path: string } {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/]*)\/?(.*)$/i.exec(url);
  if (!m) return { account: "", path: url };
  return {
    account: m[1] ?? "",
    path: (m[2] ?? "").replace(/\/+$/, "").split("/").map(decode).join("/"),
  };
}

const COPY = `
CREATE TABLE copy AS
SELECT m.ROWID AS id,
  CASE WHEN m.message_id = 0 THEN 'r' || m.ROWID ELSE 'm' || m.message_id END AS message,
  m.message_id, m.conversation_id,
  coalesce(m.subject_prefix, '') || coalesce(s.subject, '') AS subject,
  coalesce(a.comment, '') AS sender_name, coalesce(a.address, '') AS sender_address,
  coalesce(su.summary, '') AS summary, g.message_id_header AS header,
  coalesce(m.date_received, 0) AS received, m.mailbox,
  coalesce(b.account, '') AS account, coalesce(b.path, '') AS path,
  m.read = 0 AS unread, m.flagged = 1 AS flagged,
  coalesce(t.n, 0) AS attachments,
  coalesce(r.to_list, []::${ADDR}) AS to_list, coalesce(r.cc_list, []::${ADDR}) AS cc_list,
  coalesce(r.to_text, '') AS to_text, coalesce(r.cc_text, '') AS cc_text
FROM mail.messages m
LEFT JOIN mail.subjects s ON s.ROWID = m.subject
LEFT JOIN mail.addresses a ON a.ROWID = m.sender
LEFT JOIN mail.summaries su ON su.ROWID = m.summary
LEFT JOIN mail.message_global_data g ON g.ROWID = m.global_message_id
LEFT JOIN mailbox b ON b.id = m.mailbox
LEFT JOIN (SELECT message, count(*) AS n FROM mail.attachments GROUP BY message) t ON t.message = m.ROWID
LEFT JOIN (
  SELECT r.message,
    list({'name': coalesce(ad.comment, ''), 'address': coalesce(ad.address, '')} ORDER BY r.position) FILTER (WHERE r.type = 0) AS to_list,
    list({'name': coalesce(ad.comment, ''), 'address': coalesce(ad.address, '')} ORDER BY r.position) FILTER (WHERE r.type = 1) AS cc_list,
    string_agg(lower(coalesce(ad.comment, '') || ' ' || coalesce(ad.address, '')), chr(10)) FILTER (WHERE r.type = 0) AS to_text,
    string_agg(lower(coalesce(ad.comment, '') || ' ' || coalesce(ad.address, '')), chr(10)) FILTER (WHERE r.type = 1) AS cc_text
  FROM mail.recipients r JOIN mail.addresses ad ON ad.ROWID = r.address
  GROUP BY r.message
) r ON r.message = m.ROWID
WHERE m.deleted = 0`;

const PLACEMENT = `
CREATE TABLE placement AS
SELECT c.id AS copy, c.message, b.id AS mailbox, b.account, b.path, b.leaf, b.role, false AS label
FROM copy c JOIN mailbox b ON b.id = c.mailbox
UNION ALL
SELECT c.id, c.message, b.id, b.account, b.path, b.leaf, b.role, true
FROM mail.labels l JOIN copy c ON c.id = l.message_id JOIN mailbox b ON b.id = l.mailbox_id`;

const MESSAGE = `
CREATE TABLE message AS
SELECT c.message AS id,
  CASE WHEN first(c.conversation_id ORDER BY c.conversation_id = 0, c.received DESC, c.id) = 0
    THEN 'c' || c.message
    ELSE 'c' || first(c.conversation_id ORDER BY c.conversation_id = 0, c.received DESC, c.id)
  END AS conversation,
  first(c.conversation_id ORDER BY c.conversation_id = 0, c.received DESC, c.id) AS conversation_id,
  first(c.subject ORDER BY c.received DESC, c.id) AS subject,
  first(c.sender_name ORDER BY c.received DESC, c.id) AS sender_name,
  first(c.sender_address ORDER BY c.received DESC, c.id) AS sender_address,
  first(c.sender_name || ' ' || c.sender_address ORDER BY c.received DESC, c.id) AS sender,
  first(c.summary ORDER BY c.received DESC, c.id) AS summary,
  first(c.header ORDER BY c.received DESC, c.id) AS header,
  first(c.to_list ORDER BY c.received DESC, c.id) AS to_list,
  first(c.cc_list ORDER BY c.received DESC, c.id) AS cc_list,
  max(c.received) AS received,
  bool_or(c.unread) AS unread, bool_or(c.flagged) AS flagged,
  max(c.attachments) AS attachments,
  count(*) AS copies,
  coalesce(any_value(p.mailboxes), []::VARCHAR[]) AS mailboxes,
  lower(first(c.sender_name || ' ' || c.sender_address ORDER BY c.received DESC, c.id)) AS from_text,
  first(c.to_text ORDER BY c.received DESC, c.id) AS to_text,
  first(c.cc_text ORDER BY c.received DESC, c.id) AS cc_text,
  lower(first(c.subject ORDER BY c.received DESC, c.id)) AS subject_text,
  lower(first(c.subject || ' ' || c.sender_name || ' ' || c.sender_address || ' ' || c.summary ORDER BY c.received DESC, c.id)) AS search_text
FROM copy c
LEFT JOIN (SELECT message, list_sort(list_distinct(list(path))) AS mailboxes FROM placement GROUP BY message) p ON p.message = c.message
GROUP BY c.message`;

const COUNTS = `
UPDATE mailbox SET total = n.total, unread = n.unread
FROM (
  SELECT p.mailbox, count(DISTINCT p.message) AS total,
    count(DISTINCT p.message) FILTER (WHERE m.unread) AS unread
  FROM placement p JOIN message m ON m.id = p.message GROUP BY p.mailbox
) n
WHERE mailbox.id = n.mailbox`;

const CONVERSATION = `
CREATE VIEW conversation AS
SELECT conversation AS id, conversation_id,
  first(subject ORDER BY received, id) AS subject,
  list({'name': sender_name, 'address': sender_address} ORDER BY received, id) AS senders,
  count(*) AS messages,
  count(*) FILTER (WHERE unread) AS unread,
  min(received) AS first_received, max(received) AS last_received,
  list_sort(list_distinct(flatten(list(mailboxes)))) AS mailboxes,
  first(summary ORDER BY received DESC, id) AS snippet
FROM message GROUP BY conversation, conversation_id`;

const num = (v: unknown) => Number(v ?? 0);
const iso = (v: unknown) => new Date(num(v) * 1000).toISOString();
const addrs = (v: unknown): Address[] =>
  ((v as Address[] | null) ?? []).map((a) => ({
    name: a.name,
    address: a.address,
  }));
const score = (v: unknown) =>
  v === null || v === undefined ? null : Number(v);

function summaryOf(r: Row): MessageSummary {
  return {
    id: String(r.id),
    conversation: String(r.conversation),
    subject: String(r.subject ?? ""),
    from: {
      name: String(r.sender_name ?? ""),
      address: String(r.sender_address ?? ""),
    },
    to: addrs(r.to_list),
    date: iso(r.received),
    unread: Boolean(r.unread),
    flagged: Boolean(r.flagged),
    attachments: num(r.attachments),
    mailboxes: (r.mailboxes as string[] | null) ?? [],
    snippet: String(r.summary ?? ""),
    score: score(r.score),
  };
}

function conversationOf(r: Row): ConversationSummary {
  const seen = new Set<string>();
  const participants = addrs(r.senders).filter((a) => {
    const key = a.address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    id: String(r.id),
    subject: String(r.subject ?? ""),
    participants,
    messages: num(r.messages),
    unread: num(r.unread),
    first: iso(r.first_received),
    last: iso(r.last_received),
    mailboxes: (r.mailboxes as string[] | null) ?? [],
    snippet: String(r.snippet ?? ""),
    score: score(r.score),
  };
}

const scored = (text: string | null) =>
  text === null
    ? { expr: "NULL::DOUBLE", params: [] as unknown[] }
    : { expr: `${FTS}(id, ?)`, params: [text] as unknown[] };

const mtime = (path: string) =>
  statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? 0;

type State = {
  instance: DuckDBInstance;
  conn: DuckDBConnection;
  engine: DuckDbSnapshotStore;
  accounts: Map<string, Account>;
};

async function build(root: string, db: string): Promise<State> {
  const dir = versionDir(root);
  const accounts = await readAccounts(dir);
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  const engine = new DuckDbSnapshotStore(conn, ["mail"]);
  try {
    await engine.attach("mail", db);
    await conn.run(
      "CREATE TABLE mailbox (id BIGINT, account VARCHAR, path VARCHAR, leaf VARCHAR, role VARCHAR, total BIGINT, unread BIGINT, source BIGINT)",
    );
    const boxes = (
      await conn.runAndReadAll(
        "SELECT ROWID AS id, url, source FROM mail.mailboxes",
      )
    ).getRowObjectsJS();
    const insert = await conn.prepare(
      "INSERT INTO mailbox VALUES (?, ?, ?, ?, ?, 0, 0, ?)",
    );
    try {
      for (const b of boxes) {
        const { account, path } = parseUrl(String(b.url));
        const attrs = accounts.get(account)?.attrs.get(path) ?? 0;
        const values: DuckDBValue[] = [
          BigInt(num(b.id)),
          account,
          path,
          path.split("/").at(-1) ?? path,
          role(path, attrs),
          b.source === null ? null : BigInt(num(b.source)),
        ];
        insert.bind(values);
        await insert.run();
      }
    } finally {
      insert.destroySync();
    }
    for (const statement of [COPY, PLACEMENT, MESSAGE, COUNTS, CONVERSATION])
      await conn.run(statement);
    await conn.run(
      "PRAGMA create_fts_index('message', 'id', 'subject', 'sender', 'summary', stopwords = 'none', ignore = '[^\\p{L}\\p{N}]+')",
    );
    await conn.run(`SELECT ${FTS}('', 'warmup')`);
    await engine.lock();
  } catch (error) {
    conn.closeSync();
    instance.closeSync();
    throw error;
  }
  return { instance, conn, engine, accounts };
}

export async function openStore(root: string): Promise<Store> {
  const db = join(versionDir(root), "MailData", "Envelope Index");
  const stampOf = () => `${mtime(db)}:${mtime(`${db}-wal`)}`;
  const snapshots = snapshot(
    stampOf,
    () => build(root, db),
    (state) => {
      state.conn.closeSync();
      state.instance.closeSync();
    },
  );
  await snapshots.refresh();

  const rows = async (sql: string, params: unknown[] = []) =>
    (
      await snapshots.current.conn.runAndReadAll(sql, params as DuckDBValue[])
    ).getRowObjectsJS() as Row[];

  return {
    get accounts() {
      return snapshots.current.accounts;
    },

    async searchMessages(node, query, limit, offset) {
      const c = compile(node);
      const s = scored(c.text);
      const [count] = await rows(
        `SELECT count(*) AS n FROM message WHERE ${c.where}`,
        c.params,
      );
      const page = await rows(
        `SELECT * FROM (SELECT *, ${s.expr} AS score FROM message WHERE ${c.where})
         ORDER BY score DESC NULLS LAST, received DESC, id LIMIT ? OFFSET ?`,
        [...s.params, ...c.params, limit, offset],
      );
      return {
        query,
        total: num(count?.n),
        offset,
        results: page.map(summaryOf),
      };
    },

    async searchConversations(node, query, limit, offset) {
      const c = compile(node);
      const s = scored(c.text);
      const [count] = await rows(
        `SELECT count(DISTINCT conversation) AS n FROM message WHERE ${c.where}`,
        c.params,
      );
      const page = await rows(
        `WITH hit AS (SELECT conversation, ${s.expr} AS score FROM message WHERE ${c.where}),
         best AS (SELECT conversation, max(score) AS score FROM hit GROUP BY conversation)
         SELECT v.*, best.score FROM best JOIN conversation v ON v.id = best.conversation
         ORDER BY best.score DESC NULLS LAST, v.last_received DESC, v.id LIMIT ? OFFSET ?`,
        [...s.params, ...c.params, limit, offset],
      );
      return {
        query,
        total: num(count?.n),
        offset,
        results: page.map(conversationOf),
      };
    },

    async message(id) {
      const [row] = await rows(
        "SELECT *, NULL AS score FROM message WHERE id = ?",
        [id],
      );
      if (!row) return null;
      const copies = await rows(
        `SELECT c.id, c.mailbox, c.account, c.path,
           coalesce(list(p.path ORDER BY p.path) FILTER (WHERE p.label), []::VARCHAR[]) AS labels
         FROM copy c LEFT JOIN placement p ON p.copy = c.id
         WHERE c.message = ? GROUP BY c.id, c.mailbox, c.account, c.path ORDER BY c.id`,
        [id],
      );
      return {
        summary: summaryOf(row),
        cc: addrs(row.cc_list),
        header:
          row.header === null || row.header === undefined
            ? null
            : String(row.header),
        copies: copies.map((c) => ({
          id: num(c.id),
          mailbox: num(c.mailbox),
          account: String(c.account),
          path: String(c.path),
          labels: (c.labels as string[] | null) ?? [],
        })),
      };
    },

    async conversation(id) {
      const ids = await rows(
        "SELECT id FROM message WHERE conversation = ? ORDER BY received, id",
        [id],
      );
      return ids.length ? ids.map((r) => String(r.id)) : null;
    },

    async mailboxes() {
      const boxes = await rows(
        "SELECT id, account, path, role, total, unread FROM mailbox ORDER BY account, path, id",
      );
      return boxes.map((b) => ({
        id: num(b.id),
        account: String(b.account),
        path: String(b.path),
        role: (b.role ?? null) as Mailbox["role"],
        total: num(b.total),
        unread: num(b.unread),
      }));
    },

    async sql(text, maxRows) {
      return snapshots.current.engine.executeSql(text, maxRows);
    },
    refresh: snapshots.refresh,
    close: snapshots.close,
  };
}
