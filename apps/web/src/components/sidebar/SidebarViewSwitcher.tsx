import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { updateClientSettings, useClientSettings } from "~/hooks/useSettings";
import {
  offeredSidebarViews,
  resolveSidebarView,
  SIDEBAR_VIEW_LABELS,
  sidebarViewPatch,
} from "./sidebarView";

/** Switches between the sidebar views picked in Settings; shows `fallback` when only one is. */
export function SidebarViewSwitcher({ fallback = null }: { fallback?: ReactNode }) {
  const views = useClientSettings((settings) => settings.sidebarViews);
  const current = useClientSettings(resolveSidebarView);
  const offered = offeredSidebarViews(views);
  if (offered.length < 2) return fallback;
  return (
    <div
      role="radiogroup"
      aria-label="Sidebar view"
      className="inline-flex items-center gap-0.5 rounded-md bg-sidebar-control-surface p-0.5"
    >
      {offered.map((view) => (
        <button
          key={view}
          type="button"
          role="radio"
          aria-checked={current === view}
          onClick={() => updateClientSettings(sidebarViewPatch(view))}
          className={cn(
            "cursor-pointer rounded-sm px-1.5 text-xs leading-5 outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
            current === view
              ? "bg-background text-foreground shadow-xs dark:bg-input"
              : "text-sidebar-muted-foreground/80 hover:text-foreground",
          )}
        >
          {SIDEBAR_VIEW_LABELS[view]}
        </button>
      ))}
    </div>
  );
}
