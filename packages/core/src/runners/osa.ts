export type OsaRunner = (
  script: string,
  args: string[],
  sourceForm?: boolean,
  timeoutMs?: number,
) => Promise<string>;
export const osascriptRunner: OsaRunner = async (
  script,
  args,
  sourceForm,
  timeoutMs = 120000,
) => {
  const proc = Bun.spawn(
    ["osascript", ...(sourceForm ? ["-s", "s"] : []), script, ...args],
    {
      timeout: timeoutMs,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(err.trim() || `osascript exited ${code}`);
  return out;
};
