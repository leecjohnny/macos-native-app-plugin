# macos-native-app

Search Apple Mail and Photos locally from a Bun CLI or an MCP client. Mail reads the Envelope Index and message files. Mail state changes use AppleScript. Photos searches the active library and can export selected assets through PhotoKit.

## Install

On macOS, install Bun and the Xcode command line tools, then run these commands from the repository root.

```sh
bun install
bun run build:helpers
bun apps/cli/src/cli.ts help
```

The executable is `apps/cli/src/cli.ts`. To expose it as `macos-native-app` on your PATH, run `bun link` in `apps/cli`. Grant the invoking application the macOS permissions required for the operations you use.

## CLI

```sh
macos-native-app help mail search_conversations
macos-native-app mail search_conversations "is:unread" --limit 5 --json
macos-native-app photos fetch_library --json
macos-native-app photos search-media "ramen in tokyo" --limit 3
```

Use `MACOS_MAIL_ROOT` or `MACOS_PHOTOS_ROOT` to select an alternative store. A Photos export requires an output destination outside the library and an explicit byte budget. CLI preview files remain available at the printed path.

## MCP

Configure your client's stdio command as the absolute path to the executable and pass `mcp` plus one or both app flags.

```json
{
  "command": "/absolute/path/to/macos-native-app-plugin/apps/cli/src/cli.ts",
  "args": ["mcp", "--mail", "--photos"]
}
```

Each tool name starts with its app name, including when only one app is enabled. For example, `mail_execute_sql` queries Mail, and `photos_execute_sql` queries the normalized active Photos library.

## Development

Run `bun run verify` for formatting, lint, Swift and AppleScript checks, type checking, and fixture tests. Rebuild the helper after editing Swift with `bun run build:helpers`.
