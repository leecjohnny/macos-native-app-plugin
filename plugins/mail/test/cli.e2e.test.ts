import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { agentGuide } from "../src/agent-guide.ts";
import { buildFixture } from "./envelope.ts";

const REPO = join(import.meta.dir, "..");
const CLI = join(REPO, "../../apps/cli/src/cli.ts");

let root: string;
let env: Record<string, string>;

beforeAll(() => {
  root = buildFixture().root;
  env = {
    ...(process.env as Record<string, string>),
    MACOS_MAIL_ROOT: root,
  };
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const run = async (...argv: string[]) => {
  const p = Bun.spawn([process.execPath, CLI, "mail", ...argv], {
    cwd: REPO,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, out, err };
};

const TIMEOUT = 60_000;

describe("cli subprocess", () => {
  test(
    "prints markdown by default and the structured result with --json",
    async () => {
      const md = await run("search-messages", "quarterly", "--limit", "2");
      expect(md.code).toBe(0);
      expect(md.err).toBe("");
      expect(md.out).toStartWith("Found ");
      expect(md.out).toContain("## Result 1/");
      const json = await run("search_messages", "quarterly", "--json");
      expect(json.code).toBe(0);
      const page = JSON.parse(json.out);
      expect(page.query).toBe("quarterly");
      expect(page.results.length).toBeGreaterThan(0);
      const c = await run("fetch_conversation", "c1", "--json");
      expect(c.code).toBe(0);
      expect(JSON.parse(c.out).id).toBe("c1");
    },
    TIMEOUT,
  );

  test(
    "input errors exit 1 on stderr",
    async () => {
      const bad = await run("search_messages", "--limit", "500");
      expect(bad.code).toBe(1);
      expect(bad.out).toBe("");
      expect(bad.err).toContain("Input error for search_messages:");
      const proto = await run("search_messages", "--__proto__", "x");
      expect(proto.code).toBe(1);
      expect(proto.err).toContain("unknown field");
      const unknown = await run("nope");
      expect(unknown.code).toBe(1);
      expect(unknown.err).toContain('Unknown tool "nope"');
      const missing = await run("fetch_message", "--max-tokens");
      expect(missing.code).toBe(1);
      expect(missing.err).toContain("--max-tokens needs a value");
    },
    TIMEOUT,
  );

  test(
    "help lists tools and describes one; after -- it is a value",
    async () => {
      const all = await run("help");
      expect(all.code).toBe(0);
      expect(all.out).toStartWith("Usage: macos-native-app mail");
      expect(all.out).toContain("fetch_conversation");
      expect(all.out).toContain(agentGuide);
      const none = await run();
      expect(none.code).toBe(1);
      expect(none.err).toStartWith("Usage: macos-native-app mail");
      expect(none.err).toContain(agentGuide);
      for (const flag of ["--help", "-h"]) {
        const one = await run("fetch-message", flag);
        expect(one.code).toBe(0);
        expect(one.out).toStartWith("macos-native-app mail fetch_message\n");
        expect(one.out).toContain("--max-tokens");
      }
      const value = await run("search_messages", "--json", "--", "-h");
      expect(value.code).toBe(0);
      expect(value.out).not.toContain("macos-native-app mail search_messages");
      expect(JSON.parse(value.out).query).toBe("-h");
      const quoted = await run("search_messages", "--query", "--help");
      expect(quoted.code).toBe(0);
      expect(quoted.out).not.toContain("macos-native-app mail search_messages");
    },
    TIMEOUT,
  );

  test(
    "mcp serves tools over stdio and exits when the client closes",
    async () => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [join(REPO, "../../apps/cli/src/cli.ts"), "mcp", "--mail"],
        cwd: REPO,
        env,
        stderr: "pipe",
      });
      const client = new Client({ name: "cli-e2e", version: "0" });
      await client.connect(transport);
      expect(client.getInstructions()).toBe(agentGuide);
      const pid = transport.pid;
      expect(pid).not.toBeNull();
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("mail_search_messages");
      const r = await client.callTool({
        name: "mail_search_messages",
        arguments: { query: "quarterly", limit: 1 },
      });
      expect(r.isError).toBe(false);
      expect(
        (r.structuredContent as { results: unknown[] }).results,
      ).toHaveLength(1);
      const started = performance.now();
      await client.close();
      expect(performance.now() - started).toBeLessThan(2000);
      expect(() => process.kill(pid!, 0)).toThrow();
    },
    TIMEOUT,
  );
});
