import {
  arr,
  bool,
  int,
  nullable,
  num,
  obj,
  oneOf,
  opt,
  type Static,
  str,
  union,
} from "@earendil-works/pi-schema";

export const Role = oneOf([
  "inbox",
  "archive",
  "trash",
  "junk",
  "sent",
  "drafts",
  "all",
]);

export const Address = obj({ name: str(), address: str() });

export const Mailbox = obj({
  id: int(),
  account: str(),
  path: str(),
  role: nullable(Role),
  total: int(),
  unread: int(),
});

export const Copy = obj({
  id: int(),
  mailbox: int(),
  account: str(),
  path: str(),
});

const summary = {
  id: str(),
  conversation: str(),
  subject: str(),
  from: Address,
  to: arr(Address),
  date: str(),
  unread: bool(),
  flagged: bool(),
  attachments: int(),
  mailboxes: arr(str()),
  snippet: str(),
  score: nullable(num()),
};

export const MessageSummary = obj(summary);

export const ConversationSummary = obj({
  id: str(),
  subject: str(),
  participants: arr(Address),
  messages: int(),
  unread: int(),
  first: str(),
  last: str(),
  mailboxes: arr(str()),
  snippet: str(),
  score: nullable(num()),
});

export const Message = obj({
  ...summary,
  cc: arr(Address),
  header: nullable(str()),
  copies: arr(Copy),
  body: str(),
  omitted_tokens: int(),
});

export const Conversation = obj({
  id: str(),
  subject: str(),
  messages: arr(Message),
  omitted_messages: int(),
  omitted_tokens: int(),
});

export const Query = obj({
  query: opt(str({ default: "", description: "Gmail search syntax" })),
  limit: opt(int({ minimum: 1, maximum: 100, default: 10 })),
  offset: opt(int({ minimum: 0, default: 0 })),
});

const page = { query: str(), total: int(), offset: int() };

export const MessagePage = obj({ ...page, results: arr(MessageSummary) });

export const ConversationPage = obj({
  ...page,
  results: arr(ConversationSummary),
});

export const Fetch = obj({
  id: str({ minLength: 1 }),
  max_tokens: opt(int({ minimum: 64, maximum: 100000, default: 2048 })),
});

export const MailboxesInput = obj({});

export const Mailboxes = obj({ mailboxes: arr(Mailbox) });

export const Sql = obj({
  sql: str({ minLength: 1 }),
  max_rows: opt(int({ minimum: 1, maximum: 1000, default: 100 })),
});

export const Json = union([str(), num(), bool(), { type: "null" as const }]);

export const SqlResult = obj({
  columns: arr(str()),
  rows: arr(arr(Json)),
  omitted_rows: int(),
});

export const Target = union([oneOf(["inbox", "archive", "trash"]), int()]);

export const Set = obj({
  ids: arr(str({ minLength: 1 }), { minItems: 1, maxItems: 100 }),
  read: opt(bool()),
  flagged: opt(bool()),
  junk: opt(bool()),
  mailbox: opt(Target),
});

export const SetOutcome = obj({
  id: str(),
  ok: bool(),
  changed: arr(str()),
  notes: arr(str()),
  error: nullable(str()),
});

export const SetResult = obj({ results: arr(SetOutcome) });

export type Role = Static<typeof Role>;
export type Address = Static<typeof Address>;
export type Mailbox = Static<typeof Mailbox>;
export type Copy = Static<typeof Copy>;
export type MessageSummary = Static<typeof MessageSummary>;
export type ConversationSummary = Static<typeof ConversationSummary>;
export type Message = Static<typeof Message>;
export type Conversation = Static<typeof Conversation>;
export type Query = Static<typeof Query>;
export type MessagePage = Static<typeof MessagePage>;
export type ConversationPage = Static<typeof ConversationPage>;
export type Fetch = Static<typeof Fetch>;
export type SqlInput = Static<typeof Sql>;
export type SqlResult = Static<typeof SqlResult>;
export type SetInput = Static<typeof Set>;
export type SetOutcome = Static<typeof SetOutcome>;
export type SetResult = Static<typeof SetResult>;
