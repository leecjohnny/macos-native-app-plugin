export type SwiftHelperRunner = (
  args: string[],
) => Promise<Record<string, unknown>>;
export const swiftHelper =
  (binary: string): SwiftHelperRunner =>
  async (args) => {
    if (!(await Bun.file(binary).exists()))
      throw Error("Swift helper is missing. Run bun run build:helpers");
    const proc = Bun.spawn([binary, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    let result;
    try {
      result = JSON.parse(stdout);
      if (!result || typeof result !== "object" || Array.isArray(result))
        throw Error();
    } catch {
      throw Error(
        "Swift helper returned invalid JSON (exit " +
          code +
          "): " +
          stderr.trim(),
      );
    }
    if (code || result.ok === false)
      throw Error(
        "Swift helper (exit " + code + "): " + (result.error ?? stderr.trim()),
      );
    return result;
  };
