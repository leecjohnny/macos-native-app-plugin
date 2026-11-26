import { definePlugin } from "@macos-native-app/core/protocol/plugin";
import * as tools from "./tools.ts";
import { agentGuide } from "./agent-guide.ts";
export const {
  main,
  runtime,
  plugin: mail,
} = definePlugin(
  "mail",
  agentGuide,
  "Set MACOS_MAIL_ROOT to override ~/Library/Mail.",
  tools,
);
