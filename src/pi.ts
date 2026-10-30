import { createReadStream, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { cliVersion, findCli, spawnCli } from "@theopenbee/engine-sdk";
import type { Engine, EngineRequest, RunParams, RunResult, TokenUsage } from "@theopenbee/engine-sdk";

const EXTENSION_PATH = fileURLToPath(new URL("../assets/openbee-mcp.js", import.meta.url));

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isMissing(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export function buildArgs(prompt: string, sessionPath: string, extraArgs: string[]): string[] {
  return ["--mode", "json", "--session", sessionPath, "-p", prompt, ...extraArgs];
}

export function isStreamingDelta(line: string): boolean {
  return line.includes('"type":"message_update"') || line.includes('"type":"tool_execution_update"');
}

function stripFromMessage(message: unknown): boolean {
  if (!isObject(message) || !Array.isArray(message.content)) return false;
  let changed = false;
  for (const block of message.content) {
    if (isObject(block) && Object.hasOwn(block, "thinkingSignature")) {
      delete block.thinkingSignature;
      changed = true;
    }
  }
  return changed;
}

export function stripThinkingSignature(line: string): string {
  if (!line.includes('"thinkingSignature"')) return line;
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return line;
  }
  if (!isObject(event)) return line;
  if ("message" in event) {
    return stripFromMessage(event.message) ? JSON.stringify(event) : line;
  }
  if (Array.isArray(event.messages)) {
    let changed = false;
    for (const message of event.messages) {
      if (stripFromMessage(message)) changed = true;
    }
    return changed ? JSON.stringify(event) : line;
  }
  return line;
}

function filterLogLine(line: string): string | null {
  if (isStreamingDelta(line)) return null;
  return stripThinkingSignature(line);
}

function lastAssistantMessage(logPath: string): JsonObject | null {
  let content: string;
  try {
    content = readFileSync(logPath, "utf8");
  } catch {
    return null;
  }
  let result: JsonObject | null = null;
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("{") || !line.includes("agent_end")) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(event) || event.type !== "agent_end" || !Array.isArray(event.messages)) continue;
    for (let i = event.messages.length - 1; i >= 0; i--) {
      const message: unknown = event.messages[i];
      if (isObject(message) && message.role === "assistant") {
        result = message;
        break;
      }
    }
  }
  return result;
}

function resultText(message: JsonObject | null): string {
  if (!message || !Array.isArray(message.content)) return "";
  for (const item of message.content) {
    if (isObject(item) && item.type === "text" && typeof item.text === "string" && item.text !== "") {
      return item.text;
    }
  }
  return "";
}

function agentErrorText(message: JsonObject | null): string {
  if (!message || message.stopReason !== "error") return "";
  return typeof message.errorMessage === "string" ? message.errorMessage : "";
}

export function extractResultFromLog(logPath: string): string {
  return resultText(lastAssistantMessage(logPath));
}

export function checkAgentError(logPath: string): string {
  return agentErrorText(lastAssistantMessage(logPath));
}

export function extractPiError(stderr: string, fallback: string): string {
  for (const raw of stderr.split("\n")) {
    const line = raw.trim();
    if (line === "" || line[0] === "{" || line[0] === "[") continue;
    return line;
  }
  return fallback;
}

function isPlainFileName(id: unknown): id is string {
  return typeof id === "string" && id !== "" && !/[\\/\0]/.test(id);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function listFiles(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (isMissing(err)) return;
    throw err;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, out);
    else out.push(full);
  }
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function parseSessionFile(path: string): Promise<TokenUsage[]> {
  const byModel = new Map<string, TokenUsage>();
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(event) || event.type !== "message" || !isObject(event.message)) continue;
    const message = event.message;
    if (message.role !== "assistant" || !isObject(message.usage)) continue;
    const model = typeof message.model === "string" ? message.model : "";
    let total = byModel.get(model);
    if (!total) {
      total = { model, input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 };
      byModel.set(model, total);
    }
    total.input_tokens += numberOrZero(message.usage.input);
    total.output_tokens += numberOrZero(message.usage.output);
    total.cache_creation_tokens += numberOrZero(message.usage.cacheWrite);
    total.cache_read_tokens += numberOrZero(message.usage.cacheRead);
  }
  return [...byModel.values()];
}

export async function collectUsage(sessionsDir: string, sessionIds: string[]): Promise<Record<string, TokenUsage[]>> {
  const found = new Map<string, TokenUsage[]>();
  let nested: string[] | undefined;
  for (const id of sessionIds) {
    if (!isPlainFileName(id)) continue;
    let path: string | undefined = join(sessionsDir, `${id}.jsonl`);
    if (!isFile(path)) {
      if (!nested) {
        nested = [];
        listFiles(sessionsDir, nested);
      }
      const suffix = `_${id}.jsonl`;
      path = nested.find((candidate) => basename(candidate).endsWith(suffix));
    }
    if (path) found.set(id, await parseSessionFile(path));
  }
  return Object.fromEntries(found);
}

function exitText(code: number | null, signal: NodeJS.Signals | null): string {
  if (code === null) return `pi was terminated by signal ${signal ?? "unknown"}`;
  return `pi exited with code ${code}`;
}

export const engine: Engine = {
  async check(req) {
    const path = findCli(req.config, "pi");
    return { version: await cliVersion(path), path };
  },

  async run(req: EngineRequest<RunParams>): Promise<RunResult> {
    const params = req.params;
    const command = findCli(req.config, "pi");
    if (!isPlainFileName(params.session_id)) {
      throw new Error(`invalid session id ${JSON.stringify(params.session_id)}`);
    }
    const sessionsDir = join(req.state_dir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const sessionPath = join(sessionsDir, `${params.session_id}.jsonl`);

    const mcpURL = params.mcp?.url ?? "";
    const extraArgs = params.extra_args ?? [];
    const args = buildArgs(params.prompt, sessionPath, mcpURL ? ["-e", EXTENSION_PATH, ...extraArgs] : extraArgs);

    let outcome;
    try {
      outcome = await spawnCli({
        command,
        args,
        cwd: params.work_dir,
        env: mcpURL ? { OPENBEE_MCP_URL: mcpURL } : undefined,
        logPath: params.log_path,
        onStdoutLine: filterLogLine,
      });
    } catch (err) {
      throw new Error(`start pi: ${errorMessage(err)}`);
    }

    const message = lastAssistantMessage(params.log_path);
    const text = resultText(message);
    if (outcome.code !== 0) {
      return { text, error: extractPiError(outcome.stderrTail, exitText(outcome.code, outcome.signal)) };
    }
    const agentError = agentErrorText(message);
    if (agentError) return { text, error: agentError };
    return { text };
  },

  async usage(req) {
    return collectUsage(join(req.state_dir, "sessions"), req.params.session_ids ?? []);
  },
};
