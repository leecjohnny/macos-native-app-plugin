import {
  DuckDbSnapshotStore,
  snapshot,
} from "@macos-native-app/core/runners/duckdb";
export { jsonValue, OMITTED_CAP } from "@macos-native-app/core/runners/duckdb";
import { Database } from "bun:sqlite";
import { DuckDBInstance, type DuckDBValue } from "@duckdb/node-api";
import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
export const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";

const files = {
  photos: "database/Photos.sqlite",
  leo: "database/search/leo.sqlite",
  analysis:
    "private/com.apple.mediaanalysisd/MediaAnalysis/MediaAnalysis.sqlite",
};
const normalized = new Set(
  "asset asset_lexeme lexicon video_segment album asset_album person asset_person asset_keyword resource".split(
    " ",
  ),
);
export async function build(root: string) {
  const db = new Database(join(root, files.photos), { readonly: true });
  const entities = new Map(
    db
      .query<{ Z_ENT: number; Z_NAME: string }, []>(
        "select Z_ENT,Z_NAME from Z_PRIMARYKEY",
      )
      .all()
      .map((r) => [r.Z_NAME, r.Z_ENT]),
  );
  const tables = db
    .query<{ name: string }, []>(
      "select name from sqlite_master where type='table'",
    )
    .all()
    .map((r) => r.name);
  function relation(
    suffix: string,
    col: string,
    owner: string,
    member: string,
  ) {
    const preferred = "Z_" + entities.get(owner) + suffix;
    const t = tables.includes(preferred)
      ? preferred
      : tables.find((name) =>
          new RegExp("^Z_[0-9]+" + suffix + "$").test(name),
        );
    if (!t) throw Error("Missing relation " + suffix);
    const cols = db
      .query<{ name: string }, []>("pragma table_info(" + t + ")")
      .all();
    const c =
      cols.find(
        (column) => column.name === "Z_" + entities.get(member) + col,
      ) ??
      cols.find((column) =>
        new RegExp("^Z_[0-9]+" + col + "$").test(column.name),
      );
    if (!c) throw Error("Missing relation column " + col);
    return { t, c: c.name };
  }
  const albums = relation("ASSETS", "ALBUMS", "Album", "Album"),
    members = relation("ASSETS", "ASSETS", "Album", "Asset"),
    keywords = relation(
      "KEYWORDS",
      "KEYWORDS",
      "AdditionalAssetAttributes",
      "Keyword",
    ),
    attrs = relation(
      "KEYWORDS",
      "ASSETATTRIBUTES",
      "AdditionalAssetAttributes",
      "AdditionalAssetAttributes",
    );
  const timestamp = db
    .query<{ type: string }, []>(
      "select type from pragma_table_info('ZASSET') where name='ZDATECREATED'",
    )
    .get()?.type;
  const schema = db
    .query<{ schema_version: number }, []>("pragma schema_version")
    .get()?.schema_version;
  db.close();
  const instance = await DuckDBInstance.create(":memory:"),
    conn = await instance.connect();
  const close = () => {
    conn.closeSync();
    instance.closeSync();
  };
  const run = (sql: string) => conn.run(sql);
  const rows = async (sql: string, args: DuckDBValue[] = []) =>
    (await conn.runAndReadAll(sql, args)).getRowObjectsJson();
  const engine = new DuckDbSnapshotStore(conn, [], normalized);
  const layers: string[] = [];
  try {
    for (const [name, file] of Object.entries(files)) {
      const path = join(root, file);
      if (name !== "photos" && !existsSync(path)) continue;
      await engine.attach(name, path);
      layers.push(name);
    }
    const date = timestamp?.toUpperCase().includes("TIME")
      ? "epoch(a.ZDATECREATED)"
      : "a.ZDATECREATED";
    await run(
      `create table asset as
      select a.Z_PK pk,
        a.ZUUID uuid,
        a.ZUUID||'/L0/001' id,
        a.ZFILENAME stored_filename, coalesce(aa.ZORIGINALFILENAME,
        a.ZFILENAME) filename, ${date}+978307200 created_at,coalesce(aa.ZTIMEZONEOFFSET,0) tz_offset,
        case when a.ZLATITUDE > -180 and a.ZLONGITUDE > -180 then a.ZLATITUDE end lat,
        case when a.ZLATITUDE > -180 and a.ZLONGITUDE > -180 then a.ZLONGITUDE end lon,
        a.ZKIND kind,
        a.ZKINDSUBTYPE subtype,
        a.ZPLAYBACKSTYLE playback,
        a.ZDURATION duration,
        a.ZFAVORITE favorite,
        a.ZADJUSTMENTSSTATE edited,
        a.ZHDRTYPE hdr,
        a.ZDEPTHTYPE portrait,
        a.ZDERIVEDCAMERACAPTUREDEVICE selfie,
        a.ZISDETECTEDSCREENSHOT screenshot,
        a.ZUNIFORMTYPEIDENTIFIER uti,
        a.ZWIDTH width,
        a.ZHEIGHT height,
        e.ZISO iso,e.ZAPERTURE aperture,e.ZFOCALLENGTH focal_length,e.ZLENSMODEL lens,
        aa.ZTITLE title,d.ZLONGDESCRIPTION description,concat_ws(' ',e.ZCAMERAMAKE,e.ZCAMERAMODEL) camera,aa.Z_PK attributes,
        a.ZMOMENT moment,
        count(*) over burst burst_count
      from photos.ZASSET a
      left join photos.ZADDITIONALASSETATTRIBUTES aa on aa.Z_PK=a.ZADDITIONALATTRIBUTES
      left join photos.ZASSETDESCRIPTION d on d.Z_PK=aa.ZASSETDESCRIPTION
      left join photos.ZEXTENDEDATTRIBUTES e on e.Z_PK=a.ZEXTENDEDATTRIBUTES
      where a.ZTRASHEDSTATE=0 and a.ZVISIBILITYSTATE=0 and a.ZHIDDEN=0
      window burst as (partition by case when a.ZAVALANCHEKIND<>0 and a.ZAVALANCHEUUID<>'' then a.ZAVALANCHEUUID else a.ZUUID end)
      qualify row_number() over (burst order by (a.ZAVALANCHEPICKTYPE & 4)<>0 desc,
        a.ZAVALANCHEPICKTYPE>0 desc,
        a.Z_PK)=1`,
    );
    await run(
      `create table resource as
      select uuid,
        r.ZRESOURCETYPE resource_type,
        r.ZVERSION version,
        r.ZDATASTORESUBTYPE subtype,
        r.ZLOCALAVAILABILITY local_availability,
        r.ZREMOTEAVAILABILITY remote_availability,
        r.ZDATALENGTH bytes,
        r.ZCODECFOURCHARCODENAME codec,
        r.ZCOMPACTUTI uti,case
        when ZVERSION=0 and ZRECIPEID=0 and ZDATASTORESUBTYPE=1 and ZRESOURCETYPE in (0,1) then 'original'
        when ZVERSION=0 and (ZRESOURCETYPE=9 or ZDATASTORESUBTYPE=18) then 'live_video'
        when ZVERSION=2 and ZRESOURCETYPE in (0,1) then 'edited' end variant from asset
      join photos.ZINTERNALRESOURCE r on r.ZASSET=pk
      where variant is not null`,
    );
    await run(
      `create table album as
      select Z_PK pk,ZUUID id,ZTITLE title,case when g.ZUSERQUERYDATA is not null then 'SmartAlbum' else k.Z_NAME end kind
      from photos.ZGENERICALBUM g
      join photos.Z_PRIMARYKEY k on g.Z_ENT=k.Z_ENT
      where g.Z_ENT in (${["Album", "Folder", "FetchingAlbum"].map((n) => entities.get(n) ?? -1)}) and g.ZTRASHEDSTATE=0 and ZTITLE is not null
      union all select -m.Z_PK,m.ZUUID,m.ZTITLE,'Moment'
      from photos.ZMOMENT m
      where exists(select 1
      from asset
      where moment=m.Z_PK)`,
    );
    await run(
      `create table asset_album as
      select distinct uuid,album.id from asset
      join photos.${albums.t} j on j.${members.c}=asset.pk join album on album.pk=j.${albums.c}
      union select uuid,album.id
      from asset join album on album.pk=-asset.moment`,
    );
    await run(
      `create table asset_keyword as
      select uuid,k.ZTITLE keyword from asset
      join photos.${keywords.t} j on j.${attrs.c}=attributes
      join photos.ZKEYWORD k on k.Z_PK=j.${keywords.c}`,
    );
    await run(
      `create table asset_person as with recursive chain(uuid,pk) as (select uuid,f.ZPERSONFORFACE from asset
      join photos.ZDETECTEDFACE f on f.ZASSETFORFACE=asset.pk
      union select uuid,p.ZMERGETARGETPERSON from chain
      join photos.ZPERSON p on p.Z_PK=chain.pk
      where p.ZMERGETARGETPERSON is not null) select distinct uuid,p.ZPERSONUUID id,coalesce(nullif(p.ZFULLNAME,''),p.ZDISPLAYNAME) name from chain
      join photos.ZPERSON p on p.Z_PK=chain.pk
      where p.ZMERGETARGETPERSON is null and name<>''`,
    );
    await run(
      "create table person as select id,name,count(*) assets from asset_person group by all",
    );
    await run(
      "create table asset_lexeme(uuid varchar,lexeme_id bigint,score double)",
    );
    if (layers.includes("leo")) {
      const records = (
        await conn.runAndReadAll(
          "select a.uuid,i.lexeme_ids,i.lexeme_scores from leo.items i join asset a on a.uuid=split_part(i.identifier,'/',1) where i.type=1 and i.lexeme_ids is not null",
        )
      ).getRowsJS();
      const app = await conn.createAppender("asset_lexeme");
      for (const [uuid, ids, scores] of records) {
        if (!(ids instanceof Uint8Array)) continue;
        const keys = Buffer.from(ids),
          values =
            scores instanceof Uint8Array
              ? new DataView(
                  scores.buffer,
                  scores.byteOffset,
                  scores.byteLength,
                )
              : null;
        for (let i = 0; i + 4 <= keys.length; i += 4) {
          app.appendVarchar(String(uuid));
          app.appendBigInt(BigInt(keys.readUInt32LE(i)));
          const score =
            values && i / 2 + 2 <= values.byteLength
              ? values.getFloat16(i / 2, true)
              : 0;
          app.appendDouble(Number.isFinite(score) ? score : 0);
          app.endRow();
        }
      }
      app.closeSync();
      await run(
        "create table lexicon as select lexeme_id,type,category,content,score from leo.lexicon semi join asset_lexeme using(lexeme_id)",
      );
    } else
      await run(
        "create table lexicon(lexeme_id bigint,type bigint,category bigint,content varchar,score double)",
      );
    await run(
      "create table video_segment(uuid varchar,start_sec double,duration_sec double,caption varchar)",
    );
    await run("alter table asset add column caption varchar");
    if (layers.includes("analysis")) {
      await run(
        "update asset a set caption=concat_ws(' ',ic.ZCAPTION,vc.ZCAPTION) from analysis.ZASSET m left join analysis.ZIMAGECAPTIONRESULT ic on ic.Z_PK=m.ZIMAGECAPTIONRESULT left join analysis.ZVIDEOCAPTIONRESULT vc on vc.Z_PK=m.ZVIDEOCAPTIONRESULT where a.id=m.ZLOCALIDENTIFIER and coalesce(ic.ZISUNSAFE,0)=0",
      );
      await run(
        "insert into video_segment select uuid,s.ZSTARTTIMEVALUE/nullif(s.ZSTARTTIMESCALE,0),s.ZDURATIONTIMEVALUE/nullif(s.ZDURATIONTIMESCALE,0),s.ZCAPTION from asset a join analysis.ZASSET m on a.id=m.ZLOCALIDENTIFIER join analysis.ZVIDEOSEGMENTCAPTIONRESULT s on s.ZASSET=m.Z_PK left join analysis.ZIMAGECAPTIONRESULT ic on ic.Z_PK=m.ZIMAGECAPTIONRESULT where coalesce(ic.ZISUNSAFE,0)=0",
      );
    }
    await run("alter table resource add column local_path varchar");
    await run("create table local_file(uuid varchar,path varchar)");
    const local = await conn.createAppender("local_file");
    for (const r of await rows(
      "select distinct uuid,stored_filename from asset join resource using(uuid) where variant='original' and local_availability=1",
    )) {
      const uuid = String(r.uuid),
        file = String(r.stored_filename);
      if (!/^[a-f0-9]/i.test(uuid) || basename(file) !== file) continue;
      const path = join(root, "originals", uuid[0]!, file);
      if (!statSync(path, { throwIfNoEntry: false })?.isFile()) continue;
      local.appendVarchar(uuid);
      local.appendVarchar(path);
      local.endRow();
    }
    local.closeSync();
    await run(
      "update resource set local_path=f.path from local_file f where f.uuid=resource.uuid and variant='original' and local_availability=1",
    );
    await run("drop table local_file");

    await engine.detach(layers);
    await run(`create table summary as
      select uuid,
      (select list(name order by name) from asset_person
      where uuid=a.uuid) people,
      (select list(title order by title) from asset_album join album using(id)
      where uuid=a.uuid) albums,
      (select list(struct_pack(start_sec:=start_sec,duration_sec:=duration_sec,caption:=caption) order by start_sec) from video_segment
      where uuid=a.uuid) segments,
      (select max(bytes) from resource
      where uuid=a.uuid and variant='original') original_bytes,
      (select bool_or(local_availability=1) from resource
      where uuid=a.uuid and variant='original') is_local
     
      from asset a`);
    await run(
      `create table document as
      select uuid,regexp_replace(concat_ws(' ',title,description,caption,(select string_agg(content,' ') from asset_lexeme join lexicon using(lexeme_id)
      where uuid=a.uuid),(select string_agg(name,' ') from asset_person
      where uuid=a.uuid),(select string_agg(caption,' ') from video_segment
      where uuid=a.uuid)), '([一-龯ぁ-ヿ가-힣])',' \\1 ','g') body
      from asset a`,
    );
    await run(
      "pragma create_fts_index('document','uuid','body',stopwords='none',ignore='[^\\p{L}\\p{N}]+')",
    );
    await run("select fts_main_document.match_bm25('','warmup')");
    await run("select json_serialize_sql('select 1')");
    await engine.lock();
    return {
      rows,
      close,
      layers,
      schema,
      async sql(sql: string, max: number) {
        return engine.executeSql(sql, max);
      },
    };
  } catch (e) {
    close();
    throw e;
  }
}
export async function openStore(root: string) {
  const stamp = () =>
    Object.values(files)
      .flatMap((f) =>
        ["", "-wal"].map(
          (s) =>
            statSync(join(root, f + s), { throwIfNoEntry: false })?.mtimeMs,
        ),
      )
      .join(",");
  return snapshot(
    stamp,
    () => build(root),
    (current) => current.close(),
    3000,
  );
}
