import { describe, expect, it } from "@effect/vitest";

import { classifyLogin, gcloudCandidates } from "./gcpModel.ts";

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
