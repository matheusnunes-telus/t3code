/** Chat tabs sit in one group per project, and chats without a project come first. */
export const SCRATCH_TAB_GROUP_ID = "scratch";

export interface TabGroupInput<T> {
  readonly groupId: string;
  /** Used to sort groups nobody has placed yet. */
  readonly title: string;
  readonly item: T;
}

export interface TabGroup<T> {
  readonly groupId: string;
  readonly title: string;
  readonly items: T[];
}

/**
 * Splits tabs into groups. Groups follow `savedOrder`; groups missing from it come after,
 * "no project" first, then by title. Tabs keep their order inside a group.
 */
export function groupTabs<T>(
  inputs: ReadonlyArray<TabGroupInput<T>>,
  savedOrder: ReadonlyArray<string>,
): TabGroup<T>[] {
  const byId = new Map<string, TabGroup<T>>();
  for (const input of inputs) {
    const group = byId.get(input.groupId);
    if (group) group.items.push(input.item);
    else
      byId.set(input.groupId, { groupId: input.groupId, title: input.title, items: [input.item] });
  }
  const placed = savedOrder.flatMap((id) => {
    const group = byId.get(id);
    return group ? [group] : [];
  });
  const placedIds = new Set(placed.map((group) => group.groupId));
  const rest = [...byId.values()]
    .filter((group) => !placedIds.has(group.groupId))
    .toSorted((a, b) => {
      if (a.groupId === SCRATCH_TAB_GROUP_ID) return -1;
      if (b.groupId === SCRATCH_TAB_GROUP_ID) return 1;
      return a.title.localeCompare(b.title);
    });
  return [...placed, ...rest];
}

/** Moves `groupId` to where `targetId` is: before it when dragged left, after it when dragged right. */
export function moveGroupId(order: ReadonlyArray<string>, groupId: string, targetId: string) {
  const from = order.indexOf(groupId);
  const to = order.indexOf(targetId);
  if (from === -1 || to === -1 || from === to) return [...order];
  const next = order.filter((id) => id !== groupId);
  next.splice(to, 0, groupId);
  return next;
}
