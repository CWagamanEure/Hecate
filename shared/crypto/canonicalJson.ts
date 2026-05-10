/**
 * Canonical JSON serializer.
 *
 * This module is part of the verification/security boundary. Every commitment,
 * root, and receipt-body hash routes through canonicalJson(). Changing the
 * algorithm after deployment is a breaking protocol change.
 *
 * Rules:
 *   - Object keys are sorted lexicographically by UTF-16 code unit (default JS
 *     string compare). Recursive: nested objects are sorted at each level.
 *   - Array order is preserved.
 *   - null fields are emitted (consistent with our schemas; nullable !== optional).
 *   - undefined is rejected anywhere it appears (root, object value, array element).
 *   - NaN, Infinity, -Infinity are rejected (JSON.stringify silently emits null
 *     for these, which would corrupt hashes).
 *   - bigint, symbol, function are rejected (caller must convert explicitly).
 *   - Date, Map, Set, RegExp, Uint8Array (and Buffer), and any class instance
 *     are rejected. Bytes that need hashing should be passed directly to
 *     keccak256Hex / sha256Hex, not through canonicalJson.
 *   - Output contains no whitespace.
 *   - Strings are escaped per JSON.stringify (RFC 8259).
 *
 * Documented gotcha: JSON.stringify serializes -0 as "0". Acceptable for our
 * domain — protocol quantities are decimal strings, and protocol numeric
 * fields are non-negative counts/timestamps. Tested explicitly.
 */

export class CanonError extends Error {
  readonly path: readonly string[];
  constructor(message: string, path: readonly string[] = []) {
    super(
      `canonicalJson: ${message}${path.length ? ` at /${path.join("/")}` : ""}`
    );
    this.name = "CanonError";
    this.path = path;
  }
}

function canonicalize(value: unknown, path: string[]): unknown {
  if (value === null) return null;
  if (value === undefined) throw new CanonError("undefined not allowed", path);

  const t = typeof value;
  if (t === "string" || t === "boolean") return value;
  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new CanonError("non-finite number not allowed", path);
    }
    return value;
  }
  if (t === "bigint")
    throw new CanonError("bigint not allowed; convert to string first", path);
  if (t === "symbol") throw new CanonError("symbol not allowed", path);
  if (t === "function") throw new CanonError("function not allowed", path);

  // object branch
  if (Array.isArray(value)) {
    return value.map((item, i) => canonicalize(item, [...path, String(i)]));
  }

  if (value instanceof Date) throw new CanonError("Date not allowed", path);
  if (value instanceof Map) throw new CanonError("Map not allowed", path);
  if (value instanceof Set) throw new CanonError("Set not allowed", path);
  if (value instanceof RegExp) throw new CanonError("RegExp not allowed", path);
  if (value instanceof Uint8Array) {
    throw new CanonError(
      "Uint8Array/Buffer not allowed; pass bytes to keccak256Hex/sha256Hex directly",
      path
    );
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new CanonError("class instance not allowed", path);
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    out[k] = canonicalize(obj[k], [...path, k]);
  }
  return out;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, []));
}
