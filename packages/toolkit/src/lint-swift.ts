import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
export function commentOffsets(source: string) {
  const offsets: number[] = [];
  let i = 0;
  function string(hashes: string, delimiter: string) {
    i += hashes.length + delimiter.length;
    const escape = "\\" + hashes,
      close = delimiter + hashes;
    while (i < source.length) {
      if (source.startsWith(close, i)) {
        i += close.length;
        return;
      }
      if (source.startsWith(escape, i)) {
        i += escape.length;
        if (source[i] === "(") {
          i++;
          code(true);
        } else i++;
      } else i++;
    }
  }
  function code(interpolation: boolean) {
    let depth = 1;
    while (i < source.length) {
      if (source.startsWith("//", i)) {
        offsets.push(i);
        const end = source.indexOf("\n", i);
        i = end < 0 ? source.length : end;
      } else if (source.startsWith("/*", i)) {
        offsets.push(i);
        let nested = 1;
        i += 2;
        while (nested && i < source.length) {
          if (source.startsWith("/*", i)) {
            nested++;
            i += 2;
          } else if (source.startsWith("*/", i)) {
            nested--;
            i += 2;
          } else i++;
        }
      } else if (source[i] === '"' || source[i] === "#") {
        const start = i;
        while (source[i] === "#") i++;
        if (source[i] !== '"') continue;
        const delimiter = source.startsWith('"""', i) ? '"""' : '"';
        const hashes = source.slice(start, i);
        i = start;
        string(hashes, delimiter);
      } else {
        const ch = source[i++];
        if (interpolation && ch === "(") depth++;
        if (interpolation && ch === ")" && --depth === 0) return;
      }
    }
  }
  code(false);
  return offsets;
}
function files(path: string): string[] {
  return statSync(path).isDirectory()
    ? readdirSync(path)
        .filter(
          (name) =>
            name !== "node_modules" && name !== "build" && name !== ".git",
        )
        .flatMap((name) => files(join(path, name)))
    : path.endsWith(".swift")
      ? [path]
      : [];
}
if (import.meta.main)
  for (const path of process.argv.slice(2).flatMap(files)) {
    const source = await Bun.file(path).text();
    for (const offset of commentOffsets(source)) {
      console.error(
        path +
          ":" +
          source.slice(0, offset).split("\n").length +
          ": Comments are not allowed.",
      );
      process.exitCode = 1;
    }
    const result = Bun.spawnSync([
      "swiftc",
      "-warnings-as-errors",
      "-typecheck",
      path,
    ]);
    if (result.exitCode) {
      console.error(result.stderr.toString());
      process.exitCode = 1;
    }
  }
