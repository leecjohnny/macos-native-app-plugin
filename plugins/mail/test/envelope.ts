import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const GMAIL = "AAAAAAAA-0000-4000-8000-000000000001";
export const ICLOUD = "BBBBBBBB-0000-4000-8000-000000000002";
export const WORK = "CCCCCCCC-0000-4000-8000-000000000003";

export const DAY = 86400;
export const NOW = 1795000000;

const ddl = `
CREATE TABLE messages (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
message_id INTEGER NOT NULL DEFAULT 0,
global_message_id INTEGER NOT NULL,
remote_id INTEGER,
document_id TEXT COLLATE BINARY,
sender INTEGER,
subject_prefix TEXT COLLATE BINARY,
subject INTEGER NOT NULL,
summary INTEGER,
date_sent INTEGER,
date_received INTEGER,
mailbox INTEGER NOT NULL,
remote_mailbox INTEGER,
flags INTEGER NOT NULL DEFAULT 0,
read INTEGER NOT NULL DEFAULT 0,
flagged INTEGER NOT NULL DEFAULT 0,
deleted INTEGER NOT NULL DEFAULT 0,
size INTEGER NOT NULL DEFAULT 0,
conversation_id INTEGER NOT NULL DEFAULT 0,
date_last_viewed INTEGER,
list_id_hash INTEGER,
unsubscribe_type INTEGER,
searchable_message INTEGER,
brand_indicator INTEGER,
display_date INTEGER,
flag_color INTEGER,
is_urgent INTEGER NOT NULL DEFAULT 0,
color TEXT COLLATE BINARY,
type INTEGER,
fuzzy_ancestor INTEGER,
automated_conversation INTEGER DEFAULT 0,
root_status INTEGER DEFAULT -1);
CREATE TABLE mailboxes (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
url TEXT COLLATE BINARY NOT NULL,
total_count INTEGER NOT NULL DEFAULT 0,
unread_count INTEGER NOT NULL DEFAULT 0,
deleted_count INTEGER NOT NULL DEFAULT 0,
unseen_count INTEGER NOT NULL DEFAULT 0,
unread_count_adjusted_for_duplicates INTEGER NOT NULL DEFAULT 0,
change_identifier TEXT COLLATE BINARY,
source INTEGER,
alleged_change_identifier TEXT COLLATE BINARY,
UNIQUE(url) ON CONFLICT ABORT);
CREATE TABLE addresses (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
address TEXT COLLATE NOCASE NOT NULL,
comment TEXT COLLATE BINARY NOT NULL,
UNIQUE(address, comment) ON CONFLICT ABORT);
CREATE TABLE recipients (ROWID INTEGER PRIMARY KEY,
message INTEGER NOT NULL,
address INTEGER NOT NULL,
type INTEGER,
position INTEGER,
UNIQUE(message, type, position) ON CONFLICT ABORT);
CREATE TABLE subjects (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
subject TEXT COLLATE RTRIM NOT NULL,
UNIQUE(subject) ON CONFLICT ABORT);
CREATE TABLE summaries (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
summary TEXT COLLATE RTRIM NOT NULL,
UNIQUE(summary) ON CONFLICT ABORT);
CREATE TABLE message_global_data (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
message_id INTEGER,
follow_up_start_date INTEGER,
follow_up_end_date INTEGER,
follow_up_jsonstringformodelevaluationforsuggestions TEXT COLLATE BINARY,
read_later_date INTEGER,
send_later_date INTEGER,
validation_state INTEGER NOT NULL DEFAULT 0,
model_category INTEGER,
model_subcategory INTEGER,
category_model_version INTEGER,
category_is_temporary INTEGER,
model_analytics TEXT COLLATE BINARY,
model_high_impact INTEGER NOT NULL DEFAULT 0,
generated_summary INTEGER,
urgent INTEGER,
message_id_header TEXT COLLATE BINARY,
due_by INTEGER,
UNIQUE(message_id) ON CONFLICT ABORT);
CREATE TABLE attachments (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
message INTEGER NOT NULL REFERENCES messages(ROWID) ON DELETE CASCADE,
attachment_id TEXT COLLATE BINARY,
name TEXT COLLATE BINARY,
UNIQUE(message, attachment_id) ON CONFLICT ABORT);
CREATE TABLE labels (message_id INTEGER REFERENCES messages(ROWID) ON DELETE CASCADE, mailbox_id INTEGER REFERENCES mailboxes(ROWID) ON DELETE CASCADE, PRIMARY KEY(message_id, mailbox_id)) WITHOUT ROWID;
CREATE TABLE conversations (conversation_id INTEGER PRIMARY KEY AUTOINCREMENT,
flags INTEGER NOT NULL DEFAULT 0,
sync_key TEXT COLLATE BINARY);
`;

export const ATTR = {
  hasChildren: 32,
  hasNoChildren: 64,
  all: 1024,
  archive: 2048,
  drafts: 4096,
  flagged: 8192,
  junk: 16384,
  sent: 32768,
  trash: 65536,
};

type Box = {
  id: number;
  account: string;
  path: string;
  source?: number;
  attrs: number;
};

export const MAILBOXES: Box[] = [
  {
    id: 1,
    account: GMAIL,
    path: "[Gmail]/All Mail",
    attrs: ATTR.all + ATTR.hasNoChildren,
  },
  {
    id: 2,
    account: GMAIL,
    path: "INBOX",
    source: 1,
    attrs: ATTR.hasNoChildren,
  },
  {
    id: 3,
    account: GMAIL,
    path: "[Gmail]/Trash",
    attrs: ATTR.trash + ATTR.hasNoChildren,
  },
  {
    id: 4,
    account: GMAIL,
    path: "Receipts",
    source: 1,
    attrs: ATTR.hasNoChildren,
  },
  {
    id: 5,
    account: GMAIL,
    path: "[Gmail]/Spam",
    attrs: ATTR.junk + ATTR.hasNoChildren,
  },
  { id: 6, account: ICLOUD, path: "INBOX", attrs: 1 },
  { id: 7, account: ICLOUD, path: "Archive", attrs: 0 },
  { id: 8, account: ICLOUD, path: "Deleted Messages", attrs: ATTR.trash },
  { id: 9, account: ICLOUD, path: "Junk", attrs: 0 },
  { id: 10, account: WORK, path: "INBOX", attrs: ATTR.hasNoChildren },
  {
    id: 11,
    account: WORK,
    path: "Archives/2026",
    attrs: ATTR.archive + ATTR.hasNoChildren,
  },
];

type Person = { address: string; name: string };

export const ALICE: Person = {
  address: "alice@example.com",
  name: "Alice Example",
};
export const BOB: Person = { address: "bob@example.org", name: "Bob Builder" };
export const CAROL: Person = {
  address: "carol@example.net",
  name: "Carol\nInjected",
};
export const NEWS: Person = {
  address: "news@letters.example",
  name: "Weekly Letter",
};
export const ME: Person = { address: "me@example.com", name: "Me" };

type Row = {
  rowid: number;
  messageId: number;
  header: string | null;
  mailbox: number;
  labels?: number[];
  conversation: number;
  from: Person;
  to: Person[];
  cc?: Person[];
  subject: string;
  summary: string;
  date: number;
  read: boolean;
  flagged?: boolean;
  deleted?: boolean;
  attachments?: string[];
  partial?: boolean;
};

export const MESSAGES: Row[] = [
  {
    rowid: 101,
    messageId: 9001,
    header: "<report-1@example.com>",
    mailbox: 1,
    labels: [2],
    conversation: 1,
    from: ALICE,
    to: [ME],
    cc: [BOB],
    subject: "Quarterly report",
    summary: "Numbers for the quarter are attached",
    date: NOW - 3 * DAY,
    read: false,
    attachments: ["report.pdf"],
  },
  {
    rowid: 102,
    messageId: 9001,
    header: "<report-1@example.com>",
    mailbox: 6,
    conversation: 1,
    from: ALICE,
    to: [ME],
    cc: [BOB],
    subject: "Quarterly report",
    summary: "Numbers for the quarter are attached",
    date: NOW - 3 * DAY,
    read: true,
    attachments: ["report.pdf"],
    partial: true,
  },
  {
    rowid: 103,
    messageId: 9002,
    header: "<report-2@example.org>",
    mailbox: 1,
    labels: [2, 4],
    conversation: 1,
    from: BOB,
    to: [ALICE, ME],
    subject: "Re: Quarterly report",
    summary: "Looks good, one question on revenue",
    date: NOW - 2 * DAY,
    read: true,
    flagged: true,
  },
  {
    rowid: 104,
    messageId: 9003,
    header: "<invoice-42@example.net>",
    mailbox: 7,
    conversation: 2,
    from: CAROL,
    to: [ME],
    subject: "Invoice 42",
    summary: "Payment due in thirty days",
    date: NOW - 40 * DAY,
    read: true,
  },
  {
    rowid: 105,
    messageId: 0,
    header: null,
    mailbox: 6,
    conversation: 3,
    from: NEWS,
    to: [ME],
    subject: "No header one",
    summary: "First message without a Message-ID",
    date: NOW - 1 * DAY,
    read: false,
  },
  {
    rowid: 106,
    messageId: 0,
    header: null,
    mailbox: 6,
    conversation: 3,
    from: NEWS,
    to: [ME],
    subject: "No header two",
    summary: "Second message without a Message-ID",
    date: NOW - 1 * DAY + 60,
    read: true,
  },
  {
    rowid: 107,
    messageId: 9004,
    header: "<letter-7@letters.example>",
    mailbox: 10,
    conversation: 4,
    from: NEWS,
    to: [ME],
    subject: "Weekly letter: markets",
    summary: "This week in markets and quarterly earnings",
    date: NOW - 400 * DAY,
    read: true,
  },
  {
    rowid: 108,
    messageId: 9005,
    header: "<gone@example.com>",
    mailbox: 6,
    conversation: 5,
    from: ALICE,
    to: [ME],
    subject: "Deleted quarterly draft",
    summary: "This row is deleted and must never appear",
    date: NOW - 5 * DAY,
    read: true,
    deleted: true,
  },
  {
    rowid: 109,
    messageId: 9006,
    header: "<trash-1@example.org>",
    mailbox: 3,
    conversation: 6,
    from: BOB,
    to: [ME],
    subject: "Old lunch plans",
    summary: "Lunch on Friday?",
    date: NOW - 10 * DAY,
    read: true,
  },
  {
    rowid: 110,
    messageId: 9001,
    header: "<report-1@example.com>",
    mailbox: 10,
    conversation: 1,
    from: ALICE,
    to: [ME],
    cc: [BOB],
    subject: "Quarterly report",
    summary: "Numbers for the quarter are attached",
    date: NOW - 3 * DAY,
    read: true,
    flagged: true,
  },
];

const encode = (path: string) =>
  path.split("/").map(encodeURIComponent).join("/");

const mboxDir = (box: Box) =>
  box.path
    .split("/")
    .map((part) => `${part}.mbox`)
    .join("/");

export const emlxPath = (root: string, row: Row) => {
  const box = MAILBOXES.find((b) => b.id === row.mailbox);
  if (!box) throw new Error(`no mailbox ${row.mailbox}`);
  const suffix = row.partial ? ".partial.emlx" : ".emlx";
  return join(
    root,
    "V10",
    box.account,
    mboxDir(box),
    "STORE-0000",
    "Data",
    "Messages",
    `${row.rowid}${suffix}`,
  );
};

const formatAddress = (p: Person) =>
  `"${p.name.replace(/\n/g, " ")}" <${p.address}>`;

export const rfc822 = (row: Row, body = row.summary) =>
  [
    `From: ${formatAddress(row.from)}`,
    `To: ${row.to.map(formatAddress).join(", ")}`,
    ...(row.cc?.length ? [`Cc: ${row.cc.map(formatAddress).join(", ")}`] : []),
    `Subject: ${row.subject}`,
    `Date: ${new Date(row.date * 1000).toUTCString()}`,
    ...(row.header ? [`Message-ID: ${row.header}`] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
    "",
  ].join("\r\n");

export const emlx = (message: string) => {
  const bytes = Buffer.byteLength(message);
  return `${bytes}\n${message}<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>flags</key><integer>0</integer></dict></plist>\n`;
};

const plistValue = (value: unknown): string => {
  if (typeof value === "number") return `<integer>${value}</integer>`;
  if (typeof value === "string") return `<string>${value}</string>`;
  if (typeof value === "boolean") return value ? "<true/>" : "<false/>";
  if (Array.isArray(value))
    return `<array>${value.map(plistValue).join("")}</array>`;
  const entries = Object.entries(value as Record<string, unknown>);
  return `<dict>${entries.map(([k, v]) => `<key>${k}</key>${plistValue(v)}`).join("")}</dict>`;
};

type Tree = Record<
  string,
  {
    IMAPMailboxAttributes: number;
    MailboxPathComponent: string;
    IMAPMailboxChildren: Tree;
  }
>;

const mboxCache = (account: string, capabilities: string[]) => {
  const mboxes: Tree = {};
  for (const box of MAILBOXES.filter((b) => b.account === account)) {
    let level = mboxes;
    const parts = box.path.split("/");
    parts.forEach((part, i) => {
      level[part] ??= {
        MailboxPathComponent: part,
        IMAPMailboxAttributes: ATTR.hasChildren,
        IMAPMailboxChildren: {},
      };
      const node = level[part];
      if (i === parts.length - 1) node.IMAPMailboxAttributes = box.attrs;
      level = node.IMAPMailboxChildren;
    });
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">${plistValue({ separator: "/", capabilities, mboxes })}</plist>\n`;
};

export const CAPABILITIES: Record<string, string[]> = {
  [GMAIL]: ["IMAP4REV1", "X-GM-EXT-1", "SPECIAL-USE", "MOVE"],
  [ICLOUD]: ["IMAP4REV1", "MOVE"],
  [WORK]: ["IMAP4REV1", "SPECIAL-USE", "MOVE"],
};

export type Fixture = { root: string; db: string };

export function buildFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "macos-mail-"));
  const dataDir = join(root, "V10", "MailData");
  mkdirSync(dataDir, { recursive: true });
  const db = join(dataDir, "Envelope Index");
  const sql = new Database(db, { create: true });
  sql.exec("PRAGMA journal_mode = WAL");
  sql.exec(ddl);

  for (const box of MAILBOXES) {
    sql.run("INSERT INTO mailboxes (ROWID, url, source) VALUES (?, ?, ?)", [
      box.id,
      `imap://${box.account}/${encode(box.path)}`,
      box.source ?? null,
    ]);
  }

  const ids = new Map<string, number>();
  const intern = (table: string, column: string, value: string) => {
    const key = `${table}\u0000${value}`;
    const known = ids.get(key);
    if (known) return known;
    const row = sql
      .query(
        `INSERT INTO ${table} (${column}) VALUES (?) RETURNING ROWID AS id`,
      )
      .get(value) as { id: number };
    ids.set(key, row.id);
    return row.id;
  };
  const person = (p: Person) => {
    const key = `addresses\u0000${p.address}\u0000${p.name}`;
    const known = ids.get(key);
    if (known) return known;
    const row = sql
      .query(
        "INSERT INTO addresses (address, comment) VALUES (?, ?) RETURNING ROWID AS id",
      )
      .get(p.address, p.name) as { id: number };
    ids.set(key, row.id);
    return row.id;
  };
  const globals = new Map<number, number>();
  const global = (row: Row) => {
    const key = row.messageId === 0 ? -row.rowid : row.messageId;
    const known = globals.get(key);
    if (known) return known;
    const inserted = sql
      .query(
        "INSERT INTO message_global_data (message_id, message_id_header) VALUES (?, ?) RETURNING ROWID AS id",
      )
      .get(key, row.header) as { id: number };
    globals.set(key, inserted.id);
    return inserted.id;
  };

  for (const conversation of new Set(MESSAGES.map((m) => m.conversation))) {
    sql.run("INSERT INTO conversations (conversation_id) VALUES (?)", [
      conversation,
    ]);
  }

  for (const row of MESSAGES) {
    sql.run(
      `INSERT INTO messages (ROWID, message_id, global_message_id, sender, subject, summary, date_sent, date_received,
        mailbox, read, flagged, deleted, size, conversation_id, display_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.rowid,
        row.messageId,
        global(row),
        person(row.from),
        intern("subjects", "subject", row.subject),
        intern("summaries", "summary", row.summary),
        row.date - 30,
        row.date,
        row.mailbox,
        row.read ? 1 : 0,
        row.flagged ? 1 : 0,
        row.deleted ? 1 : 0,
        rfc822(row).length,
        row.conversation,
        row.date,
      ],
    );
    row.to.forEach((p, i) =>
      sql.run(
        "INSERT INTO recipients (message, address, type, position) VALUES (?, ?, 0, ?)",
        [row.rowid, person(p), i],
      ),
    );
    (row.cc ?? []).forEach((p, i) =>
      sql.run(
        "INSERT INTO recipients (message, address, type, position) VALUES (?, ?, 1, ?)",
        [row.rowid, person(p), i],
      ),
    );
    (row.attachments ?? []).forEach((name, i) =>
      sql.run(
        "INSERT INTO attachments (message, attachment_id, name) VALUES (?, ?, ?)",
        [row.rowid, String(i + 2), name],
      ),
    );
    for (const label of row.labels ?? [])
      sql.run("INSERT INTO labels (message_id, mailbox_id) VALUES (?, ?)", [
        row.rowid,
        label,
      ]);
    const file = emlxPath(root, row);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, emlx(rfc822(row)));
  }

  for (const box of MAILBOXES) {
    const live = MESSAGES.filter(
      (m) => !m.deleted && (m.mailbox === box.id || m.labels?.includes(box.id)),
    );
    sql.run(
      "UPDATE mailboxes SET total_count = ?, unread_count = ? WHERE ROWID = ?",
      [live.length, live.filter((m) => !m.read).length, box.id],
    );
  }

  for (const account of [GMAIL, ICLOUD, WORK]) {
    writeFileSync(
      join(root, "V10", account, ".mboxCache.plist"),
      mboxCache(account, CAPABILITIES[account] ?? []),
    );
  }

  sql.close();
  return { root, db };
}
