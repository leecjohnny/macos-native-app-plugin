import { mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OsaRunner } from "@macos-native-app/core/runners/osa";
import type { SwiftHelperRunner } from "@macos-native-app/core/runners/swift";
export const createFakeOsaRunner = (run: OsaRunner = async () => "") =>
  mock(run);
export const createFakeSwiftRunner = (
  run: SwiftHelperRunner = async () => ({ ok: true }),
) => mock(run);
export async function withTempDir<T>(run: (dir: string) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), "native-app-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function withSqliteFixture<T>(
  schema: string,
  run: (path: string) => Promise<T>,
) {
  return withTempDir(async (dir) => {
    const { Database } = await import("bun:sqlite");
    const path = join(dir, "fixture.sqlite");
    const db = new Database(path, { create: true });
    try {
      db.exec(schema);
    } finally {
      db.close();
    }
    return run(path);
  });
}
