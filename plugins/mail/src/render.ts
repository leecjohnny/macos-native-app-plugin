import {
  SEP,
  line,
  cell,
  guard,
  table,
  plural,
  page,
} from "@macos-native-app/core/protocol/render";
import type {
  Address,
  Conversation,
  ConversationPage,
  ConversationSummary,
  Mailbox,
  Message,
  MessagePage,
  MessageSummary,
  SetResult,
  SqlResult,
} from "./schema.ts";
import { OMITTED_CAP } from "./store.ts";

const MORE = "Raise max_tokens to read more.";

const addr = (a: Address): string => {
  const name = line(a.name);
  const address = line(a.address);
  return !name || name === address ? address : `${name} <${address}>`;
};

const addrs = (list: Address[]): string => list.map(addr).join(", ");

const quote = (s: string): string => `> ${line(s)}`.trimEnd();

const key = (k: string, v: string): string => `**${k}:** ${v}`;

const status = (unread: boolean, flagged: boolean): string =>
  [unread ? "unread" : "read", ...(flagged ? ["flagged"] : [])].join(", ");

const result = (
  i: number,
  total: number,
  subject: string,
  keys: [string, string | null][],
  snippet: string,
): string =>
  [
    `## Result ${i}/${total}: ${line(subject) || "(no subject)"}`,
    keys
      .filter((k): k is [string, string] => k[1] !== null && k[1] !== "")
      .map(([k, v]) => key(k, v))
      .join("\n"),
    "### Snippet",
    quote(snippet),
  ].join("\n\n");

const score = (s: number | null): string | null =>
  s === null ? null : s.toFixed(2);

const boxes = (m: string[]): string => m.map(line).join(", ");

const messageResult = (m: MessageSummary, i: number, total: number) =>
  result(
    i,
    total,
    m.subject,
    [
      ["ID", line(m.id)],
      ["Conversation", line(m.conversation)],
      ["From", addr(m.from)],
      ["To", addrs(m.to)],
      ["Date", line(m.date)],
      ["Mailboxes", boxes(m.mailboxes)],
      ["Status", status(m.unread, m.flagged)],
      ["Attachments", m.attachments > 0 ? String(m.attachments) : null],
      ["Score", score(m.score)],
    ],
    m.snippet,
  );

const conversationResult = (c: ConversationSummary, i: number, total: number) =>
  result(
    i,
    total,
    c.subject,
    [
      ["ID", line(c.id)],
      ["Participants", addrs(c.participants)],
      ["Messages", String(c.messages)],
      ["Unread", String(c.unread)],
      [
        "Date",
        line(c.first) === line(c.last)
          ? line(c.last)
          : `${line(c.first)} – ${line(c.last)}`,
      ],
      ["Mailboxes", boxes(c.mailboxes)],
      ["Score", score(c.score)],
    ],
    c.snippet,
  );

export const renderMessagePage = (p: MessagePage): string =>
  page(
    "message",
    p,
    p.results.map((m, i) => messageResult(m, p.offset + i + 1, p.total)),
  );

export const renderConversationPage = (p: ConversationPage): string =>
  page(
    "conversation",
    p,
    p.results.map((c, i) => conversationResult(c, p.offset + i + 1, p.total)),
  );

const truncated = (n: number): string[] =>
  n > 0 ? [`_Truncated: ${plural(n, "token")} omitted. ${MORE}_`] : [];

const headers = (m: Message, full: boolean): string =>
  [
    key("From", addr(m.from)),
    ...(m.to.length ? [key("To", addrs(m.to))] : []),
    ...(m.cc.length ? [key("Cc", addrs(m.cc))] : []),
    ...(full ? [key("Date", line(m.date))] : []),
    key("ID", line(m.id)),
    ...(full && m.header && line(m.header)
      ? [key("Message-ID", line(m.header))]
      : []),
    ...(full ? [key("Mailboxes", boxes(m.mailboxes))] : []),
    ...(full && m.copies.length
      ? [
          key(
            "Copies",
            m.copies
              .map((c) => `${c.id} in ${line(c.account)}/${line(c.path)}`)
              .join(", "),
          ),
        ]
      : []),
    ...(m.attachments > 0 ? [key("Attachments", String(m.attachments))] : []),
  ].join("\n");

export const renderMessage = (m: Message): string =>
  [
    `# ${line(m.subject) || "(no subject)"}`,
    headers(m, true),
    "---",
    guard(m.body.trim()) || "_(empty body)_",
    ...truncated(m.omitted_tokens),
  ].join("\n\n");

export const renderConversation = (c: Conversation): string => {
  const n = c.messages.length + c.omitted_messages;
  const omitted = [
    ...(c.omitted_messages > 0
      ? [`${plural(c.omitted_messages, "oldest message")} omitted`]
      : []),
    ...(c.omitted_tokens > 0
      ? [
          `${plural(c.omitted_tokens, "token")} omitted in all, counting omitted messages and cuts`,
        ]
      : []),
  ];
  return [
    [`# ${line(c.subject) || "(no subject)"}`, plural(n, "message")].join(
      "\n\n",
    ),
    ...c.messages.map((m, i) =>
      [
        `## ${c.omitted_messages + i + 1}/${n}: ${line(m.from.name) || line(m.from.address)} — ${line(m.date)}`,
        headers(m, false),
        guard(m.body.trim()) || "_(empty body)_",
        ...truncated(m.omitted_tokens),
      ].join("\n\n"),
    ),
    ...(omitted.length ? [`_Truncated: ${omitted.join(", ")}. ${MORE}_`] : []),
  ].join(SEP);
};

export const renderMailboxes = (list: Mailbox[]): string => {
  if (!list.length) return "No mailboxes found.";
  const accounts = [...new Set(list.map((m) => m.account))];
  return accounts
    .map((a) =>
      [
        `## ${line(a)}`,
        table(
          ["id", "path", "role", "total", "unread"],
          list
            .filter((m) => m.account === a)
            .map((m) => [
              String(m.id),
              cell(line(m.path)),
              m.role ?? "",
              String(m.total),
              String(m.unread),
            ]),
        ),
      ].join("\n\n"),
    )
    .join("\n\n");
};

export const renderSql = (r: SqlResult): string =>
  [
    r.columns.length
      ? table(
          r.columns.map(cell),
          r.rows.map((row) => r.columns.map((_, i) => cell(row[i] ?? null))),
        )
      : "_No columns._",
    ...(r.rows.length ? [] : ["_No rows._"]),
    ...(r.omitted_rows > 0
      ? [
          `_${r.omitted_rows >= OMITTED_CAP ? "At least " : ""}${plural(r.omitted_rows, "row")} omitted._`,
        ]
      : []),
  ].join("\n\n");

export const renderSet = (r: SetResult): string =>
  r.results.length
    ? r.results
        .map((o) =>
          [
            `- ${line(o.id)}: ${
              o.ok
                ? `ok — ${o.changed.length ? o.changed.map(line).join(", ") : "no change"}`
                : `failed — ${line(o.error ?? "") || "unknown error"}`
            }`,
            ...o.notes.map((n) => `  - ${line(n)}`),
          ].join("\n"),
        )
        .join("\n")
    : "No messages changed.";
