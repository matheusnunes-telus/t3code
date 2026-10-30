import type { GcpLoginStatus } from "@t3tools/contracts";

/**
 * Where gcloud lives when it isn't on PATH: the official installer's folder, Homebrew's cask,
 * and Linux packages. An explicit path in settings comes first.
 */
export function gcloudCandidates(input: {
  readonly configuredPath: string;
  readonly pathEntries: ReadonlyArray<string>;
  readonly home: string;
  readonly platform: NodeJS.Platform;
}): ReadonlyArray<string> {
  const binary = input.platform === "win32" ? "gcloud.cmd" : "gcloud";
  const join = (dir: string) => `${dir.replace(/[\\/]+$/, "")}/${binary}`;
  const fromPath = input.pathEntries.filter((entry) => entry.length > 0).map(join);
  const known =
    input.platform === "win32"
      ? [
          `${input.home}/AppData/Local/Google/Cloud SDK/google-cloud-sdk/bin`,
          "C:/Program Files (x86)/Google/Cloud SDK/google-cloud-sdk/bin",
        ]
      : [
          `${input.home}/google-cloud-sdk/bin`,
          "/opt/homebrew/share/google-cloud-sdk/bin",
          "/usr/local/share/google-cloud-sdk/bin",
          "/opt/homebrew/bin",
          "/usr/local/bin",
          "/usr/lib/google-cloud-sdk/bin",
          "/snap/bin",
        ];
  const all = [
    ...(input.configuredPath.length > 0 ? [input.configuredPath] : []),
    ...fromPath,
    ...known.map(join),
  ];
  return [...new Set(all)];
}

/**
 * Reads a `print-access-token` run. A token means signed in; gcloud's wording tells a login
 * that needs the browser again from one that never existed, and anything else (offline, a broken
 * install) is reported as an error rather than as signed out.
 */
export function classifyLogin(input: {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}): { readonly status: GcpLoginStatus; readonly message: string | null } {
  if (input.exitCode === 0 && input.stdout.trim().length > 0) {
    return { status: "ok", message: null };
  }
  const output = `${input.stderr}\n${input.stdout}`.trim();
  const lower = output.toLowerCase();
  const message = lastErrorLine(output);
  if (
    /do not currently have an active account|no credentialed accounts|default credentials were not found|could not automatically determine credentials|file .* was not found/.test(
      lower,
    )
  ) {
    return { status: "missing", message };
  }
  // Offline, gcloud also says it had "a problem refreshing your current auth tokens".
  if (
    /connection|unable to find the server|timed out|name resolution|network is unreachable/.test(
      lower,
    )
  ) {
    return { status: "error", message };
  }
  if (
    /reauth|invalid_grant|invalid_rapt|refresh(ing)? (your )?(current )?(auth )?tokens?|token has been expired|expired or revoked|auth (application-default )?login/.test(
      lower,
    )
  ) {
    return { status: "expired", message };
  }
  return { status: "error", message: message ?? "gcloud could not check the login." };
}

function lastErrorLine(output: string): string | null {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const error = lines.find((line) => line.startsWith("ERROR:")) ?? lines.at(-1);
  return error === undefined ? null : error.replace(/^ERROR:\s*(\([^)]*\)\s*)?/, "").slice(0, 300);
}
