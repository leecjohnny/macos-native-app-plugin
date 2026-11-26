import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { findBest, readEmlx } from "../src/markdown.ts";
import { emlx } from "./envelope.ts";

const root = mkdtempSync(join(tmpdir(), "emlx-prop-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let serial = 0;
const stash = (bytes: Uint8Array | string) => {
  const file = join(root, `slice-${serial++}.emlx`);
  writeFileSync(file, bytes);
  return file;
};

const encode = (s: string) => new TextEncoder().encode(s);

const message = fc
  .array(
    fc.oneof(
      fc.string({ unit: "grapheme", maxLength: 20 }),
      fc.string({ unit: "binary", maxLength: 8 }),
      fc.constantFrom(
        "\r\n",
        "\n",
        "\r",
        "Subject: café ☃\r\n",
        "\u{1f600}",
        "<?xml",
      ),
    ),
    { maxLength: 20 },
  )
  .map((a) => a.join(""));

describe("readEmlx", () => {
  test("returns exactly the message bytes", async () => {
    await fc.assert(
      fc.asyncProperty(message, async (msg) => {
        expect(await readEmlx(stash(emlx(msg)))).toEqual(encode(msg));
      }),
      { numRuns: 300 },
    );
  });

  test("tolerates padding around the byte count", async () => {
    await fc.assert(
      fc.asyncProperty(
        message,
        fc.stringMatching(/^[ \t]{0,3}$/),
        fc.constantFrom("", " ", "  \r", "\r", "\t"),
        fc.constantFrom("", '<?xml version="1.0"?><plist/>', "123\n"),
        async (msg, lead, trail, plist) => {
          const bytes = encode(msg);
          const file = new Uint8Array([
            ...encode(`${lead}${bytes.length}${trail}\n`),
            ...bytes,
            ...encode(plist),
          ]);
          expect(await readEmlx(stash(file))).toEqual(bytes);
        },
      ),
      { numRuns: 300 },
    );
  });

  test("throws without a leading byte count", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[ \t]*$/),
        fc.string().filter((s) => !/^[ \t]*[0-9]/.test(s)),
        async (lead, rest) => {
          await expect(readEmlx(stash(`${lead}${rest}`))).rejects.toThrow();
        },
      ),
    );
  });
});

const KNOWN = new Map<number, string[]>([
  [1, []],
  [999, []],
  [1000, ["1"]],
  [1999, ["1"]],
  [10_000, ["0", "1"]],
  [264_383, ["4", "6", "2"]],
  [9_876_543, ["6", "7", "8", "9"]],
]);

const digits = (id: number) => {
  const out: string[] = [];
  for (let n = Math.floor(id / 1000); n > 0; n = Math.floor(n / 10))
    out.push(String(n % 10));
  return out;
};

const ACCOUNTS = [
  "AAAAAAAA-0000-4000-8000-000000000001",
  "CCCCCCCC-0000-4000-8000-000000000003",
];

type State = "none" | "partial" | "full" | "both";

const copySpec = fc.record({
  id: fc.oneof(
    fc.constantFrom(...KNOWN.keys()),
    fc.integer({ min: 1, max: 999 }),
    fc.integer({ min: 1000, max: 10_000_000 }),
  ),
  account: fc.constantFrom(...ACCOUNTS),
  path: fc.constantFrom("INBOX", "[Gmail]/All Mail", "Work/Projects 2026"),
  state: fc.constantFrom<State>("none", "partial", "full", "both"),
  fullStore: fc.constantFrom("AAAA-STORE", "STORE-0000", "ZZZZ-STORE"),
  partialStore: fc.constantFrom("AAAA-STORE", "STORE-0000", "ZZZZ-STORE"),
  decoy: fc.boolean(),
  body: message,
});

type Spec = typeof copySpec extends fc.Arbitrary<infer T> ? T : never;

const mbox = (v: string, s: Spec) =>
  join(v, s.account, ...s.path.split("/").map((p) => `${p}.mbox`));

const messagesDir = (v: string, s: Spec, store: string) =>
  join(
    mbox(v, s),
    store,
    "Data",
    ...(KNOWN.get(s.id) ?? digits(s.id)),
    "Messages",
  );

const place = (v: string, s: Spec, store: string, suffix: string) => {
  const dir = messagesDir(v, s, store);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${s.id}${suffix}`);
  writeFileSync(file, emlx(`${suffix}\n${s.body}`));
  return file;
};

const build = (v: string, specs: Spec[]) =>
  specs.map((s) => {
    mkdirSync(mbox(v, s), { recursive: true });
    if (s.decoy) {
      place(v, s, ".Hidden", ".emlx");
      place(v, s, "Child.mbox", ".emlx");
    }
    const partial =
      s.state === "partial" || s.state === "both"
        ? place(v, s, s.partialStore, ".partial.emlx")
        : null;
    const full =
      s.state === "full" || s.state === "both"
        ? place(v, s, s.fullStore, ".emlx")
        : null;
    return { full, partial };
  });

describe("findBest", () => {
  test("a full copy beats a partial one regardless of order", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(copySpec, {
          minLength: 0,
          maxLength: 5,
          selector: (s) => s.id,
        }),
        async (specs) => {
          const dir = mkdtempSync(join(root, "tree-"));
          try {
            const v = join(dir, "V10");
            const placed = build(v, specs);
            const copies = specs.map(({ id, account, path }) => ({
              id,
              account,
              path,
            }));
            for (const [i, c] of copies.entries()) {
              const { full, partial } = placed[i] ?? {};
              const found = await findBest(v, [c]);
              expect(found).toBe(full ?? partial ?? null);
              if (found) {
                const kind = found.endsWith(".partial.emlx")
                  ? ".partial.emlx"
                  : ".emlx";
                expect(new TextDecoder().decode(await readEmlx(found))).toBe(
                  `${kind}\n${specs[i]?.body}`,
                );
              }
            }
            const best = await findBest(v, copies);
            const fulls = placed.flatMap((p) => (p.full ? [p.full] : []));
            const partials = placed.flatMap((p) =>
              p.partial ? [p.partial] : [],
            );
            expect(best).toBe(fulls[0] ?? partials[0] ?? null);
            expect(await findBest(v, copies.toReversed())).toBe(
              fulls.at(-1) ?? partials.at(-1) ?? null,
            );
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});
