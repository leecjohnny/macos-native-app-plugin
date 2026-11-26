import { afterAll, describe, expect, test } from "bun:test";
import fc from "fast-check";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findComments } from "@macos-native-app/toolkit/lint-osa";

const repo = join(import.meta.dir, "../../../..");
const slash = "/";
const star = "*";
const dash = "-";
const hash = "#";
const open = `(${star}`;
const close = `${star})`;

const program = (strings: string[]) =>
  strings.map((s, i) => `export const v${i} = "${s}";`);
const oxlint = (file: string) =>
  Bun.spawnSync(
    [
      join(repo, "node_modules/.bin/oxlint"),
      "-c",
      join(repo, ".oxlintrc.json"),
      file,
    ],
    { cwd: repo },
  );
const reported = (file: string) => {
  const result = oxlint(file);
  return {
    code: result.exitCode,
    count: result.stdout.toString().match(/no-comments/g)?.length ?? 0,
  };
};

const newlines = (text: string) => text.split(/\r\n?|\n/).length - 1;
export function testLintContract() {
  const dir = mkdtempSync(join(tmpdir(), "macos-mail-lint-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name: string, text: string) => {
    const file = join(dir, name);
    writeFileSync(file, text);
    return file;
  };
  let serial = 0;

  describe("no-comments oxlint plugin", () => {
    test("fails on line and block comments", () => {
      const file = write(
        "bad.ts",
        [
          "export const a = 1",
          `${slash}${slash} line`,
          `${slash}${star} block ${star}${slash}`,
          "",
        ].join("\n"),
      );
      const result = oxlint(file);
      expect(result.exitCode).toBe(1);
      expect(result.stdout.toString().match(/no-comments/g)?.length).toBe(2);
    });

    test("allows a shebang but still flags comments after it", () => {
      const shebang = `${hash}!/usr/bin/env bun`;
      expect(
        oxlint(write("bin.ts", `${shebang}\nexport const a = 1\n`)).exitCode,
      ).toBe(0);
      const result = oxlint(
        write(
          "bin-bad.ts",
          `${shebang}\n${slash}${slash} x\nexport const a = 1\n`,
        ),
      );
      expect(result.stdout.toString().match(/no-comments/g)?.length).toBe(1);
    });

    test("passes clean code with slashes in strings", () => {
      const file = write(
        "good.ts",
        `export const url = "https:${slash}${slash}example.com"\n`,
      );
      expect(oxlint(file).exitCode).toBe(0);
    });

    const tsText = fc
      .array(
        fc.constantFrom(
          "a",
          " ",
          "x1",
          `${slash}${slash}`,
          `${slash}${star}`,
          `${star}${slash}`,
          hash,
          `${dash}${dash}`,
          "'",
          "`",
        ),
        { maxLength: 8 },
      )
      .map((parts) => parts.join(""));
    const tsProgram = fc.array(tsText, { minLength: 1, maxLength: 6 });
    const tsComment = fc.oneof(
      fc.stringMatching(/^[a-z ]{0,10}$/).map((t) => `${slash}${slash}${t}`),
      fc
        .stringMatching(/^[a-z \n]{0,10}$/)
        .map((t) => `${slash}${star}${t}${star}${slash}`),
    );

    test("markers inside strings pass", () => {
      fc.assert(
        fc.property(tsProgram, (strings) => {
          const file = write(
            `clean-${serial++}.ts`,
            `${program(strings).join("\n")}\n`,
          );
          expect(reported(file)).toEqual({ code: 0, count: 0 });
        }),
        { numRuns: 20 },
      );
    }, 60_000);

    test("one generated comment anywhere fails once", () => {
      fc.assert(
        fc.property(
          tsProgram,
          tsComment,
          fc.nat(),
          fc.boolean(),
          (strings, comment, at, trailing) => {
            const lines = program(strings);
            const k = at % (lines.length + 1);
            if (trailing && k < lines.length)
              lines[k] = `${lines[k]} ${comment}`;
            else lines.splice(k, 0, comment);
            const file = write(
              `comment-${serial++}.ts`,
              `${lines.join("\n")}\n`,
            );
            expect(reported(file)).toEqual({ code: 1, count: 1 });
          },
        ),
        { numRuns: 20 },
      );
    }, 60_000);
  });

  const UNSAFE = new Set(["tell", "app", "using", "terms", "script", "run"]);
  const word = fc
    .stringMatching(/^[a-z][a-z0-9_]{0,6}$/)
    .filter((w) => !UNSAFE.has(w));
  const number = fc.nat({ max: 9999 }).map(String);
  const punct = fc.constantFrom(
    "+",
    slash,
    "&",
    "=",
    "<",
    ">",
    ",",
    ":",
    "(",
    ")",
    "{",
    "}",
    ".",
  );
  const markers = [`${dash}${dash}`, hash, open, close, dash, star, "("];
  const quoted = fc
    .array(
      fc.constantFrom(
        "a",
        " ",
        "|",
        "«",
        "»",
        '\\"',
        "\\\\",
        "\\n",
        "\n",
        "\r\n",
        "\r",
        ...markers,
      ),
      { maxLength: 8 },
    )
    .map((parts) => `"${parts.join("")}"`);
  const piped = fc
    .array(fc.constantFrom("a", " ", '"', "«", ...markers), { maxLength: 6 })
    .map((parts) => `|${parts.join("")}|`);
  const raw = fc
    .array(fc.constantFrom("a", " ", '"', "|", ...markers), { maxLength: 6 })
    .map((parts) => `«${parts.join("")}»`);
  const token = fc.oneof(word, number, punct, quoted, piped, raw);
  const segment = fc
    .array(token, { maxLength: 6 })
    .map((tokens) => tokens.join(" "));
  const ending = fc.constantFrom("\n", "\r\n", "\r");

  const lineText = fc
    .array(fc.constantFrom("a", " ", '"', "|", "«", "»", ...markers), {
      maxLength: 6,
    })
    .map((parts) => parts.join(""));
  const { block } = fc.letrec<{ block: string; body: string }>((tie) => ({
    block: fc
      .array(tie("body"), { maxLength: 4 })
      .map((parts) => `${open}${parts.join("")}${close}`),
    body: fc.oneof(
      { depthSize: "small", withCrossShrink: true },
      fc.constantFrom(
        "a",
        " ",
        '"',
        "|",
        "«",
        hash,
        `${dash}${dash}`,
        ")",
        "\n",
        "\r\n",
        "\r",
      ),
      tie("block"),
    ),
  }));
  const comment = fc.oneof(
    lineText.map((t) => `${dash}${dash}${t}`),
    lineText.map((t) => `${hash}${t}`),
    block,
  );

  const NOTE = "Comments are not allowed.";

  const osa = (texts: string[]) => {
    const sub = mkdtempSync(join(dir, "osa-"));
    const files = texts.map((text, i) => {
      const file = join(sub, `case-${i}.applescript`);
      writeFileSync(file, text);
      return file;
    });
    const result = Bun.spawnSync(
      [process.execPath, join(repo, "packages/toolkit/src/lint-osa.ts"), sub],
      { cwd: repo },
    );
    const problems = result.stderr
      .toString()
      .split("\n")
      .flatMap((l) => {
        const m = /^(.*\.applescript):(\d+): (.*)$/.exec(l);
        return m ? [{ file: m[1], line: Number(m[2]), message: m[3] }] : [];
      });
    return {
      code: result.exitCode,
      summary: result.stdout.toString().trim(),
      files,
      problems,
      comments: (file: string | undefined) =>
        problems
          .filter((p) => p.file === file && p.message === NOTE)
          .map((p) => p.line),
    };
  };

  describe("AppleScript lint", () => {
    test("reports every comment form on its line", () => {
      const run = osa([
        [
          "on run argv",
          `${dash}${dash} a`,
          `${hash} b`,
          `${open} c ${close}`,
          "return 1",
          "end run",
          "",
        ].join("\n"),
      ]);
      expect(run.code).toBe(1);
      expect(run.comments(run.files[0])).toEqual([2, 3, 4]);
      expect(run.problems).toHaveLength(3);
    });

    test("ignores comment markers inside strings and pipes", () => {
      const run = osa([
        `on run argv\nset a to "${dash}${dash} ${hash} ${open}"\nset |b${dash}${dash}c| to 1\nreturn a\nend run\n`,
      ]);
      expect(run).toMatchObject({
        code: 0,
        problems: [],
        summary: "1 AppleScript files, 0 problems",
      });
    });

    test("fails a script that does not compile", () => {
      const run = osa(["on run argv\nreturn (1 +\nend run\n"]);
      expect(run.code).toBe(1);
      expect(run.problems).toHaveLength(1);
      expect(run.problems[0]?.line).toBe(2);
      expect(run.summary).toBe("1 AppleScript files, 1 problems");
    });

    test("passes a clean script", () => {
      const run = osa(["on run argv\nreturn item 1 of argv\nend run\n"]);
      expect(run).toMatchObject({
        code: 0,
        problems: [],
        summary: "1 AppleScript files, 0 problems",
      });
    });

    test("markers only inside strings, pipes and chevrons are not comments", () => {
      fc.assert(
        fc.property(
          fc.array(fc.tuple(fc.array(segment), ending), {
            minLength: 1,
            maxLength: 8,
          }),
          (cases) => {
            for (const [segments, end] of cases)
              expect(findComments(segments.join(end))).toEqual([]);
          },
        ),
        { numRuns: 20 },
      );
    }, 60_000);

    test("each inserted comment is reported on its line", () => {
      const sample = fc.tuple(
        fc.array(fc.tuple(segment, fc.option(comment, { nil: undefined })), {
          minLength: 1,
        }),
        ending,
      );
      fc.assert(
        fc.property(
          fc.array(sample, { minLength: 1, maxLength: 8 }),
          (cases) => {
            const built = cases.map(([lines, end]) => {
              let text = "";
              const expected: number[] = [];
              lines.forEach(([code, note], i) => {
                if (i > 0) text += end;
                text += code;
                if (note === undefined) return;
                expected.push(newlines(text) + 1);
                text += ` ${note}`;
              });
              return { text, expected };
            });
            for (const { text, expected } of built)
              expect(findComments(text)).toEqual(expected);
          },
        ),
        { numRuns: 20 },
      );
    }, 60_000);
  });
  test("Swift syntax and comment gates", () => {
    for (const [i, source] of [
      'print("https://example.org")',
      "print(1) // disabled",
      "/* disabled */ print(1)",
      "let =",
    ].entries()) {
      const p = write("fixture.swift", source);
      expect(
        Bun.spawnSync([
          process.execPath,
          join(repo, "packages/toolkit/src/lint-swift.ts"),
          p,
        ]).exitCode,
      ).toBe(i === 0 ? 0 : 1);
    }
  }, 60000);
  test("TypeScript syntax gate", () =>
    expect(oxlint(write("syntax.ts", "export const =")).exitCode).toBe(1));
  test("Swift raw and interpolated strings distinguish comments and literal markers", async () => {
    const { commentOffsets } =
      await import("@macos-native-app/toolkit/lint-swift");
    expect(commentOffsets('let x = ##"abc " // /* xyz"##')).toHaveLength(0);
    expect(
      commentOffsets('let x = "value \\(1 /* inserted */ + 2)"'),
    ).toHaveLength(1);
  });
}
