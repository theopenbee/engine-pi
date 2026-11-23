import { TranscriptBuilder, readJsonLines, stripMcpPrefix } from "@theopenbee/engine-sdk";
import type { ToolKind, TranscriptStep } from "@theopenbee/engine-sdk";

type JsonObject = Record<string, unknown>;

const DURATION_ORIGIN = 0;

const BUILTIN_KINDS = new Map<string, ToolKind>([
  ["bash", "command"],
  ["read", "read"],
  ["edit", "edit"],
  ["write", "edit"],
  ["grep", "search"],
  ["find", "search"],
  ["ls", "search"],
]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolKind(toolName: string): ToolKind {
  if (toolName.includes("send_message")) return "message";
  return BUILTIN_KINDS.get(toolName) ?? "other";
}

function firstString(args: JsonObject, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

function toolSummary(kind: ToolKind, args: JsonObject): string | undefined {
  switch (kind) {
    case "command":
      return firstString(args, ["command"]);
    case "read":
    case "edit":
      return firstString(args, ["path"]);
    case "search":
      return firstString(args, ["pattern", "path"]);
    case "message":
      return firstString(args, ["content"]);
    default:
      return firstString(args, Object.keys(args));
  }
}

function diffLines(text: unknown, marker: string): string[] {
  if (typeof text !== "string" || text === "") return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => marker + line);
}

function editList(args: JsonObject): unknown[] {
  let edits: unknown = args.edits;
  if (typeof edits === "string") {
    try {
      edits = JSON.parse(edits);
    } catch {
      edits = undefined;
    }
  }
  const list: unknown[] = Array.isArray(edits) ? [...edits] : isObject(edits) ? [edits] : [];
  if (typeof args.oldText === "string" && typeof args.newText === "string") {
    list.push({ oldText: args.oldText, newText: args.newText });
  }
  return list;
}

function argsDiff(toolName: string, args: JsonObject): string | undefined {
  const lines: string[] = [];
  if (toolName === "edit") {
    for (const edit of editList(args)) {
      if (isObject(edit)) lines.push(...diffLines(edit.oldText, "-"), ...diffLines(edit.newText, "+"));
    }
  } else if (toolName === "write") {
    lines.push(...diffLines(args.content, "+"));
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

const NUMBERED_ROW = /^[+\- ]( *\d+) /;

function detailsDiff(result: unknown): string | undefined {
  if (!isObject(result) || !isObject(result.details) || typeof result.details.diff !== "string") return undefined;
  const rows = result.details.diff.split("\n");
  let numberWidth = 0;
  for (const row of rows) {
    const match = NUMBERED_ROW.exec(row);
    if (match) {
      numberWidth = match[1].length;
      break;
    }
  }
  if (numberWidth === 0) return undefined;
  const skip = numberWidth + 2;
  const lines: string[] = [];
  for (const row of rows) {
    if (!/^[+\- ]/.test(row)) return undefined;
    lines.push(row[0] + row.slice(skip));
  }
  return lines.join("\n");
}

function outputText(result: unknown): string | undefined {
  if (!isObject(result) || !Array.isArray(result.content)) return undefined;
  for (const block of result.content) {
    if (isObject(block) && block.type === "text" && typeof block.text === "string") return block.text;
  }
  return undefined;
}

function addAssistantMessage(builder: TranscriptBuilder, message: JsonObject): void {
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (!isObject(block)) continue;
      if (block.type === "text" && typeof block.text === "string") builder.text(block.text);
      else if (block.type === "thinking" && typeof block.thinking === "string") builder.thinking(block.thinking);
    }
  }
  if (message.stopReason === "error" && typeof message.errorMessage === "string" && message.errorMessage !== "") {
    builder.error(message.errorMessage);
  }
}

function addToolStart(builder: TranscriptBuilder, event: JsonObject): void {
  if (typeof event.toolCallId !== "string" || typeof event.toolName !== "string") return;
  const kind = toolKind(event.toolName);
  const args = isObject(event.args) ? event.args : {};
  builder.toolStart(
    event.toolCallId,
    { kind, name: stripMcpPrefix(event.toolName), summary: toolSummary(kind, args), diff: argsDiff(event.toolName, args) },
    DURATION_ORIGIN,
  );
}

function addToolEnd(builder: TranscriptBuilder, event: JsonObject): void {
  if (typeof event.toolCallId !== "string") return;
  const duration = typeof event.durationMs === "number" ? event.durationMs : undefined;
  const diff = event.toolName === "edit" ? detailsDiff(event.result) : undefined;
  builder.toolEnd(event.toolCallId, { output: outputText(event.result), isError: event.isError === true, diff }, duration);
}

export function transcriptFromLog(logPath: string): TranscriptStep[] {
  const builder = new TranscriptBuilder();
  for (const event of readJsonLines(logPath)) {
    switch (event.type) {
      case "message_end":
        if (isObject(event.message) && event.message.role === "assistant") addAssistantMessage(builder, event.message);
        break;
      case "tool_execution_start":
        if (!event.parentToolCallId) addToolStart(builder, event);
        break;
      case "tool_execution_end":
        if (!event.parentToolCallId) addToolEnd(builder, event);
        break;
      case "auto_retry_end":
        if (event.success === false && typeof event.finalError === "string" && event.finalError !== "") {
          builder.error(event.finalError);
        }
        break;
    }
  }
  return builder.steps();
}
