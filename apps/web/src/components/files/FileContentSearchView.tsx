import type { EnvironmentId, ProjectContentMatch } from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Spinner } from "~/components/ui/spinner";
import { useRenderedAppearance, useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { useProjectContentSearch } from "~/state/queries";

import { PierreEntryIcon } from "../chat/PierreEntryIcon";
import { HighlightedSearchLine } from "../search/HighlightedSearchLine";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  compactMatch,
  groupMatches,
  splitPath,
  VISIBLE_MATCH_WINDOW,
} from "./FileContentSearchView.logic";

// Smaller than the dialog's option buttons, so the field keeps room in the narrow explorer.
function SearchOptionButton(props: {
  readonly active: boolean;
  readonly disabled: boolean;
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            aria-label={props.label}
            disabled={props.disabled}
            pressed={props.active}
            size="xs"
            onClick={props.onClick}
          />
        }
      >
        <span className="font-mono text-xs">{props.children}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * "Search in files" mode of the Files panel: the same content search as the
 * mod+shift+f dialog, laid out as a list beside the open file.
 */
export function FileContentSearchView(props: {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  /** Header buttons rendered around the field, such as refresh and the mode toggle. */
  leading: ReactNode;
  trailing: ReactNode;
  onClose: () => void;
  onOpenMatch: (relativePath: string, lineNumber: number) => void;
}) {
  const { resolvedTheme } = useTheme();
  const renderedAppearance = useRenderedAppearance();
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [collapsedPaths, setCollapsedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const [visibleCount, setVisibleCount] = useState(VISIBLE_MATCH_WINDOW);

  const search = useProjectContentSearch({
    environmentId: props.environmentId,
    cwd: props.cwd,
    query,
    caseSensitive,
    wholeWord,
    useRegex,
  });
  const matches = search.matches;
  // New results restart the rendered window.
  const [resultsFor, setResultsFor] = useState(matches);
  if (resultsFor !== matches) {
    setResultsFor(matches);
    setVisibleCount(VISIBLE_MATCH_WINDOW);
  }
  const groups = groupMatches(matches.slice(0, visibleCount));
  const fileCount = new Set(matches.map((match) => match.path)).size;
  const canOpenMatches = search.canReadFiles && !search.isPending && search.error === null;

  const observeLoadMoreSentinel = (sentinel: HTMLElement | null) => {
    if (!sentinel) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisibleCount((current) => current + VISIBLE_MATCH_WINDOW);
      }
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  };

  const toggleGroup = (path: string) =>
    setCollapsedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const openMatch = (match: ProjectContentMatch) => {
    if (!canOpenMatches) return;
    props.onOpenMatch(match.path, match.lineNumber);
  };

  return (
    <>
      <div
        className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 in-data-[preview-panel-mode=inline]:mb-1 in-data-[preview-panel-mode=inline]:h-9 in-data-[preview-panel-mode=inline]:min-h-9 in-data-[preview-panel-mode=inline]:border-b-transparent"
        data-surface-subheader
      >
        {props.leading}
        <InputGroup variant="ghost" className="h-7 min-w-0 flex-1">
          <InputGroupInput
            type="search"
            name="project-contents-search"
            size="sm"
            value={query}
            aria-label={`Search in ${props.projectName} files`}
            placeholder="Search in files"
            spellCheck={false}
            autoFocus
            disabled={!search.canReadFiles}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                const first = matches[0];
                if (first) openMatch(first);
                return;
              }
              if (event.key !== "Escape") return;
              if (query) setQuery("");
              else props.onClose();
            }}
          />
          <InputGroupAddon align="inline-end">
            <SearchOptionButton
              active={caseSensitive}
              disabled={!search.canReadFiles}
              label="Match case"
              onClick={() => setCaseSensitive((current) => !current)}
            >
              Aa
            </SearchOptionButton>
            <SearchOptionButton
              active={wholeWord}
              disabled={!search.canReadFiles}
              label="Match whole word"
              onClick={() => setWholeWord((current) => !current)}
            >
              <span className="underline decoration-2 underline-offset-2">ab</span>
            </SearchOptionButton>
            <SearchOptionButton
              active={useRegex}
              disabled={!search.canReadFiles}
              label="Use regular expression"
              onClick={() => setUseRegex((current) => !current)}
            >
              .*
            </SearchOptionButton>
          </InputGroupAddon>
        </InputGroup>
        {props.trailing}
      </div>

      {search.hasQuery || search.error !== null ? (
        <div role="status" className="shrink-0 px-3 py-1 text-xs text-muted-foreground">
          {search.isPending ? (
            <span className="flex items-center gap-2">
              <Spinner size="sm" /> Searching…
            </span>
          ) : search.error ? (
            <span className="text-destructive">{search.error}</span>
          ) : search.invalidRegex ? (
            <span className="text-destructive">Invalid regular expression</span>
          ) : matches.length === 0 ? (
            "No results found."
          ) : (
            `${matches.length.toLocaleString()}${search.truncated ? "+" : ""} results in ${fileCount.toLocaleString()} files`
          )}
        </div>
      ) : (
        <div className="px-3 py-4 text-xs text-muted-foreground">
          {search.isCheckingAccess ? "Checking file access…" : "Type to search inside your files."}
        </div>
      )}

      {matches.length > 0 ? (
        // Long code lines must not widen the panel; rows truncate to its width instead.
        <ScrollArea className="min-h-0 flex-1 contain-inline-size" scrollFade>
          <div className="pb-2">
            {groups.map((group) => {
              const path = splitPath(group.path);
              const collapsed = collapsedPaths.has(group.path);
              return (
                <section key={group.path}>
                  <button
                    type="button"
                    className="sticky top-0 z-10 flex h-7 w-full min-w-0 items-center gap-1.5 bg-background/95 px-2 text-left text-xs backdrop-blur-sm hover:bg-accent/60"
                    aria-expanded={!collapsed}
                    onClick={() => toggleGroup(group.path)}
                  >
                    <ChevronRightIcon
                      className={cn(
                        "size-3 shrink-0 text-muted-foreground transition-transform",
                        !collapsed && "rotate-90",
                      )}
                    />
                    <PierreEntryIcon
                      pathValue={group.path}
                      kind="file"
                      theme={resolvedTheme}
                      className="size-3.5 shrink-0"
                    />
                    <span className="min-w-0 truncate font-medium text-foreground">
                      {path.name}
                    </span>
                    {path.directory ? (
                      <span className="min-w-0 flex-1 basis-0 truncate text-muted-foreground">
                        {path.directory}
                      </span>
                    ) : null}
                    <span className="ml-auto shrink-0 rounded-full bg-muted px-1.5 py-0.5 tabular-nums text-3xs text-muted-foreground">
                      {group.matches.length}
                    </span>
                  </button>
                  {collapsed
                    ? null
                    : group.matches.map((match) => {
                        const compact = compactMatch(match);
                        return (
                          <button
                            type="button"
                            key={`${match.path}:${match.lineNumber}:${match.resultIndex}`}
                            className="flex h-6 w-full min-w-0 items-center gap-2 pr-2 pl-6 text-left font-mono text-xs hover:bg-accent/60 disabled:pointer-events-none"
                            disabled={!canOpenMatches}
                            onClick={() => openMatch(match)}
                          >
                            <span className="w-7 shrink-0 text-right tabular-nums text-muted-foreground/70">
                              {match.lineNumber}
                            </span>
                            <span className="min-w-0 flex-1 truncate whitespace-pre">
                              {compact.clipped ? (
                                <span className="text-muted-foreground/70">…</span>
                              ) : null}
                              <HighlightedSearchLine
                                match={compact.match}
                                path={group.path}
                                theme={renderedAppearance}
                              />
                            </span>
                          </button>
                        );
                      })}
                </section>
              );
            })}
            {matches.length > visibleCount ? (
              <div ref={observeLoadMoreSentinel} className="h-8" aria-hidden="true" />
            ) : null}
          </div>
        </ScrollArea>
      ) : null}
    </>
  );
}
