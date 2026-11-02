import type { GcpDeployRun, GcpRunService } from "@t3tools/contracts";

/** `registry/app/api:4f2a9c1` → `4f2a9c1`; digests keep their first characters. */
export const imageTag = (image: string | null) => {
  if (image === null) return null;
  const digest = image.split("@")[1];
  if (digest) return digest.replace("sha256:", "").slice(0, 12);
  const tag = image.split("/").at(-1)?.split(":")[1];
  return tag ? tag.slice(0, 12) : null;
};

/** A person's account, not a service account or a project number. */
export const deployerPerson = (deployedBy: string | null) => {
  if (deployedBy === null || !deployedBy.includes("@")) return null;
  if (deployedBy.endsWith(".gserviceaccount.com")) return null;
  return deployedBy;
};

/** `anthony.thanpoovong@telus.com` → `AT`. */
export const personInitials = (email: string) =>
  email
    .split("@")[0]!
    .split(/[._-]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");

export interface GcpServiceGroup {
  /** The image tag the services run, or null when it can't be read. */
  readonly tag: string | null;
  /** The deploy run that built this commit, when one of the loaded runs matches. */
  readonly run: GcpDeployRun | null;
  readonly services: ReadonlyArray<GcpRunService>;
  readonly deployedAt: string | null;
  readonly people: ReadonlyArray<string>;
}

const newest = (a: string | null, b: string | null) =>
  a === null ? b : b === null ? a : Date.parse(a) >= Date.parse(b) ? a : b;

/** Healthy services grouped by the image tag (usually the commit) they run, newest first. */
export function groupServicesByTag(
  services: ReadonlyArray<GcpRunService>,
  runs: ReadonlyArray<GcpDeployRun>,
): GcpServiceGroup[] {
  const byTag = new Map<string | null, GcpRunService[]>();
  for (const service of services) {
    const tag = imageTag(service.image);
    byTag.set(tag, [...(byTag.get(tag) ?? []), service]);
  }
  return [...byTag.entries()]
    .map(([tag, members]) => ({
      tag,
      run:
        tag === null || tag.length < 7
          ? null
          : (runs.find((run) => run.headSha.startsWith(tag.slice(0, 7))) ?? null),
      services: members.toSorted((a, b) => a.name.localeCompare(b.name)),
      deployedAt: members.reduce<string | null>(
        (latest, service) => newest(latest, service.deployedAt),
        null,
      ),
      people: [...new Set(members.flatMap((service) => deployerPerson(service.deployedBy) ?? []))],
    }))
    .toSorted(
      (a, b) =>
        (b.deployedAt === null ? 0 : Date.parse(b.deployedAt)) -
        (a.deployedAt === null ? 0 : Date.parse(a.deployedAt)),
    );
}

/** A group starts open when it is the newest one or deployed in the last two days. */
export const RECENT_GROUP_MS = 2 * 24 * 60 * 60 * 1000;

export function groupStartsOpen(group: GcpServiceGroup, index: number, now: number) {
  return (
    index === 0 ||
    (group.deployedAt !== null && Date.parse(group.deployedAt) > now - RECENT_GROUP_MS)
  );
}
