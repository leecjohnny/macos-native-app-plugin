import { compile } from "@earendil-works/pi-schema";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { rmSync, writeFileSync } from "node:fs";
import { main } from "../src/plugin.ts";
import type { Runner } from "../src/mail.ts";
import { createServer } from "../../../packages/core/src/protocol/mcp.ts";
import { mail, runtime } from "../src/plugin.ts";
import { type Context, createContext, find } from "../src/tools.ts";
import {
  buildFixture,
  emlx,
  emlxPath,
  MESSAGES,
  NOW,
  rfc822,
} from "./envelope.ts";

export const row = (rowid: number) => {
  const r = MESSAGES.find((m) => m.rowid === rowid);
  if (!r) throw new Error(`no row ${rowid}`);
  return r;
};

export const LONG = Array.from(
  { length: 40 },
  (_, i) =>
    `Paragraph ${i} about markets and quarterly earnings, with enough words to matter.`,
).join("\n\n");

export const QUOTED = [
  "Looks good, one question on revenue",
  "",
  "On Mon, 16 Nov 2026, Alice Example wrote:",
  ...Array.from(
    { length: 12 },
    (_, i) => `> Quoted line ${i} of the original quarterly report text.`,
  ),
].join("\n");

export const rewrite = (root: string, rowid: number, body: string) =>
  writeFileSync(emlxPath(root, row(rowid)), emlx(rfc822(row(rowid), body)));

export const remove = (root: string, ...rowids: number[]) => {
  for (const id of rowids) rmSync(emlxPath(root, row(id)));
};

export type Call = string[];

export function fakeRunner() {
  const calls: Call[] = [];
  const runner: Runner = async (_script, args) => {
    calls.push(args);
    if (args[0] === "ensure-archive") return "exists\n";
    return args
      .slice(4)
      .map((n) => `ok\t${n}`)
      .join("\n");
  };
  return { calls, runner };
}

export type Harness = {
  root: string;
  db: string;
  ctx: Context;
  calls: Call[];
  client: Client;
  cli: (
    ...argv: string[]
  ) => Promise<{ code: number; out: string; err: string }>;
  json: (...argv: string[]) => Promise<any>;
  mcp: (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<{
    text: string;
    structured: Record<string, unknown> | undefined;
    isError: boolean;
  }>;
  close: () => Promise<void>;
};

export async function harness(
  prepare: (root: string) => void = () => {},
): Promise<Harness> {
  const { root, db } = buildFixture();
  prepare(root);
  const { calls, runner } = fakeRunner();
  const ctx = await createContext(root, runner, () => NOW);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(new Map([[mail, runtime(ctx)]])).connect(b);
  const client = new Client({ name: "e2e", version: "0" });
  await client.connect(a);
  await client.listTools();
  const cli = async (...argv: string[]) => {
    let out = "";
    let err = "";
    const code = await main(argv, {
      stdout: (s) => (out += s),
      stderr: (s) => (err += s),
      ctx,
    });
    return { code, out, err };
  };
  const json = async (...argv: string[]) => {
    const r = await cli(...argv, "--json");
    if (r.code !== 0) throw new Error(`exit ${r.code}: ${r.err}`);
    return JSON.parse(r.out);
  };
  const mcp = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name: "mail_" + name, arguments: args });
    const content = r.content as { type: string; text: string }[];
    return {
      text: content.map((c) => c.text).join(""),
      structured: r.structuredContent as Record<string, unknown> | undefined,
      isError: r.isError === true,
    };
  };
  const close = async () => {
    await client.close();
    ctx.store.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { root, db, ctx, calls, client, cli, json, mcp, close };
}

const checkers = new Map<string, ReturnType<typeof compile>>();

export const outputErrors = (name: string, value: unknown) => {
  const t = find(name);
  if (!t) throw new Error(name);
  let c = checkers.get(name);
  if (!c) {
    c = compile(t.output);
    checkers.set(name, c);
  }
  return c.errors(value);
};
