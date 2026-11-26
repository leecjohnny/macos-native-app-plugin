import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { analysis } from "./analysis.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../../packages/core/src/protocol/mcp.ts";
import { photos, runtime } from "../src/plugin.ts";
import { createContext, callTool, type Context } from "../src/tools.ts";
const id = (n: number) =>
  "AAAAAAAA-0000-4000-8000-" + String(n).padStart(12, "0");
const day = Date.UTC(2020, 0, 2) / 1000;
for (const dateType of ["REAL", "TIMESTAMP"])
  describe(dateType, () => {
    let ctx: Context, root: string, out: string;
    const calls: string[] = [];
    const run = (name: string, input: Record<string, unknown>) =>
      callTool(name, input, ctx);
    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "photos-fixture-"));
      out = await mkdtemp(join(tmpdir(), "photos-out-"));
      await mkdir(join(root, "database"));
      const db = new Database(join(root, "database", "Photos.sqlite"));
      db.exec(
        (await Bun.file(join(import.meta.dir, "schema.sql")).text()).replace(
          "ZDATECREATED TIMESTAMP",
          "ZDATECREATED " + dateType,
        ),
      );
      db.exec(
        "insert into Z_PRIMARYKEY(Z_ENT,Z_NAME) values (82,'Album'),(7,'AdditionalAssetAttributes'),(12,'Asset'),(92,'Keyword');insert into ZADDITIONALASSETATTRIBUTES(Z_PK,ZTIMEZONEOFFSET,ZORIGINALFILENAME) values(1,3600,'fixture.jpg')",
      );
      for (let k = 1; k <= 7; k++)
        db.query(
          "insert into ZASSET(Z_PK,ZUUID,ZDATECREATED,ZADDITIONALATTRIBUTES,ZTRASHEDSTATE,ZHIDDEN,ZVISIBILITYSTATE,ZFILENAME,ZKIND,ZLATITUDE,ZLONGITUDE,ZAVALANCHEKIND,ZAVALANCHEUUID,ZAVALANCHEPICKTYPE,ZFAVORITE) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ).run(
          k,
          id(k),
          day - 1800 - 978307200,
          1,
          Number(k === 3),
          Number(k === 4),
          k === 5 ? 2 : 0,
          id(k) + ".jpg",
          0,
          -180,
          100,
          k >= 6 ? 1 : 0,
          k >= 6 ? "burst" : null,
          k === 7 ? 4 : 0,
          k === 1 ? 1 : 0,
        );
      for (const k of [1, 2])
        db.query(
          "insert into ZINTERNALRESOURCE(ZASSET,ZRESOURCETYPE,ZVERSION,ZRECIPEID,ZDATASTORESUBTYPE,ZLOCALAVAILABILITY,ZDATALENGTH)values(?,0,0,0,1,1,4)",
        ).run(k);
      db.close();
      const previews = join(root, "resources/derivatives/A");
      await mkdir(previews, { recursive: true });
      await writeFile(
        join(previews, id(1) + "_1.jpeg"),
        Buffer.from("/9j/2Q==", "base64"),
      );
      await mkdir(join(root, "originals", "A"), { recursive: true });
      for (const k of [1, 2])
        await writeFile(join(root, "originals", "A", id(k) + ".jpg"), "data");
      if (dateType === "TIMESTAMP") await analysis(root, id);
      ctx = await createContext(
        root,
        async (term) => {
          calls.push(term);
          if (term === "青空") return [id(2), id(1)];
          return term === "first" ? [id(1), id(3), id(4), id(5)] : [id(2)];
        },
        async () => ({ activeCount: 3 }),
      );
    });
    afterAll(async () => {
      ctx?.store.close();
      await Promise.all(
        [root, out]
          .filter(Boolean)
          .map((path) => rm(path, { recursive: true, force: true })),
      );
    });
    test("library and PhotoKit counts are numeric", async () => {
      const result = await run("fetch_library", {});
      expect(result.isError).toBe(false);
      expect(typeof result.structured?.active).toBe("number");
      expect(result.structured?.photoKit).toMatchObject({ activeCount: 3 });
    });
    test("capture-local dates, burst pick, missing location and unavailable layers", async () => {
      const r = await run("search_media", {
        query: "after:2020/01/02 -has:location",
      });
      expect(r.isError).toBe(false);
      const hits = r.structured!.results as {
        id: string;
        burst_count: string;
      }[];
      expect(hits.map((x) => x.id)).toEqual(
        [1, 2, 7].map((k) => id(k) + "/L0/001"),
      );
      expect(Number(hits[2]!.burst_count)).toBe(2);
      expect(ctx.store.current.layers).toEqual(
        dateType === "REAL" ? ["photos"] : ["photos", "leo", "analysis"],
      );
    });
    test("neural predicates combine with structured predicates inside the active set", async () => {
      calls.length = 0;
      const r = await run("search_media", {
        query: "(first OR second) -is:favorite",
      });
      expect(calls).toEqual(["first", "second"]);
      expect(r.structured?.results).toMatchObject([{ id: id(2) + "/L0/001" }]);
      const n = calls.length;
      expect((await run("search_media", { query: "is:photo" })).isError).toBe(
        false,
      );
      expect(calls.length).toBe(n);
    });
    if (dateType === "TIMESTAMP")
      test("Leo scores, CJK ranking, segment clocks and excluded content", async () => {
        const hits = await run("search_media", { query: "青空 ocr:青空" });
        expect(hits.structured?.results).toMatchObject([
          {
            id: id(1) + "/L0/001",
            segments: [{ start_sec: 3, duration_sec: 5 }],
          },
          { id: id(2) + "/L0/001", caption: null },
        ]);
        expect(
          (await run("search_terms", { query: "excluded" })).structured
            ?.results,
        ).toEqual([]);
        expect(
          (
            await run("execute_sql", {
              sql: "select score from asset_lexeme order by score desc",
            })
          ).structured?.rows,
        ).toEqual([[1], [-1]]);
      });
    test("search pages retain the total beyond the last result", async () => {
      const first = await run("search-media", { limit: 1 });
      expect(first.structured).toMatchObject({
        query: "",
        offset: 0,
        total: 3,
      });
      expect(first.text).toContain("Next page: offset=1");
      const last = await run("search_media", { offset: 2, limit: 1 });
      expect(last.text).toContain("showing 3–3");
      expect(last.text).not.toContain("Next page");
      expect((await run("search_media", { offset: 4 })).structured).toEqual({
        query: "",
        total: 3,
        offset: 4,
        results: [],
      });
    });
    test("SQL boundary and row cap", async () => {
      for (const table of [
        "asset",
        "resource",
        "lexicon",
        "album",
        "asset_album",
        "video_segment",
        "person",
        "asset_person",
        "asset_lexeme",
        "asset_keyword",
      ])
        expect(
          (await run("execute_sql", { sql: "select count(*) from " + table }))
            .isError,
        ).toBe(false);
      for (const sql of [
        "select * from photos.ZASSET",
        "select * from duckdb_tables()",
        "attach 'invalid' as x",
        "select 1; select 2",
        "select * from sqlite_master",
      ])
        expect((await run("execute_sql", { sql })).isError).toBe(true);
      expect(
        (
          await run("execute_sql", {
            sql: "with hits as (select * from asset) select uuid from hits",
            max_rows: 1,
          })
        ).structured?.omitted_rows,
      ).toBe(2);
    });
    test("byte preflight and exclusive publication", async () => {
      const over = await run("export_media", {
        ids: [id(1), id(2)],
        out,
        max_bytes: 7,
      });
      expect(over.text).toContain("Expected 8 bytes");
      const target = join(out, "chosen.jpg");
      const params = { ids: [id(1)], out: target, max_bytes: 4 };
      expect((await run("export_media", params)).isError).toBe(false);
      expect(await readFile(target, "utf8")).toBe("data");
      expect((await run("export_media", params)).isError).toBe(true);
      expect(
        (await run("export_media", { ...params, ids: [id(4)] })).isError,
      ).toBe(true);
    });
    test("export accepts a symlinked helper directory while the read lane is occupied", async () => {
      const original = ctx.helperRunner;
      const previous = ctx.queue;
      const read = Promise.withResolvers<void>();
      ctx.queue = read.promise;
      const callsToHelper: string[] = [];
      ctx.helperRunner = async (args) => {
        callsToHelper.push(args[0]!);
        if (args[0] === "estimate") return { bytes: 3 };
        const path = args[args.indexOf("--out") + 1]!;
        await writeFile(path, "abc");
        const alias = join(out, "helper-stage");
        await symlink(dirname(path), alias);
        return {
          ok: true,
          files: [
            {
              path: join(alias, basename(path)),
              bytes: 3,
              uti: "public.jpeg",
              resourceType: 5,
              fromIcloud: true,
            },
          ],
        };
      };
      try {
        const file = join(out, "edited.jpg"),
          r = await run("export_media", {
            ids: [id(1)],
            out: file,
            max_bytes: 3,
            variant: "edited",
          });
        expect(r.isError).toBe(false);
        expect(await readFile(file, "utf8")).toBe("abc");
        expect(callsToHelper).toEqual(["estimate", "export"]);
      } finally {
        read.resolve();
        ctx.queue = previous;
        ctx.helperRunner = original;
      }
    });
    test("remaining export budget follows staged bytes across the batch", async () => {
      const original = ctx.helperRunner;
      const budgets: number[] = [];
      ctx.helperRunner = async (args) => {
        if (args[0] === "estimate") return { bytes: 2 };
        budgets.push(Number(args[args.indexOf("--max-bytes") + 1]));
        const path = join(
          args[args.indexOf("--out") + 1]!,
          "transfer-" + budgets.length,
        );
        await writeFile(path, "abc");
        return { files: [{ path, bytes: 3 }] };
      };
      try {
        const request = {
          ids: [id(1), id(2)],
          out,
          variant: "edited",
          max_bytes: 5,
        };
        expect((await run("export-media", request)).isError).toBe(true);
        expect(budgets).toEqual([5, 2]);
        expect(await Bun.file(join(out, "transfer-1")).exists()).toBe(false);
        budgets.length = 0;
        expect(
          (await run("export-media", { ...request, max_bytes: 6 })).isError,
        ).toBe(false);
        expect(budgets).toEqual([6, 3]);
      } finally {
        ctx.helperRunner = original;
      }
    });
    test("CLI subprocess and stdio MCP use the configured library", async () => {
      const cli = join(import.meta.dir, "../../../apps/cli/src/cli.ts"),
        env = { ...process.env, MACOS_PHOTOS_ROOT: root };
      const result = Bun.spawnSync(
        [
          process.execPath,
          cli,
          "photos",
          "search_media",
          "is:favorite",
          "--limit",
          "1",
          "--json",
        ],
        { env },
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.toString()).results).toMatchObject([
        { id: id(1) + "/L0/001" },
      ]);
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          join(import.meta.dir, "../../../apps/cli/src/cli.ts"),
          "mcp",
          "--photos",
        ],
        env: { ...getDefaultEnvironment(), MACOS_PHOTOS_ROOT: root },
      });
      const client = new Client({ name: "stdio-test", version: "1" });
      try {
        await client.connect(transport);
        const response = await client.callTool({
          name: "photos_fetch_media",
          arguments: { id: id(1), preview: true },
        });
        expect(response.content).toMatchObject([
          { type: "text" },
          { type: "image", mimeType: "image/jpeg", data: "/9j/2Q==" },
        ]);
      } finally {
        await client.close();
      }
    });
    test("MCP discovery and validated calls", async () => {
      const server = createServer(new Map([[photos, runtime(ctx)]])),
        client = new Client({ name: "test", version: "1" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(a);
        await client.connect(b);
        const original = ctx.helperRunner;
        let sheet = "";
        try {
          ctx.helperRunner = async (args) => {
            sheet = args[args.indexOf("--out") + 1]!;
            await writeFile(sheet, "test-sheet");
            return { ok: true };
          };
          const preview = await client.callTool({
            name: "photos_fetch-previews",
            arguments: { ids: [id(1)] },
          });
          expect(preview.content).toMatchObject([
            {
              type: "image",
              data: Buffer.from("test-sheet").toString("base64"),
            },
          ]);
          expect(await Bun.file(sheet).exists()).toBe(false);
        } finally {
          ctx.helperRunner = original;
        }
        const listed = await client.listTools();
        expect(listed.tools).toHaveLength(9);
        expect(
          listed.tools.find((t) => t.name === "photos_export_media")
            ?.inputSchema.required,
        ).toEqual(["ids", "out", "max_bytes"]);
        expect(
          (
            await client.callTool({
              name: "photos_search_media",
              arguments: { query: "unsupported:word" },
            })
          ).isError,
        ).toBe(true);
      } finally {
        await client.close();
        await server.close();
      }
    });
  });
