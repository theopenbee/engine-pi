import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const entry = join(root, "dist", "index.js");
const sessionFixtures = join(here, "fixtures", "sessions");
const scratch = mkdtempSync(join(tmpdir(), "engine-pi-e2e-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function findBun() {
  const probe = spawnSync("bun", ["-e", "console.log(process.execPath)"]);
  if (probe.status === 0) return probe.stdout.toString().trim();
  const runtime = join(homedir(), ".openbee", "runtime");
  if (!existsSync(runtime)) return null;
  for (const name of readdirSync(runtime)) {
    const candidate = join(runtime, name, "bun");
    if (name.startsWith("bun-") && existsSync(candidate)) return candidate;
  }
  return null;
}

const bun = findBun();
const runtimes = [
  { name: "node", command: process.execPath, skip: false },
  { name: "bun", command: bun, skip: bun ? false : "bun is not installed" },
];

const CANNED_STDOUT = [
  { type: "session", version: 3, id: "abc", cwd: "/tmp" },
  { type: "agent_start" },
  { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "fi" }] } },
  { type: "tool_execution_update", toolCallId: "t1", partialResult: { content: [] } },
  { type: "tool_execution_end", toolCallId: "t1", result: { content: [] } },
  {
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm", thinkingSignature: "SIGNATURE-1" },
        { type: "text", text: "final answer" },
      ],
    },
  },
  {
    type: "agent_end",
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm", thinkingSignature: "SIGNATURE-2" },
          { type: "text", text: "final answer" },
        ],
        stopReason: "stop",
      },
    ],
  },
]
  .map((event) => JSON.stringify(event))
  .join("\n");

const FAKE_PI = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write((process.env.FAKE_PI_VERSION || "0.99.1") + "\\n");
  process.exit(0);
}
const stdin = fs.readFileSync(0, "utf8");
if (process.env.FAKE_PI_RECORD) {
  fs.writeFileSync(
    process.env.FAKE_PI_RECORD,
    JSON.stringify({
      argv: args,
      cwd: process.cwd(),
      stdin,
      env: {
        OPENBEE_MCP_URL: process.env.OPENBEE_MCP_URL ?? null,
        OPENBEE_API_KEY: process.env.OPENBEE_API_KEY ?? null,
      },
    }),
  );
}
const mode = process.env.FAKE_PI_MODE || "ok";
if (mode === "ok") {
  process.stdout.write(${JSON.stringify(CANNED_STDOUT)} + "\\n");
} else if (mode === "stderr-exit") {
  process.stderr.write('{"type":"session","version":3}\\nNo API key found for unknown.\\nUse /login or set an API key environment variable.\\n');
  process.exit(1);
} else if (mode === "silent-exit") {
  process.exit(3);
} else if (mode === "stop-error") {
  process.stdout.write(
    JSON.stringify({
      type: "agent_end",
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        { role: "assistant", content: [], stopReason: "error", errorMessage: "401 invalid api key" },
      ],
    }) + "\\n",
  );
} else if (mode === "no-result") {
  process.stdout.write('{"type":"session","version":3}\\n');
}
`;

const fakePi = join(scratch, "bin", "pi");
before(() => {
  mkdirSync(dirname(fakePi), { recursive: true });
  writeFileSync(fakePi, FAKE_PI);
  chmodSync(fakePi, 0o755);
});

let counter = 0;
function freshDir(prefix) {
  const dir = join(scratch, `${prefix}-${++counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function baseRequest(method, params, overrides = {}) {
  return {
    protocol_version: 1,
    method,
    openbee_version: "9.9.9",
    engine_id: "pi",
    language: "en",
    config: { path: fakePi },
    data_dir: freshDir("data"),
    state_dir: freshDir("state"),
    params,
    ...overrides,
  };
}

function runPlugin(runtime, input, env = {}) {
  const pluginEnv = { ...process.env, OPENBEE_API_KEY: "tok-secret", ...env };
  delete pluginEnv.OPENBEE_MCP_URL;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete pluginEnv[key];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(runtime.command, [entry], { cwd: scratch, env: pluginEnv, stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(input) + "\n");
  });
}

function response(res) {
  assert.equal(res.code, 0, res.stderr);
  const lines = res.stdout.split("\n").filter((l) => l !== "");
  assert.equal(lines.length, 1, `expected exactly one stdout line, got: ${res.stdout}`);
  return JSON.parse(lines[0]);
}

function runParams(overrides = {}) {
  return {
    role: "worker",
    work_dir: freshDir("work"),
    prompt: "hello",
    session_id: "4d0ce91b-0856-44e2-b0d7-7765d824bba3",
    resume: false,
    extra_args: [],
    log_path: join(freshDir("logs"), "exec.log"),
    ...overrides,
  };
}

function recordedCall(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

for (const runtime of runtimes) {
  const t = (name, fn) => test(`[${runtime.name}] ${name}`, { skip: runtime.skip }, fn);

  t("check returns the version and path", async () => {
    const res = response(await runPlugin(runtime, baseRequest("check", {})));
    assert.deepEqual(res, { result: { version: "0.99.1", path: fakePi } });
  });

  t("check fails when the configured path does not exist", async () => {
    const missing = join(scratch, "no-such-pi");
    const res = response(await runPlugin(runtime, baseRequest("check", {}, { config: { path: missing } })));
    assert.deepEqual(res, { error: { message: `${missing} not found` } });
  });

  t("check fails with pi not found on PATH", async () => {
    const res = response(await runPlugin(runtime, baseRequest("check", {}, { config: {} }), { PATH: freshDir("empty-path") }));
    assert.deepEqual(res, { error: { message: "pi not found on PATH" } });
  });

  t("check uses pi from PATH when no path is configured", async () => {
    const res = response(await runPlugin(runtime, baseRequest("check", {}, { config: { path: "" } }), { PATH: dirname(fakePi) }));
    assert.deepEqual(res, { result: { version: "0.99.1", path: fakePi } });
  });

  t("run passes the pi arguments and returns the final answer", async () => {
    const record = join(freshDir("rec"), "call.json");
    const req = baseRequest("run", runParams({ prompt: "do the thing", extra_args: ["--model", "x"] }));
    const res = response(await runPlugin(runtime, req, { FAKE_PI_RECORD: record }));
    assert.deepEqual(res, { result: { text: "final answer" } });

    const sessionPath = join(req.state_dir, "sessions", `${req.params.session_id}.jsonl`);
    const call = recordedCall(record);
    assert.deepEqual(call.argv, ["--mode", "json", "--session", sessionPath, "-p", "do the thing", "--model", "x"]);
    assert.equal(call.stdin, "");
    assert.equal(call.cwd, realpathSync(req.params.work_dir));
    assert.equal(call.env.OPENBEE_MCP_URL, null);
    assert.ok(existsSync(join(req.state_dir, "sessions")));
  });

  t("run writes a compact log", async () => {
    const req = baseRequest("run", runParams());
    response(await runPlugin(runtime, req));
    const log = readFileSync(req.params.log_path, "utf8");
    assert.ok(!log.includes("message_update"));
    assert.ok(!log.includes("tool_execution_update"));
    assert.ok(!log.includes("thinkingSignature"));
    assert.ok(!log.includes("SIGNATURE"));
    assert.ok(log.includes('"type":"tool_execution_end"'));
    assert.ok(log.includes('"type":"agent_end"'));
    assert.ok(log.includes("final answer"));
    assert.ok(log.endsWith("\n"));
  });

  t("run loads the openbee MCP extension and sets the MCP URL", async () => {
    const record = join(freshDir("rec"), "call.json");
    const req = baseRequest(
      "run",
      runParams({
        extra_args: ["--model", "x"],
        mcp: { name: "openbee", url: "http://127.0.0.1:12350/mcp", api_key_env: "OPENBEE_API_KEY" },
      }),
    );
    const res = response(await runPlugin(runtime, req, { FAKE_PI_RECORD: record }));
    assert.deepEqual(res, { result: { text: "final answer" } });

    const extension = join(root, "assets", "openbee-mcp.js");
    assert.ok(existsSync(extension));
    const sessionPath = join(req.state_dir, "sessions", `${req.params.session_id}.jsonl`);
    const call = recordedCall(record);
    assert.deepEqual(call.argv, ["--mode", "json", "--session", sessionPath, "-p", "hello", "-e", extension, "--model", "x"]);
    assert.equal(call.env.OPENBEE_MCP_URL, "http://127.0.0.1:12350/mcp");
    assert.equal(call.env.OPENBEE_API_KEY, "tok-secret");
    assert.ok(!call.argv.some((arg) => arg.includes("tok-secret")));
  });

  t("run never puts the API key in the arguments", async () => {
    const record = join(freshDir("rec"), "call.json");
    const req = baseRequest("run", runParams());
    response(await runPlugin(runtime, req, { FAKE_PI_RECORD: record }));
    const call = recordedCall(record);
    assert.equal(call.env.OPENBEE_API_KEY, "tok-secret");
    assert.ok(!JSON.stringify(call.argv).includes("tok-secret"));
  });

  t("run delivers a large unicode prompt unchanged", async () => {
    const record = join(freshDir("rec"), "call.json");
    const prompt = `line one\n"quoted" 'single' \`tick\` $HOME \\n back\\slash\n${"emoji \u{1F41D} 你好\n".repeat(1500)}end`;
    const req = baseRequest("run", runParams({ prompt }));
    const res = response(await runPlugin(runtime, req, { FAKE_PI_RECORD: record }));
    assert.deepEqual(res, { result: { text: "final answer" } });
    assert.equal(recordedCall(record).argv[5], prompt);
  });

  t("run reports the first non-JSON stderr line when pi exits non-zero", async () => {
    const req = baseRequest("run", runParams());
    const res = response(await runPlugin(runtime, req, { FAKE_PI_MODE: "stderr-exit" }));
    assert.deepEqual(res, { result: { text: "", error: "No API key found for unknown." } });
  });

  t("run reports the exit code when pi exits non-zero without output", async () => {
    const req = baseRequest("run", runParams());
    const res = response(await runPlugin(runtime, req, { FAKE_PI_MODE: "silent-exit" }));
    assert.deepEqual(res, { result: { text: "", error: "pi exited with code 3" } });
  });

  t("run reports an API failure when pi exits cleanly", async () => {
    const req = baseRequest("run", runParams());
    const res = response(await runPlugin(runtime, req, { FAKE_PI_MODE: "stop-error" }));
    assert.deepEqual(res, { result: { text: "", error: "401 invalid api key" } });
  });

  t("run without a final answer returns empty text and no error", async () => {
    const req = baseRequest("run", runParams());
    const res = response(await runPlugin(runtime, req, { FAKE_PI_MODE: "no-result" }));
    assert.deepEqual(res, { result: { text: "" } });
  });

  t("run fails when pi cannot be found", async () => {
    const req = baseRequest("run", runParams(), { config: {} });
    const res = response(await runPlugin(runtime, req, { PATH: freshDir("empty-path") }));
    assert.deepEqual(res, { error: { message: "pi not found on PATH" } });
  });

  t("run rejects a session id that is not a plain file name", async () => {
    const req = baseRequest("run", runParams({ session_id: "../escape" }));
    const res = response(await runPlugin(runtime, req));
    assert.deepEqual(res, { error: { message: 'invalid session id "../escape"' } });
  });

  t("usage reads sessions from state_dir/sessions and omits missing ones", async () => {
    const req = baseRequest("usage", { session_ids: ["has-usage", "no-such-session"] });
    const dir = join(req.state_dir, "sessions");
    mkdirSync(dir, { recursive: true });
    copyFileSync(join(sessionFixtures, "aggregate.jsonl"), join(dir, "has-usage.jsonl"));
    const res = response(await runPlugin(runtime, req));
    assert.deepEqual(Object.keys(res.result.usage), ["has-usage"]);
    const byModel = Object.fromEntries(res.result.usage["has-usage"].map((u) => [u.model, u]));
    assert.deepEqual(byModel["claude-3-5-sonnet"], {
      model: "claude-3-5-sonnet",
      input_tokens: 300,
      output_tokens: 130,
      cache_creation_tokens: 10,
      cache_read_tokens: 20,
    });
    assert.equal(byModel["claude-3-opus"].input_tokens, 300);
  });

  t("usage without a sessions directory returns an empty map", async () => {
    const req = baseRequest("usage", { session_ids: ["a", "b"] });
    const res = response(await runPlugin(runtime, req));
    assert.deepEqual(res, { result: { usage: {} } });
  });
}
