import type { TrackedAgent, ServerMessage } from "./types.js";

// Tool categorization
const READING_TOOLS = new Set([
  "read", "cat", "grep", "find", "glob", "ls",
  "web_fetch", "webfetch", "websearch", "web_search",
]);

const TOOL_DISPLAY_DELAY_MS = 800;
const WAITING_DELAY_MS = 5_000;
const SESSION_GAP_MS = 60_000;

const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();

function cancelWaiting(agentId: number): void {
  const t = waitingTimers.get(agentId);
  if (t) { clearTimeout(t); waitingTimers.delete(agentId); }
}

function scheduleWaiting(agent: TrackedAgent, emit: (msg: ServerMessage) => void): void {
  cancelWaiting(agent.id);
  waitingTimers.set(agent.id, setTimeout(() => {
    waitingTimers.delete(agent.id);
    agent.isWaiting = true;
    agent.activity = "waiting";
    emit({ type: "agentStatus", id: agent.id, status: "waiting" });
  }, WAITING_DELAY_MS));
}

export function extractRole(record: Record<string, unknown>): string {
  const raw = String(record.role ?? record.agent ?? record.agentName ?? record.skill ?? "gstack");
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "gstack";
}

export function extractSessionId(record: Record<string, unknown>): string | null {
  const id = record.sessionId ?? record.session_id;
  return typeof id === "string" ? id : null;
}

export function extractTimestamp(record: Record<string, unknown>): number {
  const ts = record.ts ?? record.timestamp;
  return typeof ts === "number" ? ts : Date.now();
}

export { SESSION_GAP_MS };

export function processGstackLine(
  line: string,
  agent: TrackedAgent,
  emit: (msg: ServerMessage) => void,
): void {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line);
  } catch {
    return;
  }

  agent.lastActivityTime = Date.now();

  const toolRaw = String(record.tool ?? record.toolName ?? record.tool_name ?? "");
  const tool = toolRaw.toLowerCase();
  const type = String(record.type ?? "");

  if (tool) {
    const toolId = `gstack-${agent.id}-${Date.now()}`;
    const activity = READING_TOOLS.has(tool) ? "reading" : "typing";
    const status = buildStatus(tool, record);

    cancelWaiting(agent.id);
    agent.isWaiting = false;
    agent.activity = activity;

    emit({ type: "agentStatus", id: agent.id, status: "active" });
    emit({ type: "agentToolStart", id: agent.id, toolId, status });

    agent.activeTools.set(toolId, { toolId, toolName: tool, status });
    agent.activeToolNames.set(toolId, tool);

    setTimeout(() => {
      agent.activeTools.delete(toolId);
      agent.activeToolNames.delete(toolId);
      emit({ type: "agentToolDone", id: agent.id, toolId });
      scheduleWaiting(agent, emit);
    }, TOOL_DISPLAY_DELAY_MS);

  } else if (type === "turn_end" || type === "done" || type === "idle") {
    cancelWaiting(agent.id);
    if (agent.activeTools.size > 0) {
      agent.activeTools.clear();
      agent.activeToolNames.clear();
      emit({ type: "agentToolsClear", id: agent.id });
    }
    agent.isWaiting = true;
    agent.activity = "waiting";
    emit({ type: "agentStatus", id: agent.id, status: "waiting" });

  } else {
    // message / text / thinking / unknown — pulse active briefly
    cancelWaiting(agent.id);
    agent.isWaiting = false;
    emit({ type: "agentStatus", id: agent.id, status: "active" });
    scheduleWaiting(agent, emit);
  }
}

function buildStatus(tool: string, record: Record<string, unknown>): string {
  switch (tool) {
    case "bash":
    case "shell":
    case "exec":
    case "run":
    case "test": {
      const cmd = String(record.command ?? record.cmd ?? "").slice(0, 40);
      return cmd ? `Running: ${cmd}` : `Running ${tool}`;
    }
    case "read":
    case "cat":
      return `Reading ${shortPath(record.path ?? record.file ?? record.file_path ?? "")}`;
    case "write":
    case "edit":
    case "create":
      return `Editing ${shortPath(record.path ?? record.file ?? record.file_path ?? "")}`;
    case "grep":
    case "find":
      return "Searching code";
    case "glob":
    case "ls":
      return "Searching files";
    case "web_search":
    case "websearch":
      return "Searching the web";
    case "web_fetch":
    case "webfetch":
    case "fetch":
    case "browse":
      return "Fetching web content";
    case "memory":
      return "Accessing memory";
    default:
      return `Using ${tool}`;
  }
}

function shortPath(p: unknown): string {
  if (typeof p !== "string" || !p) return "";
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}
