import type { GcpDeployRun, GcpRunService } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deployerPerson,
  groupServicesByTag,
  groupStartsOpen,
  imageTag,
  personInitials,
} from "./gcpCloudPanel.logic";

const service = (
  name: string,
  tag: string,
  deployedAt: string,
  deployedBy: string | null = null,
): GcpRunService => ({
  name,
  region: "northamerica-northeast1",
  url: null,
  state: "ready",
  revision: `${name}-00001-abc`,
  image: `northamerica-northeast1-docker.pkg.dev/p/apps/${name}:${tag}`,
  deployedAt,
  deployedBy,
});

const run = (headSha: string, title: string) =>
  ({
    id: "1",
    key: "link",
    environment: "NP",
    workflow: ".github/workflows/deploy-np.yml",
    number: 12,
    status: "completed",
    conclusion: "success",
    url: "https://github.com/o/r/actions/runs/1",
    headSha,
    title,
    createdAt: "2026-11-01T10:00:00Z",
    updatedAt: "2026-11-01T10:05:00Z",
    currentJob: null,
    verified: true,
  }) satisfies GcpDeployRun;

describe("imageTag", () => {
  it("reads a tag or the start of a digest", () => {
    expect(imageTag("r/app/api:8da70c0009d47ff")).toBe("8da70c0009d4");
    expect(imageTag("r/app/api@sha256:abcdef0123456789")).toBe("abcdef012345");
    expect(imageTag(null)).toBeNull();
  });
});

describe("deployerPerson", () => {
  it("keeps people and drops service accounts and project numbers", () => {
    expect(deployerPerson("anthony.thanpoovong@telus.com")).toBe("anthony.thanpoovong@telus.com");
    expect(deployerPerson("cicd-service-account@p.iam.gserviceaccount.com")).toBeNull();
    expect(deployerPerson("1021950645292-compute@developer.gserviceaccount.com")).toBeNull();
    expect(deployerPerson("1021950645292")).toBeNull();
    expect(personInitials("anthony.thanpoovong@telus.com")).toBe("AT");
  });
});

describe("groupServicesByTag", () => {
  it("groups by commit, newest first, with the matching run's title and the people", () => {
    const groups = groupServicesByTag(
      [
        service("ai-scholar", "8da70c0009d47", "2026-10-27T10:00:00Z"),
        service("board-agent", "81ecae6d3d7b", "2026-10-28T10:00:00Z", "a.b@telus.com"),
        service("bff-example", "8da70c0009d47", "2026-10-27T11:00:00Z"),
      ],
      [run("81ecae6d3d7bffff", "feat(board-agent): iManage 2022")],
    );
    expect(groups.map((group) => group.tag)).toEqual(["81ecae6d3d7b", "8da70c0009d4"]);
    expect(groups[0]?.run?.title).toBe("feat(board-agent): iManage 2022");
    expect(groups[0]?.people).toEqual(["a.b@telus.com"]);
    expect(groups[1]?.run).toBeNull();
    expect(groups[1]?.services.map((entry) => entry.name)).toEqual(["ai-scholar", "bff-example"]);
    expect(groups[1]?.deployedAt).toBe("2026-10-27T11:00:00Z");
  });

  it("opens the newest group and the ones from the last two days", () => {
    const now = Date.parse("2026-11-02T12:00:00Z");
    const groups = groupServicesByTag(
      [
        service("a", "1111111", "2026-10-20T10:00:00Z"),
        service("b", "2222222", "2026-10-10T10:00:00Z"),
      ],
      [],
    );
    expect(groups.map((group, index) => groupStartsOpen(group, index, now))).toEqual([true, false]);
    const recent = groupServicesByTag([service("c", "3333333", "2026-11-01T10:00:00Z")], []);
    expect(groupStartsOpen(recent[0]!, 1, now)).toBe(true);
  });
});
