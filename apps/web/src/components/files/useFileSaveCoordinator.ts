import { AuthFilesystemWriteScope, type EnvironmentId } from "@t3tools/contracts";
import { createRef, useEffect, useState } from "react";

import { useFileAutoSaveStore } from "~/fileAutoSaveStore";
import { projectEnvironment } from "~/state/projects";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import { FileSaveCoordinator } from "./fileSaveCoordinator";
import {
  confirmProjectFileQueryData,
  getUnsavedProjectFileQueryData,
} from "./projectFilesQueryState";

const FILE_SAVE_DEBOUNCE_MS = 500;

// Every mounted editor's coordinator, so mod+S and turning auto-save back on
// can save whatever is pending.
const liveCoordinators = new Set<FileSaveCoordinator>();

export function saveAllPendingFiles(): boolean {
  let saved = false;
  for (const coordinator of liveCoordinators) {
    if (!coordinator.hasUnsavedChanges()) continue;
    coordinator.save();
    saved = true;
  }
  return saved;
}

let saveShortcutInstalled = false;
function installSaveShortcut() {
  if (saveShortcutInstalled || typeof window === "undefined") return;
  saveShortcutInstalled = true;
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key.toLowerCase() !== "s" || event.shiftKey || event.altKey) return;
      if (!(event.metaKey || event.ctrlKey)) return;
      if (saveAllPendingFiles()) event.preventDefault();
    },
    true,
  );
  useFileAutoSaveStore.subscribe((state, previous) => {
    if (state.autoSave && !previous.autoSave) saveAllPendingFiles();
  });
}

interface FileSaveOptions {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  onPendingChange: (relativePath: string, pending: boolean) => void;
}

export function useFileSaveCoordinator({
  environmentId,
  cwd,
  relativePath,
  onPendingChange,
}: FileSaveOptions): Pick<FileSaveCoordinator, "change"> {
  const canWriteFiles = useEnvironmentScope(environmentId, AuthFilesystemWriteScope);
  const writeFile = useProjectFileWriter();
  // A session owns the pending debounce, so it must outlive rerenders and be
  // replaced only when what it writes to changes.
  const inputs = { environmentId, cwd, relativePath, onPendingChange, writeFile };
  const [current, setCurrent] = useState(() => ({
    inputs,
    session: createFileSaveSession(inputs),
  }));
  if (
    current.inputs.environmentId !== environmentId ||
    current.inputs.cwd !== cwd ||
    current.inputs.relativePath !== relativePath ||
    current.inputs.onPendingChange !== onPendingChange ||
    current.inputs.writeFile !== writeFile
  ) {
    setCurrent({ inputs, session: createFileSaveSession(inputs) });
  }
  const session = current.session;

  // StrictMode replays effect setup. Retired file sessions stay inert, while the
  // replay gets a fresh coordinator instead of reusing a disposed one.
  useEffect(session.setup, [session]);
  useEffect(() => {
    if (!canWriteFiles) return;
    let cancelled = false;
    // Replay must retire the first session before recovery queues a draft to flush.
    queueMicrotask(() => {
      if (cancelled) return;
      const unsaved = getUnsavedProjectFileQueryData(environmentId, cwd, relativePath);
      if (unsaved) session.change(unsaved.contents);
    });
    return () => {
      cancelled = true;
    };
  }, [canWriteFiles, cwd, environmentId, relativePath, session]);
  return session;
}

function useProjectFileWriter() {
  return useAtomCommand(projectEnvironment.writeFile);
}

function createFileSaveSession({
  environmentId,
  cwd,
  relativePath,
  onPendingChange,
  writeFile,
}: FileSaveOptions & {
  writeFile: ReturnType<typeof useProjectFileWriter>;
}) {
  const coordinatorRef = createRef<FileSaveCoordinator>();
  return {
    change: (contents: string) => coordinatorRef.current?.change(contents),
    setup: () => {
      installSaveShortcut();
      const coordinator = new FileSaveCoordinator({
        debounceMs: FILE_SAVE_DEBOUNCE_MS,
        autoSave: () => useFileAutoSaveStore.getState().autoSave,
        canPersist: () => readEnvironmentScope(environmentId, AuthFilesystemWriteScope),
        onPendingChange: (pending) => onPendingChange(relativePath, pending),
        persist: (nextContents) =>
          writeFile({
            environmentId,
            input: { cwd, relativePath, contents: nextContents },
          }),
        onConfirmed: (confirmedContents) =>
          confirmProjectFileQueryData(environmentId, cwd, relativePath, confirmedContents),
      });
      coordinatorRef.current = coordinator;
      liveCoordinators.add(coordinator);
      return () => {
        coordinatorRef.current = null;
        liveCoordinators.delete(coordinator);
        coordinator.dispose();
      };
    },
  };
}
