import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

type Problem = { file: string; line: number; message: string };

export function findComments(text: string): number[] {
  const source = text.replace(/\r\n?/g, "\n");
  const lines: number[] = [];
  let line = 1;
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "\n") {
      line++;
      i++;
    } else if (c === '"') {
      i++;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === "\\") i++;
        else if (source[i] === "\n") line++;
        i++;
      }
      i++;
    } else if (c === "|") {
      i++;
      while (i < source.length && source[i] !== "|") i++;
      i++;
    } else if (c === "«") {
      while (i < source.length && source[i] !== "»") i++;
      i++;
    } else if ((c === "-" && next === "-") || c === "#") {
      lines.push(line);
      while (i < source.length && source[i] !== "\n") i++;
    } else if (c === "(" && next === "*") {
      lines.push(line);
      let depth = 0;
      while (i < source.length) {
        if (source[i] === "(" && source[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (source[i] === "*" && source[i + 1] === ")") {
          depth--;
          i += 2;
          if (depth === 0) break;
        } else {
          if (source[i] === "\n") line++;
          i++;
        }
      }
    } else {
      i++;
    }
  }
  return lines;
}

function compile(file: string): Problem[] {
  const result = Bun.spawnSync(["osacompile", "-o", "/dev/null", file], {
    stderr: "pipe",
    stdout: "ignore",
  });
  if (result.exitCode === 0) return [];
  const text = result.stderr.toString().trim();
  const match = /:(\d+): (.*)/.exec(text);
  return [
    { file, line: match ? Number(match[1]) : 0, message: match?.[2] ?? text },
  ];
}

async function lintFile(file: string): Promise<Problem[]> {
  const source = await Bun.file(file).text();
  const comments = findComments(source).map((line) => ({
    file,
    line,
    message: "Comments are not allowed.",
  }));
  return [...comments, ...compile(file)];
}

function collect(paths: string[]): string[] {
  return paths.flatMap((path) =>
    statSync(path).isDirectory()
      ? collect(
          readdirSync(path)
            .filter(
              (name) =>
                name !== "node_modules" && name !== "build" && name !== ".git",
            )
            .map((name) => join(path, name)),
        )
      : path.endsWith(".applescript")
        ? [path]
        : [],
  );
}

if (import.meta.main) {
  const files = collect(process.argv.slice(2));
  const problems = (await Promise.all(files.map(lintFile))).flat();
  for (const p of problems) console.error(`${p.file}:${p.line}: ${p.message}`);
  console.log(`${files.length} AppleScript files, ${problems.length} problems`);
  process.exit(problems.length ? 1 : 0);
}
