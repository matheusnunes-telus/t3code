/** Ctrl+Tab order: the tab you used last comes first. `null` stands in for a draft chat, which has no tab. */
export interface RecentTabCycle {
  readonly keys: ReadonlyArray<string | null>;
  readonly index: number;
}

export function startRecentTabCycle(
  recentKeys: ReadonlyArray<string>,
  tabKeys: ReadonlyArray<string>,
  activeKey: string | null,
): RecentTabCycle {
  const keys: Array<string | null> = [
    ...recentKeys.filter((key) => tabKeys.includes(key)),
    ...tabKeys.filter((key) => !recentKeys.includes(key)),
  ];
  if (activeKey === null || !keys.includes(activeKey)) keys.unshift(null);
  return { keys, index: Math.max(0, keys.indexOf(activeKey)) };
}

/** +1 goes to the next older tab, -1 to the next newer one; both wrap around. */
export function stepRecentTabCycle(cycle: RecentTabCycle, direction: 1 | -1): RecentTabCycle {
  const { keys } = cycle;
  if (keys.length < 2) return cycle;
  let index = cycle.index;
  do {
    index = (index + direction + keys.length) % keys.length;
  } while (keys[index] === null);
  return { keys, index };
}

export function moveToFront(keys: ReadonlyArray<string>, key: string): string[] {
  return [key, ...keys.filter((other) => other !== key)];
}
