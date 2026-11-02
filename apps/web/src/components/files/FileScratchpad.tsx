import type { FileContents } from "@pierre/diffs";
import { Editor, type EditorFactory, type EditorOptions } from "@pierre/diffs/edit";
import { EditProvider, File, Virtualizer } from "@pierre/diffs/react";
import { useEffect, useRef, useState } from "react";

import { scratchKey, scratchTitle, useFilesTabsStore } from "~/filesTabsStore";
import { useTheme } from "~/hooks/useTheme";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";

import { FILE_SURFACE_SUBHEADER_CLASS } from "./fileSurfaceChrome";
import { installVsCodeEditorKeys } from "./vscodeEditorKeys";

const createScratchEditor: EditorFactory<undefined, undefined> = (editorType, options, key) =>
  new Editor(editorType, options, key);

/**
 * A blank, untitled editor tab for notes, like VS Code's untitled files. Its text lives in
 * the files tab store (so it survives a restart), never on disk.
 */
export function FileScratchpad({ draftId, path }: { draftId: string; path: string }) {
  const setScratch = useFilesTabsStore((state) => state.setScratch);
  const { resolvedTheme } = useTheme();
  // The editor owns the text once open; the store only keeps a copy of it.
  const [file] = useState<FileContents>(() => ({
    name: scratchTitle(path),
    contents: useFilesTabsStore.getState().scratchByKey[scratchKey(draftId, path)] ?? "",
    cacheKey: `scratch:${draftId}:${path}`,
  }));
  const editorRef = useRef<Editor<"file", undefined, undefined> | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const editorOptions: EditorOptions<"file", undefined, undefined> = {
    onAttach: (editor) => {
      editorRef.current = editor;
      // An empty document has no line for a click to land on, so start with a caret.
      if (editor.getViewState().selections === undefined) {
        const start = { line: 0, character: 0 };
        editor.setSelections([{ start, end: start, direction: "none" }]);
      }
      editor.focus();
    },
    onComplete: () => {
      editorRef.current = null;
    },
  };
  // oxlint-disable-next-line t3code/react-effect-budget -- the VS Code shortcuts are DOM listeners on the editor's container, installed while it is mounted.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    return installVsCodeEditorKeys(root, () => editorRef.current);
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={FILE_SURFACE_SUBHEADER_CLASS}>
        <span className="truncate text-xs text-muted-foreground">
          {scratchTitle(path)} · a scratchpad, kept in this app and not saved to disk
        </span>
      </div>
      <EditProvider createEditor={createScratchEditor}>
        <div ref={rootRef} className="flex min-h-0 flex-1">
          <Virtualizer className="file-preview-virtualizer min-h-0 flex-1 overflow-auto">
            <File
              file={file}
              edit
              editorOptions={editorOptions}
              onEditChange={({ file: next }) => setScratch(draftId, path, next.contents)}
              options={{
                disableFileHeader: true,
                overflow: "wrap",
                theme: resolveDiffThemeName(resolvedTheme),
                preferredHighlighter: PREFERRED_HIGHLIGHTER,
                themeType: resolvedTheme,
              }}
              className="min-h-full"
            />
          </Virtualizer>
        </div>
      </EditProvider>
    </div>
  );
}
