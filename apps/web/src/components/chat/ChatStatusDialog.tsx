import type {
  OrchestrationV2ThreadProjection,
  ProviderInteractionMode,
  RuntimeMode,
  ServerProvider,
} from "@t3tools/contracts";
import { formatModelSelectionEffort } from "@t3tools/client-runtime/state/thread-execution";
import type { ReactNode } from "react";

import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

const RUNTIME_MODE_LABELS: Record<RuntimeMode, string> = {
  "approval-required": "Ask before edits and commands",
  "auto-accept-edits": "Auto-accept edits",
  auto: "Auto",
  "full-access": "Full access (bypass permissions)",
};

function Row(props: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-3 text-sm">
      <span className="text-muted-foreground">{props.label}</span>
      <span className="min-w-0 break-words">{props.children}</span>
    </div>
  );
}

/**
 * /status: what this chat runs on, like Claude Code's own /status. Claude Code
 * doesn't offer /status through its SDK, so this is built from what T3 knows.
 */
export function ChatStatusDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: ServerProvider | null;
  projection: OrchestrationV2ThreadProjection | null;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  cwd: string | null;
}) {
  const { provider, projection } = props;
  const latestRun =
    projection?.runs.reduce<OrchestrationV2ThreadProjection["runs"][number] | null>(
      (latest, run) => (latest === null || run.ordinal > latest.ordinal ? run : latest),
      null,
    ) ?? null;
  const modelSelection = latestRun?.modelSelection ?? projection?.thread.modelSelection ?? null;
  const modelName =
    modelSelection === null
      ? null
      : (provider?.models.find((model) => model.slug === modelSelection.model)?.name ??
        modelSelection.model);
  const effort =
    modelSelection === null ? null : formatModelSelectionEffort(modelSelection, provider?.models);
  const latestAttempt =
    projection?.attempts.findLast(
      (attempt) => latestRun === null || attempt.runId === latestRun.id,
    ) ?? null;
  const sessionId = latestAttempt?.nativeThreadId ?? null;
  const isClaude = provider?.driver === "claudeAgent";

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Status</DialogTitle>
          <DialogDescription>
            What this chat runs on{provider ? ` (${provider.displayName ?? provider.driver})` : ""}.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-2">
            <Row label="Version">
              {provider?.version
                ? `${isClaude ? "Claude Code " : ""}${provider.version}`
                : "Unknown"}
            </Row>
            <Row label="Status">
              {provider
                ? provider.status.charAt(0).toUpperCase() + provider.status.slice(1)
                : "Unknown"}
              {provider?.message ? (
                <span className="block text-muted-foreground text-xs">{provider.message}</span>
              ) : null}
            </Row>
            <Row label="Login">
              {provider?.auth.label ?? provider?.auth.status ?? "Unknown"}
              {provider?.auth.email ? (
                <span className="block text-muted-foreground text-xs">{provider.auth.email}</span>
              ) : null}
            </Row>
            <Row label="Model">
              {modelName ?? "Unknown"}
              {effort ? <span className="text-muted-foreground"> · {effort} effort</span> : null}
            </Row>
            <Row label="Permissions">
              {props.interactionMode === "plan"
                ? `Plan mode · ${RUNTIME_MODE_LABELS[props.runtimeMode]}`
                : RUNTIME_MODE_LABELS[props.runtimeMode]}
            </Row>
            <Row label="Folder">
              <span className="font-mono text-xs">
                {props.cwd ?? "No project (scratch folder)"}
              </span>
            </Row>
            <Row label="Session ID">
              <span className="font-mono text-xs">{sessionId ?? "Not started yet"}</span>
            </Row>
          </div>
          {isClaude ? (
            <p className="mt-4 text-pretty text-muted-foreground text-xs">
              For MCP servers send /mcp, for the context breakdown send /context, and for plan
              limits send /usage.
            </p>
          ) : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
