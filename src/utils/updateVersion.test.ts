import { expect, it } from "vitest";
import { hasReachedUpdateVersion } from "./updateVersion";

it.each([
  ["2.0.4", "2.0.4", true],
  ["2.0.5", "v2.0.4", true],
  ["2.0.3", "2.0.4", false],
  ["2.0.10", "2.0.9", true],
  ["2.1.0", "2.0.99", true],
  ["2.0.4-beta.1", "2.0.4", false],
  ["2.0.4", "2.0.4-rc.2", true],
  ["2.0.4-beta.10", "2.0.4-beta.2", true],
  ["2.0.4-beta.1", "2.0.4-beta.1.1", false],
  ["2.0.4-rc.1", "2.0.4-beta.9", true],
  ["2.0.4-alpha.1", "2.0.4-alpha.a", false],
  ["2.0.4-alpha.a", "2.0.4-alpha.1", true],
  ["2.0.4+build.2", "2.0.4+build.1", true],
  ["2.0.4", "", false],
  ["2.0.4", "invalid", false],
  ["invalid", "2.0.4", false],
  ["2.0.4", "2.0.04", false],
  ["2.0.4", "2.0.4-beta.01", false],
])("installed %s has reached skipped %s: %s", (current, skipped, reached) => {
  expect(hasReachedUpdateVersion(current, skipped)).toBe(reached);
});
