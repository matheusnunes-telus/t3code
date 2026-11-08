import { SidebarView } from "@t3tools/contracts/settings";

export const SIDEBAR_VIEW_LABELS: Record<SidebarView, string> = {
  plain: "Plain",
  legacy: "Legacy",
  projects: "Projects",
};

interface SidebarViewSettings {
  readonly sidebarViews: ReadonlyArray<SidebarView>;
  readonly legacySidebarEnabled: boolean;
  readonly boringSidebarEnabled: boolean;
}

/** The offered views in switcher order, ignoring duplicates. */
export function offeredSidebarViews(views: ReadonlyArray<SidebarView>): SidebarView[] {
  return SidebarView.literals.filter((view) => views.includes(view));
}

/** The picked view, or the first offered one once the picked view is no longer offered. */
export function resolveSidebarView(settings: SidebarViewSettings): SidebarView {
  const picked: SidebarView = settings.legacySidebarEnabled
    ? "projects"
    : settings.boringSidebarEnabled
      ? "legacy"
      : "plain";
  const offered = offeredSidebarViews(settings.sidebarViews);
  return offered.length === 0 || offered.includes(picked) ? picked : offered[0]!;
}

export function sidebarViewPatch(view: SidebarView) {
  return { legacySidebarEnabled: view === "projects", boringSidebarEnabled: view === "legacy" };
}
