import { describe, expect, it } from "@effect/vitest";

import {
  classifyLogin,
  environmentNameOf,
  formatTurnContext,
  gcloudCandidates,
  isTerraformCandidate,
  matchCloudProjects,
  nameTokens,
  suggestEnvironments,
} from "./gcpModel.ts";

describe("gcloudCandidates", () => {
  it("tries the configured path, then PATH, then the usual install folders, once each", () => {
    const candidates = gcloudCandidates({
      configuredPath: "/custom/gcloud",
      pathEntries: ["/opt/homebrew/bin", "/work/sdk/bin/", ""],
      home: "/Users/someone",
      platform: "darwin",
    });
    expect(candidates.slice(0, 4)).toEqual([
      "/custom/gcloud",
      "/opt/homebrew/bin/gcloud",
      "/work/sdk/bin/gcloud",
      "/Users/someone/google-cloud-sdk/bin/gcloud",
    ]);
    expect(candidates.filter((entry) => entry === "/opt/homebrew/bin/gcloud")).toHaveLength(1);
  });
});

describe("classifyLogin", () => {
  it("treats a printed token as signed in", () => {
    expect(classifyLogin({ exitCode: 0, stdout: "ya29.token\n", stderr: "" }).status).toBe("ok");
  });

  it("tells an expired login from a missing one", () => {
    expect(
      classifyLogin({
        exitCode: 1,
        stdout: "",
        stderr:
          "ERROR: (gcloud.auth.print-access-token) There was a problem refreshing your current auth tokens: Reauthentication failed. cannot prompt during non-interactive execution.\nPlease run:\n\n  $ gcloud auth login",
      }),
    ).toEqual({
      status: "expired",
      message:
        "There was a problem refreshing your current auth tokens: Reauthentication failed. cannot prompt during non-interactive execution.",
    });
    expect(
      classifyLogin({
        exitCode: 1,
        stdout: "",
        stderr:
          "ERROR: (gcloud.auth.print-access-token) You do not currently have an active account selected.",
      }).status,
    ).toBe("missing");
    expect(
      classifyLogin({
        exitCode: 1,
        stdout: "",
        stderr:
          "ERROR: (gcloud.auth.application-default.print-access-token) Your default credentials were not found.",
      }).status,
    ).toBe("missing");
  });

  it("does not call a network failure a sign-out", () => {
    expect(
      classifyLogin({
        exitCode: 1,
        stdout: "",
        stderr:
          "ERROR: gcloud crashed (ConnectionError): Unable to find the server at oauth2.googleapis.com",
      }).status,
    ).toBe("error");
    expect(
      classifyLogin({
        exitCode: 1,
        stdout: "",
        stderr:
          "ERROR: (gcloud.auth.print-access-token) There was a problem refreshing your current auth tokens: ('Connection aborted.', RemoteDisconnected())",
      }).status,
    ).toBe("error");
  });
});

describe("link suggestions", () => {
  const projects = [
    { projectId: "acme-billing-pr-9f8e7d", name: "acme-billing-pr" },
    { projectId: "acme-billing-np-1a2b3c", name: "acme-billing-np" },
    { projectId: "acme-search-np-4d5e6f", name: "acme-search-np" },
  ];

  it("matches the account's projects by distinctive name words, non-prod first", () => {
    const tokens = nameTokens("billing", "billing-service");
    expect(tokens).toEqual(["billing"]);
    expect(matchCloudProjects(tokens, projects).map((project) => project.projectId)).toEqual([
      "acme-billing-np-1a2b3c",
      "acme-billing-pr-9f8e7d",
    ]);
    expect(matchCloudProjects(nameTokens("web app"), projects)).toEqual([]);
  });

  it("names environments from common markers and keeps the id otherwise", () => {
    expect(environmentNameOf("acme-billing-np-1a2b3c").name).toBe("NP");
    expect(environmentNameOf("acme-billing-prod").name).toBe("Prod");
    expect(environmentNameOf("acme-billing-staging").name).toBe("Staging");
    expect(environmentNameOf("acme-billing").name).toBe("acme-billing");
  });

  it("pairs each environment with the deploy workflow that names it, or by file name", () => {
    const environments = suggestEnvironments({
      projects: [projects[1]!, projects[0]!],
      workflows: [
        { path: ".github/workflows/ci.yml", content: "runs tests" },
        {
          path: ".github/workflows/deploy-np.yml",
          content:
            "env:\n  PROJECT_ID: acme-billing-np-1a2b3c\n  REGION: europe-west1\nuses: google-github-actions/deploy-cloudrun@v2",
        },
        {
          path: ".github/workflows/deploy-prod.yml",
          content: "project: ${{ vars.PROJECT }}\nrun: kubectl apply -f k8s/",
        },
      ],
    });
    expect(environments).toEqual([
      {
        name: "NP",
        projectId: "acme-billing-np-1a2b3c",
        region: "europe-west1",
        runtime: "cloud-run",
        deployWorkflow: ".github/workflows/deploy-np.yml",
      },
      {
        name: "Prod",
        projectId: "acme-billing-pr-9f8e7d",
        region: null,
        runtime: "gke",
        deployWorkflow: ".github/workflows/deploy-prod.yml",
      },
    ]);
  });

  it("only offers folders with Terraform files that share a name word", () => {
    const tokens = ["billing"];
    expect(
      isTerraformCandidate({ folderName: "tf-infra-billing", tokens, hasTerraformFiles: true }),
    ).toBe(true);
    expect(
      isTerraformCandidate({ folderName: "tf-infra-billing", tokens, hasTerraformFiles: false }),
    ).toBe(false);
    expect(
      isTerraformCandidate({
        folderName: "tf-infra-billing.worktrees",
        tokens,
        hasTerraformFiles: true,
      }),
    ).toBe(false);
    expect(
      isTerraformCandidate({ folderName: "tf-infra-search", tokens, hasTerraformFiles: true }),
    ).toBe(false);
  });
});

describe("formatTurnContext", () => {
  const link = {
    key: "billing",
    title: "billing",
    projectIds: ["project-1"],
    workspaceRoot: "/code/billing",
    environments: [
      {
        name: "Staging",
        projectId: "acme-billing-stg",
        region: "europe-west1",
        runtime: "cloud-run" as const,
        deployWorkflow: ".github/workflows/deploy-staging.yml",
      },
      {
        name: "Prod",
        projectId: "acme-billing-prod",
        region: null,
        runtime: "gke" as const,
        deployWorkflow: null,
      },
    ],
    terraformRepos: ["/code/billing-infra"],
  };

  it("lists the linked environments, the Terraform folders and where deploys start", () => {
    expect(
      formatTurnContext({ link, gcloudPath: "/usr/bin/gcloud", account: "dev@example.com" }),
    ).toBe(
      [
        "<google-cloud-context>",
        "This project runs on Google Cloud. The user linked these environments in T3:",
        "- Staging: project acme-billing-stg, Cloud Run, region europe-west1, deployed by .github/workflows/deploy-staging.yml",
        "- Prod: project acme-billing-prod, GKE",
        "Terraform for these environments: /code/billing-infra",
        "gcloud: /usr/bin/gcloud, signed in as dev@example.com. Pass --project explicitly.",
        "Deploys start from the GitHub workflows above, not from gcloud, unless the user asks.",
        "</google-cloud-context>",
      ].join("\n"),
    );
  });

  it("says nothing when the user turned it off or linked no environment", () => {
    expect(
      formatTurnContext({
        link: { ...link, agentContext: false },
        gcloudPath: null,
        account: null,
      }),
    ).toBeNull();
    expect(
      formatTurnContext({ link: { ...link, environments: [] }, gcloudPath: null, account: null }),
    ).toBeNull();
  });
});
