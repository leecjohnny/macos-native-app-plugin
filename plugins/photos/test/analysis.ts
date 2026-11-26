import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
export async function analysis(root: string, id: (n: number) => string) {
  const search = join(root, "database/search"),
    media = join(root, "private/com.apple.mediaanalysisd/MediaAnalysis");
  await Promise.all([
    mkdir(search, { recursive: true }),
    mkdir(media, { recursive: true }),
  ]);
  const leo = new Database(join(search, "leo.sqlite"));
  leo.exec(
    "create table items(identifier text,type integer,lexeme_ids blob,lexeme_scores blob);create table lexicon(lexeme_id integer,type integer,category integer,content text,score real);insert into lexicon values(1,1,4120,'青空',1),(2,1,4120,'excluded',1)",
  );
  for (const [k, key, score] of [
    [1, 1, 1],
    [2, 1, -1],
    [4, 2, 1],
  ] as const) {
    const ids = Buffer.alloc(4),
      values = new Uint8Array(2);
    ids.writeUInt32LE(key);
    new DataView(values.buffer).setFloat16(0, score, true);
    leo.query("insert into items values(?,1,?,?)").run(id(k), ids, values);
  }
  leo.close();
  const db = new Database(join(media, "MediaAnalysis.sqlite"));
  db.exec(
    "create table ZASSET(Z_PK integer,ZLOCALIDENTIFIER text,ZIMAGECAPTIONRESULT integer,ZVIDEOCAPTIONRESULT integer);create table ZIMAGECAPTIONRESULT(Z_PK integer,ZCAPTION text,ZISUNSAFE integer);create table ZVIDEOCAPTIONRESULT(Z_PK integer,ZCAPTION text);create table ZVIDEOSEGMENTCAPTIONRESULT(ZASSET integer,ZCAPTION text,ZSTARTTIMEVALUE integer,ZSTARTTIMESCALE integer,ZDURATIONTIMEVALUE integer,ZDURATIONTIMESCALE integer);insert into ZIMAGECAPTIONRESULT values(1,'青空',0),(2,'excluded',1);insert into ZVIDEOSEGMENTCAPTIONRESULT values(1,'opening',30,10,50,10),(2,'excluded',0,1,1,1)",
  );
  for (const k of [1, 2])
    db.query("insert into ZASSET values(?,?,?,null)").run(
      k,
      id(k) + "/L0/001",
      k,
    );
  db.close();
}
