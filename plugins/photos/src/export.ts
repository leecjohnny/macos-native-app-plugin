import { basename, dirname, join, resolve } from "node:path";
import {
  copyFile,
  link,
  unlink,
  stat,
  realpath,
  mkdtemp,
  rm,
} from "node:fs/promises";
import { constants } from "node:fs";
import { Database } from "bun:sqlite";
import {
  swiftHelper,
  type SwiftHelperRunner,
} from "@macos-native-app/core/runners/swift";
export type HelperRunner = SwiftHelperRunner;
export const helper = swiftHelper(
  join(import.meta.dir, "../build/photos-helper"),
);
type Metadata = {
  uuid: string;
  stored: string;
  filename: string;
  uti: string;
  kind: number;
  local: number | null;
  expected: number | null;
};
function metadata(root: string, ids: string[]) {
  const db = new Database(join(root, "database/Photos.sqlite"), {
    readonly: true,
  });
  try {
    const uuids = [...new Set(ids.map((id) => id.replace(/\/L0\/001$/, "")))];
    const read = db.query<Metadata, string[]>(`with active as (
 select Z_PK,ZUUID,ZADDITIONALATTRIBUTES,ZFILENAME,ZUNIFORMTYPEIDENTIFIER,ZKIND,row_number() over(partition by case when ZAVALANCHEKIND<>0 and ZAVALANCHEUUID<>'' then ZAVALANCHEUUID else ZUUID end
 order by (ZAVALANCHEPICKTYPE & 4)<>0 desc,ZAVALANCHEPICKTYPE>0 desc,Z_PK) pick
 from ZASSET a where ZTRASHEDSTATE=0 and ZVISIBILITYSTATE=0 and ZHIDDEN=0)
 select a.ZUUID uuid,a.ZFILENAME stored,coalesce(aa.ZORIGINALFILENAME,a.ZFILENAME) filename,a.ZUNIFORMTYPEIDENTIFIER uti,a.ZKIND kind,
 max(r.ZLOCALAVAILABILITY) local,sum(r.ZDATALENGTH) expected from active a
 left join ZADDITIONALASSETATTRIBUTES aa on aa.Z_PK=a.ZADDITIONALATTRIBUTES
 left join ZINTERNALRESOURCE r on r.ZASSET=a.Z_PK and r.ZRESOURCETYPE in (0,1) and r.ZVERSION=0 and r.ZRECIPEID=0 and r.ZDATASTORESUBTYPE=1
 where pick=1 and a.ZUUID in (${uuids.map(() => "?").join(",")}) group by a.Z_PK`);
    const rows = new Map(read.all(...uuids).map((row) => [row.uuid, row]));
    return uuids.map((id) => {
      const row = rows.get(id);
      if (!row) throw Error("Active asset unavailable");
      return row;
    });
  } finally {
    db.close();
  }
}

export async function exportMedia(
  root: string,
  ids: string[],
  out: string,
  variant: string,
  max: number,
  network: boolean,
  run: HelperRunner,
) {
  const directory = (await stat(out).catch(() => null))?.isDirectory(),
    base = await realpath(directory ? out : dirname(resolve(out)));
  const library = await realpath(root);
  if (
    base === library ||
    base.startsWith(library + "/") ||
    base
      .split("/")
      .some((part) => part.toLowerCase().endsWith(".photoslibrary"))
  )
    throw Error("Choose an output outside the library");
  if (ids.length > 1 && !directory)
    throw Error("Multiple assets require an existing output directory");
  const plans = [];
  let total = 0;
  for (const a of metadata(root, ids)) {
    const uuid = a.uuid,
      name = basename(a.filename);
    const target = directory
      ? join(base, uuid.slice(0, 8) + "_" + name)
      : resolve(out);
    const candidate = join(root, "originals", uuid[0]!, basename(a.stored));
    const source =
      variant === "original" &&
      a.local === 1 &&
      (await stat(candidate).catch(() => null))?.isFile()
        ? candidate
        : null;
    const args = [
      "--id",
      uuid + "/L0/001",
      "--variant",
      variant,
      "--out",
      out,
      "--max-bytes",
      String(max),
      "--allow-network",
      String(network),
    ];
    let bytes: number;
    if (source) bytes = (await stat(source)).size;
    else if (variant === "original") {
      bytes = Number(a.expected);
      if (!bytes) bytes = Number((await run(["estimate", ...args])).bytes);
    } else bytes = Number((await run(["estimate", ...args])).bytes);
    if (!Number.isSafeInteger(bytes) || bytes <= 0)
      throw Error("Exact resource size unavailable");
    total += bytes;
    plans.push({ source, target, args, bytes, uti: a.uti, kind: a.kind });
  }
  if (total > max)
    throw Error("Expected " + total + " bytes exceeds max_bytes " + max);
  const stage = await mkdtemp(join(base, ".photos-export-"));
  const pending: {
    path: string;
    target: string;
    info: Record<string, unknown>;
  }[] = [];
  let transferred = 0;
  const installed: string[] = [];
  try {
    for (const p of plans) {
      if (transferred >= max) throw Error("Export exceeds byte budget");
      if (p.source) {
        const path = join(stage, crypto.randomUUID());
        await copyFile(p.source, path, constants.COPYFILE_EXCL);
        if ((await stat(path)).size !== p.bytes)
          throw Error("Original changed during export");
        transferred += p.bytes;
        pending.push({
          path,
          target: p.target,
          info: {
            bytes: p.bytes,
            uti: p.uti,
            resourceType: Number(p.kind) === 1 ? 2 : 1,
            fromIcloud: false,
          },
        });
      } else {
        const sub = await mkdtemp(join(stage, "asset-"));
        p.args[p.args.indexOf("--out") + 1] = directory
          ? sub
          : join(sub, "resource");
        p.args[p.args.indexOf("--max-bytes") + 1] = String(max - transferred);
        const result = await run(["export", ...p.args]);
        for (const info of result.files as Record<string, unknown>[]) {
          const path = String(info.path);
          if ((await realpath(dirname(path))) !== (await realpath(sub)))
            throw Error("Unexpected helper output path");
          const actual = (await stat(path)).size;
          transferred += actual;
          pending.push({
            path,
            target: directory ? join(base, basename(path)) : resolve(out),
            info: { ...info, bytes: actual },
          });
        }
      }
      if (transferred > max) throw Error("Export exceeds byte budget");
    }
    for (const file of pending) {
      await link(file.path, file.target);
      installed.push(file.target);
    }
    return {
      ok: true,
      files: pending.map((file) => ({ ...file.info, path: file.target })),
      error: null,
    };
  } catch (error) {
    for (const path of installed) await unlink(path);
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
