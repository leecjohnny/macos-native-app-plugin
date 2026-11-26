import {
  type DuckDBConnection,
  StatementType,
  JSDuckDBValueConverter,
} from "@duckdb/node-api";
export const OMITTED_CAP = 1_000_000;
export function jsonValue(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint")
    return Number.isSafeInteger(Number(v)) ? Number(v) : String(v);
  if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
  if (typeof v === "string" || typeof v === "boolean") return v;
  if (v instanceof Date)
    return Number.isNaN(v.getTime()) ? String(v) : v.toISOString();
  return JSON.stringify(v, (_, x: unknown) =>
    typeof x === "bigint" ? jsonValue(x) : x,
  );
}

function checkSources(value: unknown, scope: Set<string>): void {
  if (!value || typeof value !== "object") return;
  const n = value as Record<string, unknown>;
  const cte = n.cte_map as { map?: { key: string }[] } | undefined;
  const names = cte?.map?.length
    ? new Set([...scope, ...cte.map.map((e) => e.key.toLowerCase())])
    : scope;
  if (
    n.type === "TABLE_FUNCTION" ||
    (n.type === "BASE_TABLE" &&
      (!names.has(String(n.table_name).toLowerCase()) ||
        n.catalog_name ||
        (n.schema_name && n.schema_name !== "main")))
  )
    throw Error("Only normalized library tables are available");
  for (const child of Object.values(n)) checkSources(child, names);
}
export class DuckDbSnapshotStore {
  constructor(
    readonly conn: DuckDBConnection,
    readonly allowRawCatalogs: string[] = [],
    readonly normalized = new Set<string>(),
  ) {}
  async attach(alias: string, path: string) {
    await this.conn.run(
      "ATTACH " +
        "'" +
        path.replaceAll("'", "''") +
        "' AS " +
        this.identifier(alias) +
        " (TYPE sqlite,READ_ONLY)",
    );
  }
  private identifier(alias: string) {
    if (!/^[a-z_]+$/.test(alias)) throw Error("Invalid catalog alias");
    return alias;
  }
  async detach(aliases: string[]) {
    for (const alias of aliases)
      if (!this.allowRawCatalogs.includes(alias))
        await this.conn.run("DETACH " + this.identifier(alias));
  }
  async lock() {
    await this.conn.run("SET enable_external_access=false");
    await this.conn.run("SET lock_configuration=true");
  }
  async executeSql(text: string, maxRows: number) {
    const { conn, normalized } = this;
    if (!this.allowRawCatalogs.length) {
      const [entry] = (
        await conn.runAndReadAll("select json_serialize_sql(?) tree", [text])
      ).getRowObjectsJS();
      const ast = JSON.parse(String(entry?.tree));
      if (ast.error || ast.statements?.length !== 1)
        throw Error("Expected one SELECT");
      checkSources(ast, normalized);
      if (
        conn.getTableNames(text, true).some(
          (name) =>
            !normalized.has(
              name
                .toLowerCase()
                .replace(/^main\./, "")
                .replace(/^"([a-z_]+)"$/, "$1"),
            ),
        )
      )
        throw Error("Only normalized library tables are available");
    }
    const extracted = await conn.extractStatements(text);
    if (extracted.count !== 1)
      throw new Error("execute_sql takes exactly one statement");
    const prepared = await extracted.prepare(0);
    try {
      if (prepared.statementType !== StatementType.SELECT)
        throw new Error("execute_sql only runs SELECT statements");
      const result = await prepared.stream();
      try {
        const out: (string | number | boolean | null)[][] = [];
        let omitted = 0;
        for (
          let chunk = await result.fetchChunk();
          chunk && chunk.rowCount > 0 && omitted < OMITTED_CAP;
          chunk = await result.fetchChunk()
        ) {
          const take = Math.min(chunk.rowCount, maxRows - out.length);
          for (let i = 0; i < take; i++)
            out.push(
              chunk.convertRowValues(i, JSDuckDBValueConverter).map(jsonValue),
            );
          omitted += chunk.rowCount - take;
        }
        return {
          columns: result.columnNames(),
          rows: out,
          omitted_rows: Math.min(omitted, OMITTED_CAP),
        };
      } finally {
        result.closeSync();
      }
    } finally {
      prepared.destroySync();
    }
  }
}

export function snapshot<T>(
  stamp: () => string,
  build: (version: string) => Promise<T>,
  close: (current: T) => void,
  cooldownMs = 0,
) {
  let current: T | undefined,
    version: string | undefined,
    checked = -Infinity;
  let pending: Promise<boolean> | undefined;
  async function rebuild() {
    if (current && Date.now() - checked < cooldownMs) return false;
    const next = stamp();
    checked = Date.now();
    if (current && next === version) return false;
    let fresh: T;
    try {
      fresh = await build(next);
    } catch (e) {
      if (!/busy|locked/i.test(String(e))) throw e;
      await Bun.sleep(50);
      fresh = await build(next);
    }
    if (current) close(current);
    current = fresh;
    version = next;
    return true;
  }
  return {
    get current() {
      if (!current) throw Error("Snapshot is not open");
      return current;
    },
    refresh() {
      return (pending ??= rebuild().finally(() => {
        pending = undefined;
      }));
    },
    close() {
      if (current) close(current);
      current = undefined;
    },
  };
}
