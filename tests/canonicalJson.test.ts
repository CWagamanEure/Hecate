import { describe, it, expect } from "vitest";
import { canonicalJson, CanonError } from "@shared/crypto";

describe("canonicalJson — key order", () => {
  it("is independent of object key insertion order", () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it("sorts nested object keys recursively", () => {
    expect(canonicalJson({ a: { y: 2, x: 1 } })).toBe(
      canonicalJson({ a: { x: 1, y: 2 } })
    );
  });

  it("is stable across many key permutations (property test)", () => {
    const target = canonicalJson({ a: 1, b: 2, c: 3, d: 4 });
    const keys = ["a", "b", "c", "d"] as const;
    for (let i = 0; i < 100; i++) {
      const shuffled = [...keys].sort(() => Math.random() - 0.5);
      const obj: Record<string, number> = {};
      shuffled.forEach((k, j) => {
        obj[k] = ["a", "b", "c", "d"].indexOf(k) + 1;
      });
      expect(canonicalJson(obj)).toBe(target);
    }
  });
});

describe("canonicalJson — array order", () => {
  it("preserves array element order (different from key sort)", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("recurses into nested arrays without sorting them", () => {
    expect(canonicalJson([{ b: 2, a: 1 }, { a: 1, b: 2 }])).toBe(
      '[{"a":1,"b":2},{"a":1,"b":2}]'
    );
  });
});

describe("canonicalJson — null and missing", () => {
  it("emits null fields", () => {
    expect(canonicalJson({ a: null })).toBe('{"a":null}');
  });

  it("rejects undefined at root", () => {
    expect(() => canonicalJson(undefined)).toThrow(CanonError);
  });

  it("rejects undefined inside object with path", () => {
    try {
      canonicalJson({ a: { b: undefined } });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CanonError);
      expect((e as CanonError).path).toEqual(["a", "b"]);
      expect((e as Error).message).toContain("/a/b");
    }
  });

  it("rejects undefined inside array with index path", () => {
    try {
      canonicalJson([1, undefined, 3]);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CanonError);
      expect((e as CanonError).path).toEqual(["1"]);
    }
  });
});

describe("canonicalJson — forbidden numbers", () => {
  it.each([NaN, Infinity, -Infinity])("rejects %s", (v) => {
    expect(() => canonicalJson({ x: v })).toThrow(CanonError);
  });
});

describe("canonicalJson — forbidden types", () => {
  it("rejects bigint", () => {
    expect(() => canonicalJson({ x: 1n })).toThrow(/bigint/);
  });
  it("rejects symbol", () => {
    expect(() => canonicalJson({ x: Symbol("x") })).toThrow(/symbol/);
  });
  it("rejects function", () => {
    expect(() => canonicalJson({ x: () => 1 })).toThrow(/function/);
  });
  it("rejects Date", () => {
    expect(() => canonicalJson({ x: new Date() })).toThrow(/Date/);
  });
  it("rejects Map", () => {
    expect(() => canonicalJson({ x: new Map() })).toThrow(/Map/);
  });
  it("rejects Set", () => {
    expect(() => canonicalJson({ x: new Set() })).toThrow(/Set/);
  });
  it("rejects RegExp", () => {
    expect(() => canonicalJson({ x: /re/ })).toThrow(/RegExp/);
  });
  it("rejects Uint8Array", () => {
    expect(() => canonicalJson({ x: new Uint8Array([1, 2, 3]) })).toThrow(
      /Uint8Array/
    );
  });
  it("rejects Buffer (subclass of Uint8Array)", () => {
    expect(() => canonicalJson({ x: Buffer.from([1, 2, 3]) })).toThrow(
      /Uint8Array/
    );
  });
  it("rejects class instances", () => {
    class Foo {
      n = 1;
    }
    expect(() => canonicalJson({ x: new Foo() })).toThrow(/class instance/);
  });
});

describe("canonicalJson — output formatting", () => {
  it("contains no whitespace", () => {
    expect(canonicalJson({ a: 1, b: [1, 2], c: { d: null } })).toMatch(
      /^[^ \t\n\r]+$/
    );
  });
  it("escapes strings per JSON.stringify", () => {
    expect(canonicalJson({ k: 'a"b' })).toBe('{"k":"a\\"b"}');
  });
  it("empty object", () => {
    expect(canonicalJson({})).toBe("{}");
  });
  it("empty array", () => {
    expect(canonicalJson([])).toBe("[]");
  });
  it("null at root", () => {
    expect(canonicalJson(null)).toBe("null");
  });
  it("empty string", () => {
    expect(canonicalJson("")).toBe('""');
  });
});

describe("canonicalJson — negative zero", () => {
  // Documented gotcha: JSON.stringify serializes -0 as "0".
  // This is acceptable for our domain.
  it("serializes -0 as 0", () => {
    expect(canonicalJson(-0)).toBe("0");
    expect(canonicalJson({ x: -0 })).toBe('{"x":0}');
  });
});

describe("canonicalJson — known vectors", () => {
  // Locked-in vector. Changing this output is a breaking protocol change.
  it("nested object vector", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: [1, 2] } })).toBe(
      '{"a":{"x":[1,2],"y":2},"z":1}'
    );
  });
});
