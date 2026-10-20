import {
  ArrowLeftIcon,
  ChartNoAxesColumnIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
} from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { usePullRequestsSupported } from "../../state/environments";
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
}: {
  icon: ReactNode;
  label: string;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarMenuButton aria-label={label} onClick={onClick} size="icon" type="button">
            {icon}
          </SidebarMenuButton>
        }
      />
      <TooltipPopup side="right">{label}</TooltipPopup>
    </Tooltip>
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

  const handleNewThread = (event: ReactMouseEvent<HTMLButtonElement>) => {
    findSidebarControl('[aria-label="New thread"]')?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: event.shiftKey }),
    );
  };
  const handleSearch = () => {
    openPeek?.();
    requestAnimationFrame(() => {
      findSidebarControl<HTMLInputElement>('[aria-label="Search threads"]')?.focus({
        preventScroll: true,
      });
    });
  };

  return (
    <div className="flex h-full flex-col items-center pb-1">
      {showThreadActions ? (
        <div className="flex flex-col items-center gap-1 pt-2">
          <RailButton icon={<SquarePenIcon />} label="New thread" onClick={handleNewThread} />
          <RailButton icon={<SearchIcon />} label="Search threads" onClick={handleSearch} />
        </div>
      ) : null}
      <div className="flex-1" />
      <div className="flex flex-col items-center gap-1">
        {isOnUtilityPage ? (
          <RailButton
            icon={<ArrowLeftIcon />}
            label="Back"
            onClick={() => void navigateToMainApp()}
          />
        ) : (
          <>
            <RailButton
              icon={<SettingsIcon />}
              label="Settings"
              onClick={() => void navigate({ to: "/settings" })}
            />
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
          </>
        )}
      </div>
    </div>
  );
}
