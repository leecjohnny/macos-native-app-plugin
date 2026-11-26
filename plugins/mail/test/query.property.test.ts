import { compile as compileSchema } from "@earendil-works/pi-schema";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { role } from "../src/accounts.ts";
import {
  compile,
  type Field,
  MAX_DEPTH,
  type Node,
  parse,
  QueryError,
} from "../src/query.ts";
import { TOOLS } from "../src/tools.ts";

const NOW = 1_800_000_000;
const UNIT = { d: 86400, w: 7 * 86400, m: 30 * 86400, y: 365 * 86400 };
const FIELDS: Field[] = ["from", "to", "cc", "subject", "in"];
const KNOWN = new globalThis.Set([
  ...FIELDS,
  "is",
  "has",
  "after",
  "before",
  "older_than",
  "newer_than",
  "http",
  "https",
]);

type Src =
  | { kind: "text"; value: string; phrase: boolean }
  | { kind: "field"; field: Field; value: string; phrase: boolean }
  | { kind: "is"; spelling: string }
  | { kind: "has"; spelling: string }
  | { kind: "date"; text: string; node: Node }
  | { kind: "not"; node: Src }
  | { kind: "and" | "or"; nodes: Src[] };

const word = fc.oneof(
  fc
    .stringMatching(/^[A-Za-z0-9][A-Za-z0-9.@_-]{0,8}$/)
    .filter((w) => w !== "OR"),
  fc.constantFrom("http://x.com", "https://x.com/a", "10:30", "Re:hello"),
);
const bare = fc.stringMatching(/^[^\s()"]{1,10}$/);
const phrase = fc
  .string({ minLength: 1, maxLength: 12 })
  .filter((s) => !s.includes('"') && s.trim() !== "");

const local = (y: number, m: number, d: number) =>
  Math.floor(new Date(y, m - 1, d).getTime() / 1000);
const pad = (n: number, width: number, on: boolean) =>
  on ? String(n).padStart(width, "0") : String(n);

const day = fc
  .date({
    min: new Date(1000, 0, 1),
    max: new Date(9999, 11, 31),
    noInvalidDate: true,
  })
  .map((d) => ({ y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() }));

const dayText = fc
  .tuple(day, fc.constantFrom("-", "/"), fc.boolean())
  .map(
    ([{ y, m, d }, sep, padded]) =>
      [
        `${y}${sep}${pad(m, 2, padded)}${sep}${pad(d, 2, padded)}`,
        local(y, m, d),
      ] as const,
  );

const unit = fc.constantFrom("d", "w", "m", "y") as fc.Arbitrary<
  keyof typeof UNIT
>;

const leaf: fc.Arbitrary<Src> = fc.oneof(
  fc.record({
    kind: fc.constant("text" as const),
    value: word,
    phrase: fc.constant(false),
  }),
  fc.record({
    kind: fc.constant("text" as const),
    value: phrase,
    phrase: fc.constant(true),
  }),
  fc.record({
    kind: fc.constant("field" as const),
    field: fc.constantFrom(...FIELDS),
    value: bare,
    phrase: fc.constant(false),
  }),
  fc.record({
    kind: fc.constant("field" as const),
    field: fc.constantFrom(...FIELDS),
    value: phrase,
    phrase: fc.constant(true),
  }),
  fc.record({
    kind: fc.constant("is" as const),
    spelling: fc.mixedCase(
      fc.constantFrom("unread", "read", "flagged", "starred"),
    ),
  }),
  fc.record({
    kind: fc.constant("has" as const),
    spelling: fc.mixedCase(fc.constant("attachment")),
  }),
  fc
    .tuple(
      fc.constantFrom("after", "before") as fc.Arbitrary<"after" | "before">,
      dayText,
    )
    .map(([op, [text, at]]): Src => ({
      kind: "date",
      text: `${op}:${text}`,
      node: { kind: "date", op, at },
    })),
  fc
    .tuple(
      fc.constantFrom("older_than", "newer_than"),
      fc.nat({ max: 100000 }),
      unit,
      fc.boolean(),
    )
    .map(([name, n, u, upper]): Src => ({
      kind: "date",
      text: `${name}:${n}${upper ? u.toUpperCase() : u}`,
      node: {
        kind: "date",
        op: name === "older_than" ? "before" : "after",
        at: NOW - n * UNIT[u],
      },
    })),
);

const { tree } = fc.letrec<{ tree: Src }>((tie) => ({
  tree: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    leaf,
    fc.record({ kind: fc.constant("not" as const), node: tie("tree") }),
    fc.record({
      kind: fc.constantFrom("and" as const, "or" as const),
      nodes: fc.array(tie("tree"), { minLength: 2, maxLength: 4 }),
    }),
  ),
}));

const group = (s: Src): string =>
  s.kind === "and" || s.kind === "or" ? `(${print(s)})` : print(s);

function print(s: Src): string {
  switch (s.kind) {
    case "text":
      return s.phrase ? `"${s.value}"` : s.value;
    case "field":
      return s.phrase ? `${s.field}:"${s.value}"` : `${s.field}:${s.value}`;
    case "is":
      return `is:${s.spelling}`;
    case "has":
      return `has:${s.spelling}`;
    case "date":
      return s.text;
    case "not":
      return `-${group(s.node)}`;
    case "and":
      return s.nodes.map(group).join(" ");
    case "or":
      return s.nodes.map(group).join(" OR ");
  }
}

function expected(s: Src): Node {
  switch (s.kind) {
    case "text":
      return { kind: "text", value: s.value, phrase: s.phrase };
    case "field":
      return { kind: "field", field: s.field, value: s.value };
    case "is": {
      const v = s.spelling.toLowerCase();
      return { kind: "is", value: v === "starred" ? "flagged" : (v as "read") };
    }
    case "has":
      return { kind: "has", value: "attachment" };
    case "date":
      return s.node;
    case "not":
      return { kind: "not", node: expected(s.node) };
    case "and":
    case "or": {
      const kind = s.kind;
      const flat = s.nodes
        .map(expected)
        .flatMap((n) => (n.kind === kind ? n.nodes : [n]));
      return flat.length === 1 ? flat[0]! : { kind, nodes: flat };
    }
  }
}

const t = (value: string): Node => ({ kind: "text", value, phrase: false });
const key = (text: string) =>
  text
    .split(/[-/]/)
    .map((x) => Number(x).toString().padStart(4, "0"))
    .join("");

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, ks: string[]) =>
  Object.keys(v).toSorted().join() === ks.toSorted().join();

function valid(n: unknown, root = false): boolean {
  if (!isRecord(n)) return false;
  switch (n.kind) {
    case "text":
      return (
        keys(n, ["kind", "value", "phrase"]) &&
        typeof n.value === "string" &&
        typeof n.phrase === "boolean" &&
        n.value.trim() !== "" &&
        (n.phrase ? !n.value.includes('"') : !/[\s()"]/.test(n.value))
      );
    case "field":
      return (
        keys(n, ["kind", "field", "value"]) &&
        (FIELDS as unknown[]).includes(n.field) &&
        typeof n.value === "string" &&
        n.value.trim() !== ""
      );
    case "is":
      return (
        keys(n, ["kind", "value"]) &&
        ["unread", "read", "flagged"].includes(n.value as string)
      );
    case "has":
      return keys(n, ["kind", "value"]) && n.value === "attachment";
    case "date":
      return (
        keys(n, ["kind", "op", "at"]) &&
        (n.op === "after" || n.op === "before") &&
        Number.isSafeInteger(n.at)
      );
    case "not":
      return keys(n, ["kind", "node"]) && valid(n.node);
    case "and":
    case "or": {
      const kind = n.kind;
      const nodes = n.nodes;
      return (
        keys(n, ["kind", "nodes"]) &&
        Array.isArray(nodes) &&
        (nodes.length >= 2 || (root && kind === "and" && nodes.length === 0)) &&
        nodes.every((c) => isRecord(c) && c.kind !== kind && valid(c))
      );
    }
    default:
      return false;
  }
}

const outcome = (input: string): Node | QueryError => {
  try {
    return parse(input, NOW);
  } catch (e) {
    if (e instanceof QueryError) return e;
    throw e;
  }
};

const fragment = fc.constantFrom(
  " ",
  "\t",
  "(",
  ")",
  '"',
  "-",
  ":",
  "OR",
  "or",
  "a",
  "Bob",
  "from:",
  "subject:",
  "in:",
  "is:",
  "unread",
  "starred",
  "has:",
  "attachment",
  "after:",
  "before:",
  "2024-02-29",
  "2026/13/01",
  "older_than:",
  "newer_than:",
  "3d",
  "2Y",
  "x",
  "label:",
  "http:",
  "https://x",
  "__proto__",
  "constructor",
);
const query = fc.oneof(
  fc.string({ maxLength: 40 }),
  fc.string({ unit: "grapheme", maxLength: 20 }),
  fc.array(fragment, { maxLength: 15 }).map((a) => a.join("")),
  tree.map(print),
);

describe("parse", () => {
  test("any string yields a valid Node or a QueryError", () => {
    fc.assert(
      fc.property(query, (input) => {
        const r = outcome(input);
        if (!(r instanceof QueryError)) expect(valid(r, true)).toBe(true);
      }),
    );
  });

  test("moderately deep nesting parses", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 500 }), word, (n, w) => {
        expect(parse(`${"(".repeat(n)}${w}${")".repeat(n)}`)).toEqual({
          kind: "text",
          value: w,
          phrase: false,
        });
        let node: Node = { kind: "text", value: w, phrase: false };
        for (let i = 0; i < n; i++) node = { kind: "not", node };
        expect(parse(`${"-".repeat(n)}${w}`)).toEqual(node);
      }),
    );
  });

  test("whitespace-only queries match everything", () => {
    fc.assert(
      fc.property(
        fc
          .array(fc.constantFrom(" ", "\t", "\n", "\r", " "))
          .map((a) => a.join("")),
        (input) => {
          expect(parse(input)).toEqual({ kind: "and", nodes: [] });
        },
      ),
    );
  });

  test("printed ASTs round-trip to their normal form", () => {
    fc.assert(
      fc.property(tree, (s) => {
        expect(parse(print(s), NOW)).toEqual(expected(s));
      }),
    );
  });

  test("OR binds tighter than juxtaposition", () => {
    fc.assert(
      fc.property(word, word, word, (a, b, c) => {
        expect(parse(`${a} ${b} OR ${c}`)).toEqual({
          kind: "and",
          nodes: [t(a), { kind: "or", nodes: [t(b), t(c)] }],
        });
        expect(parse(`${a} OR ${b} ${c}`)).toEqual({
          kind: "and",
          nodes: [{ kind: "or", nodes: [t(a), t(b)] }, t(c)],
        });
        expect(parse(`${a}"${b} ${c}"${a}`)).toEqual({
          kind: "and",
          nodes: [
            t(a),
            { kind: "text", value: `${b} ${c}`, phrase: true },
            t(a),
          ],
        });
        expect(parse(`${a} or ${b}`)).toEqual({
          kind: "and",
          nodes: [t(a), t("or"), t(b)],
        });
      }),
    );
  });

  test("malformed syntax around a valid query throws QueryError", () => {
    fc.assert(
      fc.property(tree, (s) => {
        const q = print(s);
        const n = q.length;
        const cases: [string, string][] = [
          [`${q} )`, `unbalanced ')' at position ${n + 1}`],
          [`( ${q}`, "unbalanced '(' at position 0"],
          [`OR ${q}`, "unexpected OR at position 0"],
          [`${q} OR`, "OR needs a right operand"],
          [`${q} OR OR x`, "OR needs a right operand"],
          [`(${q} OR) x`, "OR needs a right operand"],
          [`${q} -`, `dangling '-' at position ${n + 1}`],
          [`${q} - x`, `dangling '-' at position ${n + 1}`],
          [`${q} "x`, `unterminated quote at position ${n + 1}`],
          [`${q} ""`, `empty phrase at position ${n + 1}`],
          [`${q} ()`, `empty group at position ${n + 1}`],
          [`${q} from:`, `empty value for 'from:' at position ${n + 1}`],
          [`${q} from: x`, `empty value for 'from:' at position ${n + 1}`],
          [`${q} from:""`, `empty value for 'from:' at position ${n + 1}`],
          [`${q} from:(a)`, "grouped values are not supported for 'from:'"],
          [`${q} -OR x`, "unexpected OR"],
        ];
        for (const [input, message] of cases) {
          expect(() => parse(input, NOW)).toThrow(QueryError);
          expect(() => parse(input, NOW)).toThrow(message);
        }
      }),
    );
  });

  test("-X negates parse(X)", () => {
    fc.assert(
      fc.property(tree, (s) => {
        expect(parse(`-${group(s)}`, NOW)).toEqual({
          kind: "not",
          node: parse(print(s), NOW),
        });
      }),
    );
  });

  test("relative dates count back from now", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("older_than", "newer_than"),
        fc.nat({ max: 1_000_000 }),
        unit,
        fc.integer({ min: 0, max: 4_000_000_000 }),
        (name, n, u, now) => {
          expect(parse(`${name}:${n}${u}`, now)).toEqual({
            kind: "date",
            op: name === "older_than" ? "before" : "after",
            at: now - n * UNIT[u],
          });
        },
      ),
    );
  });

  test("absolute dates are local midnight and monotonic", () => {
    fc.assert(
      fc.property(dayText, dayText, ([ta, a], [tb]) => {
        const pa = parse(`after:${ta}`);
        const pb = parse(`after:${tb}`);
        expect(pa).toEqual({ kind: "date", op: "after", at: a });
        expect(parse(`before:${ta}`)).toEqual({
          kind: "date",
          op: "before",
          at: a,
        });
        if (pa.kind !== "date" || pb.kind !== "date")
          throw new Error("not a date");
        expect(Math.sign(pa.at - pb.at)).toBe(
          Math.sign(key(ta).localeCompare(key(tb))),
        );
      }),
    );
  });

  test("invalid calendar dates are rejected", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1000, max: 9999 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 29, max: 99 }),
        (y, m, d) => {
          fc.pre(d > new Date(y, m, 0).getDate());
          expect(() => parse(`after:${y}-${m}-${d}`)).toThrow(QueryError);
        },
      ),
    );
  });

  test("unknown operators throw QueryError", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z_]{1,12}$/).filter((n) => !KNOWN.has(n)),
        fc.oneof(
          bare,
          phrase.map((p) => `"${p}"`),
        ),
        fc.option(word, { nil: undefined }),
        (name, value, before) => {
          const input =
            before === undefined
              ? `${name}:${value}`
              : `${before} ${name}:${value}`;
          const pos = before === undefined ? 0 : before.length + 1;
          expect(() => parse(input)).toThrow(QueryError);
          expect(() => parse(input)).toThrow(
            `unknown operator '${name}:' at position ${pos}`,
          );
        },
      ),
    );
  });

  test("invalid is:, has: and relative values throw QueryError", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("is", "has", "older_than", "newer_than"),
        fc.oneof(
          bare,
          fc.mixedCase(fc.constantFrom("__proto__", "constructor")),
        ),
        (name, value) => {
          const ok =
            name === "is"
              ? ["unread", "read", "flagged", "starred"].includes(
                  value.toLowerCase(),
                )
              : name === "has"
                ? value.toLowerCase() === "attachment"
                : /^\d+[dwmy]$/.test(value.toLowerCase());
          fc.pre(!ok);
          expect(() => parse(`${name}:${value}`)).toThrow(QueryError);
        },
      ),
    );
  });
});

function terms(n: Node, negated = false): string[] {
  switch (n.kind) {
    case "text":
      return n.phrase || negated ? [] : [n.value];
    case "not":
      return terms(n.node, !negated);
    case "and":
    case "or":
      return n.nodes.flatMap((c) => terms(c, negated));
    default:
      return [];
  }
}

const ROLE_WORDS = [
  "inbox",
  "archive",
  "trash",
  "junk",
  "spam",
  "sent",
  "drafts",
  "draft",
  "all",
];
const PROTO = [
  "constructor",
  "__proto__",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "__defineGetter__",
];
const scalar = (v: unknown) =>
  v === null || typeof v === "string" || typeof v === "number";

describe("compile", () => {
  test("only unnegated bare words are BM25 terms, never phrases", () => {
    fc.assert(
      fc.property(tree, (s) => {
        const node = parse(print(s), NOW);
        const want = terms(node);
        expect(compile(node).text).toBe(want.length ? want.join(" ") : null);
      }),
    );
  });

  test("params are SQL scalars and in: roles come only from own keys", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.mixedCase(fc.constantFrom(...PROTO, ...ROLE_WORDS)), bare),
        (value) => {
          const c = compile(parse(`in:${value}`, NOW));
          expect(c.params.every(scalar)).toBe(true);
          const v = value.toLowerCase();
          const known = ROLE_WORDS.includes(v);
          expect(c.params[2] === null).toBe(!known);
        },
      ),
    );
    fc.assert(
      fc.property(tree, (s) => {
        expect(compile(parse(print(s), NOW)).params.every(scalar)).toBe(true);
      }),
    );
  });

  test("mailbox roles never come from the prototype chain", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.mixedCase(fc.constantFrom(...PROTO)), bare),
        fc.constantFrom("", "[Gmail]/", "Parent/"),
        (name, prefix) => {
          const r = role(`${prefix}${name}`, 0);
          expect(
            r === null ||
              [
                "inbox",
                "archive",
                "trash",
                "junk",
                "sent",
                "drafts",
                "all",
              ].includes(r),
          ).toBe(true);
          if (PROTO.includes(name)) expect(r).toBeNull();
        },
      ),
    );
  });
});

const opt = <T>(a: fc.Arbitrary<T>) => fc.option(a, { nil: undefined });
const defined = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const id = fc.string({ minLength: 1 });
const queryIn = fc
  .record({
    query: opt(fc.string()),
    limit: opt(fc.integer({ min: 1, max: 100 })),
    offset: opt(fc.nat()),
  })
  .map(defined);
const INPUTS: Record<string, fc.Arbitrary<Record<string, unknown>>> = {
  search_messages: queryIn,
  search_conversations: queryIn,
  fetch_message: fc
    .record({ id, max_tokens: opt(fc.integer({ min: 64, max: 100000 })) })
    .map(defined),
  fetch_conversation: fc
    .record({ id, max_tokens: opt(fc.integer({ min: 64, max: 100000 })) })
    .map(defined),
  fetch_mailboxes: fc.constant({}),
  execute_sql: fc
    .record({ sql: id, max_rows: opt(fc.integer({ min: 1, max: 1000 })) })
    .map(defined),
  set_messages: fc
    .record({
      ids: fc.array(id, { minLength: 1, maxLength: 100 }),
      read: opt(fc.boolean()),
      flagged: opt(fc.boolean()),
    })
    .map(defined),
};

test("tool inputs reject unknown keys", () => {
  for (const tool of TOOLS) {
    const input = INPUTS[tool.name];
    if (!input) throw new Error(`no input generator for ${tool.name}`);
    const schema = compileSchema(tool.input);
    const known = Object.keys(
      (tool.input as { properties?: object }).properties ?? {},
    );
    fc.assert(
      fc.property(
        input,
        fc.stringMatching(/^[a-z_]{1,10}$/).filter((k) => !known.includes(k)),
        (v, k) => {
          expect(schema.check(v)).toBe(true);
          expect(schema.errors({ ...v, [k]: 1 }).map((e) => e.path)).toContain(
            `/${k}`,
          );
        },
      ),
    );
  }
});

test("nesting past MAX_DEPTH is a QueryError, never a stack overflow", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: MAX_DEPTH + 1, max: 50000 }),
      fc.constantFrom("paren", "neg"),
      (n, shape) => {
        const q =
          shape === "paren"
            ? `${"(".repeat(n)}a${")".repeat(n)}`
            : `${"-".repeat(n)}a`;
        expect(() => parse(q)).toThrow(QueryError);
      },
    ),
    { numRuns: 20 },
  );
});

import { testQueryGrammarProperties } from "@macos-native-app/testing/contracts/query-grammar";
testQueryGrammarProperties(parse);
