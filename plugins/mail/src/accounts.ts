import { readdirSync } from "node:fs";
import { join } from "node:path";

export type Role =
  "inbox" | "archive" | "trash" | "junk" | "sent" | "drafts" | "all";

export type Account = {
  id: string;
  gmail: boolean;
  attrs: Map<string, number>;
};

export const ATTR = {
  all: 1024,
  archive: 2048,
  drafts: 4096,
  junk: 16384,
  sent: 32768,
  trash: 65536,
} as const;

export function versionDir(root: string): string {
  const versions = readdirSync(root)
    .filter((name) => /^V\d+$/.test(name))
    .toSorted((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
  const latest = versions[0];
  if (!latest) throw new Error(`No V* directory in ${root}`);
  return join(root, latest);
}

type Node = {
  IMAPMailboxAttributes?: number;
  IMAPMailboxChildren?: Record<string, Node>;
};

function walk(
  nodes: Record<string, Node>,
  prefix: string,
  out: Map<string, number>,
) {
  for (const [name, node] of Object.entries(nodes)) {
    const path = prefix ? `${prefix}/${name}` : name;
    out.set(path, node.IMAPMailboxAttributes ?? 0);
    walk(node.IMAPMailboxChildren ?? {}, path, out);
  }
}

export async function readAccount(
  dir: string,
  id: string,
): Promise<Account | null> {
  const file = join(dir, id, ".mboxCache.plist");
  if (!(await Bun.file(file).exists())) return null;
  const result = Bun.spawnSync(
    ["plutil", "-convert", "json", "-o", "-", file],
    { stderr: "pipe" },
  );
  if (result.exitCode !== 0)
    throw new Error(
      `plutil failed on ${file}: ${result.stderr.toString().trim()}`,
    );
  const plist = JSON.parse(result.stdout.toString()) as {
    capabilities?: string[];
    mboxes?: Record<string, Node>;
  };
  const capabilities = plist.capabilities ?? [];
  const attrs = new Map<string, number>();
  walk(plist.mboxes ?? {}, "", attrs);
  return {
    id,
    gmail: capabilities.includes("X-GM-EXT-1"),
    attrs,
  };
}

export async function readAccounts(dir: string): Promise<Map<string, Account>> {
  const ids = readdirSync(dir).filter((name) => /^[0-9A-F-]{36}$/i.test(name));
  const accounts = await Promise.all(ids.map((id) => readAccount(dir, id)));
  return new Map(
    accounts.filter((a): a is Account => a !== null).map((a) => [a.id, a]),
  );
}

const byName = new Map<string, Role>([
  ["inbox", "inbox"],
  ["archive", "archive"],
  ["trash", "trash"],
  ["deleted messages", "trash"],
  ["junk", "junk"],
  ["spam", "junk"],
  ["sent", "sent"],
  ["sent messages", "sent"],
  ["sent mail", "sent"],
  ["drafts", "drafts"],
  ["all mail", "all"],
]);

export function role(path: string, attrs: number): Role | null {
  if (path.toUpperCase() === "INBOX") return "inbox";
  if (attrs & ATTR.archive) return "archive";
  if (attrs & ATTR.trash) return "trash";
  if (attrs & ATTR.junk) return "junk";
  if (attrs & ATTR.sent) return "sent";
  if (attrs & ATTR.drafts) return "drafts";
  if (attrs & ATTR.all) return "all";
  const leaf = path.split("/").at(-1)?.toLowerCase() ?? "";
  const top = !path.includes("/") || path.startsWith("[Gmail]/");
  return top ? (byName.get(leaf) ?? null) : null;
}
