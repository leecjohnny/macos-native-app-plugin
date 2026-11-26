#!/usr/bin/env bun
import { main } from "@macos-native-app/core/protocol/cli";
import { mail } from "@macos-native-app/mail/plugin";
import { photos } from "@macos-native-app/photos/plugin";
try {
  const code = await main([mail, photos], process.argv.slice(2));
  await Promise.all(
    [process.stdout, process.stderr].map(
      (stream) =>
        new Promise<void>((resolve) => stream.write("", () => resolve())),
    ),
  );
  process.exit(code);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
