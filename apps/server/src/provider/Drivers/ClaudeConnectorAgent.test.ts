import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { parseClaudeAgentStream } from "./ClaudeConnectorAgent.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const lines = (...messages: ReadonlyArray<unknown>) =>
  messages.map((message) => encodeJson(message)).join("\n");

it("collects the tools a run had and each tool call with its raw reply", () => {
  const parsed = parseClaudeAgentStream(
    lines(
      {
        type: "system",
        subtype: "init",
        tools: ["mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql"],
        mcp_servers: [{ name: "claude.ai Atlassian", status: "connected" }],
      },
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql",
              input: { jql: "assignee = currentUser()" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [{ type: "text", text: '{"issues":[]}' }],
            },
          ],
        },
      },
      { type: "assistant", message: { content: [{ type: "text", text: "done" }] } },
      { type: "result", subtype: "success", is_error: false, result: "done" },
    ),
  );
  expect(parsed).toEqual({
    availableTools: ["mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql"],
    mcpServers: [{ name: "claude.ai Atlassian", status: "connected" }],
    toolResults: [
      {
        tool: "mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql",
        input: { jql: "assignee = currentUser()" },
        isError: false,
        text: '{"issues":[]}',
      },
    ],
    output: "done",
    error: undefined,
  });
});

it("prefers the structured answer, and reports a failed run", () => {
  expect(
    parseClaudeAgentStream(
      lines({ type: "result", is_error: false, result: "", structured_output: { matches: [] } }),
    ).output,
  ).toEqual({ matches: [] });
  expect(
    parseClaudeAgentStream(lines({ type: "result", is_error: true, result: "Not logged in" }))
      .error,
  ).toBe("Not logged in");
});

it("skips lines that are not JSON", () => {
  expect(parseClaudeAgentStream("warning: something\n\n").toolResults).toEqual([]);
});
