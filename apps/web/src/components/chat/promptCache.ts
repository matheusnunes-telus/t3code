import { threadRuntimeCanArchive } from "@t3tools/client-runtime/state/models";
import type { ThreadShell } from "../../types";

/** Claude Code's prompt cache lasts an hour and restarts after every turn. */
export const CLAUDE_PROMPT_CACHE_TTL_MS = 60 * 60 * 1000;
export const PROMPT_CACHE_WARNING_MS = 10 * 60 * 1000;

const CLAUDE_DRIVER = "claudeAgent";

/**
 * Time left on a Claude chat's prompt cache, or null when it doesn't apply: another
 * provider, a chat that hasn't finished a turn, or a turn still running (the cache
 * is being refreshed). Zero means it has expired.
 */
export function resolvePromptCacheRemainingMs(input: {
  readonly thread: Pick<ThreadShell, "latestRun" | "runtime"> | null | undefined;
  readonly driver: string | null | undefined;
  readonly nowIso: string;
}): number | null {
  const { thread, driver, nowIso } = input;
  if (!thread || driver !== CLAUDE_DRIVER) return null;
  if (!threadRuntimeCanArchive(thread.runtime)) return null;
  const completedAt = thread.latestRun?.completedAt;
  if (!completedAt) return null;
  const completedMs = Date.parse(completedAt);
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(completedMs) || !Number.isFinite(nowMs)) return null;
  return Math.max(0, completedMs + CLAUDE_PROMPT_CACHE_TTL_MS - nowMs);
}

export function formatPromptCacheRemaining(remainingMs: number): string {
  const minutes = Math.ceil(remainingMs / 60_000);
  if (minutes <= 1) return "1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}
