import { join } from "node:path";
import { type Account, ATTR, role } from "./accounts.ts";
import type { SetInput, SetOutcome, SetResult } from "./schema.ts";

export type Runner = (script: string, args: string[]) => Promise<string>;

export type CopyRef = {
  id: number;
  account: string;
  path: string;
  labels: string[];
};

export type MailboxRef = { account: string; path: string };

export type SetDeps = {
  copies: (id: string) => Promise<CopyRef[] | null>;
  accounts: Map<string, Account>;
  runner: Runner;
  script?: string;
  mailbox?: (id: number) => MailboxRef | null;
};

type Op = "read" | "flagged" | "junk" | "move" | "copy" | "trash";

type Action = {
  id: string;
  label: string;
  op: Op;
  account: string;
  path: string;
  value: string;
  copy: number;
  create: boolean;
};

type Plan = {
  id: string;
  actions: Action[];
  notes: string[];
  errors: string[];
};

type Box = Pick<Account, "id" | "gmail" | "attrs">;

const SCRIPT = join(import.meta.dir, "..", "osa", "set.applescript");

export { osascriptRunner } from "@macos-native-app/core/runners/osa";
const isInbox = (path: string) => path.toUpperCase() === "INBOX";

const samePath = (a: string, b: string) =>
  a === b || (isInbox(a) && isInbox(b));

const inInbox = (c: CopyRef) => isInbox(c.path) || c.labels.some(isInbox);

function archiveMailbox(
  account: Box,
): { path: string; create: boolean } | { error: string } {
  const boxes = [...account.attrs];
  const flagged = boxes.filter(([, a]) => a & ATTR.archive);
  if (flagged.length > 1)
    return {
      error: `account ${account.id} has several \\Archive mailboxes: ${flagged.map(([p]) => p).join(", ")}`,
    };
  if (flagged[0]) return { path: flagged[0][0], create: false };
  if (account.gmail) {
    const all = boxes.find(([, a]) => a & ATTR.all);
    if (!all)
      return { error: `Gmail account ${account.id} has no \\All mailbox` };
    return { path: all[0], create: false };
  }
  const top = boxes.find(
    ([p]) => !p.includes("/") && p.toLowerCase() === "archive",
  );
  return top
    ? { path: top[0], create: false }
    : { path: "Archive", create: true };
}

const byAccount = (copies: CopyRef[]) => {
  const out = new Map<string, CopyRef[]>();
  for (const c of copies)
    out.set(c.account, [...(out.get(c.account) ?? []), c]);
  return out;
};

const roleOf = (account: Box, path: string) =>
  role(path, account.attrs.get(path) ?? 0);

function source(account: Box, cs: CopyRef[]) {
  const inbox = cs.find(inInbox);
  const copy = inbox ?? cs[0];
  if (!copy) return null;
  const path =
    inbox && account.gmail && !isInbox(copy.path) ? "INBOX" : copy.path;
  return { copy, path };
}

function leftAlone(p: Plan, account: Box, cs: CopyRef[], acted: CopyRef) {
  const rest = cs.filter((c) => c !== acted);
  if (rest.length)
    p.notes.push(
      `left ${rest.map((c) => `${c.id} in ${c.path}`).join(", ")} in account ${account.id} alone`,
    );
}

function relocate(
  p: Plan,
  label: string,
  account: Box,
  cs: CopyRef[],
  dest: string,
  create = false,
) {
  const src = source(account, cs);
  if (!src) return;
  if (
    samePath(src.path, dest) ||
    (account.gmail && cs.some((c) => c.labels.some((l) => samePath(l, dest))))
  )
    return void p.notes.push(`already in ${dest} in account ${account.id}`);
  const fromAll =
    account.gmail && (account.attrs.get(src.path) ?? 0) & ATTR.all;
  p.actions.push({
    id: p.id,
    label,
    op: fromAll ? "copy" : "move",
    account: account.id,
    path: src.path,
    value: dest,
    copy: src.copy.id,
    create,
  });
  leftAlone(p, account, cs, src.copy);
}

function trash(p: Plan, account: Box, cs: CopyRef[]) {
  if (cs.some((c) => roleOf(account, c.path) === "trash"))
    return void p.notes.push(`already in trash in account ${account.id}`);
  const copy = account.gmail ? cs[0] : (cs.find(inInbox) ?? cs[0]);
  if (!copy) return;
  p.actions.push({
    id: p.id,
    label: "trash",
    op: "trash",
    account: account.id,
    path: copy.path,
    value: "",
    copy: copy.id,
    create: false,
  });
  leftAlone(p, account, cs, copy);
}

function moves(
  p: Plan,
  copies: CopyRef[],
  target: NonNullable<SetInput["mailbox"]>,
  deps: SetDeps,
) {
  const groups = byAccount(copies);
  const lenient = (id: string): Box =>
    deps.accounts.get(id) ?? { id, gmail: false, attrs: new Map() };
  if (typeof target === "number") {
    const box = deps.mailbox?.(target) ?? null;
    if (!box) return void p.errors.push(`unknown mailbox ${target}`);
    for (const [id, cs] of groups)
      if (id !== box.account)
        p.notes.push(
          `left ${cs.map((c) => c.id).join(", ")} in account ${id} alone: mailbox ${target} is in account ${box.account}`,
        );
    const cs = groups.get(box.account);
    if (!cs)
      return void p.errors.push(
        `no copy in account ${box.account}, which holds mailbox ${target}`,
      );
    relocate(p, `mailbox ${target}`, lenient(box.account), cs, box.path);
    return;
  }
  if (target === "archive" && !copies.some(inInbox))
    return void p.notes.push("not in inbox; nothing moved");
  for (const [id, cs] of groups) {
    if (target === "trash") trash(p, lenient(id), cs);
    else if (target === "inbox") {
      if (cs.some(inInbox)) p.notes.push(`already in inbox in account ${id}`);
      else relocate(p, "inbox", lenient(id), cs, "INBOX");
    } else if (!cs.some(inInbox))
      p.notes.push(`not in inbox in account ${id}; nothing moved`);
    else {
      const account = deps.accounts.get(id);
      if (!account) {
        p.errors.push(
          `no mailbox cache for account ${id}; cannot resolve its archive mailbox`,
        );
        continue;
      }
      const box = archiveMailbox(account);
      if ("error" in box) p.errors.push(box.error);
      else relocate(p, "archive", account, cs, box.path, box.create);
    }
  }
}

async function plan(id: string, input: SetInput, deps: SetDeps): Promise<Plan> {
  const p: Plan = { id, actions: [], notes: [], errors: [] };
  const copies = await deps.copies(id);
  if (!copies?.length) return { ...p, errors: [`unknown message ${id}`] };
  for (const key of ["read", "flagged", "junk"] as const) {
    const value = input[key];
    if (value === undefined) continue;
    for (const c of copies)
      p.actions.push({
        id,
        label: key,
        op: key,
        account: c.account,
        path: c.path,
        value: String(value),
        copy: c.id,
        create: false,
      });
  }
  if (input.mailbox !== undefined) moves(p, copies, input.mailbox, deps);
  if (p.errors.length) p.actions = [];
  return p;
}

function parseLines(out: string): Map<string, string | null> {
  const results = new Map<string, string | null>();
  for (const line of out.split(/\r\n|\r|\n/)) {
    const [status, n, ...rest] = line.split("\t");
    if (!n || !/^\d+$/.test(n)) continue;
    if (status === "ok" && rest.length === 0) {
      if (!results.has(n)) results.set(n, null);
    } else if (status === "error")
      results.set(n, rest.join(" ").trim() || "error");
  }
  return results;
}

const rank: Record<Op, number> = {
  read: 0,
  flagged: 0,
  junk: 0,
  move: 1,
  copy: 1,
  trash: 1,
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function ensure(
  actions: Action[],
  script: string,
  runner: Runner,
): Promise<Map<string, string | null>> {
  const status = new Map<string, string | null>();
  for (const a of actions) {
    if (!a.create || status.has(a.account)) continue;
    try {
      const out = (
        await runner(script, ["ensure-archive", a.account, a.value, ""])
      ).trim();
      status.set(
        a.account,
        out === "created" || out === "exists"
          ? out
          : `unexpected reply from Mail: ${out}`,
      );
    } catch (e) {
      status.set(a.account, `could not create ${a.value}: ${message(e)}`);
    }
  }
  return status;
}

async function run(
  actions: Action[],
  script: string,
  runner: Runner,
): Promise<Map<Action, string | null>> {
  const groups = new Map<string, Action[]>();
  for (const a of actions) {
    const key = [a.op, a.account, a.path, a.value].join("\u0000");
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }
  const ordered = [...groups.values()].toSorted(
    (x, y) => rank[x[0]?.op ?? "read"] - rank[y[0]?.op ?? "read"],
  );
  const results = new Map<Action, string | null>();
  for (const group of ordered) {
    const first = group[0];
    if (!first) continue;
    const ids = [...new Set(group.map((a) => String(a.copy)))];
    let lines: Map<string, string | null>;
    try {
      lines = parseLines(
        await runner(script, [
          first.op,
          first.account,
          first.path,
          first.value,
          ...ids,
        ]),
      );
    } catch (e) {
      lines = new Map(ids.map((n) => [n, message(e)]));
    }
    for (const a of group) {
      const n = String(a.copy);
      results.set(
        a,
        lines.has(n) ? (lines.get(n) ?? null) : "no result from Mail",
      );
    }
  }
  return results;
}

export async function setMessages(
  input: SetInput,
  deps: SetDeps,
): Promise<SetResult> {
  const script = deps.script ?? SCRIPT;
  const plans = await Promise.all(input.ids.map((id) => plan(id, input, deps)));
  const actions = plans.flatMap((p) => p.actions);
  const ensured = await ensure(actions, script, deps.runner);
  const runnable = actions.filter(
    (a) =>
      !a.create ||
      ensured.get(a.account) === "created" ||
      ensured.get(a.account) === "exists",
  );
  const results = await run(runnable, script, deps.runner);
  const outcome = (p: Plan): SetOutcome => {
    const errors = [...p.errors];
    const notes = [...p.notes];
    const changed: string[] = [];
    for (const a of p.actions) {
      const state = ensured.get(a.account);
      const err =
        a.create && state !== "created" && state !== "exists"
          ? (state ?? "archive mailbox not ensured")
          : results.get(a);
      if (err) errors.push(`${a.label} ${a.copy}: ${err}`);
      else if (!changed.includes(a.label)) changed.push(a.label);
      if (a.create && state === "created") {
        const note = `created Archive in account ${a.account}`;
        if (!notes.includes(note)) notes.push(note);
      }
    }
    return {
      id: p.id,
      ok: errors.length === 0,
      changed,
      notes,
      error: errors.length ? errors.join("; ") : null,
    };
  };
  return { results: plans.map(outcome) };
}
