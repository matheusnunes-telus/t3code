import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { type ClaudeSettings, TextGenerationError } from "@t3tools/contracts";
import type {
  ConnectorAgent,
  ConnectorAgentResult,
  ConnectorAgentToolResult,
} from "@t3tools/provider-core/server/driver";
import { normalizeCliError } from "@t3tools/provider-core/server/textGenerationUtils";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  type ClaudeModelCatalog,
  resolveClaudeCatalogApiModelId,
  resolveClaudeModelSlug,
} from "../ClaudeModelCatalog.ts";
import { makeClaudeEnvironment } from "./ClaudeHome.ts";

const CONNECTOR_AGENT_TIMEOUT_MS = 180_000;

const decodeJsonLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Where Claude Code says it saved a tool reply too large to keep in the conversation. */
const SAVED_OUTPUT_PATH = /(\/[^\s"'`]*tool-results\/[^\s"'`]+)/;

interface ParsedStream {
  readonly toolResults: ReadonlyArray<ConnectorAgentToolResult>;
  readonly output: unknown;
  readonly availableTools: ReadonlyArray<string>;
  readonly mcpServers: ReadonlyArray<{ readonly name: string; readonly status: string }>;
  readonly error: string | undefined;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const entry = record(block);
      return entry?.type === "text" && typeof entry.text === "string" ? entry.text : "";
    })
    .join("");
}

/**
 * Reads `claude -p --output-format stream-json --verbose` output: which connector tools the run
 * had, every tool call with its raw reply, and the final answer.
 */
export function parseClaudeAgentStream(stdout: string): ParsedStream {
  const calls = new Map<string, { readonly tool: string; readonly input: unknown }>();
  const toolResults: Array<ConnectorAgentToolResult> = [];
  let availableTools: ReadonlyArray<string> = [];
  let mcpServers: ReadonlyArray<{ name: string; status: string }> = [];
  let output: unknown = undefined;
  let lastText: string | undefined;
  let error: string | undefined;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    const message = record(Option.getOrUndefined(decodeJsonLine(trimmed)));
    if (message === undefined) continue;
    if (message.type === "system" && message.subtype === "init") {
      if (Array.isArray(message.tools)) {
        availableTools = message.tools.filter((tool): tool is string => typeof tool === "string");
      }
      if (Array.isArray(message.mcp_servers)) {
        mcpServers = message.mcp_servers.flatMap((server) => {
          const entry = record(server);
          return typeof entry?.name === "string"
            ? [{ name: entry.name, status: typeof entry.status === "string" ? entry.status : "" }]
            : [];
        });
      }
      continue;
    }
    const content = record(message.message)?.content;
    if (message.type === "assistant" && Array.isArray(content)) {
      for (const block of content) {
        const entry = record(block);
        if (entry?.type === "tool_use" && typeof entry.id === "string") {
          calls.set(entry.id, { tool: String(entry.name ?? ""), input: entry.input });
        } else if (entry?.type === "text" && typeof entry.text === "string") {
          lastText = entry.text;
        }
      }
      continue;
    }
    if (message.type === "user" && Array.isArray(content)) {
      for (const block of content) {
        const entry = record(block);
        if (entry?.type !== "tool_result") continue;
        const call =
          typeof entry.tool_use_id === "string" ? calls.get(entry.tool_use_id) : undefined;
        toolResults.push({
          tool: call?.tool ?? "",
          input: call?.input,
          isError: entry.is_error === true,
          text: toolResultText(entry.content),
        });
      }
      continue;
    }
    if (message.type === "result") {
      if (message.structured_output !== undefined) output = message.structured_output;
      if (typeof message.result === "string") lastText = message.result;
      if (message.is_error === true) {
        error = typeof message.result === "string" ? message.result : "Claude reported an error.";
      }
    }
  }
  return { toolResults, output: output ?? lastText, availableTools, mcpServers, error };
}

export const makeClaudeConnectorAgent = Effect.fn("makeClaudeConnectorAgent")(function* (
  claudeSettings: ClaudeSettings,
  environment: NodeJS.ProcessEnv,
  modelCatalog: Effect.Effect<ClaudeModelCatalog>,
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);

  const collect = <E>(operation: string, stream: Stream.Stream<Uint8Array, E>) =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
      Effect.mapError((cause) =>
        normalizeCliError("claude", operation, cause, "Failed to collect process output"),
      ),
    );

  /** A reply Claude Code moved to a file is swapped back for the file, so callers get it whole. */
  const expandSavedOutput = (result: ConnectorAgentToolResult) => {
    const path = SAVED_OUTPUT_PATH.exec(result.text)?.[1];
    if (path === undefined) return Effect.succeed(result);
    return fileSystem.readFileString(path).pipe(
      Effect.map((text) => ({ ...result, text })),
      Effect.orElseSucceed(() => result),
    );
  };

  const run: ConnectorAgent["run"] = Effect.fn("ClaudeConnectorAgent.run")(function* (request) {
    const { operation } = request;
    const catalog = yield* modelCatalog;
    const modelSelection = {
      ...request.modelSelection,
      model: resolveClaudeModelSlug(catalog, request.modelSelection.model),
    };
    const settingsJson = encodeJson({ disableAllHooks: true });
    const runCommand = Effect.fn("ClaudeConnectorAgent.runCommand")(function* () {
      const workingDirectory = yield* fileSystem
        .makeTempDirectoryScoped({ prefix: "t3code-claude-connector-" })
        .pipe(
          Effect.mapError((cause) =>
            normalizeCliError("claude", operation, cause, "Failed to create a working directory"),
          ),
        );
      const spawnCommand = yield* resolveSpawnCommand(
        claudeSettings.binaryPath || "claude",
        [
          "-p",
          "--output-format",
          "stream-json",
          "--verbose",
          "--model",
          resolveClaudeCatalogApiModelId(catalog, modelSelection),
          ...(request.outputSchema === undefined
            ? []
            : ["--json-schema", encodeJson(request.outputSchema)]),
          "--settings",
          settingsJson,
          // No built-in tools; the account's connectors still load, and only the named ones may
          // run without asking, which dontAsk turns into "everything else is refused".
          "--tools",
          "",
          ...(request.toolPrefixes.length > 0
            ? ["--allowedTools", request.toolPrefixes.join(",")]
            : []),
          "--disable-slash-commands",
          "--permission-mode",
          "dontAsk",
        ],
        { env: claudeEnvironment },
      );
      const child = yield* commandSpawner
        .spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            env: claudeEnvironment,
            cwd: workingDirectory,
            shell: spawnCommand.shell,
            stdin: { stream: Stream.encodeText(Stream.make(request.prompt)) },
            forceKillAfter: "1 second",
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            normalizeCliError("claude", operation, cause, "Failed to spawn Claude CLI process"),
          ),
        );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collect(operation, child.stdout),
          collect(operation, child.stderr),
          child.exitCode.pipe(
            Effect.mapError((cause) =>
              normalizeCliError("claude", operation, cause, "Failed to read Claude CLI exit code"),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );
      const parsed = parseClaudeAgentStream(stdout);
      if (exitCode !== 0 || parsed.error !== undefined) {
        const detail = parsed.error ?? (stderr.trim() || stdout.trim().slice(-2_000));
        return yield* new TextGenerationError({
          operation,
          detail:
            detail.length > 0
              ? `Claude CLI command failed: ${detail}`
              : `Claude CLI command failed with code ${exitCode}.`,
        });
      }
      const toolResults = yield* Effect.forEach(parsed.toolResults, expandSavedOutput);
      return {
        toolResults,
        output: parsed.output,
        availableTools: parsed.availableTools,
        mcpServers: parsed.mcpServers,
      } satisfies ConnectorAgentResult;
    });
    return yield* runCommand().pipe(
      Effect.scoped,
      Effect.timeoutOption(request.timeoutMs ?? CONNECTOR_AGENT_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({ operation, detail: "Claude CLI request timed out." }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );
  });

  return { run } satisfies ConnectorAgent;
});
