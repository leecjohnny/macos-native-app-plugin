import { fail } from "./parser.ts";
const UNIT: Record<string, number> = {
  d: 86400,
  w: 7 * 86400,
  m: 30 * 86400,
  y: 365 * 86400,
};

export function day(value: string, pos: number, utc: boolean): number {
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(value);
  if (!m) return fail(`invalid date '${value}'`, pos);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = utc ? new Date(Date.UTC(y, mo - 1, d)) : new Date(y, mo - 1, d);
  if (
    (utc ? date.getUTCFullYear() : date.getFullYear()) !== y ||
    (utc ? date.getUTCMonth() : date.getMonth()) !== mo - 1 ||
    (utc ? date.getUTCDate() : date.getDate()) !== d
  )
    fail(`invalid date '${value}'`, pos);
  return Math.floor(date.getTime() / 1000);
}

export function relativeDate(
  name: string,
  value: string,
  now: number,
  pos: number,
) {
  const v = value.toLowerCase();
  const m = /^(\d+)([dwmy])$/.exec(v);
  if (!m) fail(`invalid value '${name}:${value}'`, pos);
  const at = now - Number(m![1]) * UNIT[m![2]!]!;
  if (!Number.isFinite(at)) fail("Invalid relative duration", pos);
  return at;
}

export function enumValue<T>(values: Record<string, T>, value: string) {
  return Object.hasOwn(values, value) ? values[value] : undefined;
}
export function textValue(name: string, value: string, pos: number) {
  if (!value.trim()) fail(`empty value for '${name}:'`, pos);
  return value;
}
export function near(value: string) {
  const parts = value.split(",");
  if (
    parts.length !== 3 ||
    parts.some((x) => !x.trim() || !Number.isFinite(Number(x)))
  )
    return;
  const [lat, lon, km] = parts.map(Number) as [number, number, number];
  if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && km >= 0)
    return { lat, lon, km };
}
function quantity(
  value: string,
  pattern: RegExp,
  units: Record<string, number>,
) {
  const match = pattern.exec(value.toLowerCase());
  if (match) {
    const result = Number(match[1]) * units[match[2]!]!;
    if (Number.isFinite(result)) return result;
  }
}
export const duration = (value: string) =>
  quantity(value, /^(\d+(?:\.\d+)?)(s|m|h)$/, { s: 1, m: 60, h: 3600 });
export const bytes = (value: string) =>
  quantity(value, /^(\d+(?:\.\d+)?)(b|kb|mb|gb)$/, {
    b: 1,
    kb: 1024,
    mb: 1048576,
    gb: 1073741824,
  });
