import type {
  GcpDeployRun,
  GcpEnvironment,
  GcpEnvironmentResources,
  GcpResourceState,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { CloudIcon, ExternalLinkIcon, LoaderIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";

import { cn } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";
import { gcpLinkForProject, useGcpCommand, useGcpSnapshot } from "~/state/gcp";
import { relativeAge } from "~/state/jira";
import { Button } from "../ui/button";
import { useMinuteClock } from "./useMinuteClock";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";

/** A panel read older than this is read again when it is shown. */
const STALE_MS = 5 * 60 * 1000;

const DOT: Record<GcpResourceState | "succeeded" | "running" | "none", string> = {
  ready: "bg-success",
  succeeded: "bg-success",
  failed: "bg-destructive",
  deploying: "bg-info",
  running: "bg-info",
  unknown: "bg-muted-foreground/50",
  none: "bg-muted-foreground/50",
};

const RUNTIME_NAMES: Record<GcpEnvironment["runtime"], string> = {
  "cloud-run": "Cloud Run",
  gke: "GKE",
  other: "Other",
};

/** `registry/app/api:4f2a9c1` → `4f2a9c1`; digests keep their first characters. */
const imageTag = (image: string | null) => {
  if (image === null) return null;
  const digest = image.split("@")[1];
  if (digest) return digest.replace("sha256:", "").slice(0, 12);
  const tag = image.split("/").at(-1)?.split(":")[1];
  return tag ? tag.slice(0, 12) : null;
};

const consoleUrl = (path: string, projectId: string) =>
  `https://console.cloud.google.com/${path}?project=${encodeURIComponent(projectId)}`;

function SectionLabel({ children }: { children: string }) {
  return (
    <p className="mb-1 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
      {children}
    </p>
  );
}

function Row({
  state,
  name,
  detail,
  meta,
  links,
}: {
  state: keyof typeof DOT;
  name: string;
  detail?: string | null;
  meta?: string | null;
  links?: ReadonlyArray<{ readonly label: string; readonly href: string }>;
}) {
  return (
    <li className="flex flex-col gap-0.5 py-1 text-xs">
      <div className="flex min-w-0 items-center gap-2">
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT[state])} />
        <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
        {meta ? <span className="shrink-0 text-muted-foreground">{meta}</span> : null}
      </div>
      {detail || (links && links.length > 0) ? (
        <div className="flex min-w-0 items-center gap-1.5 pl-3.5 text-muted-foreground">
          {detail ? <span className="min-w-0 truncate">{detail}</span> : null}
          {links?.map((link) => (
            <a
              key={link.label}
              href={link.href}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 underline underline-offset-2 hover:text-foreground"
            >
              {link.label}
            </a>
          ))}
        </div>
      ) : null}
    </li>
  );
}

function EnvironmentResources({
  environment,
  resources,
  now,
}: {
  environment: GcpEnvironment;
  resources: GcpEnvironmentResources;
  now: number;
}) {
  const { projectId } = environment;
  const empty =
    resources.services.length === 0 &&
    resources.jobs.length === 0 &&
    resources.clusters.length === 0;
  return (
    <div className="flex flex-col gap-3">
      {resources.message ? (
        <p className="text-xs text-warning-foreground">{resources.message}</p>
      ) : null}
      {resources.services.length > 0 ? (
        <div>
          <SectionLabel>Cloud Run services</SectionLabel>
          <ul>
            {resources.services.map((service) => (
              <Row
                key={service.name}
                state={service.state}
                name={service.name}
                meta={
                  service.deployedAt === null
                    ? null
                    : `deployed ${relativeAge(service.deployedAt, now)}`
                }
                detail={[
                  service.revision?.split("-").at(-2) === undefined
                    ? null
                    : `rev ${service.revision.split("-").at(-2)}`,
                  imageTag(service.image),
                  service.deployedBy?.split("@")[0] ?? null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                links={[
                  ...(service.url ? [{ label: "URL", href: service.url }] : []),
                  ...(service.region
                    ? [
                        {
                          label: "logs",
                          href: consoleUrl(
                            `run/detail/${service.region}/${service.name}/logs`,
                            projectId,
                          ),
                        },
                      ]
                    : []),
                ]}
              />
            ))}
          </ul>
        </div>
      ) : null}
      {resources.jobs.length > 0 ? (
        <div>
          <SectionLabel>Jobs</SectionLabel>
          <ul>
            {resources.jobs.map((job) => (
              <Row
                key={job.name}
                state={job.lastRunState}
                name={job.name}
                meta={
                  job.lastRunAt === null
                    ? "never ran"
                    : `${job.lastRunState === "succeeded" ? "ok" : job.lastRunState} · ${relativeAge(job.lastRunAt, now)}`
                }
              />
            ))}
          </ul>
        </div>
      ) : null}
      {resources.clusters.length > 0 ? (
        <div>
          <SectionLabel>GKE clusters</SectionLabel>
          <ul>
            {resources.clusters.map((cluster) => (
              <Row
                key={cluster.name}
                state={cluster.state}
                name={cluster.name}
                meta={cluster.location}
                detail={cluster.version}
                links={[
                  {
                    label: "workloads",
                    href: consoleUrl("kubernetes/workload/overview", projectId),
                  },
                ]}
              />
            ))}
          </ul>
        </div>
      ) : null}
      {empty && resources.message === null ? (
        <p className="text-xs text-muted-foreground">
          Nothing runs on Cloud Run here
          {environment.runtime === "gke" ? " and no GKE cluster was found" : ""}.
        </p>
      ) : null}
    </div>
  );
}

function EnvironmentDeploys({
  runs,
  workflow,
  now,
}: {
  runs: ReadonlyArray<GcpDeployRun>;
  workflow: string | null;
  now: number;
}) {
  if (workflow === null) return null;
  return (
    <div className="mt-3">
      <SectionLabel>Deploys</SectionLabel>
      {runs.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No recent runs of {workflow.split("/").at(-1)} found with gh.
        </p>
      ) : (
        <ul>
          {runs.slice(0, 5).map((run) => (
            <Row
              key={run.id}
              state={
                run.status !== "completed"
                  ? "running"
                  : run.conclusion === "success"
                    ? "succeeded"
                    : "failed"
              }
              name={run.title}
              meta={relativeAge(run.createdAt, now)}
              detail={[
                run.number === null ? null : `#${run.number}`,
                run.headSha.slice(0, 7),
                run.status !== "completed"
                  ? run.status === "waiting"
                    ? "waiting for approval"
                    : (run.currentJob ?? "running")
                  : run.verified === true
                    ? "running in Google Cloud"
                    : run.verified === false
                      ? "not running in Google Cloud"
                      : (run.conclusion ?? null),
              ]
                .filter(Boolean)
                .join(" · ")}
              links={[{ label: "run", href: run.url }]}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** The right panel's Google Cloud tab: what runs in each linked environment of the thread's project. */
export function GcpCloudPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const environmentId = threadRef.environmentId;
  const snapshot = useGcpSnapshot(environmentId);
  const command = useGcpCommand(environmentId);
  const shell = useThreadShell(threadRef);
  const now = useMinuteClock();
  const link = gcpLinkForProject(snapshot, shell?.projectId);
  const [selected, setSelected] = useState<string | null>(null);
  const environment =
    link?.environments.find((entry) => entry.name === selected) ?? link?.environments[0] ?? null;
  const projectId = environment?.projectId ?? null;
  const resources = projectId === null ? undefined : snapshot?.resources[projectId];
  const loading = projectId !== null && (snapshot?.loading.includes(projectId) ?? false);
  const stale = resources === undefined || Date.parse(resources.fetchedAt) < now - STALE_MS;

  const loadIfStale = useEffectEvent(() => {
    if (projectId !== null && stale && !loading) {
      void command({ type: "loadResources", projectId });
    }
  });
  // oxlint-disable-next-line t3code/react-effect-budget, react/exhaustive-effect-dependencies -- showing an environment is what reads it from Google Cloud; the panel opens from the menu or a restored layout, so no single handler covers it. Only a newly shown one reads; Refresh covers the rest.
  useEffect(() => loadIfStale(), [projectId]);

  if (link === null || environment === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
        <CloudIcon className="size-5" />
        This project isn't linked to Google Cloud. Link it in the project's settings.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div className="mb-3 flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{link.title}</span>
          {link.environments.length > 1 ? (
            <ToggleGroup
              aria-label="Environment"
              size="sm"
              value={[environment.name]}
              onValueChange={(next) => {
                const value = next[0];
                if (typeof value === "string") setSelected(value);
              }}
            >
              {link.environments.map((entry) => (
                <ToggleGroupItem key={entry.name} value={entry.name}>
                  {entry.name}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          ) : null}
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          <span className="font-mono">{environment.projectId}</span> ·{" "}
          {RUNTIME_NAMES[environment.runtime]}
          {environment.region ? ` · ${environment.region}` : ""}
          {environment.deployWorkflow ? ` · deploys with ${environment.deployWorkflow}` : ""}
        </p>
        {resources === undefined ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <LoaderIcon className="size-3 animate-spin" />
            Reading {environment.projectId} with gcloud…
          </p>
        ) : (
          <EnvironmentResources environment={environment} resources={resources} now={now} />
        )}
        <EnvironmentDeploys
          runs={(snapshot?.deploys ?? []).filter(
            (run) => run.key === link.key && run.environment === environment.name,
          )}
          workflow={environment.deployWorkflow}
          now={now}
        />
        {link.terraformRepos.length > 0 ? (
          <div className="mt-3">
            <SectionLabel>Terraform</SectionLabel>
            <ul className="text-xs">
              {link.terraformRepos.map((folder) => (
                <li key={folder} className="truncate py-0.5 font-mono text-muted-foreground">
                  {folder}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-1.5">
          <Button
            size="compact"
            variant="outline"
            render={
              <a
                href={consoleUrl(
                  environment.runtime === "gke" ? "kubernetes/list/overview" : "run",
                  environment.projectId,
                )}
                target="_blank"
                rel="noreferrer"
              />
            }
          >
            <ExternalLinkIcon />
            Open console
          </Button>
        </div>
      </div>
      <div className="flex items-center gap-1.5 border-t border-border px-4 py-2 text-xs text-muted-foreground">
        {loading ? <LoaderIcon className="size-3 animate-spin" /> : null}
        <span className="min-w-0 flex-1 truncate">
          {resources === undefined
            ? "Not read yet"
            : `Read ${relativeAge(resources.fetchedAt, now)} with gcloud`}
        </span>
        <button
          type="button"
          disabled={loading}
          className="inline-flex cursor-pointer items-center gap-1 hover:text-foreground"
          onClick={() => {
            void command({ type: "loadResources", projectId: environment.projectId });
            void command({ type: "refreshDeploys" });
          }}
        >
          <RefreshCwIcon className="size-3" />
          Refresh
        </button>
      </div>
    </div>
  );
}
