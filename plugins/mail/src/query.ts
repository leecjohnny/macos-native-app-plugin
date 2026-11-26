import {
  day,
  relativeDate,
  textValue,
  enumValue,
} from "@macos-native-app/core/query/operators";
export type Field = "from" | "to" | "cc" | "subject" | "in";

export type Node =
  | { kind: "text"; value: string; phrase: boolean }
  | { kind: "field"; field: Field; value: string }
  | { kind: "is"; value: "unread" | "read" | "flagged" }
  | { kind: "has"; value: "attachment" }
  | { kind: "date"; op: "after" | "before"; at: number }
  | { kind: "not"; node: Node }
  | { kind: "and"; nodes: Node[] }
  | { kind: "or"; nodes: Node[] };

import {
  type Token,
  fail,
  parseQuery,
} from "@macos-native-app/core/query/parser";
export { QueryError, MAX_DEPTH } from "@macos-native-app/core/query/parser";
const FIELDS = new Set<string>(["from", "to", "cc", "subject", "in"]);
const IS: Record<string, "unread" | "read" | "flagged"> = {
  unread: "unread",
  read: "read",
  flagged: "flagged",
  starred: "flagged",
};
function operator(
  tok: Extract<Token, { t: "op" }>,
  now: number,
): Extract<Node, { kind: "is" | "has" | "date" | "field" }> {
  const { name, value, pos } = tok;
  textValue(name, value, pos);
  if (FIELDS.has(name)) return { kind: "field", field: name as Field, value };
  const v = value.toLowerCase();
  if (name === "is") {
    const is = enumValue(IS, v);
    return is
      ? { kind: "is", value: is }
      : fail(`invalid value 'is:${value}'`, pos);
  }
  if (name === "has") {
    return v === "attachment"
      ? { kind: "has", value: "attachment" }
      : fail(`invalid value 'has:${value}'`, pos);
  }
  if (name === "after" || name === "before")
    return { kind: "date", op: name, at: day(value, pos, false) };
  if (name === "older_than" || name === "newer_than") {
    const at = relativeDate(name, value, now, pos);
    return { kind: "date", op: name === "older_than" ? "before" : "after", at };
  }
  return fail(`unknown operator '${name}:'`, pos);
}

export const parse = (input: string, now?: number): Node =>
  parseQuery(operator, /^([a-z_]+):(.*)$/s, false, input, now);
export type Compiled = {
  where: string;
  params: unknown[];
  text: string | null;
};

const ROLES = new Map<string, string>([
  ["inbox", "inbox"],
  ["archive", "archive"],
  ["trash", "trash"],
  ["junk", "junk"],
  ["spam", "junk"],
  ["sent", "sent"],
  ["drafts", "drafts"],
  ["draft", "drafts"],
  ["all", "all"],
]);

const COLUMN = {
  from: "from_text",
  to: "to_text",
  cc: "cc_text",
  subject: "subject_text",
} as const;

export const FTS = "fts_main_message.match_bm25";

function where(
  node: Node,
  params: unknown[],
  terms: string[],
  negated: boolean,
): string {
  const group = (nodes: Node[], op: string, empty: string) =>
    nodes.length === 0
      ? empty
      : `(${nodes.map((n) => where(n, params, terms, negated)).join(` ${op} `)})`;
  switch (node.kind) {
    case "and":
      return group(node.nodes, "AND", "TRUE");
    case "or":
      return group(node.nodes, "OR", "FALSE");
    case "not":
      return `(NOT ${where(node.node, params, terms, !negated)})`;
    case "text": {
      params.push(node.value.toLowerCase());
      if (node.phrase) return "contains(search_text, ?)";
      if (!negated) terms.push(node.value);
      return `(${FTS}(id, ?, conjunctive := 1) IS NOT NULL)`;
    }
    case "field": {
      const value = node.value.toLowerCase();
      if (node.field !== "in") {
        params.push(value);
        return `contains(${COLUMN[node.field]}, ?)`;
      }
      params.push(value, value, ROLES.get(value) ?? null);
      return "id IN (SELECT message FROM placement WHERE lower(path) = ? OR lower(leaf) = ? OR role = ?)";
    }
    case "is":
      return node.value === "unread"
        ? "unread"
        : node.value === "read"
          ? "(NOT unread)"
          : "flagged";
    case "has":
      return "(attachments > 0)";
    case "date":
      params.push(node.at);
      return node.op === "after" ? "(received >= ?)" : "(received < ?)";
  }
}

export function compile(node: Node): Compiled {
  const params: unknown[] = [];
  const terms: string[] = [];
  const sql = where(node, params, terms, false);
  return { where: sql, params, text: terms.length ? terms.join(" ") : null };
}
