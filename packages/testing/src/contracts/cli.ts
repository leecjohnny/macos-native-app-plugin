import { test, expect } from "bun:test";
export function testCliContract(cli: string) {
  for (const [args, status] of [
    [["help"], 0],
    [["mcp"], 1],
    [["mcp", "--unknown"], 1],
    [["missing"], 1],
    [["help", "photos", "search-media"], 0],
  ] as const)
    test(args.join(" "), () => {
      const p = Bun.spawnSync([process.execPath, cli, ...args]);
      expect(p.exitCode).toBe(status);
      if (args[0] === "mcp") {
        expect(p.stderr.toString()).toContain("--mail");
        expect(p.stderr.toString()).toContain("--photos");
      }
    });
}
