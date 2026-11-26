import {
  cell as escapeCell,
  table as markdownTable,
  page,
  guard,
} from "@macos-native-app/core/protocol/render";
function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
function table(rows: Record<string, unknown>[]) {
  const cols = Object.keys(rows[0] ?? {});
  return cols.length
    ? markdownTable(
        cols.map(escapeCell),
        rows.map((r) => cols.map((k) => escapeCell(cell(r[k])))),
      )
    : "(none)";
}
export function render(data: Record<string, unknown>) {
  if (
    typeof data.total === "number" &&
    typeof data.offset === "number" &&
    Array.isArray(data.results)
  ) {
    if (!data.results.length)
      return page(
        "item",
        {
          query: String(data.query ?? ""),
          offset: data.offset,
          total: data.total,
        },
        [],
      );
    const end = data.offset + data.results.length;
    return [
      `Found ${data.total} items (showing ${data.offset + 1}–${end}).`,
      table(data.results),
      end < data.total ? `_Next page: offset=${end}._` : "_End of results._",
    ].join("\n\n");
  }
  return Object.entries(data)
    .map(([key, value]) => {
      if (
        Array.isArray(value) &&
        (!value.length ||
          value.every((x) => x && typeof x === "object" && !Array.isArray(x)))
      )
        return "### " + key + "\n\n" + table(value);
      return "**" + key + "**  " + guard(cell(value));
    })
    .join("\n\n");
}
