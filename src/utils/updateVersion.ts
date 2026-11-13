type Version = { core: bigint[]; prerelease: string[] };

function parseVersion(value: string): Version | undefined {
  const match =
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(
      value,
    );
  if (!match) return;
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0")))
    return;
  return { core: match.slice(1, 4).map(BigInt), prerelease };
}

/** Invalid versions never clear a saved skip; release versions follow SemVer precedence. */
export function hasReachedUpdateVersion(current: string, skipped: string): boolean {
  const installed = parseVersion(current);
  const target = parseVersion(skipped);
  if (!installed || !target) return false;
  for (let index = 0; index < 3; index++) {
    const a = installed.core[index];
    const b = target.core[index];
    if (a !== b) return a > b;
  }
  if (!installed.prerelease.length) return true;
  if (!target.prerelease.length) return false;
  for (
    let index = 0;
    index < Math.max(installed.prerelease.length, target.prerelease.length);
    index++
  ) {
    const a = installed.prerelease[index];
    const b = target.prerelease[index];
    if (a === b) continue;
    if (a === undefined) return false;
    if (b === undefined) return true;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return BigInt(a) > BigInt(b);
    if (aNumeric !== bNumeric) return bNumeric;
    return a > b;
  }
  return true;
}
