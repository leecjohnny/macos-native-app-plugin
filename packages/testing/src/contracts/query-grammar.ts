import { expect, test } from "bun:test";
import fc from "fast-check";
export function testQueryGrammarProperties(parse: (s: string) => unknown) {
  test("parentheses preserve each positive search term", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z]{1,20}$/), (word) =>
        expect(parse("(" + word + ")")).toEqual(parse(word)),
      ),
    );
  });
}
