import { afterAll, describe, expect, test } from "bun:test";
import fc from "fast-check";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ATTR,
  readAccounts,
  type Role,
  role,
  versionDir,
} from "../src/accounts.ts";
import {
  type CopyRef,
  type MailboxRef,
  type Runner,
  setMessages,
} from "../src/mail.ts";
import type { SetInput, SetOutcome } from "../src/schema.ts";
import { buildFixture, GMAIL, ICLOUD, MAILBOXES, WORK } from "./envelope.ts";

const BARE = "DDDDDDDD-0000-4000-8000-000000000004";
const TWO = "EEEEEEEE-0000-4000-8000-000000000005";
const GBAD = "FFFFFFFF-0000-4000-8000-000000000006";
const LOST = "99999999-0000-4000-8000-000000000007";
const SCRIPT = "/fake/set.applescript";
const HAS_CHILDREN = 32;
const HAS_NO_CHILDREN = 64;

const fixture = buildFixture();
const scratch = mkdtempSync(join(tmpdir(), "macos-mail-accounts-"));
afterAll(() => {
  rmSync(fixture.root, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});
const accounts = await readAccounts(versionDir(fixture.root));
accounts.set(BARE, {
  id: BARE,
  gmail: false,
  attrs: new Map([["INBOX", HAS_NO_CHILDREN]]),
});
accounts.set(TWO, {
  id: TWO,
  gmail: false,
  attrs: new Map([
    ["INBOX", 0],
    ["Archive A", ATTR.archive],
    ["Old/Archive", ATTR.archive],
  ]),
});
accounts.set(GBAD, {
  id: GBAD,
  gmail: true,
  attrs: new Map([
    ["INBOX", 0],
    ["[Gmail]/Trash", ATTR.trash],
  ]),
});

const ARCHIVE: Record<string, { path: string; create: boolean }> = {
  [GMAIL]: { path: "[Gmail]/All Mail", create: false },
  [ICLOUD]: { path: "Archive", create: false },
  [WORK]: { path: "Archives/2026", create: false },
  [BARE]: { path: "Archive", create: true },
};
const BROKEN = [TWO, GBAD];
const ACCOUNT_IDS = [GMAIL, ICLOUD, WORK, BARE, TWO, GBAD, LOST];
const pathsOf = (id: string) =>
  id === LOST
    ? ["INBOX", "Stuff"]
    : [...(accounts.get(id)?.attrs.keys() ?? [])];
const ALL_PATHS = new Set(ACCOUNT_IDS.flatMap(pathsOf));

const BOXES = new Map<number, MailboxRef>([
  ...MAILBOXES.map((b): [number, MailboxRef] => [
    b.id,
    { account: b.account, path: b.path },
  ]),
  [20, { account: BARE, path: "INBOX" }],
  [21, { account: TWO, path: "Archive A" }],
  [22, { account: GBAD, path: "[Gmail]/Trash" }],
  [23, { account: LOST, path: "Stuff" }],
]);
const OPS = new Set([
  "read",
  "flagged",
  "junk",
  "move",
  "copy",
  "trash",
  "ensure-archive",
]);
const MOVES = new Set(["move", "copy", "trash"]);
const KEYS = ["read", "flagged", "junk"] as const;

const isInbox = (p: string) => p.toUpperCase() === "INBOX";
const inInbox = (c: CopyRef) => isInbox(c.path) || c.labels.some(isInbox);

const anyCase = (p: string) =>
  isInbox(p) ? fc.mixedCase(fc.constant(p)) : fc.constant(p);

const copyShape = fc.constantFrom(...ACCOUNT_IDS).chain((account) => {
  const paths = pathsOf(account);
  const gmail = accounts.get(account)?.gmail ?? false;
  const labels = paths.filter((p) => !p.startsWith("[Gmail]/"));
  return fc.record({
    account: fc.constant(account),
    path: fc.constantFrom(...paths).chain(anyCase),
    labels: gmail
      ? fc
          .subarray(labels)
          .chain((ls) => fc.tuple(...ls.map(anyCase)))
          .map((ls) => [...ls])
      : fc.constant<string[]>([]),
  });
});

const flag = fc.option(fc.boolean(), { nil: undefined });
const target = fc.option(
  fc.oneof(
    fc.constantFrom<"archive" | "inbox" | "trash">("archive", "inbox", "trash"),
    fc.constantFrom(...BOXES.keys(), 99),
  ),
  { nil: undefined },
);

type Scenario = { copies: Map<string, CopyRef[]>; input: SetInput };

const scenarioWith = (mailbox: fc.Arbitrary<SetInput["mailbox"]>) =>
  fc
    .array(fc.array(copyShape, { minLength: 1, maxLength: 4 }), {
      minLength: 1,
      maxLength: 5,
    })
    .chain((messages) => {
      let next = 1000;
      const copies = new Map(
        messages.map((cs, i): [string, CopyRef[]] => [
          `m${i}`,
          cs.map((c) => ({ ...c, id: next++ })),
        ]),
      );
      const names = [...copies.keys()];
      const id = fc.oneof(
        { arbitrary: fc.constantFrom(...names), weight: 6 },
        { arbitrary: fc.constantFrom("nope", "gone"), weight: 1 },
      );
      return fc
        .record({
          ids: fc.array(id, { minLength: 1, maxLength: 8 }),
          read: flag,
          flagged: flag,
          junk: flag,
          mailbox,
        })
        .map((input): Scenario => ({ copies, input }));
    });
const scenario = scenarioWith(target);

type Call = { script: string; args: string[] };

const recorder = (reply: (args: string[]) => string) => {
  const calls: Call[] = [];
  const runner: Runner = async (script, args) => {
    calls.push({ script, args: [...args] });
    return reply(args);
  };
  return { calls, runner };
};

const allOk = (args: string[]) =>
  args[0] === "ensure-archive"
    ? "created\n"
    : args
        .slice(4)
        .map((n) => `ok\t${n}`)
        .join("\n");

const set = (s: Scenario, runner: Runner) =>
  setMessages(s.input, {
    copies: async (id) => s.copies.get(id) ?? null,
    accounts,
    runner,
    script: SCRIPT,
    mailbox: (id) => BOXES.get(id) ?? null,
  });

const reference = async (s: Scenario) => {
  const { calls, runner } = recorder(allOk);
  const { results } = await set(s, runner);
  return { calls, results };
};

const touches = (call: Call, cs: CopyRef[]) =>
  call.args[0] !== "ensure-archive" &&
  cs.some((c) => call.args.slice(4).includes(String(c.id)));

const ownerOf = (s: Scenario, n: string) => {
  for (const cs of s.copies.values())
    for (const c of cs) if (String(c.id) === n) return c;
  return null;
};

const RUNS = { numRuns: 300 };
const crash = (account: string) => `osascript exited 1 in ${account}`;

describe("set_messages planning", () => {
  test("one outcome per input id, in order; unknown ids never reach Mail", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async (s) => {
        const { calls, results } = await reference(s);
        expect(results.map((r) => r.id)).toEqual(s.input.ids);
        for (const r of results) {
          expect(r.ok).toBe(r.error === null);
          if (s.copies.has(r.id)) continue;
          expect(r).toEqual({
            id: r.id,
            ok: false,
            changed: [],
            notes: [],
            error: `unknown message ${r.id}`,
          });
        }
        for (const call of calls)
          for (const n of call.args.slice(4))
            expect(ownerOf(s, n)).not.toBeNull();
      }),
      RUNS,
    );
  });

  test("argv holds only plain values from the input (M9)", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async (s) => {
        const { calls } = await reference(s);
        const known = s.input.ids.flatMap((id) => s.copies.get(id) ?? []);
        const accountIds = new Set(known.map((c) => c.account));
        const paths = new Set([...known.map((c) => c.path), "INBOX"]);
        const values = new Set(["true", "false", "", ...ALL_PATHS]);
        for (const { script, args } of calls) {
          expect(script).toBe(SCRIPT);
          expect(OPS.has(args[0] ?? "")).toBe(true);
          for (const arg of args) expect(arg).not.toMatch(/[\n\r\t"]/);
          expect(accountIds.has(args[1] ?? "")).toBe(true);
          if (args[0] === "ensure-archive") {
            const want = ARCHIVE[args[1] ?? ""];
            expect(want?.create).toBe(true);
            expect(args.slice(2)).toEqual([want?.path ?? "", ""]);
            continue;
          }
          expect(paths.has(args[2] ?? "")).toBe(true);
          expect(values.has(args[3] ?? "")).toBe(true);
          const ids = args.slice(4);
          expect(ids.length).toBeGreaterThan(0);
          expect(new Set(ids).size).toBe(ids.length);
          for (const n of ids) {
            expect(n).toMatch(/^\d+$/);
            expect(ownerOf(s, n)?.account).toBe(args[1]);
          }
        }
      }),
      RUNS,
    );
  });

  test("a planning error leaves every copy of that id untouched (M8)", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async (s) => {
        const { calls, results } = await reference(s);
        const { mailbox } = s.input;
        results.forEach((r) => {
          const cs = s.copies.get(r.id);
          if (!cs) return;
          if (!r.ok) {
            expect(calls.some((c) => touches(c, cs))).toBe(false);
            expect(r.changed).toEqual([]);
          }
          if (
            mailbox === "archive" &&
            cs.some((c) => BROKEN.includes(c.account) && inInbox(c))
          )
            expect(r.ok).toBe(false);
          if (mailbox === 99) expect(r.error).toBe("unknown mailbox 99");
          if (mailbox === undefined) expect(r.ok).toBe(true);
        });
      }),
      RUNS,
    );
  });

  test("read, flagged and junk reach every copy once, before any move (M7)", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async (s) => {
        const { calls, results } = await reference(s);
        const keys = KEYS.filter((k) => s.input[k] !== undefined);
        for (const r of results) {
          const cs = s.copies.get(r.id);
          if (!cs || !r.ok) continue;
          expect(r.changed.slice(0, keys.length)).toEqual(keys);
          for (const key of keys)
            for (const c of cs) {
              const hits = calls.filter(
                ({ args }) =>
                  args[0] === key &&
                  args[1] === c.account &&
                  args[2] === c.path &&
                  args[3] === String(s.input[key]) &&
                  args.slice(4).includes(String(c.id)),
              );
              expect(hits).toHaveLength(1);
            }
        }
        const ops = calls.map((c) => c.args[0] ?? "");
        const firstMove = ops.findIndex((op) => MOVES.has(op));
        if (firstMove >= 0)
          for (const op of ops.slice(firstMove))
            expect(KEYS.some((k) => k === op)).toBe(false);
      }),
      RUNS,
    );
  });

  test("moves take at most one copy per account and name the rest (M7)", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async (s) => {
        const { calls, results } = await reference(s);
        const { mailbox } = s.input;
        const moved = calls.filter((c) => MOVES.has(c.args[0] ?? ""));
        if (mailbox === undefined) expect(moved).toEqual([]);
        for (const r of results) {
          const cs = s.copies.get(r.id);
          if (!cs || !r.ok || mailbox === undefined) continue;
          const groups = Map.groupBy(cs, (c) => c.account);
          for (const [account, group] of groups) {
            const hit = new Set(
              moved
                .filter((c) => c.args[1] === account)
                .flatMap((c) => c.args.slice(4))
                .filter((n) => group.some((c) => String(c.id) === n)),
            );
            expect(hit.size).toBeLessThanOrEqual(1);
            const [acted] = [...hit];
            const rest = group.filter((c) => String(c.id) !== acted);
            if (acted && rest.length)
              expect(
                r.notes.some(
                  (n) =>
                    n.includes(`account ${account}`) &&
                    rest.every((c) => n.includes(String(c.id))),
                ),
              ).toBe(true);
            const noted = r.notes.some((n) => n.includes(`account ${account}`));
            if (typeof mailbox === "number") {
              const box = BOXES.get(mailbox);
              if (account !== box?.account) {
                expect(hit.size).toBe(0);
                expect(noted).toBe(true);
              }
            } else
              expect(
                hit.size === 1 ||
                  noted ||
                  r.notes.includes("not in inbox; nothing moved"),
              ).toBe(true);
          }
        }
      }),
      RUNS,
    );
  });

  test("archive goes to each account's archive mailbox, creating it first (M8, M18)", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioWith(fc.constant("archive")), async (s) => {
        const { calls, results } = await reference(s);
        const ensures = calls.filter((c) => c.args[0] === "ensure-archive");
        expect(ensures.length).toBeLessThanOrEqual(1);
        calls.forEach(({ args }, i) => {
          if (!MOVES.has(args[0] ?? "")) return;
          const want = ARCHIVE[args[1] ?? ""];
          expect(want).toBeDefined();
          expect(args[3]).toBe(want?.path);
          expect(args[0]).toBe("move");
          if (want?.create)
            expect(
              calls
                .slice(0, i)
                .some(
                  (c) =>
                    c.args[0] === "ensure-archive" && c.args[1] === args[1],
                ),
            ).toBe(true);
        });
        for (const r of results) {
          const cs = s.copies.get(r.id);
          if (!cs || !r.ok) continue;
          const bare = cs.some((c) => c.account === BARE && inInbox(c));
          expect(r.notes.includes(`created Archive in account ${BARE}`)).toBe(
            bare,
          );
        }
      }),
      RUNS,
    );
  });

  test("ensure-archive failures fail only the ids that needed it (M18)", async () => {
    const reply = fc.constantFrom("created", "exists", "throw", "garbage");
    await fc.assert(
      fc.asyncProperty(
        scenarioWith(fc.constant("archive")),
        reply,
        async (s, mode) => {
          const ref = await reference(s);
          const { calls, runner } = recorder((args) => {
            if (args[0] !== "ensure-archive") return allOk(args);
            if (mode === "throw") throw new Error("Mail said no");
            return `${mode}\n`;
          });
          const { results } = await set(s, runner);
          const good = mode === "created" || mode === "exists";
          const reason =
            mode === "throw"
              ? "could not create Archive: Mail said no"
              : "unexpected reply from Mail: garbage";
          if (!good)
            expect(
              calls.some(
                (c) => MOVES.has(c.args[0] ?? "") && c.args[1] === BARE,
              ),
            ).toBe(false);
          results.forEach((r, i) => {
            const cs = s.copies.get(r.id);
            const before = ref.results[i];
            if (!cs || !before?.ok) return expect(before).toEqual(r);
            const needs = cs.some((c) => c.account === BARE && inInbox(c));
            const note = `created Archive in account ${BARE}`;
            expect(r.notes.filter((n) => n === note)).toHaveLength(
              needs && mode === "created" ? 1 : 0,
            );
            expect(r.ok).toBe(good || !needs);
            if (!good && needs) expect(r.error).toContain(reason);
          });
        },
      ),
      RUNS,
    );
  });

  test("runner replies map to exactly the ids whose copies failed", async () => {
    const faulty = scenario.chain((s) => {
      const total = [...s.copies.values()].flat().length;
      return fc.record({
        s: fc.constant(s),
        fates: fc.array(fc.constantFrom("ok", "error", "missing"), {
          minLength: total,
          maxLength: total,
        }),
        throwing: fc.subarray(ACCOUNT_IDS),
      });
    });
    await fc.assert(
      fc.asyncProperty(faulty, async ({ s, fates, throwing }) => {
        const ref = await reference(s);
        const fate = (n: string) => fates[Number(n) - 1000] ?? "ok";
        const { calls, runner } = recorder((args) => {
          if (args[0] === "ensure-archive") return "created\n";
          const account = args[1] ?? "";
          if (throwing.includes(account)) throw new Error(crash(account));
          return args
            .slice(4)
            .flatMap((n) =>
              fate(n) === "ok"
                ? [`ok\t${n}`]
                : fate(n) === "error"
                  ? [`error\t${n}\tboom ${n}`]
                  : [],
            )
            .join("\n");
        });
        const { results } = await set(s, runner);
        expect(calls).toEqual(ref.calls);
        results.forEach((r: SetOutcome, i) => {
          const before = ref.results[i];
          const cs = s.copies.get(r.id);
          if (!cs || !before?.ok) return expect(before).toEqual(r);
          const reasons = calls
            .filter((c) => touches(c, cs))
            .flatMap(({ args }) =>
              args
                .slice(4)
                .filter((n) => cs.some((c) => String(c.id) === n))
                .flatMap((n) => {
                  const account = args[1] ?? "";
                  if (throwing.includes(account)) return [crash(account)];
                  if (fate(n) === "error") return [`boom ${n}`];
                  if (fate(n) === "missing") return ["no result from Mail"];
                  return [];
                }),
            );
          expect(r.ok).toBe(reasons.length === 0);
          for (const reason of reasons) expect(r.error).toContain(reason);
        });
      }),
      RUNS,
    );
  });
});

const INBOX_BOXES = [...BOXES].filter(([, b]) => isInbox(b.path));

const archiveRun = async (gmail: boolean, boxes: [string, number][]) => {
  const { calls, runner } = recorder(allOk);
  const { results } = await setMessages(
    { ids: ["m"], mailbox: "archive" },
    {
      copies: async () => [
        { id: 1, account: "GEN", path: "INBOX", labels: [] },
      ],
      accounts: new Map([
        ["GEN", { id: "GEN", gmail, attrs: new Map([["INBOX", 0], ...boxes]) }],
      ]),
      runner,
      script: SCRIPT,
    },
  );
  return { calls, result: results[0] };
};

describe("set_messages robustness", () => {
  test("accounts without a mailbox cache only block archiving from their inbox", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async (s) => {
        const { calls, results } = await reference(s);
        const { mailbox } = s.input;
        for (const r of results) {
          const cs = s.copies.get(r.id);
          if (!cs) continue;
          const lost = cs.filter((c) => c.account === LOST);
          const blocked = mailbox === "archive" && lost.some((c) => inInbox(c));
          if (mailbox === "archive" && !cs.some(inInbox))
            expect(r.notes).toEqual(["not in inbox; nothing moved"]);
          if (blocked)
            expect(r.error).toContain(`no mailbox cache for account ${LOST}`);
          else expect(r.error ?? "").not.toContain("no mailbox cache");
          if (
            mailbox === undefined ||
            mailbox === "trash" ||
            mailbox === "inbox"
          )
            expect(r.ok).toBe(true);
          if (!r.ok || !lost.length) continue;
          for (const key of KEYS)
            if (s.input[key] !== undefined)
              for (const c of lost)
                expect(
                  calls.some(
                    ({ args }) =>
                      args[0] === key &&
                      args[1] === LOST &&
                      args.slice(4).includes(String(c.id)),
                  ),
                ).toBe(true);
          if (mailbox === 23 || mailbox === "trash")
            expect(
              calls.some(
                ({ args }) =>
                  MOVES.has(args[0] ?? "") &&
                  args[1] === LOST &&
                  args
                    .slice(4)
                    .some((n) => lost.some((c) => String(c.id) === n)),
              ) || r.notes.some((n) => n.startsWith("already in")),
            ).toBe(true);
        }
      }),
      RUNS,
    );
  });

  test("a copy already in an inbox of any case is not moved to that inbox", async () => {
    const inboxTarget = fc.oneof(
      fc.constant<"inbox">("inbox"),
      fc.constantFrom(...INBOX_BOXES.map(([id]) => id)),
    );
    await fc.assert(
      fc.asyncProperty(scenarioWith(inboxTarget), async (s) => {
        const { calls, results } = await reference(s);
        const { mailbox } = s.input;
        const accountOfTarget =
          typeof mailbox === "number" ? BOXES.get(mailbox)?.account : null;
        for (const r of results) {
          const cs = s.copies.get(r.id);
          if (!cs || !r.ok) continue;
          for (const [account, group] of Map.groupBy(cs, (c) => c.account)) {
            if (accountOfTarget && account !== accountOfTarget) continue;
            if (!group.some(inInbox)) continue;
            expect(
              calls.some(
                ({ args }) =>
                  MOVES.has(args[0] ?? "") &&
                  args[1] === account &&
                  args
                    .slice(4)
                    .some((n) => group.some((c) => String(c.id) === n)),
              ),
            ).toBe(false);
            expect(
              r.notes.some(
                (n) =>
                  n.startsWith("already in") &&
                  n.endsWith(`account ${account}`),
              ),
            ).toBe(true);
          }
        }
      }),
      RUNS,
    );
  });

  test("malformed reply lines from Mail are ignored", async () => {
    const junk = fc.oneof(
      fc.constantFrom(
        "",
        "ok",
        "error",
        "ok\t",
        "error\t",
        "\t",
        "weird\t{n}",
        "ok\t{n}x",
        "ok\t {n}",
        "ok\t{n}\textra",
        "OK\t{n}",
      ),
      fc.stringMatching(/^[a-z ]{0,12}$/),
    );
    const eol = fc.constantFrom("\n", "\r\n", "\r");
    const fated = scenario.chain((s) => {
      const total = [...s.copies.values()].flat().length;
      return fc.record({
        s: fc.constant(s),
        fates: fc.array(fc.constantFrom("ok", "error", "missing"), {
          minLength: total,
          maxLength: total,
        }),
        noise: fc.array(fc.tuple(junk, eol), { maxLength: 6 }),
        end: eol,
      });
    });
    await fc.assert(
      fc.asyncProperty(fated, async ({ s, fates, noise, end }) => {
        const fate = (n: string) => fates[Number(n) - 1000] ?? "ok";
        const reply = (args: string[]) =>
          args
            .slice(4)
            .flatMap((n) =>
              fate(n) === "ok"
                ? [`ok\t${n}`]
                : fate(n) === "error"
                  ? [`error\t${n}\tboom ${n}`]
                  : [],
            );
        const clean = recorder((args) =>
          args[0] === "ensure-archive" ? allOk(args) : reply(args).join("\n"),
        );
        const ref = await set(s, clean.runner);
        const noisy = recorder((args) => {
          if (args[0] === "ensure-archive") return allOk(args);
          const mixed = reply(args);
          const n = args[4] ?? "1000";
          for (const [i, [line]] of noise.entries())
            mixed.splice(i % (mixed.length + 1), 0, line.replaceAll("{n}", n));
          return mixed.map((line, i) => line + (noise[i]?.[1] ?? end)).join("");
        });
        const { results } = await set(s, noisy.runner);
        expect(noisy.calls).toEqual(clean.calls);
        expect(results).toEqual(ref.results);
      }),
      RUNS,
    );
  });

  test("archive resolves to a mailbox the account's rules allow (M8, M18)", async () => {
    const box = fc.record({
      path: fc
        .oneof(
          fc.constantFrom(
            "Archive",
            "archive",
            "ARCHIVE",
            "Projects/Archive",
            "[Gmail]/All Mail",
            "Old",
          ),
          fc.stringMatching(/^[A-Za-z]{1,6}(\/[A-Za-z]{1,6})?$/),
        )
        .filter((p) => !isInbox(p)),
      attrs: fc
        .tuple(fc.subarray([ATTR.archive, ATTR.all, ATTR.trash]), noise)
        .map(([bits, extra]) => sum(bits) | extra),
    });
    const plain = fc
      .stringMatching(/^[A-Za-z]{1,6}\/[A-Za-z]{1,6}$/)
      .filter((p) => !p.toLowerCase().endsWith("archive"));
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(box, { selector: (b) => b.path, maxLength: 6 }),
        fc.boolean(),
        plain,
        async (generated, gmail, extra) => {
          const boxes = generated.map((b): [string, number] => [
            b.path,
            b.attrs,
          ]);
          const attrs = new Map(boxes);
          const { calls, result } = await archiveRun(gmail, boxes);
          const flagged = boxes.filter(([, a]) => a & ATTR.archive);
          const moves = calls.filter((c) => MOVES.has(c.args[0] ?? ""));
          const ensures = calls.filter((c) => c.args[0] === "ensure-archive");
          if (!result?.ok) {
            expect(calls).toEqual([]);
            expect(
              flagged.length > 1 ||
                (gmail &&
                  !boxes.some(([, a]) => a & (ATTR.archive | ATTR.all))),
            ).toBe(true);
          } else {
            expect(moves).toHaveLength(1);
            const dest = moves[0]?.args[3] ?? "";
            expect(moves[0]?.args[0]).toBe("move");
            const bits = attrs.get(dest) ?? 0;
            if (flagged.length) expect(bits & ATTR.archive).toBeTruthy();
            else if (gmail) expect(bits & ATTR.all).toBeTruthy();
            else {
              expect(dest.toLowerCase()).toBe("archive");
              expect(ensures.length).toBe(attrs.has(dest) ? 0 : 1);
            }
            if (gmail) expect(ensures).toEqual([]);
          }
          if (attrs.has(extra)) return;
          const more = await archiveRun(gmail, [...boxes, [extra, 0]]);
          expect(more.calls).toEqual(calls);
        },
      ),
      { numRuns: 500 },
    );
  });
});

const NOISE_BITS = [1, 2, 4, 8, 16, HAS_CHILDREN, HAS_NO_CHILDREN, 128, 8192];
const sum = (bits: number[]) => bits.reduce((a, b) => a | b, 0);
const noise = fc.subarray(NOISE_BITS).map(sum);
const ROLES = Object.keys(ATTR) as (keyof typeof ATTR)[];
const KNOWN: [string, Role | null][] = [
  ["Archive", "archive"],
  ["Deleted Messages", "trash"],
  ["Junk", "junk"],
  ["Sent Messages", "sent"],
  ["Drafts", "drafts"],
  ["[Gmail]/All Mail", "all"],
  ["[Gmail]/Spam", "junk"],
  ["[Gmail]/Trash", "trash"],
  ["Receipts", null],
  ["Archives/2026", null],
  ["Projects/Archive", null],
];
const segment = fc.oneof(
  fc.mixedCase(fc.constantFrom("archive", "junk", "trash", "sent", "drafts")),
  fc.stringMatching(/^[A-Za-z0-9 .[\]]{1,8}$/),
);
const anyPath = fc
  .array(segment, { minLength: 1, maxLength: 4 })
  .map((parts) => parts.join("/"))
  .filter((p) => !isInbox(p));
const withLeaf = (path: string, leaf: string) =>
  [...path.split("/").slice(0, -1), leaf].join("/");

describe("accounts", () => {
  test("a single role bit names its role for any path", () => {
    fc.assert(
      fc.property(anyPath, fc.constantFrom(...ROLES), noise, (p, r, extra) => {
        expect(role(p, ATTR[r] | extra)).toBe(r);
      }),
      { numRuns: 500 },
    );
  });

  test("several role bits give one of their roles", () => {
    fc.assert(
      fc.property(
        anyPath,
        fc.subarray(ROLES, { minLength: 1 }),
        noise,
        (p, rs, extra) => {
          const got = role(p, sum(rs.map((r) => ATTR[r])) | extra);
          expect(rs.some((r) => r === got)).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });

  test("INBOX in any case is always the inbox", () => {
    fc.assert(
      fc.property(
        fc.mixedCase(fc.constant("inbox")),
        fc.nat({ max: 1 << 20 }),
        (path, attrs) => {
          expect(role(path, attrs)).toBe("inbox");
        },
      ),
    );
  });

  test("without role bits, names decide only at the top or under [Gmail], in any case", () => {
    fc.assert(
      fc.property(anyPath, noise, fc.boolean(), (p, extra, gmail) => {
        expect(role(p, extra)).toBe(role(p, 0));
        const parts = p.split("/");
        if (parts.length > 1 && parts[0] !== "[Gmail]")
          expect(role(p, extra)).toBeNull();
        const leaf = parts.at(-1) ?? "";
        const top = gmail ? `[Gmail]/${leaf}` : leaf;
        if (!isInbox(top))
          expect(role(top, extra)).toBe(
            role(withLeaf(top, leaf.toLowerCase()), 0),
          );
      }),
      { numRuns: 500 },
    );
  });

  test("fixture mailbox names keep their known roles in any case", () => {
    fc.assert(
      fc.property(fc.constantFrom(...KNOWN), noise, ([path, want], extra) =>
        fc.assert(
          fc.property(
            fc.mixedCase(fc.constant(path.split("/").at(-1) ?? "")),
            (leaf) => {
              expect(role(withLeaf(path, leaf), extra)).toBe(want);
            },
          ),
          { numRuns: 5 },
        ),
      ),
    );
  });

  test("object prototype keys are never mailbox roles", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...Object.getOwnPropertyNames(Object.prototype)),
        fc.boolean(),
        noise,
        (name, gmail, extra) => {
          expect(role(gmail ? `[Gmail]/${name}` : name, extra)).toBeNull();
        },
      ),
    );
  });

  type Node = { IMAPMailboxAttributes?: number; IMAPMailboxChildren?: Tree };
  type Tree = Record<string, Node>;
  type Draft = { attrs: number; omit: boolean; children: Map<string, Draft> };
  const name = fc
    .stringMatching(/^[A-Za-z0-9 _.[\]-]{1,10}$/)
    .filter((n) => n !== "__proto__");
  const entry = fc.record({
    parts: fc.array(name, { minLength: 1, maxLength: 4 }),
    attrs: fc.nat({ max: 1 << 17 }),
    omit: fc.boolean(),
  });
  const toTree = (drafts: Map<string, Draft>): Tree =>
    Object.fromEntries(
      [...drafts].map(([key, d]): [string, Node] => [
        key,
        {
          ...(d.omit && d.attrs === 0
            ? {}
            : { IMAPMailboxAttributes: d.attrs }),
          ...(d.children.size
            ? { IMAPMailboxChildren: toTree(d.children) }
            : {}),
        },
      ]),
    );
  const CAPS = ["IMAP4REV1", "X-GM-EXT-1", "SPECIAL-USE", "MOVE"];
  const EMPTY = "00000000-0000-0000-0000-000000000000";
  let version = 1;

  test("readAccounts reads back every mailbox path written to a plist", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(
          fc.record({
            id: fc.uuid().filter((id) => id !== EMPTY),
            capabilities: fc.subarray(CAPS),
            entries: fc.array(entry, { maxLength: 8 }),
            format: fc.constantFrom("xml1", "binary1"),
          }),
          { selector: (a) => a.id.toUpperCase(), maxLength: 4 },
        ),
        async (generated) => {
          const dir = join(scratch, `V${version++}`);
          mkdirSync(join(dir, EMPTY), { recursive: true });
          mkdirSync(join(dir, "MailData"));
          const wanted = new Map<string, Map<string, number>>();
          for (const a of generated) {
            const want = new Map<string, number>();
            const root = new Map<string, Draft>();
            for (const e of a.entries) {
              let level = root;
              e.parts.forEach((part, i) => {
                const path = e.parts.slice(0, i + 1).join("/");
                const last = i === e.parts.length - 1;
                let d = level.get(part);
                if (!d) {
                  d = { attrs: 0, omit: true, children: new Map() };
                  level.set(part, d);
                  want.set(path, 0);
                }
                if (last) {
                  d.attrs = e.attrs;
                  d.omit = e.omit;
                  want.set(path, e.attrs);
                }
                level = d.children;
              });
            }
            wanted.set(a.id, want);
            mkdirSync(join(dir, a.id));
            const file = join(dir, a.id, ".mboxCache.plist");
            writeFileSync(
              file,
              JSON.stringify({
                separator: "/",
                capabilities: a.capabilities,
                mboxes: toTree(root),
              }),
            );
            const done = Bun.spawnSync(["plutil", "-convert", a.format, file]);
            expect(done.exitCode).toBe(0);
          }
          expect(versionDir(scratch)).toBe(dir);
          const read = await readAccounts(dir);
          expect([...read.keys()].toSorted()).toEqual(
            generated.map((a) => a.id).toSorted(),
          );
          for (const a of generated) {
            const got = read.get(a.id);
            expect(got?.attrs).toEqual(wanted.get(a.id));
            expect(got?.gmail).toBe(a.capabilities.includes("X-GM-EXT-1"));
          }
        },
      ),
      { numRuns: 25 },
    );
  }, 60_000);
});
