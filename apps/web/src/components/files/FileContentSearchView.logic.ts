import type { ProjectContentMatch } from "@t3tools/contracts";

// Result rows are syntax highlighted, so they mount in windows rather than all at once.
export const VISIBLE_MATCH_WINDOW = 100;

export function splitPath(path: string): { readonly name: string; readonly directory: string } {
  const separator = path.lastIndexOf("/");
  return separator === -1
    ? { name: path, directory: "" }
    : { name: path.slice(separator + 1), directory: path.slice(0, separator) };
}

export function groupMatches(matches: ReadonlyArray<ProjectContentMatch>) {
  const groups = new Map<string, Array<ProjectContentMatch & { readonly resultIndex: number }>>();
  matches.forEach((match, resultIndex) => {
    const group = groups.get(match.path);
    if (group) group.push({ ...match, resultIndex });
    else groups.set(match.path, [{ ...match, resultIndex }]);
  });
  return [...groups].map(([path, groupedMatches]) => ({ path, matches: groupedMatches }));
}

// Characters kept before the first match when a row is cut to fit the narrow panel.
const MATCH_LEAD_CHARS = 8;

/** Drops leading indentation, and text far ahead of the first match, so the match stays visible. */
export function compactMatch(match: ProjectContentMatch): {
  readonly match: ProjectContentMatch;
  readonly clipped: boolean;
} {
  const indent = match.lineContent.length - match.lineContent.trimStart().length;
  const firstStart = Math.min(...match.matchRanges.map((range) => range.start));
  const leadStart = Number.isFinite(firstStart) ? firstStart - MATCH_LEAD_CHARS : 0;
  // Never past the first match, e.g. when the query itself is leading whitespace.
  const offset = Math.min(Math.max(indent, leadStart), firstStart);
  if (offset <= 0) return { match, clipped: false };
  return {
    match: {
      ...match,
      lineContent: match.lineContent.slice(offset),
      matchRanges: match.matchRanges.map((range) => ({
        start: Math.max(0, range.start - offset),
        end: Math.max(0, range.end - offset),
      })),
    },
    clipped: offset > indent,
  };
}
