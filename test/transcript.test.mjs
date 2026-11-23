import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { engine } from "../dist/pi.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "transcript", "pi.jsonl");
const scratch = mkdtempSync(join(tmpdir(), "engine-pi-transcript-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;

function transcriptOf(logPath) {
  return engine.transcript({
    protocol_version: 1,
    method: "transcript",
    openbee_version: "9.9.9",
    engine_id: "pi",
    language: "en",
    config: {},
    data_dir: scratch,
    state_dir: scratch,
    params: { log_path: logPath },
  });
}

function transcriptOfEvents(events) {
  const path = join(scratch, `log-${++counter}.jsonl`);
  writeFileSync(path, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  return transcriptOf(path);
}

function toolEvents(toolName, args, result, extra = {}) {
  return [
    { type: "tool_execution_start", toolCallId: "t1", toolName, args },
    { type: "tool_execution_end", toolCallId: "t1", toolName, result, isError: false, ...extra },
  ];
}

test("the pi fixture becomes the expected steps", async () => {
  assert.deepEqual(await transcriptOf(fixture), [
    { type: "thinking", text: "I should look at the files first." },
    { type: "text", text: "Let me look at the project." },
    {
      type: "tool",
      kind: "command",
      name: "bash",
      summary: "ls -la echo done",
      output: "total 8\nREADME.md\nsrc\ndone",
      status: "done",
      duration_ms: 42,
    },
    { type: "text", text: "Now reading the readme.\n\nThen the source." },
    {
      type: "tool",
      kind: "read",
      name: "read",
      summary: "/work/project/README.md",
      output: "# Project\nA smal project.",
      status: "done",
      duration_ms: 3,
    },
    {
      type: "tool",
      kind: "search",
      name: "grep",
      summary: "TODO",
      output: "src/main.ts:3: TODO tidy",
      status: "done",
      duration_ms: 11,
    },
    { type: "tool", kind: "search", name: "find", summary: "*.md", output: "README.md", status: "done", duration_ms: 5 },
    { type: "tool", kind: "search", name: "ls", summary: "src", output: "main.ts", status: "done", duration_ms: 2 },
    { type: "text", text: "Fixing the typo." },
    {
      type: "tool",
      kind: "edit",
      name: "edit",
      summary: "/work/project/README.md",
      output: "Successfully replaced 1 block in /work/project/README.md.",
      status: "done",
      duration_ms: 8,
    },
    {
      type: "tool",
      kind: "edit",
      name: "write",
      summary: "/work/project/NOTES.md",
      output: "EACCES: permission denied",
      status: "error",
    },
    { type: "tool", kind: "command", name: "bash", summary: "false", status: "error", duration_ms: 7 },
    {
      type: "tool",
      kind: "message",
      name: "send_message",
      summary: "Typo fixed. All done.",
      output: "sent",
      status: "done",
      duration_ms: 120,
    },
    {
      type: "tool",
      kind: "other",
      name: "lookup",
      summary: "typo",
      output: "caption",
      status: "done",
      duration_ms: 30,
    },
    { type: "tool", kind: "command", name: "bash", summary: "sleep 100", status: "running" },
    { type: "thinking", text: "The provider keeps failing." },
    { type: "text", text: "Partial answer before the failure." },
    { type: "error", text: "429 rate limit exceeded" },
    { type: "text", text: "Quiet failure." },
    { type: "error", text: "429 rate limit exceeded after 3 attempts" },
  ]);
});

test("a missing log gives no steps", async () => {
  assert.deepEqual(await transcriptOf(join(scratch, "no-such.log")), []);
});

test("user and tool result messages are ignored", async () => {
  const steps = await transcriptOfEvents([
    { type: "message_end", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
    { type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "output" }] } },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "stop" } },
  ]);
  assert.deepEqual(steps, [{ type: "text", text: "hi" }]);
});

test("agent_end messages are not repeated", async () => {
  const steps = await transcriptOfEvents([
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } },
    { type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] },
  ]);
  assert.deepEqual(steps, [{ type: "text", text: "done" }]);
});

test("thinking before an error message comes first and a blank error adds nothing", async () => {
  const steps = await transcriptOfEvents([
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "why" },
          { type: "text", text: "oops" },
        ],
        stopReason: "error",
        errorMessage: "boom",
      },
    },
    { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "" } },
    { type: "message_end", message: { role: "assistant", content: [], stopReason: "error" } },
    { type: "auto_retry_end", success: false, finalError: "" },
    { type: "auto_retry_end", success: false, finalError: 7 },
  ]);
  assert.deepEqual(steps, [
    { type: "thinking", text: "why" },
    { type: "text", text: "oops" },
    { type: "error", text: "boom" },
  ]);
});

test("an error message text only counts for the error stop reason", async () => {
  const steps = await transcriptOfEvents([
    { type: "message_end", message: { role: "assistant", content: [], stopReason: "stop", errorMessage: "stale" } },
  ]);
  assert.deepEqual(steps, []);
});

test("tool kinds follow the tool name", async () => {
  const cases = [
    ["bash", { command: "echo hi" }, "command", "bash", "echo hi"],
    ["read", { path: "/a" }, "read", "read", "/a"],
    ["edit", { path: "/b" }, "edit", "edit", "/b"],
    ["write", { path: "/c" }, "edit", "write", "/c"],
    ["grep", { pattern: "x", path: "/d" }, "search", "grep", "x"],
    ["grep", { path: "/d" }, "search", "grep", "/d"],
    ["find", { pattern: "*.go" }, "search", "find", "*.go"],
    ["ls", { path: "/e" }, "search", "ls", "/e"],
    ["ls", {}, "search", "ls", undefined],
    ["send_message", { content: "hello" }, "message", "send_message", "hello"],
    ["mcp__openbee__send_message", { content: "hello" }, "message", "send_message", "hello"],
    ["mcp__other__read", { path: "/f", note: "n" }, "other", "read", "/f"],
    ["codemode", { limit: 3, code: "return 1" }, "other", "codemode", "return 1"],
    ["custom", { limit: 3 }, "other", "custom", undefined],
    ["custom", null, "other", "custom", undefined],
    ["constructor", { value: "x" }, "other", "constructor", "x"],
    ["toString", { value: "y" }, "other", "toString", "y"],
    ["__proto__", { value: "z" }, "other", "__proto__", "z"],
  ];
  for (const [toolName, args, kind, name, summary] of cases) {
    const steps = await transcriptOfEvents(toolEvents(toolName, args, { content: [] }));
    const expected = { type: "tool", kind, name, status: "done" };
    if (summary !== undefined) expected.summary = summary;
    assert.deepEqual(steps, [expected], `${toolName} ${JSON.stringify(args)}`);
  }
});

test("a tool output uses the first text block", async () => {
  const steps = await transcriptOfEvents(
    toolEvents("bash", { command: "x" }, {
      content: [
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    }),
  );
  assert.equal(steps[0].output, "first");
});

test("a tool result without content has no output", async () => {
  for (const result of [undefined, null, "text", {}, { content: "text" }, { content: [{ type: "image" }] }]) {
    const steps = await transcriptOfEvents(toolEvents("bash", { command: "x" }, result));
    assert.deepEqual(steps, [{ type: "tool", kind: "command", name: "bash", summary: "x", status: "done" }]);
  }
});

test("the tool duration comes from durationMs", async () => {
  const steps = await transcriptOfEvents([
    ...toolEvents("bash", { command: "a" }, { content: [] }, { durationMs: 1500 }),
    { type: "tool_execution_start", toolCallId: "t2", toolName: "bash", args: { command: "b" } },
    { type: "tool_execution_end", toolCallId: "t2", toolName: "bash", result: { content: [] }, isError: false, durationMs: "slow" },
    { type: "tool_execution_start", toolCallId: "t3", toolName: "bash", args: { command: "c" } },
    { type: "tool_execution_end", toolCallId: "t3", toolName: "bash", result: { content: [] }, isError: false, durationMs: -5 },
  ]);
  assert.deepEqual(
    steps.map((step) => step.duration_ms),
    [1500, undefined, undefined],
  );
});

test("a tool end sets the error status", async () => {
  const steps = await transcriptOfEvents([
    { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "x" } },
    { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { content: [{ type: "text", text: "bad" }] }, isError: true },
  ]);
  assert.deepEqual(steps, [{ type: "tool", kind: "command", name: "bash", summary: "x", output: "bad", status: "error" }]);
});

test("nested tool calls are skipped", async () => {
  const steps = await transcriptOfEvents([
    { type: "tool_execution_start", toolCallId: "outer", toolName: "codemode", args: { code: "run" } },
    { type: "tool_execution_start", toolCallId: "outer/1", toolName: "bash", args: { command: "x" }, parentToolCallId: "outer" },
    {
      type: "tool_execution_end",
      toolCallId: "outer/1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "inner" }] },
      isError: false,
      parentToolCallId: "outer",
    },
    { type: "tool_execution_end", toolCallId: "outer", toolName: "codemode", result: { content: [{ type: "text", text: "ok" }] }, isError: false },
  ]);
  assert.deepEqual(steps, [{ type: "tool", kind: "other", name: "codemode", summary: "run", output: "ok", status: "done" }]);
});

test("events without a tool call id are ignored", async () => {
  const steps = await transcriptOfEvents([
    { type: "tool_execution_start", toolName: "bash", args: { command: "x" } },
    { type: "tool_execution_start", toolCallId: 5, toolName: "bash", args: { command: "x" } },
    { type: "tool_execution_start", toolCallId: "t1", args: { command: "x" } },
    { type: "tool_execution_end", toolName: "bash", result: {}, isError: false },
  ]);
  assert.deepEqual(steps, []);
});
