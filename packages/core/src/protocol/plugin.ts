import type { AgentGuide } from "./agent-guide.ts";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
export type Runtime = {
  call(
    name: string,
    args: unknown,
  ): Promise<{
    structured: Record<string, unknown> | null;
    text: string;
    isError: boolean;
  }>;
  close(): void;
};
export type NativeAppPlugin = {
  name: string;
  agentGuide: AgentGuide;
  tools: Tool[];
  createContext(): Promise<Runtime>;
  cli(args: string[]): Promise<number>;
  image?(
    name: string,
    data: Record<string, unknown>,
  ): { path: string; cleanup?: boolean } | undefined;
};

import { appCli } from "./cli.ts";

export function definePlugin<R, C extends { store: { close(): void } }>(
  name: string,
  agentGuide: string,
  rootHelp: string,
  tools: Parameters<typeof appCli<R, C>>[3],
  image?: NativeAppPlugin["image"],
) {
  const command = "macos-native-app " + name;
  const usage = `Usage: ${command} <tool> [value] [--flag value …] [--json]
       macos-native-app help ${name} [tool]

Flags accept kebab-case or snake_case. A positional value fills the main field. Array fields accept comma-separated values or repeated flags. ${rootHelp}`;
  const main = appCli(command, usage, agentGuide, tools);
  const runtime = (ctx: C): Runtime => ({
    call: (tool, args) => tools.callTool(tool, args, ctx),
    close: () => ctx.store.close(),
  });
  const plugin: NativeAppPlugin = {
    name,
    agentGuide: { app: name, sections: agentGuide.split("\n\n") },
    tools: tools.TOOLS.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.input as Tool["inputSchema"],
      outputSchema: t.output as Tool["outputSchema"],
      annotations: t.annotations,
    })),
    createContext: async () =>
      runtime(await tools.createContext(tools.defaultRoot())),
    cli: (args) =>
      main(args, {
        stdout: (s) => process.stdout.write(s),
        stderr: (s) => process.stderr.write(s),
        env: process.env,
      }),
    image,
  };
  return { main, runtime, plugin };
}
