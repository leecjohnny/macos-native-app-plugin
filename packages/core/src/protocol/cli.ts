import type { NativeAppPlugin } from "./plugin.ts";
import { serve } from "./mcp.ts";
export async function main(plugins: NativeAppPlugin[], args: string[]) {
  const [cmd, ...rest] = args;
  const flags = plugins.map((p) => "--" + p.name);
  const usage = `Usage: macos-native-app <${plugins.map((p) => p.name).join("|")}> <tool> [value] [--flag value] [--json]
       macos-native-app help [app [tool]]
       macos-native-app mcp ${flags.map((f) => "[" + f + "]").join(" ")} (select at least one app)`;
  if (cmd === "mcp") {
    if (!rest.length || rest.some((f) => !flags.includes(f))) {
      console.error(usage);
      return 1;
    }
    await serve(plugins.filter((p) => rest.includes("--" + p.name)));
    return 0;
  }
  if (cmd === "help" && !rest.length) {
    console.log(usage);
    return 0;
  }
  const p = plugins.find(
    (plugin) => plugin.name === (cmd === "help" ? rest[0] : cmd),
  );
  if (!p || rest[0] === "mcp") {
    console.error(usage);
    return 1;
  }
  return p.cli(cmd === "help" ? ["help", ...rest.slice(1)] : rest);
}

import type { Schema } from "@earendil-works/pi-schema";
import { properties } from "./tool.ts";
type Tool = {
  input: Schema;
  output: Schema;
  annotations: import("@modelcontextprotocol/sdk/types.js").Tool["annotations"];
  title: string;
  name: string;
  primary: string | null;
  description: string;
};
type Io<R, C> = {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  env?: Record<string, string | undefined>;
  runner?: R;
  ctx?: C;
};
export function appCli<R, C extends { store: { close(): void } }>(
  command: string,
  usage: string,
  agentGuide: string,
  {
    find,
    TOOLS,
    defaultRoot,
    createContext,
    callTool,
  }: {
    find: (name: string) => Tool | null | undefined;
    TOOLS: Tool[];
    defaultRoot: (env?: Record<string, string | undefined>) => string;
    createContext: (root: string, runner?: R) => Promise<C>;
    callTool: (
      name: string,
      input: unknown,
      c: C,
    ) => Promise<{
      isError: boolean;
      text: string;
      structured: Record<string, unknown> | null;
    }>;
  },
) {
  const fields = (t: Tool) =>
    Object.entries(properties(t.input)).map(([k, p]) => {
      const s = p as { type?: string; default?: unknown; enum?: string[] };
      const type = s.enum?.join("|") ?? s.type ?? "value";
      const def =
        s.default === undefined
          ? ""
          : ` (default ${JSON.stringify(s.default)})`;
      return `  --${k.replaceAll("_", "-")} <${type}>${def}${k === t.primary ? " [positional]" : ""}`;
    });

  const help = (name?: string): string => {
    const t = name ? find(name) : null;
    if (t)
      return [`${command} ${t.name}`, "", t.description, "", ...fields(t)].join(
        "\n",
      );
    return [
      usage,
      "",
      "Tools:",
      ...TOOLS.map((x) => `  ${x.name.padEnd(22)}${x.title}`),
      "",
      `Run \`macos-native-app help ${command.split(" ").at(-1)} <tool>\` for its description and flags.`,
      "",
      "Agent guide",
      agentGuide,
    ].join("\n");
  };

  class UsageError extends Error {
    override name = "UsageError";
  }

  function parseArgs(
    t: Tool,
    args: string[],
  ): { input: Record<string, unknown>; json: boolean; help: boolean } {
    const props = properties(t.input);
    const isArray = (k: string) =>
      (props[k] as { type?: string } | undefined)?.type === "array";
    const isBool = (k: string) =>
      (props[k] as { type?: string } | undefined)?.type === "boolean";
    const input: Record<string, unknown> = Object.create(null);
    const positional: string[] = [];
    let json = false;
    const add = (k: string, v: string) => {
      if (isArray(k))
        input[k] = [
          ...((input[k] as string[] | undefined) ?? []),
          ...v.split(",").filter(Boolean),
        ];
      else input[k] = v;
    };
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === "--help" || a === "-h") return { input, json, help: true };
      if (a === "--json") {
        json = true;
        continue;
      }
      if (a === "--") {
        positional.push(...args.slice(i + 1));
        break;
      }
      if (!a.startsWith("--") || a.length === 2) {
        positional.push(a);
        continue;
      }
      const eq = a.indexOf("=");
      const k = (eq < 0 ? a.slice(2) : a.slice(2, eq)).replaceAll("-", "_");
      if (eq >= 0) add(k, a.slice(eq + 1));
      else if (isBool(k) && !/^(true|false)$/.test(args[i + 1] ?? ""))
        input[k] = true;
      else {
        const v = args[i + 1];
        if (v === undefined)
          throw new UsageError(`--${k.replaceAll("_", "-")} needs a value`);
        add(k, v);
        i++;
      }
    }
    if (positional.length) {
      if (!t.primary)
        throw new UsageError(`${t.name} takes no positional value`);
      if (isArray(t.primary)) for (const p of positional) add(t.primary, p);
      else if (input[t.primary] !== undefined)
        throw new UsageError(`${t.primary} is given twice`);
      else input[t.primary] = positional.join(" ");
    }
    return { input, json, help: false };
  }

  return async function runApp(argv: string[], io: Io<R, C>): Promise<number> {
    const [cmd, ...rest] = argv;
    if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
      const target = rest[0];
      if (target && !find(target)) {
        io.stderr(`Unknown tool ${JSON.stringify(target)}.\n\n${help()}\n`);
        return 1;
      }
      (cmd ? io.stdout : io.stderr)(`${help(target)}\n`);
      return cmd ? 0 : 1;
    }
    const t = find(cmd);
    if (!t) {
      io.stderr(`Unknown tool ${JSON.stringify(cmd)}.\n\n${help()}\n`);
      return 1;
    }
    let parsed: ReturnType<typeof parseArgs>;
    try {
      parsed = parseArgs(t, rest);
    } catch (e) {
      io.stderr(
        `${e instanceof Error ? e.message : String(e)}\n\n${help(t.name)}\n`,
      );
      return 1;
    }
    if (parsed.help) {
      io.stdout(`${help(t.name)}\n`);
      return 0;
    }
    const ctx = io.ctx ?? (await createContext(defaultRoot(io.env), io.runner));
    try {
      const r = await callTool(t.name, parsed.input, ctx);
      if (r.isError) {
        io.stderr(`${r.text}\n`);
        return 1;
      }
      io.stdout(
        parsed.json
          ? `${JSON.stringify(r.structured, null, 2)}\n`
          : `${r.text}\n`,
      );
      return 0;
    } finally {
      if (!io.ctx) ctx.store.close();
    }
  };
}
