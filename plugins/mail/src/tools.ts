import { dispatch } from "@macos-native-app/core/protocol/dispatch";
import {
  defineTool,
  readOnly as read,
  mutating,
} from "@macos-native-app/core/protocol/tool";
import { type Schema, type Static } from "@earendil-works/pi-schema";
import { homedir } from "node:os";
import { join } from "node:path";
import { versionDir } from "./accounts.ts";
import { osascriptRunner, type Runner, setMessages } from "./mail.ts";
import {
  findBest,
  parseMessage,
  readEmlx,
  tokens,
  toMarkdown,
  trimQuoted,
  truncate,
} from "./markdown.ts";
import { parse, QueryError } from "./query.ts";
import {
  renderConversation,
  renderConversationPage,
  renderMailboxes,
  renderMessage,
  renderMessagePage,
  renderSet,
  renderSql,
} from "./render.ts";
import {
  Conversation,
  ConversationPage,
  Fetch,
  Mailboxes,
  MailboxesInput,
  Message,
  MessagePage,
  Query,
  Set as SetSchema,
  SetResult,
  Sql,
  SqlResult,
} from "./schema.ts";
import { OMITTED_CAP, openStore, type Store } from "./store.ts";

export type Context = {
  store: Store;
  versionDir: string;
  runner: Runner;
  now: () => number;
  queue: Promise<unknown>;
};

type Annotations = {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

export type Tool<I extends Schema = Schema, O extends Schema = Schema> = {
  name: string;
  title: string;
  description: string;
  primary: string | null;
  input: I;
  output: O;
  annotations: Annotations;
  run(
    input: Static<I>,
    ctx: Context,
  ): Promise<{ structured: Static<O>; text: string }>;
};

type Result = {
  structured: Record<string, unknown> | null;
  text: string;
  isError: boolean;
};

export const defaultRoot = (
  env: Record<string, string | undefined> = process.env,
) => env.MACOS_MAIL_ROOT || join(homedir(), "Library", "Mail");

export async function createContext(
  root: string,
  runner: Runner = osascriptRunner,
  now: () => number = () => Math.floor(Date.now() / 1000),
): Promise<Context> {
  return {
    store: await openStore(root),
    versionDir: versionDir(root),
    runner,
    now,
    queue: Promise.resolve(),
  };
}

const notFound = (kind: string, id: string) =>
  new Error(
    `No ${kind} with id ${JSON.stringify(id)}. Ids come from search results.`,
  );

type Source = "full" | "partial" | "summary";

const partial = (file: string) => file.endsWith(".partial.emlx");

async function body(
  ctx: Context,
  copies: { id: number; account: string; path: string }[],
  snippet: string,
): Promise<{ text: string; source: Source }> {
  const files = (
    await Promise.all(copies.map((c) => findBest(ctx.versionDir, [c])))
  )
    .filter((f) => f !== null)
    .toSorted((a, b) => Number(partial(a)) - Number(partial(b)));
  for (const file of files) {
    try {
      return {
        text: toMarkdown(await parseMessage(await readEmlx(file))),
        source: partial(file) ? "partial" : "full",
      };
    } catch {}
  }
  return { text: snippet, source: "summary" };
}

const NOTES: Record<Source, string> = {
  full: "",
  partial:
    "_Only a partial download of this message is on disk; parts or attachments may be missing._",
  summary: "_The message body is not on disk; this is Mail's summary of it._",
};

const noteTokens = (source: Source) =>
  NOTES[source] ? tokens(`\n\n${NOTES[source]}`) : 0;

type Loaded = { message: Message; full: string; source: Source };

async function load(ctx: Context, id: string): Promise<Loaded> {
  const detail = await ctx.store.message(id);
  if (!detail) throw notFound("message", id);
  const copies = detail.copies.map((c) => ({
    id: c.id,
    mailbox: c.mailbox,
    account: c.account,
    path: c.path,
  }));
  const b = await body(ctx, copies, detail.summary.snippet);
  return {
    message: {
      ...detail.summary,
      cc: detail.cc,
      header: detail.header,
      copies,
      body: "",
      omitted_tokens: 0,
    },
    full: b.text,
    source: b.source,
  };
}

const cut = (l: Loaded, text: string, budget: number): Message => {
  const kept = truncate(text, Math.max(0, budget - noteTokens(l.source))).text;
  return {
    ...l.message,
    body: [kept, NOTES[l.source]].filter(Boolean).join("\n\n"),
    omitted_tokens:
      kept === l.full ? 0 : Math.max(1, tokens(l.full) - tokens(kept)),
  };
};

const MIN_SHARE = 64;

const sized = (l: Loaded, text: string) => tokens(text) + noteTokens(l.source);

const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);

async function readConversation(
  ctx: Context,
  id: string,
  maxTokens: number,
): Promise<Conversation> {
  const ids = await ctx.store.conversation(id);
  if (!ids) throw notFound("conversation", id);
  const loaded = await Promise.all(ids.map((m) => load(ctx, m)));
  const fits = sum(loaded.map((l) => sized(l, l.full))) <= maxTokens;
  const texts = loaded.map((l, i) =>
    fits || i === 0 ? l.full : trimQuoted(l.full).text,
  );
  const sizes = loaded.map((l, i) => sized(l, texts[i]!));
  const keep =
    sum(sizes) <= maxTokens
      ? loaded.length
      : Math.max(1, Math.min(loaded.length, Math.floor(maxTokens / MIN_SHARE)));
  const dropped = loaded.length - keep;
  const budgets = share(sizes.slice(dropped), maxTokens);
  const messages = budgets.map((b, i) =>
    cut(loaded[dropped + i]!, texts[dropped + i]!, b),
  );
  return {
    id,
    subject: loaded[0]?.message.subject ?? "",
    messages,
    omitted_messages: dropped,
    omitted_tokens:
      sum(loaded.slice(0, dropped).map((l) => tokens(l.full))) +
      sum(messages.map((m) => m.omitted_tokens)),
  };
}

function share(sizes: number[], budget: number): number[] {
  const out = sizes.map(() => 0);
  let left = budget;
  const order = sizes
    .map((s, i) => [s, i] as const)
    .toSorted((a, b) => a[0] - b[0]);
  order.forEach(([size, i], k) => {
    const give = Math.min(size, Math.floor(left / (order.length - k)));
    out[i] = give;
    left -= give;
  });
  return out;
}

const QUERY_HELP = `Query syntax is Gmail's: words are ANDed; \`OR\`, \`-\` to negate, \`( )\` to group, \`"exact phrase"\`. Operators: from: to: cc: subject: in:<mailbox path, leaf or role: inbox|archive|trash|junk|spam|sent|drafts|all> is:unread|read|flagged|starred has:attachment after:YYYY/MM/DD before:YYYY/MM/DD older_than:/newer_than:<n><d|w|m|y>. Unknown operators are errors. Free text ranks by BM25 over subject, sender and summary; otherwise newest first. Empty query lists everything.`;

const IDS = `Message ids look like \`m123\` (or \`r123\` when Mail has no Message-ID); conversation ids look like \`c123\` for a thread, or \`c\` plus the message id (\`cm123\`, \`cr123\`) for an unthreaded message; mailbox ids are integers from fetch_mailboxes.`;

const tool = <I extends Schema, O extends Schema>(t: Tool<I, O>) =>
  t as unknown as Tool;

export const TOOLS: Tool[] = [
  tool({
    name: "search_conversations",
    title: "Search conversations",
    description: `Search Apple Mail and return matching conversations (threads), best match first; a conversation matches when any of its messages does. Duplicated copies across mailboxes and accounts count once. ${QUERY_HELP} ${IDS} Page with limit and offset.`,
    primary: "query",
    input: Query,
    output: ConversationPage,
    annotations: read("Search conversations"),
    async run(input, ctx) {
      const query = input.query ?? "";
      const structured = await ctx.store.searchConversations(
        parse(query, ctx.now()),
        query,
        input.limit ?? 10,
        input.offset ?? 0,
      );
      return { structured, text: renderConversationPage(structured) };
    },
  }),
  tool({
    name: "search_messages",
    title: "Search messages",
    description: `Search Apple Mail and return individual messages, de-duplicated by Message-ID across mailboxes and accounts. ${QUERY_HELP} ${IDS} Page with limit and offset.`,
    primary: "query",
    input: Query,
    output: MessagePage,
    annotations: read("Search messages"),
    async run(input, ctx) {
      const query = input.query ?? "";
      const structured = await ctx.store.searchMessages(
        parse(query, ctx.now()),
        query,
        input.limit ?? 10,
        input.offset ?? 0,
      );
      return { structured, text: renderMessagePage(structured) };
    },
  }),
  tool({
    name: "fetch_conversation",
    title: "Fetch conversation",
    description: `Read every message of a conversation by its \`c…\` id (\`c123\`, or \`cm123\`/\`cr123\` for an unthreaded message), oldest first, as markdown within one max_tokens budget shared by all messages. When the thread does not fit, quoted replies are trimmed first; only if it still does not fit are bodies cut and the oldest messages omitted. Every cut is counted in the output, and omitted_tokens is the total across omitted messages and cuts.`,
    primary: "id",
    input: Fetch,
    output: Conversation,
    annotations: read("Fetch conversation"),
    async run(input, ctx) {
      const structured = await readConversation(
        ctx,
        input.id,
        input.max_tokens ?? 2048,
      );
      return { structured, text: renderConversation(structured) };
    },
  }),
  tool({
    name: "fetch_message",
    title: "Fetch message",
    description: `Read one message by its \`m…\` or \`r…\` id: headers, its copies (Mail message id, account, mailbox) and mailboxes, then the body as markdown cut to max_tokens, with the number of omitted tokens stated.`,
    primary: "id",
    input: Fetch,
    output: Message,
    annotations: read("Fetch message"),
    async run(input, ctx) {
      const l = await load(ctx, input.id);
      const structured = cut(l, l.full, input.max_tokens ?? 2048);
      return { structured, text: renderMessage(structured) };
    },
  }),
  tool({
    name: "fetch_mailboxes",
    title: "Fetch mailboxes",
    description: `List every account and mailbox with its numeric id, path, role (inbox, archive, trash, junk, sent, drafts, all) and total and unread counts. Use the ids as set_messages targets and the paths or roles with in:.`,
    primary: null,
    input: MailboxesInput,
    output: Mailboxes,
    annotations: read("Fetch mailboxes"),
    async run(_input, ctx) {
      const mailboxes = await ctx.store.mailboxes();
      return { structured: { mailboxes }, text: renderMailboxes(mailboxes) };
    },
  }),
  tool({
    name: "execute_sql",
    title: "Execute SQL",
    description: `Run one read-only SELECT on an in-memory DuckDB holding Mail's Envelope Index attached as \`mail\` (mail.messages, mail.mailboxes, mail.addresses, …) plus de-duplicated tables \`message\` (id, conversation, subject, sender_name, sender_address, summary, received as unix seconds, unread, flagged, attachments, mailboxes, to_list, cc_list), \`conversation\`, \`copy\` (one row per Mail copy) and \`mailbox\` (id, account, path, role, total, unread). File access, ATTACH and writes are disabled. Rows beyond max_rows are counted, not returned; counting stops at ${OMITTED_CAP}, stated as at least that many.`,
    primary: "sql",
    input: Sql,
    output: SqlResult,
    annotations: read("Execute SQL"),
    async run(input, ctx) {
      const structured = await ctx.store.sql(input.sql, input.max_rows ?? 100);
      return { structured, text: renderSql(structured) };
    },
  }),
  tool({
    name: "set_messages",
    title: "Set messages",
    description: `Change the state or location of messages through Mail.app, never their content. ids are \`m…\`/\`r…\` message ids; each copy of a message is updated. read, flagged and junk are booleans. mailbox moves the message to \`inbox\`, \`archive\` (where Mail's own Archive would put it, e.g. All Mail on Gmail), \`trash\`, or a numeric mailbox id from fetch_mailboxes. Reports what changed for each id.`,
    primary: "ids",
    input: SetSchema,
    output: SetResult,
    annotations: mutating("Set messages"),
    async run(input, ctx) {
      const boxes = new Map(
        (await ctx.store.mailboxes()).map((b) => [
          b.id,
          { account: b.account, path: b.path },
        ]),
      );
      const structured = await setMessages(input, {
        copies: async (id) => (await ctx.store.message(id))?.copies ?? null,
        accounts: ctx.store.accounts,
        runner: ctx.runner,
        mailbox: (id) => boxes.get(id) ?? null,
      });
      return { structured, text: renderSet(structured) };
    },
  }),
];

export const find = (name: string) =>
  TOOLS.find((t) => t.name === name.replaceAll("-", "_")) ?? null;

const validators = new Map(
  TOOLS.map((t) => [t.name, defineTool(t.input, t.output)]),
);
export { properties } from "@macos-native-app/core/protocol/tool";
const fail = (text: string): Result => ({
  structured: null,
  text,
  isError: true,
});

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

class OutputError extends Error {
  override name = "OutputError";
}

export async function callTool(
  name: string,
  args: unknown,
  ctx: Context,
): Promise<Result> {
  return dispatch(ctx, "serial", () => invoke(name, args, ctx));
}

async function invoke(
  name: string,
  args: unknown,
  ctx: Context,
): Promise<Result> {
  const t = find(name);
  if (!t)
    return fail(
      `Unknown tool ${JSON.stringify(name)}. Tools: ${TOOLS.map((x) => x.name).join(", ")}.`,
    );
  const parsed = validators.get(t.name)!.parse(args ?? {});
  if (!parsed.ok)
    return fail(
      [
        `Input error for ${t.name}:`,
        ...parsed.errors.map((e) => `- ${e.path || "(input)"}: ${e.message}`),
      ].join("\n"),
    );
  const input = parsed.value;
  let out: { structured: unknown; text: string };
  try {
    await ctx.store.refresh();
    out = await t.run(input as never, ctx);
  } catch (e) {
    return fail(
      e instanceof QueryError
        ? `Input error for ${t.name}: query: ${e.message}`
        : `Error in ${t.name}: ${message(e)}`,
    );
  }
  const errors = validators.get(t.name)!.errors(out.structured);
  if (errors.length)
    throw new OutputError(
      `${t.name} output does not match its schema: ${errors.map((e) => `${e.path} ${e.message}`).join("; ")}`,
    );
  return {
    structured: out.structured as Record<string, unknown>,
    text: out.text,
    isError: false,
  };
}
