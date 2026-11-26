import { composeGuides } from "./agent-guide.ts";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { NativeAppPlugin, Runtime } from "./plugin.ts";
export function createServer(
  active: Map<NativeAppPlugin, Runtime>,
  pending = new Set<Promise<unknown>>(),
) {
  const plugins = [...active.keys()];
  const server = new Server(
    { name: "macos-native-app", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions: composeGuides(plugins.map((p) => p.agentGuide)),
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: plugins.flatMap((p) =>
      p.tools.map((t) => ({ ...t, name: p.name + "_" + t.name })),
    ),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const invoke = async (): Promise<CallToolResult> => {
      const name = req.params.name.replaceAll("-", "_"),
        p = plugins.find((plugin) => name.startsWith(plugin.name + "_"));
      if (!p)
        return {
          content: [{ type: "text", text: "Unknown tool " + name }],
          isError: true,
        };
      const tool = name.slice(p.name.length + 1),
        r = await active.get(p)!.call(tool, req.params.arguments ?? {});
      const content: CallToolResult["content"] = [
        { type: "text", text: r.text },
      ];
      const image = r.structured && p.image?.(tool, r.structured);
      if (image)
        try {
          if (image.cleanup) content.length = 0;
          content.push({
            type: "image",
            mimeType: "image/jpeg",
            data: Buffer.from(
              await Bun.file(image.path).arrayBuffer(),
            ).toString("base64"),
          });
        } finally {
          if (image.cleanup)
            await rm(dirname(image.path), { recursive: true, force: true });
        }
      return {
        content,
        isError: r.isError,
        ...(r.structured ? { structuredContent: r.structured } : {}),
      };
    };
    const job = invoke();
    pending.add(job);
    try {
      return await job;
    } finally {
      pending.delete(job);
    }
  });
  return server;
}
export async function serve(plugins: NativeAppPlugin[]) {
  const active = new Map<NativeAppPlugin, Runtime>();
  const pending = new Set<Promise<unknown>>();
  try {
    for (const p of plugins) active.set(p, await p.createContext());
    const server = createServer(active, pending);
    const ended = new Promise<void>((resolve) =>
      process.stdin.once("end", resolve),
    );
    await server.connect(new StdioServerTransport());
    await ended;
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.allSettled(pending);
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    for (const ctx of active.values()) ctx.close();
  }
}
