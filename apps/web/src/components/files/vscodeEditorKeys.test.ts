import type { EditorSelection, TextEdit } from "@pierre/diffs/edit";
import { describe, expect, it } from "vite-plus/test";

import { resolveVsCodeCommand, runVsCodeCommand, type VsCodeKeysEditor } from "./vscodeEditorKeys";

const caret = (line: number, character: number): EditorSelection => ({
  start: { line, character },
  end: { line, character },
  direction: 0,
});

function fakeEditor(text: string, selections: EditorSelection[]) {
  const state = { text, selections };
  const offset = (lines: string[], line: number, character: number) =>
    lines.slice(0, line).reduce((sum, entry) => sum + entry.length + 1, 0) + character;
  const editor: VsCodeKeysEditor = {
    getViewState: () => ({ selections: state.selections }),
    setViewState: ({ selections: next }) => {
      state.selections = next;
    },
    getText: () => state.text,
    applyEdits: (edits: TextEdit[]) => {
      for (const edit of edits) {
        const lines = state.text.split("\n");
        const from = offset(lines, edit.range.start.line, edit.range.start.character);
        const to = offset(lines, edit.range.end.line, edit.range.end.character);
        state.text = state.text.slice(0, from) + edit.newText + state.text.slice(to);
      }
    },
  };
  return { editor, state };
}

const keys = (code: string, mods: { meta?: boolean; alt?: boolean; shift?: boolean }) => ({
  code,
  metaKey: mods.meta ?? false,
  ctrlKey: false,
  altKey: mods.alt ?? false,
  shiftKey: mods.shift ?? false,
});

describe("resolveVsCodeCommand", () => {
  it("maps VS Code's macOS shortcuts", () => {
    expect(resolveVsCodeCommand(keys("ArrowDown", { meta: true, alt: true }), true)).toBe(
      "addCursorBelow",
    );
    expect(resolveVsCodeCommand(keys("KeyL", { meta: true, shift: true }), true)).toBe(
      "selectAllOccurrences",
    );
    expect(resolveVsCodeCommand(keys("KeyL", { meta: true }), true)).toBe("selectLine");
    expect(resolveVsCodeCommand(keys("KeyK", { meta: true, shift: true }), true)).toBe(
      "deleteLine",
    );
    expect(resolveVsCodeCommand(keys("KeyI", { alt: true, shift: true }), true)).toBe(
      "cursorsAtLineEnds",
    );
    expect(resolveVsCodeCommand(keys("KeyD", { meta: true }), true)).toBeNull();
  });
});

describe("runVsCodeCommand", () => {
  it("adds cursors below, keeping the column across a short line", () => {
    const { editor, state } = fakeEditor("abcdef\nab\nabcdef", [caret(0, 4)]);
    const keysState = { stickyColumn: null };
    runVsCodeCommand(editor, "addCursorBelow", keysState);
    runVsCodeCommand(editor, "addCursorBelow", keysState);
    expect(state.selections.map((s) => [s.end.line, s.end.character])).toEqual([
      [0, 4],
      [1, 2],
      [2, 4],
    ]);
  });

  it("selects every whole-word occurrence of the word at the caret", () => {
    const { editor, state } = fakeEditor("foo food\nfoo", [caret(1, 1)]);
    runVsCodeCommand(editor, "selectAllOccurrences", { stickyColumn: null });
    expect(state.selections.map((s) => [s.start.line, s.start.character, s.end.character])).toEqual(
      [
        [0, 0, 3],
        [1, 0, 3],
      ],
    );
  });

  it("deletes the lines under each cursor", () => {
    const { editor, state } = fakeEditor("one\ntwo\nthree\nfour", [caret(1, 1), caret(3, 2)]);
    runVsCodeCommand(editor, "deleteLine", { stickyColumn: null });
    expect(state.text).toBe("one\nthree");
  });

  it("puts a cursor at the end of each selected line", () => {
    const { editor, state } = fakeEditor("ab\ncde\nf", [
      { start: { line: 0, character: 1 }, end: { line: 2, character: 1 }, direction: 1 },
    ]);
    runVsCodeCommand(editor, "cursorsAtLineEnds", { stickyColumn: null });
    expect(state.selections.map((s) => [s.end.line, s.end.character])).toEqual([
      [0, 2],
      [1, 3],
      [2, 1],
    ]);
  });

  it("selects the line, then grows by a line", () => {
    const { editor, state } = fakeEditor("a\nb\nc", [caret(0, 0)]);
    runVsCodeCommand(editor, "selectLine", { stickyColumn: null });
    expect(state.selections[0]?.end).toEqual({ line: 1, character: 0 });
    runVsCodeCommand(editor, "selectLine", { stickyColumn: null });
    expect(state.selections[0]?.end).toEqual({ line: 2, character: 0 });
  });
});
