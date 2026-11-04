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
import { useLocation, useNavigate } from "@tanstack/react-router";

import { cn } from "~/lib/utils";
import { openCommandPalette } from "../../commandPaletteBus";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { startNewThreadFromContext } from "../../lib/chatThreadActions";
import { useRightPanelStore } from "../../rightPanelStore";
import { usePrimaryEnvironmentId, usePullRequestsSupported } from "../../state/environments";
import { gcpLinkForProject, gcpLoginHealth, useGcpSnapshot } from "../../state/gcp";
import { useJiraSnapshot } from "../../state/jira";
import { useUiStateStore } from "../../uiStateStore";
import { useNavigateToThreadKey } from "../ChatTabsBar";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  resolveThreadLastVisitedAt,
  resolveThreadStatusPill,
  type ThreadStatusPill,
} from "../Sidebar.logic";
import { useChatTabStrip } from "../useChatTabStrip";
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

/** The rail's copy of a tab: the same icon, status and click as in the top bar. */
function RailTab({
  label,
  icon,
  dot,
  active,
  faded,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  dot?: ThreadStatusPill | null;
  active: boolean;
  faded: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-current={active || undefined}
            className="group/rail-tab relative flex w-full shrink-0 justify-center py-0.5"
            onClick={onClick}
          >
            {active ? (
              <span className="absolute inset-y-1.5 left-0 w-0.75 rounded-e-full bg-foreground" />
            ) : null}
            <span
              className={cn(
                "relative flex size-7 items-center justify-center rounded-md transition-colors",
                active ? "bg-accent" : "group-hover/rail-tab:bg-accent/60",
                faded && "opacity-70",
              )}
            >
              {icon}
              {dot ? (
                <span
                  className={cn(
                    "absolute -top-0.5 -right-0.5 size-2 rounded-full ring-2 ring-sidebar",
                    dot.dotClass,
                    dot.pulse && "motion-safe:animate-status-pulse",
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

const railTabIcon = (project: Parameters<typeof ProjectFavicon>[0]["project"] | undefined) =>
  project ? (
    <ProjectFavicon project={project} className="size-4" />
  ) : (
    <MessageSquareIcon aria-hidden className="size-4 text-muted-foreground" />
  );

/** The tab strip as a column: same tabs, same order, with a small gap between project groups. */
function RailTabs() {
  const { tabGroups, draftTabs, activeThreadKey, routeDraftId } = useChatTabStrip();
  const lastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const navigate = useNavigate();
  const navigateToThreadKey = useNavigateToThreadKey();
  if (tabGroups.length === 0 && draftTabs.length === 0) return null;

  return (
    <div className="flex min-h-0 w-full flex-col items-center gap-2 overflow-y-auto py-1 [scrollbar-width:none]">
      {tabGroups.map((group) => (
        <div key={group.groupId} className="flex w-full shrink-0 flex-col items-center gap-0.5">
          {group.items.map(({ tab, thread, title, iconProject }) => {
            const pill = thread
              ? resolveThreadStatusPill({
                  thread: {
                    ...thread,
                    lastVisitedAt: resolveThreadLastVisitedAt(
                      thread.lastVisitedAt,
                      lastVisitedAtById[tab.threadKey],
                    ),
                  },
                })
              : null;
            return (
              <RailTab
                key={tab.threadKey}
                label={pill ? `${title}: ${pill.label}` : title}
                icon={railTabIcon(iconProject)}
                dot={pill}
                active={tab.threadKey === activeThreadKey}
                faded={tab.preview}
                onClick={() => void navigateToThreadKey(tab.threadKey)}
              />
            );
          })}
        </div>
      ))}
      {draftTabs.length > 0 ? (
        <div className="flex w-full shrink-0 flex-col items-center gap-0.5">
          {draftTabs.map((draft) => (
            <RailTab
              key={draft.draftId}
              label={`${draft.title} (unsent)`}
              icon={railTabIcon(draft.project)}
              active={draft.draftId === routeDraftId}
              faded
              onClick={() =>
                void navigate({ to: "/draft/$draftId", params: { draftId: draft.draftId } })
              }
            />
          ))}
        </div>
      ) : null}
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
  return (
    <div className="flex h-full flex-col items-center pb-1">
      <div className="flex flex-col items-center gap-1 pt-2">
        <RailButton icon={<SquarePenIcon />} label="New thread" onClick={handleNewThread} />
        <RailButton icon={<SearchIcon />} label="Search threads" onClick={handleSearch} />
      </div>
      <div className="my-2 h-px w-5 shrink-0 bg-border" />
      <div className="flex min-h-0 w-full flex-1 flex-col">
        <RailTabs />
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
