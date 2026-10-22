import type { PullRequestRef, ScopedThreadRef, ThreadPullRequestUpdates } from "@t3tools/contracts";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import { BellIcon, BotIcon, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { useServerConfigs, useThreadShell } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PullRequestGlyph } from "./pullRequestIcons";

const HOLD_TO_REVEAL_MS = 300;

export const PULL_REQUEST_UPDATE_LEVELS: ReadonlyArray<{
  readonly value: ThreadPullRequestUpdates;
  readonly label: string;
  readonly description: string;
  readonly icon: LucideIcon;
}> = [
  {
    value: "link",
    label: "Link only",
    description: "Keeps the link. No notifications, nothing sent to the chat.",
    icon: PullRequestGlyph.link,
  },
  {
    value: "notify",
    label: "Notify",
    description: "Notifies you about comments, approvals, checks and merges.",
    icon: BellIcon,
  },
  {
    value: "act",
    label: "Auto-action",
    description:
      "Sends comments, approvals, checks and merges to the chat while it is not settled.",
    icon: BotIcon,
  },
];

/**
 * Three icons; pressing and holding shows every label, and letting go over one picks it.
 */
export function PullRequestUpdatesToggle({
  value,
  defaultValue,
  onChange,
  disabled = false,
  className,
}: {
  value: ThreadPullRequestUpdates;
  /** The level this one falls back to, marked in its tooltip. */
  defaultValue?: ThreadPullRequestUpdates;
  onChange: (value: ThreadPullRequestUpdates) => void;
  disabled?: boolean;
  className?: string | undefined;
}) {
  const [revealed, setRevealed] = useState(false);
  const holdTimer = useRef<number | null>(null);
  const pressed = useRef<ThreadPullRequestUpdates | null>(null);

  const clearHold = () => {
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
    holdTimer.current = null;
  };
  useEffect(
    () => () => {
      if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
    },
    [],
  );

  const levelAt = (x: number, y: number) =>
    (document.elementFromPoint(x, y)?.closest("[data-update-level]") as HTMLElement | null)?.dataset
      .updateLevel as ThreadPullRequestUpdates | undefined;

  return (
    <div
      role="radiogroup"
      aria-label="Pull request updates"
      data-revealed={revealed || undefined}
      className={cn(
        "inline-flex shrink-0 touch-none select-none items-center gap-0.5 rounded-lg bg-input/40 p-0.5",
        disabled && "pointer-events-none opacity-50",
        className,
      )}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        pressed.current = levelAt(event.clientX, event.clientY) ?? null;
        event.currentTarget.setPointerCapture(event.pointerId);
        clearHold();
        holdTimer.current = window.setTimeout(() => setRevealed(true), HOLD_TO_REVEAL_MS);
      }}
      onPointerUp={(event) => {
        clearHold();
        // A quick click picks what it pressed; after a hold, whatever the pointer is over.
        const picked = revealed ? levelAt(event.clientX, event.clientY) : pressed.current;
        pressed.current = null;
        setRevealed(false);
        if (picked !== undefined && picked !== null && picked !== value) onChange(picked);
      }}
      onPointerCancel={() => {
        clearHold();
        pressed.current = null;
        setRevealed(false);
      }}
    >
      {PULL_REQUEST_UPDATE_LEVELS.map((level) => {
        const active = level.value === value;
        const Icon = level.icon;
        const name = `${level.label}${level.value === defaultValue ? " (default)" : ""}`;
        return (
          <Tooltip key={level.value}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={name}
                  data-update-level={level.value}
                  tabIndex={active ? 0 : -1}
                  className={cn(
                    "inline-flex h-6 min-w-6 items-center justify-center gap-1 rounded-md px-1.5 text-muted-foreground outline-hidden transition-[color,background-color,box-shadow] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                    active
                      ? "bg-background text-foreground shadow-xs dark:bg-input"
                      : "hover:text-foreground",
                  )}
                  // Pointer picks happen on the group; this only serves the keyboard.
                  onClick={(event) => {
                    if (event.detail === 0 && !active) onChange(level.value);
                  }}
                  onKeyDown={(event) => {
                    const step =
                      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
                    if (step === 0) return;
                    event.preventDefault();
                    const index = PULL_REQUEST_UPDATE_LEVELS.findIndex(
                      (candidate) => candidate.value === value,
                    );
                    const next =
                      PULL_REQUEST_UPDATE_LEVELS[
                        (index + step + PULL_REQUEST_UPDATE_LEVELS.length) %
                          PULL_REQUEST_UPDATE_LEVELS.length
                      ];
                    if (next === undefined) return;
                    onChange(next.value);
                    const group = event.currentTarget.parentElement;
                    requestAnimationFrame(() =>
                      group
                        ?.querySelector<HTMLElement>(`[data-update-level="${next.value}"]`)
                        ?.focus(),
                    );
                  }}
                >
                  <Icon aria-hidden className="size-3.5 shrink-0" />
                  <span
                    aria-hidden
                    className={cn(
                      "overflow-hidden whitespace-nowrap text-xs transition-[max-width,opacity] duration-150 ease-out motion-reduce:transition-none",
                      revealed ? "max-w-24 opacity-100" : "max-w-0 opacity-0",
                    )}
                  >
                    {level.label}
                  </span>
                </button>
              }
            />
            {revealed ? null : (
              <TooltipPopup side="bottom" className="max-w-64">
                <span className="font-medium">{name}</span>
                <span className="block text-muted-foreground">{level.description}</span>
              </TooltipPopup>
            )}
          </Tooltip>
        );
      })}
    </div>
  );
}

/** The toggle for one pull request linked to a thread; nothing when the thread does not link it. */
export function ThreadPullRequestUpdatesControl({
  threadRef,
  reference,
  className,
}: {
  threadRef: ScopedThreadRef;
  reference: Pick<PullRequestRef, "repository" | "number">;
  className?: string;
}) {
  const thread = useThreadShell(threadRef);
  const config = useServerConfigs().get(threadRef.environmentId);
  const watch = useAtomCommand(threadEnvironment.watchPullRequest, { reportFailure: true });
  const repository = reference.repository.toLowerCase();
  const link = visibleThreadPullRequests(thread?.pullRequests ?? []).find(
    (candidate) =>
      candidate.number === reference.number && candidate.repository.toLowerCase() === repository,
  );
  if (link === undefined || config?.environment.capabilities.threadPullRequestWatch !== true) {
    return null;
  }
  const fallback = config.settings.pullRequestUpdates;
  return (
    <PullRequestUpdatesToggle
      value={link.updates ?? fallback}
      defaultValue={fallback}
      className={className}
      onChange={(updates) =>
        void watch({
          environmentId: threadRef.environmentId,
          input: {
            threadId: threadRef.threadId,
            host: link.host,
            repository: link.repository,
            number: link.number,
            watching: updates !== "link",
            updates,
          },
        })
      }
    />
  );
}
