import type {
  DeviceServiceState,
  EnvironmentId,
  MessageId,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useRightPanelStore } from "~/rightPanelStore";
import { DeviceSetup } from "../device/DeviceSetup";
import { PullRequestThreadDialog } from "../PullRequestThreadDialog";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { WizardPopup } from "../ui/wizard";
import { registerThreadOverlay } from "./threadOverlayRetention";

/**
 * Open state for overlays the chat view hosts. It lives in atoms rather than
 * ChatView state so opening or closing one renders only its host, not the
 * whole chat chrome. Each entry carries the thread it was opened for; a host
 * shows only its own thread's entry, and leaving that thread's route drops it.
 */
type ThreadOverlayAtom<T> = Atom.Writable<{ readonly threadKey: string; readonly value: T } | null>;

function makeThreadOverlayAtom<T>(label: string): ThreadOverlayAtom<T> {
  const atom = Atom.make<{ readonly threadKey: string; readonly value: T } | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel(`chat:${label}`),
  );
  registerThreadOverlay((threadKey) => {
    const entry = appAtomRegistry.get(atom);
    if (entry !== null && entry.threadKey !== threadKey) closeThreadOverlay(atom);
  });
  return atom;
}

function closeThreadOverlay<T>(atom: ThreadOverlayAtom<T>): void {
  appAtomRegistry.set(atom, null);
}

function useThreadOverlay<T>(atom: ThreadOverlayAtom<T>, threadKey: string | null): T | null {
  const entry = useAtomValue(atom);
  return threadKey !== null && entry?.threadKey === threadKey ? entry.value : null;
}

const pullRequestThreadDialogAtom = makeThreadOverlayAtom<{
  readonly initialReference: string | null;
  readonly key: number;
}>("pull-request-thread-dialog");

export function openPullRequestThreadDialog(threadKey: string, reference?: string): void {
  appAtomRegistry.set(pullRequestThreadDialogAtom, {
    threadKey,
    value: { initialReference: reference ?? null, key: Date.now() },
  });
}

export function PullRequestThreadDialogHost(props: {
  readonly threadKey: string | null;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly cwd: string | null;
  readonly onPrepared: (input: {
    branch: string;
    worktreePath: string | null;
  }) => Promise<void> | void;
}) {
  const state = useThreadOverlay(pullRequestThreadDialogAtom, props.threadKey);
  if (state === null) return null;
  return (
    <PullRequestThreadDialog
      key={state.key}
      open
      environmentId={props.environmentId}
      threadId={props.threadId}
      cwd={props.cwd}
      initialReference={state.initialReference}
      onOpenChange={(open) => {
        if (!open) closeThreadOverlay(pullRequestThreadDialogAtom);
      }}
      onPrepared={props.onPrepared}
    />
  );
}

const deviceSetupDialogAtom = makeThreadOverlayAtom<true>("device-setup-dialog");

export function openDeviceSetupDialog(threadKey: string): void {
  appAtomRegistry.set(deviceSetupDialogAtom, { threadKey, value: true });
}

export function DeviceSetupDialogHost(props: {
  readonly threadKey: string | null;
  readonly threadRef: ScopedThreadRef | null;
  readonly state: DeviceServiceState;
}) {
  const open = useThreadOverlay(deviceSetupDialogAtom, props.threadKey) !== null;
  const { threadRef } = props;
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) closeThreadOverlay(deviceSetupDialogAtom);
      }}
    >
      <WizardPopup>
        {threadRef ? (
          <DeviceSetup
            environmentId={threadRef.environmentId}
            state={props.state}
            onComplete={() => {
              useRightPanelStore.getState().open(threadRef, "device");
              closeThreadOverlay(deviceSetupDialogAtom);
            }}
          />
        ) : null}
      </WizardPopup>
    </Dialog>
  );
}

const branchRestoreConfirmAtom = makeThreadOverlayAtom<true>("branch-restore-confirm");

export function openBranchRestoreConfirm(threadKey: string): void {
  appAtomRegistry.set(branchRestoreConfirmAtom, { threadKey, value: true });
}

export function BranchRestoreConfirmHost(props: {
  readonly threadKey: string | null;
  readonly threadBranch: string;
  readonly canWriteSourceControl: boolean;
  readonly onConfirm: () => void;
}) {
  const open = useThreadOverlay(branchRestoreConfirmAtom, props.threadKey) !== null;
  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) closeThreadOverlay(branchRestoreConfirmAtom);
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Switch to <code className="font-medium">{props.threadBranch}</code>?
          </AlertDialogTitle>
          <AlertDialogDescription>
            You have uncommitted changes. They'll carry over to the other branch, or block the
            switch if they conflict.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button
            variant="default"
            disabled={!props.canWriteSourceControl}
            onClick={() => {
              closeThreadOverlay(branchRestoreConfirmAtom);
              props.onConfirm();
            }}
          >
            Switch branch
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

export interface RevertChangedFile {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

export interface PendingRevert {
  readonly turnCount: number;
  readonly messageId: MessageId;
  /** Files changed by turns after the message, so the user can keep or revert them. */
  readonly files: ReadonlyArray<RevertChangedFile>;
  /** Set when the message was edited in place and should be re-sent with this text. */
  readonly editedText?: string;
}

const revertConfirmAtom = makeThreadOverlayAtom<PendingRevert>("revert-confirm");

export function openRevertConfirm(threadKey: string, pending: PendingRevert): void {
  appAtomRegistry.set(revertConfirmAtom, { threadKey, value: pending });
}

export function RevertConfirmHost(props: {
  readonly threadKey: string;
  readonly onConfirm: (pending: PendingRevert, restoreFiles: boolean) => void;
}) {
  const pending = useThreadOverlay(revertConfirmAtom, props.threadKey);
  const confirm = (restoreFiles: boolean) => {
    if (pending === null) return;
    closeThreadOverlay(revertConfirmAtom);
    props.onConfirm(pending, restoreFiles);
  };
  const files = pending?.files ?? [];
  return (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) closeThreadOverlay(revertConfirmAtom);
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Keep or revert code changes?</AlertDialogTitle>
          <AlertDialogDescription>
            {files.length === 1 ? "1 file was" : `${files.length} files were`} changed after this
            message. The chat will go back to before it. Reverting also undoes your own edits to
            these files.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="mx-6 mb-2 max-h-56 overflow-y-auto rounded-lg border border-border/70 text-xs">
          {files.map((file) => (
            <li
              key={file.path}
              className="flex items-center justify-between gap-3 border-b border-border/50 px-3 py-1.5 last:border-b-0"
            >
              <span className="min-w-0 truncate font-mono">{file.path}</span>
              <span className="shrink-0 tabular-nums">
                <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>{" "}
                <span className="text-destructive">-{file.deletions}</span>
              </span>
            </li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button variant="destructive" onClick={() => confirm(true)}>
            Revert code changes
          </Button>
          <Button onClick={() => confirm(false)}>Keep code changes</Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
