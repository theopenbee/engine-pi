import { after, test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildArgs,
  checkAgentError,
  collectUsage,
  extractPiError,
  extractResultFromLog,
  isStreamingDelta,
  stripThinkingSignature,
} from "../dist/pi.js";

const here = dirname(fileURLToPath(import.meta.url));
const logs = join(here, "fixtures", "logs");
const sessions = join(here, "fixtures", "sessions");
const scratch = mkdtempSync(join(tmpdir(), "engine-pi-unit-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function sessionsDir() {
  return mkdtempSync(join(scratch, "sessions-"));
}

function place(dir, relative, fixture) {
  const target = join(dir, relative);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(sessions, fixture), target);
}

test("buildArgs with an empty prompt", () => {
  assert.deepEqual(buildArgs("", "/tmp/session.jsonl", []), ["--mode", "json", "--session", "/tmp/session.jsonl", "-p", ""]);
});

test("buildArgs with a prompt", () => {
  assert.deepEqual(buildArgs("hello world", "/tmp/session.jsonl", []), [
    "--mode",
    "json",
    "--session",
    "/tmp/session.jsonl",
    "-p",
    "hello world",
  ]);
});

test("buildArgs appends extra args after the prompt", () => {
  assert.deepEqual(buildArgs("hi", "/s.jsonl", ["-e", "/ext.js", "--model", "x"]), [
    "--mode",
    "json",
    "--session",
    "/s.jsonl",
    "-p",
    "hi",
    "-e",
    "/ext.js",
    "--model",
    "x",
  ]);
});

test("extractResultFromLog returns the final answer", () => {
  assert.equal(extractResultFromLog(join(logs, "basic.jsonl")), "final answer");
});

test("extractResultFromLog: the last agent_end wins", () => {
  assert.equal(extractResultFromLog(join(logs, "last-wins.jsonl")), "last");
});

test("extractResultFromLog skips non-text content", () => {
  assert.equal(extractResultFromLog(join(logs, "skips-non-text.jsonl")), "answer");
});

test("extractResultFromLog takes the last assistant message of an agent_end", () => {
  assert.equal(extractResultFromLog(join(logs, "last-assistant-of-many.jsonl")), "final");
});

test("extractResultFromLog keeps the earlier answer when a later agent_end has no assistant message", () => {
  assert.equal(extractResultFromLog(join(logs, "agent-end-without-assistant.jsonl")), "kept");
});

test("extractResultFromLog ignores lines that are not JSON objects", () => {
  assert.equal(extractResultFromLog(join(logs, "noisy.jsonl")), "indented");
});

test("extractResultFromLog on an empty log", () => {
  assert.equal(extractResultFromLog(join(logs, "empty.jsonl")), "");
});

test("extractResultFromLog without an agent_end", () => {
  assert.equal(extractResultFromLog(join(logs, "no-agent-end.jsonl")), "");
});

test("extractResultFromLog on a missing log", () => {
  assert.equal(extractResultFromLog(join(scratch, "missing.jsonl")), "");
});

test("checkAgentError reports an authentication error", () => {
  assert.equal(
    checkAgentError(join(logs, "auth-error.jsonl")),
    '401 {"error":{"type":"authentication_error","message":"The API Key appears to be invalid or may have expired."}}',
  );
});

test("checkAgentError with a clean stop", () => {
  assert.equal(checkAgentError(join(logs, "stop-ok.jsonl")), "");
});

test("checkAgentError on an empty log", () => {
  assert.equal(checkAgentError(join(logs, "empty.jsonl")), "");
});

test("checkAgentError on a missing log", () => {
  assert.equal(checkAgentError(join(scratch, "missing.jsonl")), "");
});

test("extractPiError returns the first non-JSON line", () => {
  const stderr = `{"type":"session","version":3}
No API key found for unknown.
Use /login or set an API key environment variable.`;
  assert.equal(extractPiError(stderr, "exit status 1"), "No API key found for unknown.");
});

test("extractPiError falls back when stderr is all JSON", () => {
  assert.equal(extractPiError('{"type":"session","version":3}', "exit status 1"), "exit status 1");
});

test("extractPiError falls back on empty stderr", () => {
  assert.equal(extractPiError("", "exit status 1"), "exit status 1");
});

test("extractPiError skips blank lines, arrays and CRLF", () => {
  assert.equal(extractPiError('\r\n[1,2]\r\n  boom happened  \r\nlater\r\n', "fallback"), "boom happened");
});

test("isStreamingDelta", () => {
  const cases = [
    ["message_update filtered", '{"type":"message_update","message":{}}', true],
    ["tool_execution_update filtered", '{"type":"tool_execution_update","toolCallId":"x","partialResult":{"content":[]}}', true],
    ["tool_execution_start not filtered", '{"type":"tool_execution_start","toolCallId":"x","toolName":"bash","args":{}}', false],
    ["tool_execution_end not filtered", '{"type":"tool_execution_end","toolCallId":"x","result":{"content":[]}}', false],
    ["message_end not filtered", '{"type":"message_end","message":{"role":"assistant","content":[]}}', false],
    ["plain JSON not filtered", '{"type":"agent_start"}', false],
  ];
  for (const [name, line, want] of cases) {
    assert.equal(isStreamingDelta(line), want, name);
  }
});

test("stripThinkingSignature removes the field from a message_end event", () => {
  const line = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm", thinkingSignature: "SIG" },
        { type: "text", text: "answer" },
      ],
    },
  });
  assert.deepEqual(JSON.parse(stripThinkingSignature(line)), {
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "answer" },
      ],
    },
  });
});

test("stripThinkingSignature removes the field from every message of an agent_end event", () => {
  const line = JSON.stringify({
    type: "agent_end",
    messages: [
      { role: "user", content: [{ type: "text", text: "q" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "a", thinkingSignature: "S1" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "b", thinkingSignature: "S2" }, { type: "text", text: "done" }] },
    ],
  });
  const out = stripThinkingSignature(line);
  assert.ok(!out.includes("thinkingSignature"));
  assert.deepEqual(JSON.parse(out).messages, [
    { role: "user", content: [{ type: "text", text: "q" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "a" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "b" }, { type: "text", text: "done" }] },
  ]);
});

test("stripThinkingSignature leaves other lines untouched", () => {
  const untouched = [
    '{"type":"agent_start"}',
    '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"mentions thinkingSignature"}]}}',
    '{"type":"message_end","message":{"role":"assistant","content":"thinkingSignature"}}',
    '{"thinkingSignature":"x"}',
    '{"type":"message_end","message":',
    "thinkingSignature is not json",
    '["thinkingSignature"]',
  ];
  for (const line of untouched) {
    assert.equal(stripThinkingSignature(line), line);
  }
});

test("collectUsage aggregates by model", async () => {
  const dir = sessionsDir();
  place(dir, "20250101_pi-sess-abc123.jsonl", "aggregate.jsonl");
  const usage = await collectUsage(dir, ["pi-sess-abc123"]);
  const byModel = Object.fromEntries(usage["pi-sess-abc123"].map((u) => [u.model, u]));
  assert.deepEqual(Object.keys(byModel).sort(), ["claude-3-5-sonnet", "claude-3-opus"]);
  assert.deepEqual(byModel["claude-3-5-sonnet"], {
    model: "claude-3-5-sonnet",
    input_tokens: 300,
    output_tokens: 130,
    cache_creation_tokens: 10,
    cache_read_tokens: 20,
  });
  assert.deepEqual(byModel["claude-3-opus"], {
    model: "claude-3-opus",
    input_tokens: 300,
    output_tokens: 100,
    cache_creation_tokens: 5,
    cache_read_tokens: 0,
  });
});

test("collectUsage skips non-assistant and wrong-type lines", async () => {
  const dir = sessionsDir();
  place(dir, "skip-test.jsonl", "skip.jsonl");
  const usage = await collectUsage(dir, ["skip-test"]);
  assert.deepEqual(usage["skip-test"], [
    { model: "claude-3-5-sonnet", input_tokens: 100, output_tokens: 50, cache_creation_tokens: 0, cache_read_tokens: 0 },
  ]);
});

test("collectUsage tolerates malformed lines and missing counters", async () => {
  const dir = sessionsDir();
  place(dir, "robust.jsonl", "robust.jsonl");
  const usage = await collectUsage(dir, ["robust"]);
  assert.deepEqual(usage.robust, [
    { model: "m-a", input_tokens: 11, output_tokens: 22, cache_creation_tokens: 3, cache_read_tokens: 4 },
  ]);
});

test("collectUsage omits sessions whose file does not exist", async () => {
  const dir = sessionsDir();
  place(dir, "present.jsonl", "single.jsonl");
  const usage = await collectUsage(dir, ["present", "nonexistent-session"]);
  assert.deepEqual(Object.keys(usage), ["present"]);
});

test("collectUsage with a missing sessions directory", async () => {
  const usage = await collectUsage(join(scratch, "missing", "sessions"), ["nonexistent-session"]);
  assert.deepEqual(usage, {});
});

test("collectUsage finds a nested legacy file by its _<id>.jsonl suffix", async () => {
  const dir = sessionsDir();
  place(dir, "--tmp--work--/2025-01-01T00-00-00_nested-id.jsonl", "single.jsonl");
  const usage = await collectUsage(dir, ["nested-id"]);
  assert.equal(usage["nested-id"].length, 1);
  assert.equal(usage["nested-id"][0].input_tokens, 100);
});

test("collectUsage prefers the flat file over a nested one", async () => {
  const dir = sessionsDir();
  place(dir, "both.jsonl", "single.jsonl");
  place(dir, "sub/2025_both.jsonl", "aggregate.jsonl");
  const usage = await collectUsage(dir, ["both"]);
  assert.deepEqual(usage.both.map((u) => u.model), ["claude-3-5-sonnet"]);
  assert.equal(usage.both[0].input_tokens, 100);
});

test("collectUsage does not match a nested file without the underscore prefix", async () => {
  const dir = sessionsDir();
  place(dir, "sub/other.jsonl", "single.jsonl");
  place(dir, "sub/xother.jsonl", "single.jsonl");
  const usage = await collectUsage(dir, ["other"]);
  assert.deepEqual(usage, {});
});

test("collectUsage ignores session ids that point outside the sessions directory", async () => {
  const dir = sessionsDir();
  writeFileSync(join(scratch, "escape.jsonl"), '{"type":"message","message":{"role":"assistant","model":"m","usage":{"input":1}}}\n');
  const usage = await collectUsage(dir, ["../escape", "a/b"]);
  assert.deepEqual(usage, {});
});
