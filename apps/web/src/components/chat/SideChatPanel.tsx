import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { deriveThreadActivityRun } from "@t3tools/client-runtime/state/thread-execution";
import { ArrowUpIcon, ExternalLinkIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { newMessageId } from "~/lib/utils";
import { useThreadProjection, useThreadVisibleTurnItems } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";

const WORKING_RUN_STATUSES = new Set(["preparing", "starting", "running"]);

interface SideChatMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly streaming: boolean;
}

/**
 * A /btw side chat inside its main chat's right panel. The thread is a fork, so it
 * already knows the main chat; only the messages sent here are shown.
 */
export function SideChatPanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string | undefined;
  readonly onOpenAsChat: () => void;
}) {
  const { threadRef } = props;
  const projection = useThreadProjection(threadRef)?.projection ?? null;
  const turnItems = useThreadVisibleTurnItems(threadRef);
  const startThreadTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Items copied from the main chat are "inherited"; the side chat's own are "local".
  const messages = turnItems.flatMap((projected): SideChatMessage[] => {
    if (projected.visibility !== "local") return [];
    const { item } = projected;
    switch (item.type) {
      case "user_message":
        return [{ id: item.id, role: "user", text: item.text, streaming: false }];
      case "assistant_message":
        return [{ id: item.id, role: "assistant", text: item.text, streaming: item.streaming }];
      case "proposed_plan":
        // Plan mode can answer with a plan instead of a message.
        return [
          {
            id: item.id,
            role: "assistant",
            text: item.markdown,
            streaming: item.streaming,
          },
        ];
      default:
        return [];
    }
  });
  const activityRun = projection === null ? null : deriveThreadActivityRun(projection);
  const working = sending || (activityRun !== null && WORKING_RUN_STATUSES.has(activityRun.status));
  const waiting = activityRun?.status === "waiting";
  const lastMessage = messages.at(-1);

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- New and streaming text grow the list; follow it to the bottom.
  }, [messages.length, lastMessage?.text.length, working]);

  const send = async () => {
    const text = draft.trim();
    if (text.length === 0 || working) return;
    setSending(true);
    setError(null);
    const result = await startThreadTurn({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        message: { messageId: newMessageId(), role: "user", text, attachments: [] },
        runtimeMode: "approval-required",
        interactionMode: "plan",
        createdAt: new Date().toISOString(),
      },
    });
    setSending(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Failed to send the message.");
      }
      return;
    }
    setDraft("");
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">
          Read-only side chat. It knows the main chat up to its last finished reply.
        </span>
        <Button size="xs" variant="ghost" onClick={props.onOpenAsChat}>
          <ExternalLinkIcon className="size-3" />
          Open as chat
        </Button>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {messages.length === 0 && !working ? (
          <p className="text-center text-sm text-muted-foreground">
            Ask anything about the main chat. Nothing you ask here is added to it.
          </p>
        ) : null}
        <div className="flex flex-col gap-3">
          {messages.map((message) =>
            message.role === "user" ? (
              <div
                key={message.id}
                className="ms-6 self-end whitespace-pre-wrap rounded-lg bg-muted px-2.5 py-1.5 text-sm"
              >
                {message.text}
              </div>
            ) : (
              <ChatMarkdown
                key={message.id}
                text={message.text}
                cwd={props.cwd}
                threadRef={threadRef}
                isStreaming={message.streaming}
              />
            ),
          )}
        </div>
        {working ? (
          <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner className="size-3" />
            Thinking…
          </div>
        ) : null}
        {waiting ? (
          <p className="mt-3 text-xs text-muted-foreground">
            The side chat is waiting for an answer or approval. Use "Open as chat" to reply.
          </p>
        ) : null}
        {error ? <p className="mt-3 text-xs text-destructive">{error}</p> : null}
      </div>
      <form
        className="flex items-end gap-2 border-t border-border/60 p-2"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <Textarea
          size="sm"
          value={draft}
          placeholder="Ask a side question…"
          aria-label="Side chat message"
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <Button
          type="submit"
          size="icon-sm"
          aria-label="Send side chat message"
          disabled={working || draft.trim().length === 0}
        >
          <ArrowUpIcon className="size-4" />
        </Button>
      </form>
    </div>
  );
}
