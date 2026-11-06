import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, GcpSnapshot } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { cn } from "~/lib/utils";
import { useThreadShells } from "~/state/entities";
import { relativeAge } from "~/state/jira";
import { buildThreadRouteParams } from "../../threadRoutes";
import { chatDelivery } from "./gcpDelivery.logic";
import { useMinuteClock } from "./useMinuteClock";

const DOT_BY_STAGE: Record<string, string> = {
  "test-failed": "bg-destructive",
  "prod-failed": "bg-destructive",
  "in-prod": "bg-success",
};

/** Chats whose merged work hasn't reached Prod, per linked project; one deploy often ships several. */
export function GcpWaitingForProd({
  environmentId,
  snapshot,
  routeThreadKey,
}: {
  environmentId: EnvironmentId;
  snapshot: GcpSnapshot;
  routeThreadKey: string | null;
}) {
  const navigate = useNavigate();
  const now = useMinuteClock();
  const shells = useThreadShells().filter(
    (shell) =>
      shell.environmentId === environmentId &&
      shell.archivedAt === null &&
      shell.settledAt === null,
  );
  const groups = snapshot.links.flatMap((link) => {
    const rows = shells.flatMap((shell) => {
      const summary = chatDelivery(
        snapshot.deliveries.filter((delivery) => delivery.key === link.key),
        shell.id,
      );
      return summary === null ? [] : [{ shell, summary }];
    });
    return rows.length === 0 ? [] : [{ link, rows }];
  });
  if (groups.length === 0) return null;
  return (
    <div className="mb-2 flex flex-col gap-1" data-gcp-waiting-for-prod>
      {groups.map(({ link, rows }) => (
        <section key={link.key}>
          <div className="flex h-6 items-center px-2 text-xs text-sidebar-muted-foreground">
            <span className="min-w-0 truncate">
              {link.title} · Waiting for {rows[0]?.summary.deliveries[0]?.prodEnvironment ?? "prod"}{" "}
              ({rows.length})
            </span>
          </div>
          <ul className="flex flex-col">
            {rows.map(({ shell, summary }) => {
              const ref = scopeThreadRef(shell.environmentId, shell.id);
              return (
                <li key={shell.id}>
                  <button
                    type="button"
                    data-active={routeThreadKey === scopedThreadKey(ref)}
                    onClick={() =>
                      void navigate({
                        to: "/$environmentId/$threadId",
                        params: buildThreadRouteParams(ref),
                      })
                    }
                    className="flex h-7 w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2 text-left text-sm text-sidebar-foreground outline-hidden hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-[active=true]:bg-sidebar-row-selected"
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        DOT_BY_STAGE[summary.stage] ?? "bg-warning",
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate">{shell.title}</span>
                    <span className="shrink-0 font-mono text-3xs text-sidebar-muted-foreground">
                      {summary.label} · {relativeAge(summary.deliveries[0]?.mergedAt ?? null, now)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
