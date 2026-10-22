import type { ThreadPullRequestUpdates } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { PullRequestUpdatesToggle } from "./PullRequestUpdatesToggle";

const pointer = (type: string, element: Element) => {
  const box = element.getBoundingClientRect();
  return new PointerEvent(type, {
    bubbles: true,
    button: 0,
    pointerId: 1,
    clientX: box.left + box.width / 2,
    clientY: box.top + box.height / 2,
  });
};

async function renderToggle(value: ThreadPullRequestUpdates = "notify") {
  const onChange = vi.fn();
  const screen = await render(<PullRequestUpdatesToggle value={value} onChange={onChange} />);
  const group = screen.container.querySelector('[role="radiogroup"]')!;
  const level = (name: ThreadPullRequestUpdates) =>
    group.querySelector(`[data-update-level="${name}"]`)!;
  return Object.assign(screen, { onChange, group, level });
}

it("picks a level with a quick click", async () => {
  await using screen = await renderToggle();
  expect(screen.level("notify").getAttribute("aria-checked")).toBe("true");
  await act(() => {
    screen.level("act").dispatchEvent(pointer("pointerdown", screen.level("act")));
    screen.group.dispatchEvent(pointer("pointerup", screen.level("act")));
  });
  expect(screen.onChange).toHaveBeenCalledWith("act");
  expect(screen.group.hasAttribute("data-revealed")).toBe(false);
});

it("shows every label while held, and picks the one it is let go over", async () => {
  await using screen = await renderToggle();
  await act(() => screen.level("act").dispatchEvent(pointer("pointerdown", screen.level("act"))));
  await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
  expect(screen.group.hasAttribute("data-revealed")).toBe(true);
  expect(screen.group.textContent).toContain("Link only");
  expect(screen.group.textContent).toContain("Auto-action");

  await act(() => screen.group.dispatchEvent(pointer("pointerup", screen.level("link"))));
  expect(screen.onChange).toHaveBeenCalledWith("link");
  expect(screen.group.hasAttribute("data-revealed")).toBe(false);
});

it("does nothing when the current level is picked again", async () => {
  await using screen = await renderToggle("link");
  await act(() => {
    screen.level("link").dispatchEvent(pointer("pointerdown", screen.level("link")));
    screen.group.dispatchEvent(pointer("pointerup", screen.level("link")));
  });
  expect(screen.onChange).not.toHaveBeenCalled();
});
