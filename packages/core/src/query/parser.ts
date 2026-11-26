import { appendWord } from "./text.ts";
type Leaf = { kind: "field" | "is" | "has" | "date" };
export type Ast<L extends Leaf> =
  | L
  | { kind: "text"; value: string; phrase: boolean }
  | { kind: "not"; node: Ast<L> }
  | { kind: "and" | "or"; nodes: Ast<L>[] };
export class QueryError extends Error {
  override name = "QueryError";
  constructor(
    message: string,
    readonly position?: number,
  ) {
    super(message);
  }
}

export type Token =
  | { t: "lp" | "rp" | "or" | "neg"; pos: number }
  | { t: "phrase"; pos: number; value: string }
  | { t: "word"; pos: number; value: string }
  | { t: "op"; pos: number; name: string; value: string };

export const fail = (msg: string, pos: number): never => {
  throw new QueryError(`${msg} at position ${pos}`, pos);
};

const space = (c: string | undefined) => c !== undefined && /\s/.test(c);
const stop = (c: string | undefined) =>
  c === undefined || space(c) || c === "(" || c === ")" || c === '"';

function quoted(input: string, i: number): [string, number] {
  const end = input.indexOf('"', i + 1);
  if (end < 0) fail("unterminated quote", i);
  return [input.slice(i + 1, end), end + 1];
}

function tokenize(input: string, pattern: RegExp): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (space(c)) {
      i++;
    } else if (c === "(" || c === ")") {
      out.push({ t: c === "(" ? "lp" : "rp", pos: i });
      i++;
    } else if (c === "-") {
      if (stop(input[i + 1]) && input[i + 1] !== "(" && input[i + 1] !== '"')
        fail("dangling '-'", i);
      out.push({ t: "neg", pos: i });
      i++;
    } else if (c === '"') {
      const [value, next] = quoted(input, i);
      if (!value.trim()) fail("empty phrase", i);
      out.push({ t: "phrase", pos: i, value });
      i = next;
    } else {
      const start = i;
      while (!stop(input[i])) i++;
      const word = input.slice(start, i);
      const m = pattern.exec(word);
      if (word === "OR") out.push({ t: "or", pos: start });
      else if (!m || m[1] === "http" || m[1] === "https")
        out.push({ t: "word", pos: start, value: word });
      else if (m[2] === "" && input[i] === '"') {
        const [value, next] = quoted(input, i);
        out.push({ t: "op", pos: start, name: m[1]!, value });
        i = next;
      } else if (m[2] === "" && input[i] === "(") {
        fail(`grouped values are not supported for '${m[1]}:'`, start);
      } else {
        out.push({ t: "op", pos: start, name: m[1]!, value: m[2]! });
      }
    }
  }
  return out;
}

function join<L extends Leaf>(kind: "and" | "or", nodes: Ast<L>[]): Ast<L> {
  const flat = nodes.flatMap((n) => (n.kind === kind ? n.nodes : [n]));
  return flat.length === 1 ? flat[0]! : { kind, nodes: flat };
}

export const MAX_DEPTH = 1000;

export function parseQuery<L extends Leaf>(
  operator: (t: Extract<Token, { t: "op" }>, now: number) => L,
  pattern: RegExp,
  coalesce: boolean,
  input: string,
  now = Math.floor(Date.now() / 1000),
): Ast<L> {
  const toks = tokenize(input, pattern);
  let i = 0;
  const end = input.length;
  const at = () => toks[i]?.pos ?? end;

  const conj = (positive = true): Ast<L> => {
    const nodes: Ast<L>[] = [];
    let previousWord:
      { kind: "text"; value: string; phrase: boolean } | undefined;
    while (i < toks.length && toks[i]!.t !== "rp") {
      const start = i;
      const clause = disj(positive);
      if (
        coalesce &&
        positive &&
        i === start + 1 &&
        toks[start]?.t === "word" &&
        clause.kind === "text"
      ) {
        if (previousWord) {
          appendWord(previousWord, clause.value);
          continue;
        }
        previousWord = clause;
      } else previousWord = undefined;
      nodes.push(clause);
    }
    return join("and", nodes);
  };
  const disj = (positive: boolean): Ast<L> => {
    if (toks[i]?.t === "or") fail("unexpected OR", at());
    const nodes = [unary(positive)];
    while (toks[i]?.t === "or") {
      i++;
      const next = toks[i]?.t;
      if (next === undefined || next === "rp" || next === "or")
        fail("OR needs a right operand", at());
      nodes.push(unary(positive));
    }
    return join("or", nodes);
  };
  let depth = 0;
  const nest = <T>(pos: number, f: () => T): T => {
    if (++depth > MAX_DEPTH) fail(`nesting deeper than ${MAX_DEPTH}`, pos);
    const r = f();
    depth--;
    return r;
  };
  const unary = (positive: boolean): Ast<L> => {
    const tok = toks[i++];
    if (!tok) return fail("unexpected end of query", end);
    if (tok.t === "neg")
      return { kind: "not", node: nest(tok.pos, () => unary(!positive)) };
    if (tok.t === "lp") {
      if (toks[i]?.t === "rp") fail("empty group", tok.pos);
      const node = nest(tok.pos, () => conj(positive));
      if (toks[i]?.t !== "rp") fail("unbalanced '('", tok.pos);
      i++;
      return node;
    }
    if (tok.t === "word")
      return { kind: "text", value: tok.value, phrase: false };
    if (tok.t === "phrase")
      return { kind: "text", value: tok.value, phrase: true };
    if (tok.t === "op") return operator(tok, now);
    return fail(tok.t === "rp" ? "unbalanced ')'" : "unexpected OR", tok.pos);
  };

  const node = conj();
  if (i < toks.length) fail("unbalanced ')'", at());
  return node;
}
