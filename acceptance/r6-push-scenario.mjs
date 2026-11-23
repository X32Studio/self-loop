import { closingScenario } from "./closing-fixture.mjs";
import { seed, seeded } from "./scenario.mjs";

/** @typedef {{slug: string, url: string, checks: object[]}} Destination */
/** @typedef {{close: ReturnType<typeof closingScenario>, first: Destination, second: Destination}} PushScenario */

/** @returns {PushScenario} */
export function pushScenario(options = {}) {
  const close = closingScenario(options);
  const draw = seeded(seed);
  const destination = (slug, checks) => ({ slug, url: "git@github.com:" + slug + ".git", checks });
  return {
    close,
    first: destination(close.destination, close.initial),
    second: destination("mirror/release-" + draw(10_000), close.failedRerun),
  };
}
