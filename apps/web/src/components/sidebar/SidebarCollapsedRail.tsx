import {
  ArrowLeftIcon,
  ChartNoAxesColumnIcon,
  CloudIcon,
  MessageSquareIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
  TicketIcon,
} from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import type { ScopedProjectRef } from "@t3tools/contracts";
import {
  scopedProjectKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { cn } from "~/lib/utils";
import { openCommandPalette } from "../../commandPaletteBus";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useThreadRouteTarget } from "../../hooks/useThreadRouteTarget";
import { startNewThreadFromContext } from "../../lib/chatThreadActions";
import { useRightPanelStore } from "../../rightPanelStore";
import { usePrimaryEnvironmentId, usePullRequestsSupported } from "../../state/environments";
import { useThreadShell, useThreadShellsForProjectRefs } from "../../state/entities";
import { gcpLinkForProject, gcpLoginHealth, useGcpSnapshot } from "../../state/gcp";
import { useJiraSnapshot } from "../../state/jira";
import { useUiStateStore } from "../../uiStateStore";
import { useChatTabsStore } from "../../chatTabsStore";
import { useProjects, useThreadShells } from "../../state/entities";
import { useNavigateToThreadKey } from "../ChatTabsBar";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useLegacySidebarRailProjects } from "../LegacySidebar";
import { ProjectFavicon } from "../ProjectFavicon";
import { resolveProjectStatusIndicator } from "../LegacySidebar.logic";
import { resolveThreadStatusPill } from "../Sidebar.logic";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { SidebarMenuButton, useSidebarPeek } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { isSidebarUtilityPage, useNavigateToMainApp } from "./mainAppLocation";

// The full sidebar stays mounted off-screen while collapsed, so the rail
// forwards to its controls instead of duplicating their logic.
function findSidebarControl<T extends HTMLElement>(selector: string): T | null {
  return document.querySelector<T>(`[data-slot="sidebar-container"] ${selector}`);
}

function RailButton({
  icon,
  label,
  onClick,
  disabled = false,
  badgeClassName,
  active = false,
}: {
  icon: ReactNode;
  label: string;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  badgeClassName?: string | null;
  active?: boolean;
}) {
  return (
    <Tooltip>
      {/* A span triggers the tooltip, so a disabled button still explains itself on hover. */}
      <TooltipTrigger render={<span className="inline-flex" data-sidebar-rail-control />}>
        <SidebarMenuButton
          aria-label={label}
          aria-disabled={disabled || undefined}
          className="relative"
          isActive={active}
          onClick={disabled ? undefined : onClick}
          size="icon"
          type="button"
        >
          {icon}
          {badgeClassName ? (
            <span
              className={cn(
                "absolute top-1 right-1 size-2 rounded-full ring-2 ring-sidebar",
                badgeClassName,
              )}
            />
          ) : null}
        </SidebarMenuButton>
      </TooltipTrigger>
      <TooltipPopup side="right">{label}</TooltipPopup>
    </Tooltip>
  );
}

function RailProject({
  project,
  memberProjectRefs,
  active,
  onOpen,
}: {
  project: SidebarProjectSnapshot;
  memberProjectRefs: readonly ScopedProjectRef[];
  active: boolean;
  onOpen: (projectKey: string) => void;
}) {
  const threads = useThreadShellsForProjectRefs(memberProjectRefs);
  const lastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const status = resolveProjectStatusIndicator(
    threads.map((thread) => {
      const lastVisitedAt =
        lastVisitedAtById[scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))];
      return resolveThreadStatusPill({
        thread: { ...thread, ...(lastVisitedAt ? { lastVisitedAt } : {}) },
      });
    }),
  );
  const label = status ? `${project.displayName}: ${status.label}` : project.displayName;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-current={active || undefined}
            className="group/rail-project relative flex w-full shrink-0 justify-center py-0.5"
            onClick={() => onOpen(project.projectKey)}
          >
            {active ? (
              <span className="absolute inset-y-1.5 left-0 w-0.75 rounded-e-full bg-foreground" />
            ) : null}
            <span
              className={cn(
                "relative flex size-7 items-center justify-center rounded-md transition-colors",
                active ? "bg-accent" : "group-hover/rail-project:bg-accent/60",
              )}
            >
              <ProjectFavicon project={project} className="size-4" />
              {status ? (
                <span
                  className={cn(
                    "absolute -top-0.5 -right-0.5 size-2 rounded-full ring-2 ring-sidebar",
                    status.dotClass,
                    status.pulse && "motion-safe:animate-status-pulse",
                  )}
                />
              ) : null}
            </span>
          </button>
        }
      />
      <TooltipPopup side="right">{label}</TooltipPopup>
    </Tooltip>
  );
}

function RailProjects({ onOpen }: { onOpen: (projectKey: string) => void }) {
  const projects = useLegacySidebarRailProjects();
  const routeTarget = useThreadRouteTarget();
  const routeThread = useThreadShell(routeTarget?.kind === "server" ? routeTarget.threadRef : null);
  const activeProjectKey = routeThread
    ? scopedProjectKey({
        environmentId: routeThread.environmentId,
        projectId: routeThread.projectId,
      })
    : null;
  if (projects.length === 0) return null;

  return (
    <div className="flex min-h-0 w-full flex-col items-center gap-0.5 overflow-y-auto py-1 [scrollbar-width:none]">
      {projects.map(({ project, memberProjectRefs }) => (
        <RailProject
          key={project.projectKey}
          project={project}
          memberProjectRefs={memberProjectRefs}
          active={
            activeProjectKey !== null &&
            memberProjectRefs.some((ref) => scopedProjectKey(ref) === activeProjectKey)
          }
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}

/** The open chat tabs as project icons, in the order of the tab strip. */
function RailTabs() {
  const tabs = useChatTabsStore((state) => state.tabs);
  const threads = useThreadShells();
  const projects = useProjects();
  const lastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const routeTarget = useThreadRouteTarget();
  const navigateToThreadKey = useNavigateToThreadKey();
  const activeKey = routeTarget?.kind === "server" ? scopedThreadKey(routeTarget.threadRef) : null;
  const threadByKey = new Map(
    threads.map((thread) => [
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      thread,
    ]),
  );
  const projectByKey = new Map(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project] as const),
  );
  const items = tabs.flatMap((tab) => {
    const thread = threadByKey.get(tab.threadKey);
    if (!thread) return [];
    const project = projectByKey.get(`${thread.environmentId}:${thread.projectId}`);
    const lastVisitedAt = lastVisitedAtById[tab.threadKey];
    const pill = resolveThreadStatusPill({
      thread: { ...thread, ...(lastVisitedAt ? { lastVisitedAt } : {}) },
    });
    return [{ tab, thread, project, pill }];
  });
  if (items.length === 0) return null;

  return (
    <div className="flex min-h-0 w-full flex-col items-center gap-0.5 overflow-y-auto py-1 [scrollbar-width:none]">
      {items.map(({ tab, thread, project, pill }) => {
        const active = tab.threadKey === activeKey;
        const label = pill ? `${thread.title}: ${pill.label}` : thread.title;
        return (
          <Tooltip key={tab.threadKey}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={label}
                  aria-current={active || undefined}
                  className="group/rail-tab relative flex w-full shrink-0 justify-center py-0.5"
                  onClick={() => void navigateToThreadKey(tab.threadKey)}
                >
                  {active ? (
                    <span className="absolute inset-y-1.5 left-0 w-0.75 rounded-e-full bg-foreground" />
                  ) : null}
                  <span
                    className={cn(
                      "relative flex size-7 items-center justify-center rounded-md transition-colors",
                      active ? "bg-accent" : "group-hover/rail-tab:bg-accent/60",
                      tab.preview && "opacity-70",
                    )}
                  >
                    {project ? (
                      <ProjectFavicon project={project} className="size-4" />
                    ) : (
                      <MessageSquareIcon aria-hidden className="size-4 text-muted-foreground" />
                    )}
                    {pill ? (
                      <span
                        className={cn(
                          "absolute -top-0.5 -right-0.5 size-2 rounded-full ring-2 ring-sidebar",
                          pill.dotClass,
                          pill.pulse && "motion-safe:animate-status-pulse",
                        )}
                      />
                    ) : null}
                  </span>
                </button>
              }
            />
            <TooltipPopup side="right">{label}</TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}

export function SidebarCollapsedRail({ showThreadActions }: { showThreadActions: boolean }) {
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const openPeek = useSidebarPeek();
  const pullRequestsSupported = usePullRequestsSupported();
  const isOnUtilityPage = useLocation({
    select: (location) => isSidebarUtilityPage(location.pathname),
  });
  const newThreadContext = useHandleNewThread();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const jiraSnapshot = useJiraSnapshot(primaryEnvironmentId);
  const gcpSnapshot = useGcpSnapshot(primaryEnvironmentId);
  const routeThreadRef = newThreadContext.routeThreadRef;
  const routeProjectId = newThreadContext.activeThread?.projectId;
  const loginHealth = gcpLoginHealth(gcpSnapshot);
  const cloudNeedsSignIn =
    loginHealth === "signed-out" || loginHealth === "app-credentials" || loginHealth === "error";
  const jiraAvailable = routeThreadRef !== null && jiraSnapshot?.enabled === true;
  const cloudAvailable =
    routeThreadRef !== null && gcpLinkForProject(gcpSnapshot, routeProjectId) !== null;

  const handleNewThread = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (!showThreadActions) {
      void startNewThreadFromContext({
        ...newThreadContext,
        activeThread: newThreadContext.activeThread ?? undefined,
      });
      return;
    }
    findSidebarControl('[aria-label="New thread"]')?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: event.shiftKey }),
    );
  };
  const handleSearch = () => {
    if (!showThreadActions) {
      openCommandPalette();
      return;
    }
    openPeek?.();
    requestAnimationFrame(() => {
      findSidebarControl<HTMLInputElement>('[aria-label="Search threads"]')?.focus({
        preventScroll: true,
      });
    });
  };
  const handleOpenProject = (projectKey: string) => {
    openPeek?.();
    requestAnimationFrame(() => {
      findSidebarControl(`[data-sidebar-project-key="${CSS.escape(projectKey)}"]`)?.scrollIntoView({
        block: "nearest",
      });
    });
  };

  return (
    <div className="flex h-full flex-col items-center pb-1">
      <div className="flex flex-col items-center gap-1 pt-2">
        <RailButton icon={<SquarePenIcon />} label="New thread" onClick={handleNewThread} />
        <RailButton icon={<SearchIcon />} label="Search threads" onClick={handleSearch} />
      </div>
      <div className="my-2 h-px w-5 shrink-0 bg-border" />
      <div className="flex min-h-0 w-full flex-1 flex-col">
        <RailTabs />
        {showThreadActions ? null : <RailProjects onOpen={handleOpenProject} />}
      </div>
      <div className="flex flex-col items-center gap-1 pt-2">
        {isOnUtilityPage ? (
          <RailButton
            icon={<ArrowLeftIcon />}
            label="Back"
            onClick={() => void navigateToMainApp()}
          />
        ) : (
          <>
            {jiraSnapshot?.enabled ? (
              <RailButton
                icon={<TicketIcon />}
                label={jiraAvailable ? "Jira" : "Jira: open a chat first"}
                disabled={!jiraAvailable}
                onClick={() => {
                  if (routeThreadRef) useRightPanelStore.getState().open(routeThreadRef, "jira");
                }}
              />
            ) : null}
            {gcpSnapshot?.enabled ? (
              <RailButton
                icon={<CloudIcon />}
                label={
                  cloudNeedsSignIn
                    ? "Google Cloud: sign in again"
                    : cloudAvailable
                      ? "Google Cloud"
                      : routeThreadRef === null
                        ? "Google Cloud: open a chat first"
                        : "Google Cloud: link this project in its settings"
                }
                disabled={!cloudAvailable}
                badgeClassName={cloudNeedsSignIn ? "bg-warning" : null}
                onClick={() => {
                  if (routeThreadRef) useRightPanelStore.getState().open(routeThreadRef, "cloud");
                }}
              />
            ) : null}
            {pullRequestsSupported ? (
              <RailButton
                icon={<PullRequestGlyph.pullRequest />}
                label="Pull Requests"
                onClick={() =>
                  void navigate({ to: "/pull-requests", search: readPullRequestListPreferences() })
                }
              />
            ) : null}
            <RailButton
              icon={<ChartNoAxesColumnIcon />}
              label="Usage"
              onClick={() => void navigate({ to: "/usage" })}
            />
            <RailButton
              icon={<SettingsIcon />}
              label="Settings"
              onClick={() => void navigate({ to: "/settings" })}
            />
          </>
        )}
      </div>
    </div>
  );
}
