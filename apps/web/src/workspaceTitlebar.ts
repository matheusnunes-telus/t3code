// A collapsed sidebar can still leave a rail of --sidebar-collapsed-width
// beside the content, which already offsets it from the window controls.
export const COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS =
  "[[data-sidebar-state=collapsed]_&]:pl-[max(0px,calc(var(--workspace-titlebar-content-left)_-_var(--sidebar-collapsed-width,0px)))] max-md:[[data-sidebar-state=expanded]_&]:pl-[var(--workspace-titlebar-content-left)]";
