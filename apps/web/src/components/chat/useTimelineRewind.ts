import type { EnvironmentThreadShell, ThreadStructure } from "@t3tools/client-runtime/state/shell";
import type { ComposerThreadTarget } from "../../composerDraftStore";
import type { ComposerHandleRef } from "../../composerHandleContext";
import type { SessionPhase } from "../../types";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  type EnvironmentId,
  type MessageId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ScopedThreadRef,
  type ThreadId,
  type RunId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { readLocalApi } from "../../localApi";
import { findRevertCheckpoint } from "../../session-logic";
import { type ChatMessage } from "../../types";
import { newMessageId, newThreadId, randomUUID } from "~/lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useComposerDraftStore } from "../../composerDraftStore";
import { threadEnvironment } from "../../state/threads";
import { waitForThreadShell } from "../../state/entities";
import { openRevertConfirm, type PendingRevert, type RevertChangedFile } from "./ChatOverlayHosts";
import { assetEnvironment } from "../../state/assets";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { rewindToMessage } from "./chatViewSend";
import {
  hasAgentFileEditInRuns,
  makeThreadErrorSetter,
  waitForRevertedMessage,
} from "../ChatView.logic";
import type { ThreadCheckpointSummary } from "@t3tools/client-runtime/state/thread-checkpoints";
interface TimelineRewindInput {
  readonly environmentId: EnvironmentId;
  readonly routeThreadRef: ScopedThreadRef;
  readonly routeThreadKey: string;
  readonly currentRouteThreadKeyRef: { readonly current: string | null };
  readonly serverProjection: ThreadStructure | null;
  readonly activeThread: EnvironmentThreadShell | undefined;
  readonly timelineMessages: ReadonlyArray<ChatMessage>;
  readonly phase: SessionPhase;
  readonly isConnecting: boolean;
  readonly isSendBusy: boolean;
  readonly isRevertingCheckpoint: boolean;
  readonly supportsConversationRollback: boolean;
  readonly activeEnvironmentUnavailable: boolean;
  readonly activeEnvironmentUnavailableLabel: string | null;
  readonly promptRef: { current: string };
  readonly composerRef: ComposerHandleRef;
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly setThreadError: ReturnType<typeof makeThreadErrorSetter>;
  readonly turnDiffSummaries: ReadonlyArray<ThreadCheckpointSummary>;
  readonly serverVisibleTurnItems: ThreadStructure["visibleTurnItems"];
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

/**
 * Going back in a thread's timeline: reverting to an earlier turn (restoring that message into
 * the composer), rolling back a provider checkpoint, and forking a new thread from a run.
 */
export function useTimelineRewind(input: TimelineRewindInput) {
  const {
    environmentId,
    routeThreadRef,
    routeThreadKey,
    currentRouteThreadKeyRef,
    serverProjection,
    activeThread,
    timelineMessages,
    phase,
    isConnecting,
    isSendBusy,
    isRevertingCheckpoint,
    supportsConversationRollback,
    activeEnvironmentUnavailable,
    activeEnvironmentUnavailableLabel,
    promptRef,
    composerRef,
    composerDraftTarget,
    setThreadError,
    turnDiffSummaries,
    serverVisibleTurnItems,
    runtimeMode,
    interactionMode,
  } = input;
  const navigate = useNavigate();
  const createAttachmentAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });

  const revertThreadCheckpoint = useOrchestrationCommand(threadEnvironment.revertCheckpoint, {
    reportFailure: false,
  });
  const forkThreadFromRun = useAtomCommand(threadEnvironment.forkFromRun, {
    reportFailure: false,
  });
  const startThreadTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });

  const changedFilesAfterTurn = (turnCount: number): RevertChangedFile[] => {
    const byPath = new Map<string, RevertChangedFile>();
    for (const summary of turnDiffSummaries) {
      if (summary.checkpointTurnCount <= turnCount) continue;
      for (const file of summary.files) {
        const existing = byPath.get(file.path);
        byPath.set(file.path, {
          path: file.path,
          additions: (existing?.additions ?? 0) + file.additions,
          deletions: (existing?.deletions ?? 0) + file.deletions,
        });
      }
    }
    return [...byPath.values()];
  };

  const onRevertToTurnCount = async (
    turnCount: number,
    messageId: MessageId,
    restoreFiles?: boolean,
  ) => {
    const localApi = readLocalApi();
    if (
      !localApi ||
      !activeThread ||
      isRevertingCheckpoint ||
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
    )
      return;
    const message = timelineMessages.find((message) => message.id === messageId);
    if (!message || message.role !== "user") return;

    if (!supportsConversationRollback) {
      setThreadError(
        activeThread.id,
        "This provider does not support reverting conversation history. Start a new thread instead.",
      );
      return;
    }
    if (activeEnvironmentUnavailable && activeEnvironmentUnavailableLabel) {
      setThreadError(
        activeThread.id,
        `Reconnect ${activeEnvironmentUnavailableLabel} before reverting checkpoints.`,
      );
      return;
    }
    if (phase === "running" || isSendBusy || isConnecting) {
      setThreadError(activeThread.id, "Interrupt the current turn before reverting checkpoints.");
      return;
    }
    if (restoreFiles === undefined) {
      const files = changedFilesAfterTurn(turnCount);
      if (files.length === 0) {
        void onRevertToTurnCount(turnCount, messageId, false);
        return;
      }
      openRevertConfirm(routeThreadKey, { turnCount, messageId, files });
      return;
    }

    useComposerDraftStore.setState((store) => ({
      rewindingThreadKeys: new Set(store.rewindingThreadKeys).add(routeThreadKey),
    }));
    setThreadError(activeThread.id, null);
    const rewind = await rewindToMessage({
      message,
      environmentId,
      routeThreadRef,
      threadId: activeThread.id,
      turnCount,
      restoreFiles,
      // Keep the live checkpoint identity when command context refetches a bounded window.
      checkpoint: findRevertCheckpoint(serverProjection?.checkpoints ?? [], turnCount),
      draftTarget: composerDraftTarget,
      composerHasPendingAttachments: composerRef.current?.hasPendingAttachments() === true,
      createAssetUrl: createAttachmentAssetUrl,
      revertThreadCheckpoint,
    });
    useComposerDraftStore.setState((store) => {
      const remaining = new Set(store.rewindingThreadKeys);
      remaining.delete(routeThreadKey);
      return { rewindingThreadKeys: remaining };
    });
    if (rewind.error !== null) {
      setThreadError(activeThread.id, rewind.error);
      return;
    }
    if (currentRouteThreadKeyRef.current === routeThreadKey) {
      const nextPrompt = rewind.prompt;
      promptRef.current = nextPrompt;
      composerRef.current?.resetCursorState({ prompt: nextPrompt, cursor: nextPrompt.length });
      requestAnimationFrame(() => {
        if (currentRouteThreadKeyRef.current === routeThreadKey) composerRef.current?.focusAtEnd();
      });
    }
  };
  const onRevertToTurnCountStable = useStableCallback(onRevertToTurnCount);
  const performEditMessage = async (
    turnCount: number,
    messageId: MessageId,
    text: string,
    restoreFiles: boolean,
  ) => {
    if (!activeThread) return;
    setThreadError(activeThread.id, null);
    const commandId = CommandId.make(randomUUID());
    const revertError = await waitForRevertedMessage(
      routeThreadRef,
      turnCount,
      commandId,
      async () => {
        const result = await revertThreadCheckpoint({
          environmentId,
          input: { commandId, threadId: activeThread.id, turnCount, restoreFiles },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      },
    ).then(
      () => null,
      (error: unknown) => error ?? new Error("Could not edit the message."),
    );
    if (revertError !== null) {
      setThreadError(
        activeThread.id,
        revertError instanceof Error ? revertError.message : "Could not edit the message.",
      );
      return;
    }
    const result = await startThreadTurn({
      environmentId,
      input: {
        threadId: activeThread.id,
        message: { messageId: newMessageId(), role: "user", text, attachments: [] },
        runtimeMode,
        interactionMode,
        dispatchMode: "start",
      },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setThreadError(
        activeThread.id,
        error instanceof Error ? error.message : "Could not edit the message.",
      );
    }
  };
  const onEditMessage = (turnCount: number, messageId: MessageId, text: string) => {
    if (
      !activeThread ||
      isRevertingCheckpoint ||
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
    ) {
      return;
    }
    if (!supportsConversationRollback) {
      setThreadError(
        activeThread.id,
        "This provider does not support reverting conversation history. Start a new thread instead.",
      );
      return;
    }
    if (phase === "running" || isSendBusy || isConnecting) {
      setThreadError(activeThread.id, "Interrupt the current turn before editing a message.");
      return;
    }
    const files = changedFilesAfterTurn(turnCount);
    const droppedRunIds = new Set(
      turnDiffSummaries
        .filter((summary) => summary.checkpointTurnCount > turnCount)
        .map((summary) => summary.runId),
    );
    if (files.length === 0 || !hasAgentFileEditInRuns(serverVisibleTurnItems, droppedRunIds)) {
      void performEditMessage(turnCount, messageId, text, false);
      return;
    }
    openRevertConfirm(routeThreadKey, { turnCount, messageId, files, editedText: text });
  };
  const onEditMessageStable = useStableCallback(onEditMessage);
  const onConfirmRevert = (pending: PendingRevert, restoreFiles: boolean) => {
    if (pending.editedText !== undefined) {
      void performEditMessage(
        pending.turnCount,
        pending.messageId,
        pending.editedText,
        restoreFiles,
      );
      return;
    }
    void onRevertToTurnCount(pending.turnCount, pending.messageId, restoreFiles);
  };
  const onConfirmRevertStable = useStableCallback(onConfirmRevert);

  const onRollbackCheckpoint = async (input: {
    readonly checkpointId: string;
    readonly scopeId: string;
  }) => {
    if (!activeThread || isRevertingCheckpoint) return;
    if (activeEnvironmentUnavailable && activeEnvironmentUnavailableLabel) {
      setThreadError(
        activeThread.id,
        `Reconnect ${activeEnvironmentUnavailableLabel} before reverting checkpoints.`,
      );
      return;
    }
    if (phase === "running" || isSendBusy || isConnecting) {
      setThreadError(activeThread.id, "Interrupt the current turn before reverting checkpoints.");
      return;
    }
    const localApi = readLocalApi();
    const confirmed =
      localApi == null
        ? window.confirm("Roll back this thread to the selected checkpoint?")
        : await localApi.dialogs.confirm(
            "Roll back this thread to the selected checkpoint?\nThis action cannot be undone.",
          );
    if (!confirmed) return;

    useComposerDraftStore.setState((store) => ({
      rewindingThreadKeys: new Set(store.rewindingThreadKeys).add(routeThreadKey),
    }));
    setThreadError(activeThread.id, null);
    const result = await revertThreadCheckpoint({
      environmentId,
      input: {
        threadId: activeThread.id,
        checkpointId: input.checkpointId,
        scopeId: input.scopeId,
      },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setThreadError(
        activeThread.id,
        error instanceof Error ? error.message : "Failed to revert thread state.",
      );
    }
    useComposerDraftStore.setState((store) => {
      const remaining = new Set(store.rewindingThreadKeys);
      remaining.delete(routeThreadKey);
      return { rewindingThreadKeys: remaining };
    });
  };

  const onForkFromRun = async (input: {
    readonly sourceThreadId: ThreadId;
    readonly runId: RunId;
  }) => {
    if (!activeThread || activeEnvironmentUnavailable) return;
    const targetThreadId = newThreadId();
    const targetThreadRef = scopeThreadRef(environmentId, targetThreadId);
    const result = await forkThreadFromRun({
      environmentId,
      input: {
        sourceThreadId: input.sourceThreadId,
        targetThreadId,
        runId: input.runId,
        title: `${activeThread.title} fork`,
      },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          activeThread.id,
          error instanceof Error ? error.message : "Failed to fork this response.",
        );
      }
      return;
    }
    const targetThreadReady = await waitForThreadShell(targetThreadRef);
    if (!targetThreadReady) {
      setThreadError(
        activeThread.id,
        "The fork was created, but its thread data did not reach this client. Reconnect and try opening it from the sidebar.",
      );
      return;
    }
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(targetThreadRef),
    });
  };
  const onForkFromRunStable = useStableCallback(onForkFromRun);
  const onTimelineRollbackCheckpoint = (input: {
    readonly checkpointId: string;
    readonly scopeId: string;
  }) => {
    void onRollbackCheckpoint(input);
  };
  const onTimelineRollbackCheckpointStable = useStableCallback(onTimelineRollbackCheckpoint);
  const onRevertTimelineTurn = (targetTurnCount: number, messageId: MessageId) => {
    void onRevertToTurnCountStable(targetTurnCount, messageId);
  };
  const onRevertTimelineTurnStable = useStableCallback(onRevertTimelineTurn);
  return {
    onConfirmRevertStable,
    onEditMessageStable,
    onForkFromRunStable,
    onRevertTimelineTurnStable,
    onTimelineRollbackCheckpointStable,
  };
}
