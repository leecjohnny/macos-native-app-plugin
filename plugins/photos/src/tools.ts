import { spaceCjk } from "@macos-native-app/core/query/text";
import { dispatch } from "@macos-native-app/core/protocol/dispatch";
import {
  defineTool,
  readOnly,
  exportTransfer,
} from "@macos-native-app/core/protocol/tool";
import {
  obj,
  int,
  str,
  arr,
  opt,
  bool,
  oneOf,
  unknown as anyValue,
  map,
  nullable,
  type Schema,
  type Static,
} from "@earendil-works/pi-schema";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { openStore, quote } from "./store.ts";
import { compile, parse, searchRunner, type Runner } from "./query.ts";
import { helper, exportMedia, type HelperRunner } from "./export.ts";
import { render } from "./render.ts";
export const defaultRoot = (
  env: Record<string, string | undefined> = process.env,
) =>
  env.MACOS_PHOTOS_ROOT ||
  join(homedir(), "Pictures", "Photos Library.photoslibrary");
export async function createContext(
  root: string,
  runner: Runner = searchRunner,
  helperRunner: HelperRunner = helper,
) {
  return {
    root,
    runner,
    helperRunner,
    store: await openStore(root),
    exports: new Set<Promise<unknown>>(),
    queue: Promise.resolve() as Promise<unknown>,
  };
}
export type Context = Awaited<ReturnType<typeof createContext>>;
type Data = Record<string, unknown>;
const row = map(anyValue()),
  rowList = arr(row);
const outputs: Record<string, Schema> = {
  search_media: obj({
    query: str(),
    total: int(),
    offset: int(),
    results: rowList,
  }),
  search_terms: obj({ results: rowList }),
  fetch_media: obj({
    asset: row,
    resource: rowList,
    asset_person: rowList,
    asset_album: rowList,
    asset_keyword: rowList,
    video_segment: rowList,
    asset_lexeme: rowList,
    preview: opt(str()),
  }),
  fetch_previews: obj({ preview: str() }),
  export_media: obj({ ok: bool(), files: rowList, error: nullable(str()) }),
  fetch_albums: obj({ albums: rowList }),
  fetch_people: obj({ people: rowList }),
  fetch_library: obj(
    { layers: arr(str()), active: int(), photoKit: row },
    { open: true },
  ),
  execute_sql: obj({
    columns: arr(str()),
    rows: arr(arr(anyValue())),
    omitted_rows: int(),
  }),
};
function tool<S extends Schema>(
  name: string,
  description: string,
  primary: string | null,
  input: S,
  run: (input: Static<S>, ctx: Context) => Promise<Data>,
) {
  return {
    name,
    title: description,
    description,
    primary,
    output: outputs[name]!,
    validator: defineTool(input, outputs[name]!),
    input,
    run,
    annotations:
      name === "export_media"
        ? exportTransfer(description)
        : readOnly(description),
  };
}
const query = opt(str({ default: "" })),
  limit = opt(int({ minimum: 1, maximum: 100, default: 10 })),
  ids = arr(str({ minLength: 1 }), { minItems: 1, maxItems: 64 });
async function thumbnail(id: string, ctx: Context) {
  const [a] = await ctx.store.current.rows(
    "select uuid from asset where id=? or uuid=?",
    [id, id],
  );
  if (!a) throw Error("Active asset unavailable");
  const uuid = String(a.uuid),
    dir = join(ctx.root, "resources/derivatives", uuid[0]!);
  const file = (await readdir(dir))
    .toSorted()
    .find((f) => f.startsWith(uuid + "_") && /\.jpe?g$/i.test(f));
  if (!file) throw Error("No local thumbnail");
  return join(dir, file);
}
export const TOOLS = [
  tool(
    "search_media",
    "Search active photos and videos",
    "query",
    obj({ query, limit, offset: opt(int({ minimum: 0, default: 0 })) }),
    async (i, c) => {
      const terms: string[] = [];
      const where = await compile(parse(i.query ?? ""), c.runner, terms);
      const text = spaceCjk(terms.join(" "));
      const labels = [
        ...new Set(
          terms
            .flatMap((t) => [t, ...t.split(/\s+/)])
            .map((t) => quote(t.toLowerCase())),
        ),
      ].join(",");
      const score = terms.length
        ? `coalesce(fts_main_document.match_bm25(uuid,${quote(text)}),0)+coalesce((select max(l.score) from asset_lexeme l join lexicon x using(lexeme_id) where l.uuid=a.uuid and lower(content) in (${labels})),0)`
        : "0";
      const matched = terms.length
        ? `(select list(distinct content order by content) from asset_lexeme join lexicon using(lexeme_id) where uuid=a.uuid and lower(content) in (${labels}))`
        : "null";
      const [count] = await c.store.current.rows(
        "select count(*) total from asset a where " + where,
      );
      return {
        query: i.query ?? "",
        total: Number(count!.total),
        offset: i.offset ?? 0,
        results: await c.store.current.rows(
          `select id,filename,kind,created_at,tz_offset,duration,lat,lon,caption,burst_count,s.* exclude(uuid),${matched} matched_terms,${score} score from asset a join summary s using(uuid) where ${where} order by score desc,created_at desc,uuid limit ? offset ?`,
          [i.limit ?? 10, i.offset ?? 0],
        ),
      };
    },
  ),
  tool(
    "search_terms",
    "Find indexed terms by prefix",
    "query",
    obj({ query, category: opt(int()), limit }),
    async (i, c) => ({
      results: await c.store.current.rows(
        "select content,category,count(distinct uuid) assets from lexicon join asset_lexeme using(lexeme_id) where starts_with(lower(content),lower(?)) and (? is null or category=?) group by all order by assets desc,content limit ?",
        [i.query ?? "", i.category ?? null, i.category ?? null, i.limit ?? 10],
      ),
    }),
  ),
  tool(
    "fetch_media",
    "Read asset metadata and resources",
    "id",
    obj({ id: str(), preview: opt(bool()) }),
    async (i, c) => {
      const rows = c.store.current.rows;
      const [asset] = await rows("select * from asset where id=? or uuid=?", [
        i.id,
        i.id,
      ]);
      if (!asset) throw Error("Active asset unavailable");
      const data: Data = { asset };
      for (const table of [
        "resource",
        "asset_person",
        "asset_album join album using(id)",
        "asset_keyword",
        "video_segment",
        "asset_lexeme join lexicon using(lexeme_id)",
      ])
        data[table.split(" ")[0]!] = await rows(
          "select * from " + table + " where uuid=?",
          [String(asset.uuid)],
        );
      if (i.preview) data.preview = await thumbnail(i.id, c);
      return data;
    },
  ),
  tool(
    "fetch_previews",
    "Build a labelled JPEG sheet of local previews",
    "ids",
    obj({
      ids,
      max_size: opt(int({ minimum: 32, maximum: 1024 })),
      cols: opt(int({ minimum: 1, maximum: 12 })),
    }),
    async (i, c) => {
      const args = [
        "contact-sheet",
        "--size",
        String(i.max_size ?? 220),
        "--cols",
        String(i.cols ?? 4),
      ];
      for (const id of i.ids)
        args.push("--item", id.slice(0, 8) + "=" + (await thumbnail(id, c)));
      const dir = await mkdtemp(join(tmpdir(), "photos-preview-"));
      const path = join(dir, "sheet.jpg");
      try {
        await c.helperRunner([...args, "--out", path]);
        return { preview: path };
      } catch (e) {
        await rm(dir, { recursive: true, force: true });
        throw e;
      }
    },
  ),
  tool(
    "export_media",
    "Export selected media to disk",
    "ids",
    obj({
      ids,
      out: str({ minLength: 1 }),
      max_bytes: int({ minimum: 1 }),
      variant: opt(oneOf(["original", "edited", "live_video", "raw", "all"])),
      allow_network: opt(bool()),
    }),
    async (i, c) =>
      exportMedia(
        c.root,
        i.ids,
        i.out,
        i.variant ?? "original",
        i.max_bytes,
        i.allow_network ?? true,
        c.helperRunner,
      ),
  ),
  tool(
    "fetch_albums",
    "List library albums, folders and moments",
    null,
    obj({}),
    async (_, c) => ({
      albums: await c.store.current.rows(
        "select album.*,kind in ('FetchingAlbum','SmartAlbum') rule_based,count(uuid) assets from album left join asset_album using(id) group by all order by title",
      ),
    }),
  ),
  tool(
    "fetch_people",
    "List named people and pets",
    null,
    obj({}),
    async (_, c) => ({
      people: await c.store.current.rows("select * from person order by name"),
    }),
  ),
  tool(
    "fetch_library",
    "Inspect library layers and coverage",
    null,
    obj({}),
    async (_, c) => ({
      layers: c.store.current.layers,
      schema_version: c.store.current.schema,
      ...Object.fromEntries(
        Object.entries(
          (
            await c.store.current.rows(
              "select (select count(distinct uuid) from asset_lexeme) indexed,(select count(distinct uuid) from video_segment) segmented,count(*) active,count_if(caption<>'') captioned,count_if(" +
                "exists(select 1 from resource r where r.uuid=a.uuid and variant='original' and local_availability=1)) local,active-local icloud from asset a",
            )
          )[0] ?? {},
        ).map(([key, value]) => [key, value === null ? null : Number(value)]),
      ),
      photoKit: await c.helperRunner(["status"]),
    }),
  ),
  tool(
    "execute_sql",
    "Query normalized library tables",
    "sql",
    obj({ sql: str(), max_rows: opt(int({ minimum: 1, maximum: 1000 })) }),
    async (i, c) => c.store.current.sql(i.sql, i.max_rows ?? 100),
  ),
];
export type Tool = (typeof TOOLS)[number];
export const find = (name: string) =>
  TOOLS.find((t) => t.name === name.replaceAll("-", "_"));
export async function callTool(name: string, args: unknown, c: Context) {
  const t = find(name);
  async function invoke() {
    try {
      if (!t) throw Error("Unknown tool " + name);
      const parsed = t.validator.parse(args);
      if (!parsed.ok) throw Error(JSON.stringify(parsed.errors));
      if (t.name !== "export_media") await c.store.refresh();
      const structured = await t.run(parsed.value as never, c);
      const errors = t.validator.errors(structured);
      if (errors.length)
        throw Error(
          "Invalid output for " + name + ": " + JSON.stringify(errors),
        );
      return { structured, text: render(structured), isError: false };
    } catch (e) {
      return {
        structured: null,
        text: e instanceof Error ? e.message : String(e),
        isError: true,
      };
    }
  }
  return dispatch(
    c,
    t?.name === "export_media" ? "parallel" : "serial",
    invoke,
  );
}
