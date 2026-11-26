import { expect, test } from "bun:test";
import fc from "fast-check";
import { parse, compile, QueryError } from "../src/query.ts";
test("structured Boolean expressions never call Photos", async () => {
  const field = fc.constantFrom(
    "is:favorite",
    "near:-35,120,20",
    "before:2020/01/01",
    'filename:"a\'b"',
    "longer:1s",
    "place:青空",
    "has:ocr",
    "newer_than:1w",
  );
  await fc.assert(
    fc.asyncProperty(
      fc.array(field, { minLength: 1, maxLength: 12 }),
      async (fields) => {
        const clauses = fields.map((f, i) => (i % 2 ? "-(" + f + ")" : f));
        const result = await compile(
          parse(clauses.join(" OR ")),
          async () => {
            throw Error("Unexpected search");
          },
          [],
        );
        expect(result).toBeTruthy();
      },
    ),
  );
});
test("invalid operator values fail during parsing", () => {
  for (const value of [
    "is:unknown",
    "has:fish",
    "Foo:abc",
    "near:181,0,1",
    "near:1,,2",
    "larger:1m",
    "shorter:xx",
    "before:2025/02/29",
    "older_than:NaN",
    'unclosed:"abc',
  ])
    expect(() => parse(value)).toThrow(QueryError);
});
test("adjacent words share a Photos search and clause boundaries survive", async () => {
  for (const [input, expected] of [
    ["ramen in tokyo", ["ramen in tokyo"]],
    ["ramen in tokyo is:video", ["ramen in tokyo"]],
    [
      'ramen "in tokyo" -night (late lunch) today',
      ["ramen", "in tokyo", "night", "late lunch", "today"],
    ],
    ["(red sky) OR (blue lake)", ["red sky", "blue lake"]],
  ] as const) {
    const calls: string[] = [];
    await compile(
      parse(input),
      async (text) => {
        calls.push(text);
        return [];
      },
      [],
    );
    expect(calls).toEqual([...expected]);
  }
});

import { testQueryGrammarProperties } from "@macos-native-app/testing/contracts/query-grammar";
testQueryGrammarProperties(parse);
