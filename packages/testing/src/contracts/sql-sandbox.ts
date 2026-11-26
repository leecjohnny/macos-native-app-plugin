import { expect, test } from "bun:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { DuckDbSnapshotStore } from "@macos-native-app/core/runners/duckdb";
export function testSqlSandboxContract() {
  test("normalized table boundary and SELECT-only execution", async () => {
    const db = await DuckDBInstance.create(":memory:"),
      conn = await db.connect();
    try {
      await conn.run("create table active as select 1 id");
      await conn.run("select json_serialize_sql('select 1')");
      const store = new DuckDbSnapshotStore(conn, [], new Set(["active"]));
      await store.lock();
      expect((await store.executeSql("select * from active", 1)).rows).toEqual([
        [1],
      ]);
      for (const sql of [
        "select * from duckdb_tables()",
        "delete from active",
        "select 1;select 2",
      ])
        await expect(store.executeSql(sql, 2)).rejects.toThrow();
    } finally {
      conn.closeSync();
      db.closeSync();
    }
  });
}
