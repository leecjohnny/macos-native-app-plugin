import {
  day,
  relativeDate,
  textValue,
  near,
  duration as parseDuration,
  bytes,
} from "@macos-native-app/core/query/operators";
import { osascriptRunner } from "@macos-native-app/core/runners/osa";
import { quote } from "./store.ts";
export type Node =
  | { kind: "text"; value: string; phrase: boolean }
  | { kind: "field"; field: string; value: string }
  | { kind: "date"; op: "after" | "before"; at: number; relative?: boolean }
  | { kind: "not"; node: Node }
  | { kind: "and"; nodes: Node[] }
  | { kind: "or"; nodes: Node[] };

import {
  type Token,
  fail,
  parseQuery,
  QueryError,
} from "@macos-native-app/core/query/parser";
export { QueryError, MAX_DEPTH } from "@macos-native-app/core/query/parser";
function operator(
  tok: Extract<Token, { t: "op" }>,
  now: number,
): Extract<Node, { kind: "is" | "has" | "date" | "field" }> {
  const { name, value, pos } = tok;
  textValue(name, value, pos);

  if (
    "is has in place near person scene text ocr keyword camera filename longer shorter larger smaller"
      .split(" ")
      .includes(name)
  ) {
    try {
      predicate(name, value);
    } catch (e) {
      if (e instanceof QueryError) fail(e.message, pos);
      throw e;
    }
    return { kind: "field", field: name, value };
  }
  if (name === "after" || name === "before")
    return { kind: "date", op: name, at: day(value, pos, true) };
  if (name === "older_than" || name === "newer_than") {
    const at = relativeDate(name, value, now, pos);
    return {
      kind: "date",
      relative: true,
      op: name === "older_than" ? "before" : "after",
      at,
    };
  }
  return fail(`unknown operator '${name}:'`, pos);
}

export const parse = (input: string, now?: number): Node =>
  parseQuery(operator, /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/s, true, input, now);
export type Runner = (query: string) => Promise<string[]>;
export const searchRunner: Runner = async (query) => {
  if (!query.trim()) throw new QueryError("Empty Photos search");
  const result = await osascriptRunner(
    import.meta.dir + "/../osa/search.applescript",
    [query],
    true,
  );
  return result.match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi) ?? [];
};
const flags: Record<string, string> = {
  photo: "kind=0",
  video: "kind=1",
  live: "kind=0 and subtype=2 and playback in (3,5)",
  favorite: "favorite>0",
  screenshot: "(screenshot>0 or (kind=0 and subtype=10))",
  portrait: "kind=0 and portrait=1",
  selfie: "selfie=1",
  pano: "kind=0 and subtype=1",
  slomo: "kind=1 and subtype=101",
  timelapse: "kind=1 and subtype=102",
  cinematic: "kind=1 and portrait=2",
  raw: "(uti ilike '%raw%' or uti ilike '%dng%' or filename ilike '%.dng')",
  hdr: "hdr>0",
  edited: "edited>0",
  local:
    "exists(select 1 from resource r where r.uuid=a.uuid and variant='original' and local_availability=1)",
  icloud:
    "exists(select 1 from resource r where r.uuid=a.uuid and variant='original' and local_availability<>1 and remote_availability=1)",
};
const categories: Record<string, string> = {
  place: "category between 2000 and 2299",
  person: "category between 3000 and 3099",
  scene: "(category between 4000 and 4119 or category=4130)",
  ocr: "category=4120",
  text: "category=4120",
};
const linked = (table: string, condition: string) =>
  "exists(select 1 from " + table + " where uuid=a.uuid and " + condition + ")";
export async function compile(
  node: Node,
  runner: Runner,
  terms: string[],
  positive = true,
): Promise<string> {
  if (node.kind === "and" || node.kind === "or") {
    const parts = [];
    for (const item of node.nodes)
      parts.push(await compile(item, runner, terms, positive));
    return "(" + (parts.join(" " + node.kind + " ") || "true") + ")";
  }
  if (node.kind === "not")
    return (
      "not coalesce((" +
      (await compile(node.node, runner, terms, !positive)) +
      "),false)"
    );
  if (node.kind === "date")
    return (
      "(created_at+tz_offset " +
      (node.op === "after" ? ">=" : "<") +
      (node.relative
        ? "floor((" + node.at + "+tz_offset)/86400)*86400"
        : node.at) +
      ")"
    );
  if (node.kind === "text") {
    if (positive) terms.push(node.value);
    const ids = await runner(node.value);
    return "uuid in (" + (ids.map(quote).join(",") || "NULL") + ")";
  }
  return "(" + predicate(node.field, node.value) + ")";
}
function predicate(field: string, value: string): string {
  const v = quote(value.toLowerCase());
  const contains = (col: string) => "contains(lower(" + col + ")," + v + ")";
  const leo = (cat: string) =>
    linked(
      "asset_lexeme join lexicon using(lexeme_id)",
      cat + " and " + contains("content"),
    );
  if (Object.hasOwn(categories, field)) {
    const sql = leo(categories[field]!);
    return field === "person"
      ? "(" + sql + " or " + linked("asset_person", contains("name")) + ")"
      : sql;
  }
  if (field === "filename" || field === "camera") return contains(field);
  if (field === "keyword") return linked("asset_keyword", contains("keyword"));
  if (field === "in")
    return linked(
      "asset_album join album using(id)",
      "(" + contains("title") + " or lower(id)=" + v + ")",
    );
  if (field === "is" && Object.hasOwn(flags, value.toLowerCase()))
    return "(" + flags[value.toLowerCase()] + ")";
  if (field === "has") {
    const options: Record<string, string> = {
      caption:
        "(coalesce(caption,'')<>'' or " +
        linked("video_segment", "caption<>''") +
        ")",
      location: "lat is not null",
      ocr: linked(
        "asset_lexeme join lexicon using(lexeme_id)",
        "category=4120",
      ),
      people:
        "(" +
        linked("asset_person", "true") +
        " or " +
        linked(
          "asset_lexeme join lexicon using(lexeme_id)",
          categories.person!,
        ) +
        ")",
    };
    if (Object.hasOwn(options, value)) return options[value]!;
  }
  if (field === "near") {
    const coords = near(value);
    if (coords) {
      const { lat, lon, km } = coords;
      return `lat is not null and 12742*asin(sqrt(least(1,sin(radians(lat-${lat})/2)^2+cos(radians(lat))*cos(radians(${lat}))*sin(radians(lon-${lon})/2)^2)))<=${km}`.replaceAll(
        "--",
        "- -",
      );
    }
  }
  const duration = field === "longer" || field === "shorter";
  if (duration || field === "larger" || field === "smaller") {
    const amount = duration ? parseDuration(value) : bytes(value);
    if (amount !== undefined)
      return (
        (duration
          ? "kind=1 and duration"
          : "(select max(bytes) from resource where uuid=a.uuid and variant='original')") +
        (field === "longer" || field === "larger" ? ">" : "<") +
        amount
      );
  }
  throw new QueryError("Invalid " + field + ":" + value);
}
