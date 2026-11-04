import type {
  GcpDeployRun,
  GcpEnvironment,
  GcpEnvironmentResources,
  GcpResourceState,
  GcpRunService,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  ArrowUpRightIcon,
  CheckIcon,
  ChevronRightIcon,
  CloudIcon,
  ExternalLinkIcon,
  LoaderIcon,
  ScrollTextIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { type ReactNode, useEffect, useEffectEvent, useState } from "react";

import { cn } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";
import { gcpLinkForProject, useGcpCommand, useGcpSnapshot } from "~/state/gcp";
import { relativeAge } from "~/state/jira";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { RefreshIcon } from "../ui/refresh-icon";
import { Skeleton } from "../ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  type GcpServiceGroup,
  groupServicesByTag,
  groupStartsOpen,
  imageTag,
  personInitials,
} from "./gcpCloudPanel.logic";
import { useGcpFollowedDeploysStore } from "./gcpFollowedDeploysStore";
import { useMinuteClock } from "./useMinuteClock";

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

/** A finished deploy stays on top this long, so its result is seen. */
const FINISHED_DEPLOY_MS = 15 * 60 * 1000;
const FILTER_FROM_SERVICES = 10;

const consoleUrl = (path: string, projectId: string) =>
  `https://console.cloud.google.com/${path}?project=${encodeURIComponent(projectId)}`;

const revisionNumber = (revision: string | null) => revision?.split("-").at(-2) ?? null;

function SectionLabel({ children, end }: { children: ReactNode; end?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-1 pt-3 pb-1">
      <span className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
        {children}
      </span>
      {end ? <span className="ms-auto truncate text-xs text-muted-foreground">{end}</span> : null}
    </div>
  );
}

function IconLink({ href, label, icon }: { href: string; label: string; icon: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-micro"
            variant="ghost"
            aria-label={label}
            render={<a href={href} target="_blank" rel="noreferrer" />}
          />
        }
      >
        {icon}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

function PersonBadge({ email }: { email: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-info/20 text-3xs font-semibold text-foreground" />
        }
      >
        {personInitials(email)}
      </TooltipTrigger>
      <TooltipPopup>Deployed by {email}</TooltipPopup>
    </Tooltip>
  );
}

function ServiceRow({
  service,
  projectId,
  now,
  tag,
}: {
  service: GcpRunService;
  projectId: string;
  now: number;
  /** Set when the row stands alone for its commit, so it shows the commit and age itself. */
  tag?: string | null;
}) {
  const alone = tag !== undefined;
  const details = [
    revisionNumber(service.revision) ? `Revision ${revisionNumber(service.revision)}` : null,
    imageTag(service.image) ? `image ${imageTag(service.image)}` : null,
    service.region,
    service.deployedAt ? `deployed ${relativeAge(service.deployedAt, now)}` : null,
    service.deployedBy ? `by ${service.deployedBy}` : null,
  ].filter(Boolean);
  return (
    <li
      className={cn(
        "group/service flex h-7 items-center gap-2 rounded-md pe-1 text-xs hover:bg-accent",
        alone ? "ps-5.5" : "ps-6",
      )}
    >
      {alone ? (
        <span className="shrink-0 font-mono text-muted-foreground">
          {tag?.slice(0, 7) ?? "no tag"}
        </span>
      ) : null}
      {service.state === "ready" ? null : (
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT[service.state])} />
      )}
      <Tooltip>
        <TooltipTrigger render={<span className="min-w-0 truncate" />}>
          {service.name}
        </TooltipTrigger>
        <TooltipPopup>{details.join(" · ")}</TooltipPopup>
      </Tooltip>
      {alone && service.deployedAt ? (
        <span className="ms-auto min-w-14 shrink-0 text-end whitespace-nowrap text-muted-foreground tabular-nums group-hover/service:hidden group-focus-within/service:hidden">
          {relativeAge(service.deployedAt, now)}
        </span>
      ) : null}
      <span
        className={cn(
          "ms-auto shrink-0 items-center gap-0.5",
          alone
            ? "hidden group-hover/service:flex group-focus-within/service:flex"
            : "flex opacity-0 group-hover/service:opacity-100 group-focus-within/service:opacity-100",
        )}
      >
        {service.url ? (
          <IconLink href={service.url} label={`Open ${service.name}`} icon={<ExternalLinkIcon />} />
        ) : null}
        {service.region ? (
          <IconLink
            href={consoleUrl(`run/detail/${service.region}/${service.name}/logs`, projectId)}
            label={`Logs of ${service.name}`}
            icon={<ScrollTextIcon />}
          />
        ) : null}
      </span>
    </li>
  );
}

function ServiceGroup({
  group,
  open,
  onToggle,
  projectId,
  now,
}: {
  group: GcpServiceGroup;
  open: boolean;
  onToggle: () => void;
  projectId: string;
  now: number;
}) {
  const [only] = group.services;
  if (group.services.length === 1 && only && group.run === null) {
    return <ServiceRow service={only} projectId={projectId} now={now} tag={group.tag} />;
  }
  const names = group.services.map((service) => service.name);
  const summary =
    group.run?.title ??
    (names.length > 2 ? `${names.slice(0, 2).join(", ")}, +${names.length - 2}` : names.join(", "));
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-md px-1 text-left text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="shrink-0 font-mono">{group.tag?.slice(0, 7) ?? "no tag"}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {open && group.run === null ? null : summary}
        </span>
        {group.people.slice(0, 2).map((email) => (
          <PersonBadge key={email} email={email} />
        ))}
        {open ? null : (
          <span className="shrink-0 text-muted-foreground tabular-nums">
            {group.services.length}
          </span>
        )}
        {group.deployedAt ? (
          <span className="min-w-14 shrink-0 text-end whitespace-nowrap text-muted-foreground tabular-nums">
            {relativeAge(group.deployedAt, now)}
          </span>
        ) : null}
      </button>
      {open ? (
        <ul>
          {group.services.map((service) => (
            <ServiceRow key={service.name} service={service} projectId={projectId} now={now} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function AttentionRow({
  name,
  detail,
  href,
  hrefLabel,
}: {
  name: string;
  detail: string;
  href: string | null;
  hrefLabel: string;
}) {
  return (
    <li className="flex h-8 items-center gap-2 rounded-md bg-destructive/8 ps-2.5 pe-1 text-xs">
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-destructive" />
      <span className="min-w-0 truncate font-medium">{name}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{detail}</span>
      {href ? <IconLink href={href} label={hrefLabel} icon={<ScrollTextIcon />} /> : null}
    </li>
  );
}

function EnvironmentResources({
  environment,
  resources,
  runs,
  now,
}: {
  environment: GcpEnvironment;
  resources: GcpEnvironmentResources;
  runs: ReadonlyArray<GcpDeployRun>;
  now: number;
}) {
  const { projectId } = environment;
  const [query, setQuery] = useState("");
  const [toggledGroups, setToggledGroups] = useState<ReadonlySet<string>>(new Set());
  const [jobsOpen, setJobsOpen] = useState(false);
  const failedServices = resources.services.filter((service) => service.state === "failed");
  const failedJobs = resources.jobs.filter((job) => job.lastRunState === "failed");
  const needle = query.trim().toLowerCase();
  const shownServices = resources.services.filter(
    (service) =>
      service.state !== "failed" && (needle === "" || service.name.toLowerCase().includes(needle)),
  );
  const groups = groupServicesByTag(shownServices, runs);
  const runningJobs = resources.jobs.filter((job) => job.lastRunState === "running").length;
  const lastJobRun = resources.jobs.reduce<string | null>(
    (latest, job) =>
      job.lastRunAt !== null && (latest === null || job.lastRunAt > latest)
        ? job.lastRunAt
        : latest,
    null,
  );
  const empty =
    resources.services.length === 0 &&
    resources.jobs.length === 0 &&
    resources.clusters.length === 0;

  return (
    <>
      {resources.message ? (
        <p className="px-1 pt-2 text-xs text-warning-foreground">{resources.message}</p>
      ) : null}
      {failedServices.length + failedJobs.length > 0 ? (
        <>
          <SectionLabel>Needs attention</SectionLabel>
          <ul className="flex flex-col gap-1">
            {failedServices.map((service) => (
              <AttentionRow
                key={service.name}
                name={service.name}
                detail={
                  revisionNumber(service.revision)
                    ? `revision ${revisionNumber(service.revision)} failed`
                    : "failed"
                }
                href={
                  service.region
                    ? consoleUrl(`run/detail/${service.region}/${service.name}/logs`, projectId)
                    : null
                }
                hrefLabel={`Logs of ${service.name}`}
              />
            ))}
            {failedJobs.map((job) => (
              <AttentionRow
                key={job.name}
                name={job.name}
                detail={`last run failed${job.lastRunAt ? ` ${relativeAge(job.lastRunAt, now)}` : ""}`}
                href={
                  job.region
                    ? consoleUrl(`run/jobs/details/${job.region}/${job.name}/executions`, projectId)
                    : null
                }
                hrefLabel={`Runs of ${job.name}`}
              />
            ))}
          </ul>
        </>
      ) : null}
      {resources.services.length > 0 ? (
        <>
          <SectionLabel
            end={`${resources.services.length} service${resources.services.length === 1 ? "" : "s"}`}
          >
            Services by commit
          </SectionLabel>
          {resources.services.length > FILTER_FROM_SERVICES ? (
            <InputGroup className="mb-1">
              <InputGroupAddon>
                <SearchIcon aria-hidden className="size-3" />
              </InputGroupAddon>
              <InputGroupInput
                size="sm"
                aria-label="Filter services"
                placeholder="Filter services"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setQuery("");
                }}
              />
            </InputGroup>
          ) : null}
          <ul>
            {groups.map((group, index) => {
              const key = group.tag ?? "";
              const open =
                needle !== "" || groupStartsOpen(group, index, now) !== toggledGroups.has(key);
              return (
                <ServiceGroup
                  key={key}
                  group={group}
                  open={open}
                  onToggle={() =>
                    setToggledGroups((current) => {
                      const next = new Set(current);
                      if (!next.delete(key)) next.add(key);
                      return next;
                    })
                  }
                  projectId={projectId}
                  now={now}
                />
              );
            })}
          </ul>
          {groups.length === 0 && needle !== "" ? (
            <p className="px-1 py-1 text-xs text-muted-foreground">No service matches "{query}".</p>
          ) : null}
        </>
      ) : null}
      {resources.jobs.length > 0 ? (
        <>
          <button
            type="button"
            aria-expanded={jobsOpen}
            onClick={() => setJobsOpen((current) => !current)}
            className="mt-2 flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-md px-1 text-left text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
          >
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-3 shrink-0 text-muted-foreground transition-transform",
                jobsOpen && "rotate-90",
              )}
            />
            <span className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
              Jobs
            </span>
            <span className="ms-auto truncate text-muted-foreground">
              {resources.jobs.length} job{resources.jobs.length === 1 ? "" : "s"}
              {failedJobs.length > 0
                ? `, ${failedJobs.length} failed`
                : runningJobs > 0
                  ? `, ${runningJobs} running`
                  : ""}
              {lastJobRun ? ` · last run ${relativeAge(lastJobRun, now)}` : ""}
            </span>
          </button>
          {jobsOpen ? (
            <ul>
              {resources.jobs.map((job) => (
                <li key={job.name} className="flex h-7 items-center gap-2 ps-6 pe-1 text-xs">
                  <span
                    aria-hidden
                    className={cn("size-1.5 shrink-0 rounded-full", DOT[job.lastRunState])}
                  />
                  <span className="min-w-0 flex-1 truncate">{job.name}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {job.lastRunAt === null ? "never ran" : relativeAge(job.lastRunAt, now)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
      {resources.clusters.length > 0 ? (
        <>
          <SectionLabel>GKE clusters</SectionLabel>
          <ul>
            {resources.clusters.map((cluster) => (
              <li key={cluster.name} className="flex h-7 items-center gap-2 px-1 text-xs">
                {cluster.state === "ready" ? null : (
                  <span
                    aria-hidden
                    className={cn("size-1.5 shrink-0 rounded-full", DOT[cluster.state])}
                  />
                )}
                <span className="min-w-0 flex-1 truncate">{cluster.name}</span>
                <span className="shrink-0 text-muted-foreground">
                  {[cluster.location, cluster.version].filter(Boolean).join(" · ")}
                </span>
                <IconLink
                  href={consoleUrl("kubernetes/workload/overview", projectId)}
                  label={`Workloads in ${cluster.name}`}
                  icon={<ExternalLinkIcon />}
                />
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {empty && resources.message === null ? (
        <p className="px-1 pt-3 text-xs text-muted-foreground">
          Nothing runs on Cloud Run here
          {environment.runtime === "gke" ? " and no GKE cluster was found" : ""}.
        </p>
      ) : null}
    </>
  );
}

function DeployStep({
  state,
  children,
}: {
  state: "done" | "running" | "failed" | "waiting";
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1",
        state === "waiting" && "text-muted-foreground",
      )}
    >
      {state === "done" ? (
        <CheckIcon aria-hidden className="size-3 text-success" />
      ) : state === "failed" ? (
        <XIcon aria-hidden className="size-3 text-destructive" />
      ) : state === "running" ? (
        <LoaderIcon aria-hidden className="size-3 animate-spin text-info" />
      ) : (
        <span aria-hidden className="size-1.5 rounded-full bg-muted-foreground/50" />
      )}
      {children}
    </span>
  );
}

/** The deploy running now (or just finished) for one environment, from GitHub to Google Cloud. */
function LiveDeploy({
  run,
  environment,
  now,
  threadKey,
}: {
  run: GcpDeployRun;
  environment: string;
  now: number;
  threadKey: string;
}) {
  const following = useGcpFollowedDeploysStore((state) =>
    (state.followedByThreadKey[threadKey] ?? []).includes(run.id),
  );
  const follow = useGcpFollowedDeploysStore((state) => state.follow);
  const unfollow = useGcpFollowedDeploysStore((state) => state.unfollow);
  const finished = run.status === "completed";
  const succeeded = finished && run.conclusion === "success";
  const failed = finished && !succeeded;
  const verifyFailed = succeeded && run.verified === false;
  const title = failed
    ? `Deploy of ${run.headSha.slice(0, 7)} to ${environment} failed`
    : succeeded && run.verified === true
      ? `${run.headSha.slice(0, 7)} is live on ${environment}`
      : `Deploying ${run.headSha.slice(0, 7)} to ${environment}`;
  return (
    <div
      className={cn(
        "mt-2 rounded-lg border px-3 py-2 text-xs",
        failed || verifyFailed
          ? "border-destructive/40 bg-destructive/6"
          : "border-info/35 bg-info/6",
      )}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
        <span className="shrink-0 text-muted-foreground">{relativeAge(run.createdAt, now)}</span>
        <Button
          size="xs"
          variant="outline"
          onClick={() => (following ? unfollow(threadKey, run.id) : follow(threadKey, run.id))}
        >
          {following ? "Following" : "Follow in this chat"}
        </Button>
        <IconLink href={run.url} label="Open the run on GitHub" icon={<ExternalLinkIcon />} />
      </div>
      <p className="truncate text-muted-foreground">{run.title}</p>
      <div className="mt-1.5 flex items-center gap-2">
        <DeployStep state={failed ? "failed" : finished ? "done" : "running"}>
          {finished
            ? `GitHub run${run.number === null ? "" : ` #${run.number}`}`
            : run.status === "waiting"
              ? "Waiting for approval"
              : (run.currentJob ?? "GitHub run")}
        </DeployStep>
        <span aria-hidden className="h-px min-w-3 flex-1 bg-border" />
        <DeployStep
          state={
            !succeeded
              ? "waiting"
              : run.verified === true
                ? "done"
                : run.verified === false
                  ? "failed"
                  : "running"
          }
        >
          {verifyFailed ? "Google Cloud runs another commit" : "Google Cloud serves it"}
        </DeployStep>
      </div>
    </div>
  );
}

function RecentDeploys({ runs, now }: { runs: ReadonlyArray<GcpDeployRun>; now: number }) {
  if (runs.length === 0) return null;
  return (
    <>
      <SectionLabel>Recent deploys</SectionLabel>
      <ul>
        {runs.slice(0, 5).map((run) => (
          <li
            key={run.id}
            className="group/deploy flex h-7 items-center gap-2 rounded-md px-1 text-xs hover:bg-accent"
          >
            {run.status !== "completed" ? (
              <LoaderIcon aria-hidden className="size-3 shrink-0 animate-spin text-info" />
            ) : run.conclusion === "success" ? (
              <CheckIcon aria-hidden className="size-3 shrink-0 text-success" />
            ) : (
              <XIcon aria-hidden className="size-3 shrink-0 text-destructive" />
            )}
            <span className="shrink-0 font-mono text-muted-foreground">
              {run.headSha.slice(0, 7)}
            </span>
            <span className="min-w-0 flex-1 truncate">{run.title}</span>
            <span className="shrink-0 text-muted-foreground group-hover/deploy:hidden">
              {relativeAge(run.createdAt, now)}
            </span>
            <span className="hidden shrink-0 group-hover/deploy:flex">
              <IconLink href={run.url} label="Open the run on GitHub" icon={<ExternalLinkIcon />} />
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

function ResourcesSkeleton() {
  return (
    <div className="flex flex-col gap-2 px-1 pt-4" aria-label="Reading from Google Cloud">
      <Skeleton className="h-3 w-24" />
      {[70, 55, 80, 45].map((width) => (
        <Skeleton key={width} className="h-3.5" style={{ width: `${width}%` }} />
      ))}
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync, react/exhaustive-effect-dependencies -- showing an environment is what reads it from Google Cloud; the panel opens from the menu or a restored layout, so no single handler covers it. Only a newly shown one reads; Refresh covers the rest.
  useEffect(() => loadIfStale(), [projectId]);

  if (link === null || environment === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
        <CloudIcon className="size-5" />
        This project isn't linked to Google Cloud. Link it in the project's settings.
      </div>
    );
  }

  const runs = (snapshot?.deploys ?? []).filter(
    (run) => run.key === link.key && run.environment === environment.name,
  );
  const liveRun =
    runs.find(
      (run) => run.status !== "completed" || Date.parse(run.updatedAt) > now - FINISHED_DEPLOY_MS,
    ) ?? null;
  const describe = (entry: GcpEnvironment) =>
    [
      entry.projectId,
      RUNTIME_NAMES[entry.runtime],
      entry.region,
      entry.deployWorkflow ? `deploys with ${entry.deployWorkflow.split("/").at(-1)}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
  const readLabel =
    resources === undefined
      ? "Not read yet. Refresh"
      : `Read ${relativeAge(resources.fetchedAt, now)} with gcloud. Refresh`;

  return (
    <div className="h-full min-h-0 overflow-y-auto px-3 py-3">
      <div className="flex items-center gap-1.5 px-1">
        <CloudIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
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
              <Tooltip key={entry.name}>
                <TooltipTrigger render={<ToggleGroupItem value={entry.name} />}>
                  {entry.name}
                </TooltipTrigger>
                <TooltipPopup>{describe(entry)}</TooltipPopup>
              </Tooltip>
            ))}
          </ToggleGroup>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Refresh"
                disabled={loading}
                onClick={() => {
                  void command({ type: "loadResources", projectId: environment.projectId });
                  void command({ type: "refreshDeploys" });
                }}
              />
            }
          >
            <RefreshIcon refreshing={loading} />
          </TooltipTrigger>
          <TooltipPopup>{readLabel}</TooltipPopup>
        </Tooltip>
        <IconLink
          href={consoleUrl(
            environment.runtime === "gke" ? "kubernetes/list/overview" : "run",
            environment.projectId,
          )}
          label="Open in the Google Cloud console"
          icon={<ArrowUpRightIcon />}
        />
      </div>
      <p className="truncate px-1 font-mono text-2xs text-muted-foreground select-all">
        {environment.projectId}
      </p>
      {liveRun ? (
        <LiveDeploy
          run={liveRun}
          environment={environment.name}
          now={now}
          threadKey={scopedThreadKey(threadRef)}
        />
      ) : null}
      {resources === undefined ? (
        <ResourcesSkeleton />
      ) : (
        <EnvironmentResources
          key={environment.projectId}
          environment={environment}
          resources={resources}
          runs={runs}
          now={now}
        />
      )}
      {environment.deployWorkflow ? (
        <RecentDeploys runs={runs.filter((run) => run !== liveRun)} now={now} />
      ) : null}
      {link.terraformRepos.length > 0 ? (
        <>
          <SectionLabel>Terraform</SectionLabel>
          <ul className="text-xs">
            {link.terraformRepos.map((folder) => (
              <li key={folder} className="truncate px-1 py-0.5 font-mono text-muted-foreground">
                {folder}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
