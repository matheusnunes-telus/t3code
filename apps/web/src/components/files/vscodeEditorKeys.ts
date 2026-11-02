import type { EditorSelection, Position, TextEdit } from "@pierre/diffs/edit";

/** The part of the @pierre/diffs editor these shortcuts drive. */
export interface VsCodeKeysEditor {
  getViewState(): { selections?: EditorSelection[] };
  setViewState(state: { selections: EditorSelection[] }): void;
  getText(): string;
  applyEdits(edits: TextEdit[]): void;
}

type Command =
  | "addCursorAbove"
  | "addCursorBelow"
  | "selectAllOccurrences"
  | "undoCursor"
  | "selectLine"
  | "deleteLine"
  | "cursorsAtLineEnds";

const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);

/** VS Code's multi-cursor and line shortcuts the editor doesn't have itself (it has mod+D, Alt+drag). */
export function resolveVsCodeCommand(
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "code">,
  mac = isMac,
): Command | null {
  const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  const { altKey: alt, shiftKey: shift, code } = event;
  if (mod && alt && !shift && code === "ArrowUp") return "addCursorAbove";
  if (mod && alt && !shift && code === "ArrowDown") return "addCursorBelow";
  if (mod && shift && !alt && code === "KeyL") return "selectAllOccurrences";
  if (mod && !shift && !alt && code === "KeyU") return "undoCursor";
  if (mod && !shift && !alt && code === "KeyL") return "selectLine";
  if (mod && shift && !alt && code === "KeyK") return "deleteLine";
  if (!mod && shift && alt && code === "KeyI" && !event.metaKey && !event.ctrlKey) {
    return "cursorsAtLineEnds";
  }
  return null;
}

const documentLines = (text: string) =>
  text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));

const caret = (line: number, character: number): EditorSelection => ({
  start: { line, character },
  end: { line, character },
  direction: 0,
});

const comparePositions = (a: Position, b: Position) => a.line - b.line || a.character - b.character;

const isCollapsed = (selection: EditorSelection) =>
  comparePositions(selection.start, selection.end) === 0;

const activeEnd = (selection: EditorSelection) =>
  selection.direction === -1 ? selection.start : selection.end;

/** Drops duplicate selections, keeping the last copy so the primary (last) stays primary. */
function uniqueSelections(selections: readonly EditorSelection[]): EditorSelection[] {
  const seen = new Set<string>();
  const kept: EditorSelection[] = [];
  for (const selection of selections.toReversed()) {
    const key = `${selection.start.line}:${selection.start.character}-${selection.end.line}:${selection.end.character}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.unshift(selection);
  }
  return kept;
}

const WORD = /[\p{L}\p{N}_$]/u;

function wordAt(lines: readonly string[], position: Position): EditorSelection | null {
  const text = lines[position.line] ?? "";
  let start = position.character;
  let end = position.character;
  while (start > 0 && WORD.test(text[start - 1]!)) start -= 1;
  while (end < text.length && WORD.test(text[end]!)) end += 1;
  if (start === end) return null;
  return {
    start: { line: position.line, character: start },
    end: { line: position.line, character: end },
    direction: 1,
  };
}

function selectedText(lines: readonly string[], selection: EditorSelection) {
  const { start, end } = selection;
  if (start.line === end.line)
    return (lines[start.line] ?? "").slice(start.character, end.character);
  return [
    (lines[start.line] ?? "").slice(start.character),
    ...lines.slice(start.line + 1, end.line),
    (lines[end.line] ?? "").slice(0, end.character),
  ].join("\n");
}

const offsetToPosition = (lineStarts: readonly number[], offset: number): Position => {
  let line = 0;
  while (line + 1 < lineStarts.length && lineStarts[line + 1]! <= offset) line += 1;
  return { line, character: offset - lineStarts[line]! };
};

export interface VsCodeKeysState {
  /** The column a run of add-cursor presses keeps, so a short line doesn't pull it left. */
  stickyColumn: number | null;
}

/** Applies one command; returns false when it doesn't apply, so the key falls through. */
export function runVsCodeCommand(
  editor: VsCodeKeysEditor,
  command: Command,
  state: VsCodeKeysState,
): boolean {
  const selections = editor.getViewState().selections ?? [];
  const primary = selections.at(-1);
  if (primary === undefined) return false;
  const text = editor.getText();
  const lines = documentLines(text);
  const setSelections = (next: EditorSelection[]) =>
    editor.setViewState({ selections: uniqueSelections(next) });

  switch (command) {
    case "addCursorAbove":
    case "addCursorBelow": {
      const down = command === "addCursorBelow";
      const edge = selections.reduce((best, selection) => {
        const line = activeEnd(selection).line;
        return down
          ? line > activeEnd(best).line
            ? selection
            : best
          : line < activeEnd(best).line
            ? selection
            : best;
      }, primary);
      const from = activeEnd(edge);
      const line = from.line + (down ? 1 : -1);
      if (line < 0 || line >= lines.length) return true;
      state.stickyColumn ??= from.character;
      setSelections([
        ...selections,
        caret(line, Math.min(state.stickyColumn, (lines[line] ?? "").length)),
      ]);
      return true;
    }
    case "selectAllOccurrences": {
      const word = isCollapsed(primary) ? wordAt(lines, primary.start) : null;
      const target = word ?? primary;
      const needle = selectedText(lines, target);
      if (needle === "") return true;
      const normalized = lines.join("\n");
      const lineStarts = [0];
      for (let index = 0; index < normalized.length; index += 1) {
        if (normalized[index] === "\n") lineStarts.push(index + 1);
      }
      const matches: EditorSelection[] = [];
      for (
        let index = normalized.indexOf(needle);
        index !== -1;
        index = normalized.indexOf(needle, index + needle.length)
      ) {
        // A word picked from the caret matches whole words only, as in VS Code.
        if (
          word &&
          ((index > 0 && WORD.test(normalized[index - 1]!)) ||
            WORD.test(normalized[index + needle.length] ?? ""))
        ) {
          continue;
        }
        matches.push({
          start: offsetToPosition(lineStarts, index),
          end: offsetToPosition(lineStarts, index + needle.length),
          direction: 1,
        });
      }
      const primaryKey = comparePositions.bind(null, target.start);
      const others = matches.filter((match) => primaryKey(match.start) !== 0);
      setSelections([...others, target]);
      return true;
    }
    case "undoCursor": {
      if (selections.length < 2) return true;
      setSelections(selections.slice(0, -1));
      return true;
    }
    case "selectLine": {
      setSelections(
        selections.map((selection) => {
          // Whole lines grow by the next line; a selection that ends at a line start (but
          // didn't start at one) already covers the line before it.
          const endsAtLineStart =
            !isCollapsed(selection) &&
            selection.end.character === 0 &&
            selection.start.character !== 0;
          const endLine = endsAtLineStart ? selection.end.line : selection.end.line + 1;
          const end =
            endLine >= lines.length
              ? { line: lines.length - 1, character: (lines.at(-1) ?? "").length }
              : { line: endLine, character: 0 };
          return { start: { line: selection.start.line, character: 0 }, end, direction: 1 };
        }),
      );
      return true;
    }
    case "deleteLine": {
      const blocks = selections
        .map((selection) => ({
          from: selection.start.line,
          // A selection ending at the start of a line doesn't take that line.
          to:
            selection.end.character === 0 && selection.end.line > selection.start.line
              ? selection.end.line - 1
              : selection.end.line,
          character: activeEnd(selection).character,
        }))
        .toSorted((a, b) => a.from - b.from);
      const merged: typeof blocks = [];
      for (const block of blocks) {
        const last = merged.at(-1);
        if (last && block.from <= last.to + 1) last.to = Math.max(last.to, block.to);
        else merged.push({ ...block });
      }
      const edits: TextEdit[] = merged.toReversed().map(({ from, to }) => {
        if (to + 1 < lines.length) {
          return {
            range: { start: { line: from, character: 0 }, end: { line: to + 1, character: 0 } },
            newText: "",
          };
        }
        const start =
          from > 0
            ? { line: from - 1, character: (lines[from - 1] ?? "").length }
            : { line: 0, character: 0 };
        return {
          range: { start, end: { line: to, character: (lines[to] ?? "").length } },
          newText: "",
        };
      });
      editor.applyEdits(edits);
      const nextLines = documentLines(editor.getText());
      let removed = 0;
      setSelections(
        merged.map(({ from, to, character }) => {
          const line = Math.min(from - removed, nextLines.length - 1);
          removed += to - from + 1;
          return caret(line, Math.min(character, (nextLines[line] ?? "").length));
        }),
      );
      return true;
    }
    case "cursorsAtLineEnds": {
      const next = selections.flatMap((selection) => {
        if (isCollapsed(selection) || selection.start.line === selection.end.line) {
          return [caret(selection.end.line, selection.end.character)];
        }
        const carets: EditorSelection[] = [];
        for (let line = selection.start.line; line < selection.end.line; line += 1) {
          carets.push(caret(line, (lines[line] ?? "").length));
        }
        if (selection.end.character > 0) {
          carets.push(caret(selection.end.line, selection.end.character));
        }
        return carets;
      });
      setSelections(next);
      return true;
    }
  }
}

const EDITOR_ATTRIBUTE = "data-vscode-keys-editor";

/**
 * Whether a key belongs to a VS Code keys editor that has focus. Window-level shortcut
 * handlers that run first (the chat's mod+shift+L) step aside for it.
 */
export function claimsVsCodeEditorShortcut(event: KeyboardEvent): boolean {
  return (
    event.target instanceof Element &&
    event.target.closest(`[${EDITOR_ATTRIBUTE}]`) !== null &&
    resolveVsCodeCommand(event) !== null
  );
}

/** Marks a re-dispatched pointerdown, so the root listener lets it through. */
const TRANSLATED = Symbol("vscodeKeysTranslated");

/**
 * The editor adds a cursor on mod+click and makes a column selection on Alt+drag. VS Code
 * adds a cursor on Alt+click and makes columns on Shift+Alt+drag, so the pointerdown is
 * re-sent with the editor's modifiers before the editor sees it.
 */
function translatePointerDown(event: PointerEvent, mac: boolean): PointerEventInit | null {
  if (event.button !== 0 || !event.altKey || event.metaKey || event.ctrlKey) return null;
  const init: PointerEventInit = {
    bubbles: true,
    composed: true,
    cancelable: true,
    clientX: event.clientX,
    clientY: event.clientY,
    screenX: event.screenX,
    screenY: event.screenY,
    button: event.button,
    buttons: event.buttons,
    pointerId: event.pointerId,
    pointerType: event.pointerType,
    isPrimary: event.isPrimary,
    detail: event.detail,
  };
  if (event.shiftKey) return { ...init, altKey: true, shiftKey: false };
  return { ...init, altKey: false, metaKey: mac, ctrlKey: !mac };
}

export function installVsCodeEditorKeys(
  root: HTMLElement,
  getEditor: () => VsCodeKeysEditor | null,
): () => void {
  const state: VsCodeKeysState = { stickyColumn: null };

  const onKeyDown = (event: KeyboardEvent) => {
    const command = resolveVsCodeCommand(event);
    if (command !== "addCursorAbove" && command !== "addCursorBelow") state.stickyColumn = null;
    if (command === null || event.isComposing) return;
    const editor = getEditor();
    if (editor === null) return;
    if (!runVsCodeCommand(editor, command, state)) return;
    // Ahead of the editor and of app shortcuts on the same keys (mod+U opens Usage).
    event.preventDefault();
    event.stopPropagation();
  };
  const onPointerDown = (event: PointerEvent) => {
    if ((event as PointerEvent & { [TRANSLATED]?: true })[TRANSLATED]) return;
    const init = translatePointerDown(event, isMac);
    const target = event.composedPath()[0];
    if (init === null || !(target instanceof Element)) return;
    // Only the pointerdown is swapped; the browser still places its caret for the click.
    event.stopPropagation();
    const translated = new PointerEvent("pointerdown", init);
    Object.defineProperty(translated, TRANSLATED, { value: true });
    target.dispatchEvent(translated);
  };

  root.setAttribute(EDITOR_ATTRIBUTE, "");
  root.addEventListener("keydown", onKeyDown, true);
  root.addEventListener("pointerdown", onPointerDown, true);
  return () => {
    root.removeAttribute(EDITOR_ATTRIBUTE);
    root.removeEventListener("keydown", onKeyDown, true);
    root.removeEventListener("pointerdown", onPointerDown, true);
  };
}
