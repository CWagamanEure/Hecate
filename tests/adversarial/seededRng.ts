/**
 * Mulberry32 PRNG. Deterministic, fast, no deps.
 *
 * Usage:
 *   const rng = makeRng(seed);
 *   rng.next();              // [0, 1)
 *   rng.nextInt(N);          // [0, N)
 *   rng.pick(arr);
 *
 * Adversarial tests use a fixed default seed for reproducibility. On failure,
 * the test message includes the seed and iteration index so reproduction is
 * one line.
 */

export type Rng = {
  next: () => number;
  nextInt: (n: number) => number;
  pick: <T>(arr: readonly T[]) => T;
};

export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  if (a === 0) a = 1; // mulberry32 stuck-at-zero guard
  const next = (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const nextInt = (n: number): number => Math.floor(next() * n);
  const pick = <T>(arr: readonly T[]): T => arr[nextInt(arr.length)]!;
  return { next, nextInt, pick };
}
