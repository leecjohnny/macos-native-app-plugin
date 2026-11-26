import { dirname, basename, join } from "node:path";
import { mkdir } from "node:fs/promises";
for await (const source of new Bun.Glob("plugins/*/swift/*.swift").scan(".")) {
  const dir = dirname(source),
    build = join(dir, "../build");
  await mkdir(build, { recursive: true });
  const code = await Bun.spawn(
    [
      "swiftc",
      "-O",
      "-warnings-as-errors",
      source,
      "-o",
      join(build, basename(source, ".swift")),
      "-Xlinker",
      "-sectcreate",
      "-Xlinker",
      "__TEXT",
      "-Xlinker",
      "__info_plist",
      "-Xlinker",
      join(dir, "Info.plist"),
    ],
    { stderr: "inherit" },
  ).exited;
  if (code) process.exit(code);
}
