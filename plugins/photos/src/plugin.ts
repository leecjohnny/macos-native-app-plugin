import { definePlugin } from "@macos-native-app/core/protocol/plugin";
import * as tools from "./tools.ts";
import { agentGuide } from "./agent-guide.ts";
export const {
  main,
  runtime,
  plugin: photos,
} = definePlugin(
  "photos",
  agentGuide,
  "Set MACOS_PHOTOS_ROOT to override ~/Pictures/Photos Library.photoslibrary.",
  tools,
  (name, data) =>
    typeof data.preview === "string"
      ? { path: data.preview, cleanup: name === "fetch_previews" }
      : undefined,
);
