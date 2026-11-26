import { test, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "@macos-native-app/core/protocol/mcp";
import type {
  NativeAppPlugin,
  Runtime,
} from "@macos-native-app/core/protocol/plugin";
export function testMcpContract(plugins: NativeAppPlugin[]) {
  test("combined discovery and kebab-case calls", async () => {
    const runtime: Runtime = {
      call: async (name) => ({ structured: null, text: name, isError: false }),
      close() {},
    };
    const server = createServer(new Map(plugins.map((p) => [p, runtime])));
    const client = new Client({ name: "contract", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(a);
      await client.connect(b);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(
        plugins.flatMap((p) => p.tools.map((t) => p.name + "_" + t.name)),
      );
      const result = await client.callTool({
        name: "photos-search-media",
        arguments: {},
      });
      expect(result.content).toEqual([{ type: "text", text: "search_media" }]);
    } finally {
      await client.close();
      await server.close();
    }
  });
}
