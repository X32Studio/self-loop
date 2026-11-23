import assert from "node:assert/strict";

// Scenario facts. Product age is relative to the clock chosen by the test, not the wall clock.
// A product without activityAt is a records repository with no configured loop.
/** @typedef {{name: string, project: string, phase: string, activityAt?: string, onStall?: 'show' | 'resume'}} Product */
/** @typedef {{now: string, hours: number, products: Product[]}} Scenario */

const hourMs = 3_600_000;
export const hours = count => count * hourMs;
export const shift = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString();
export const seed = Number(process.env.SELF_LOOP_ACCEPTANCE_SEED ?? 101);
assert.ok(Number.isSafeInteger(seed), "SELF_LOOP_ACCEPTANCE_SEED must be an integer");
export const now = shift("2026-11-21T17:00:00.000Z", (seed % 400) * 60_000);

export function seeded(seed0) {
  let state = seed0 >>> 0;
  return max => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state % max;
  };
}

export function product(name, age, overrides = {}) {
  return {
    name,
    project: name,
    phase: "phase-" + name,
    ...(age === undefined ? {} : { activityAt: shift(now, -hours(age)) }),
    ...overrides,
  };
}

export function groups(seed0, size) {
  const draw = seeded(seed0);
  const products = Array.from({ length: size }, (_, index) => {
    const name = `group-${index}-${draw(10_000)}`;
    const isIdle = index === 0 || (index > 1 && draw(7) < 3);
    return { spec: product(name, isIdle ? 3 + draw(97) : 0.05 + draw(50) / 100), isIdle };
  });
  // Registry order depends on the seed. Each product must be visited regardless of where it falls.
  for (let i = products.length - 1; i > 0; i--) {
    const j = draw(i + 1);
    [products[i], products[j]] = [products[j], products[i]];
  }
  return products;
}
