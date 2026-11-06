import type { GcpDelivery, GcpDeliveryStage, JiraChangeSet } from "@t3tools/contracts";

import type { GcpFinishingChat } from "./gcpFinishingStore";

/** The stage that speaks for a chat with several pull requests: failures first, then the slowest. */
const STAGE_ORDER: ReadonlyArray<GcpDeliveryStage> = [
  "test-failed",
  "prod-failed",
  "merged",
  "deploying-test",
  "on-test",
  "deploying-prod",
  "in-prod",
];

export interface ChatDelivery {
  readonly stage: GcpDeliveryStage;
  /** The pull requests at that stage. */
  readonly deliveries: ReadonlyArray<GcpDelivery>;
  readonly label: string;
}

export function chatDelivery(
  deliveries: ReadonlyArray<GcpDelivery>,
  threadId: string,
): ChatDelivery | null {
  const own = deliveries.filter((delivery) => delivery.threadId === threadId);
  const stage = STAGE_ORDER.find((candidate) => own.some((entry) => entry.stage === candidate));
  if (stage === undefined) return null;
  const members = own.filter((entry) => entry.stage === stage);
  return {
    stage,
    deliveries: members,
    label: members.map((entry) => `#${entry.number}`).join(", "),
  };
}

/**
 * Whether a finishing chat can settle. Its new cards must have arrived first: the snapshot can lag
 * the draft's reply, and an empty list then would settle before the cards were ever shown.
 */
export function cardsResolved(
  chat: Pick<GcpFinishingChat, "expectedCards" | "knownCardIds">,
  changeSets: ReadonlyArray<{
    readonly id: string;
    readonly threadId: string | null;
    readonly state: JiraChangeSet["state"];
  }>,
  threadId: string | undefined,
): boolean {
  const cards = changeSets.filter((set) => set.threadId === threadId);
  const drafted = cards.filter((set) => !chat.knownCardIds.includes(set.id));
  if (drafted.length < chat.expectedCards) return false;
  return !cards.some((set) => ["pending", "applying", "failed"].includes(set.state));
}
