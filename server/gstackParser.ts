/**
 * gstackParser.ts — processes lines from ~/.gstack/analytics.jsonl and emits
 * the exact same ServerMessage shapes that the Claude Code transcript parser
 * (parser.ts) emits, so the UI receives identical event types.
 *
 * Animation mapping (drives extractToolName() → isReadingTool() in the UI):
 *
 *   Tool                           → status prefix  → UI tool name  → animation
 *   ─────────────────────────────────────────────────────────────────────────────
 *   read / cat                     → "Reading …"    → Read          → reading
 *   grep / find                    → "Searching …"  → Grep          → reading
 *   glob / ls                      → "Searching …"  → Grep          → reading
 *   web_search / websearch / search→ "Searching web…"→ WebSearch    → reading
 *   web_fetch / fetch / browse     → "Fetching …"   → WebFetch      → reading
 *   write / create                 → "Writing …"    → Write         → typing
 *   edit                           → "Editing …"    → Edit          → typing
 *   bash / shell / exec / run /
 *     test / anything else         → "Running: …"   → Bash          → typing
 *
 * Reading tools (Read, Grep, Glob, WebFetch, WebSearch) show the lean-back
 * reading sprite. Typing tools show the keyboard-typing sprite. In both cases
 * the character walks to its assigned desk first (WALK animation → TYPE/read).
 *
 * Session boundary: caller detects sessionId changes or 60-second gaps and
 * closes all gstack characters before passing new lines here.
 */

import type { TrackedAgent, ServerMessage } from "./types.js";

/** 60-second silence → new session boundary (exported for use in index.ts) */
export const SESSION_GAP_MS = 60_000;

/**
 * How long to show the "tool running" animation before auto-completing it.
 * Analytics entries are already finished, so we simulate a visible pulse.
 */
const TOOL_VISIBLE_MS = 1_200;

/**
 * Delay between marking a tool done and the agentToolDone message.
 * Matches the constant in parser.ts (TOOL_DONE_DELAY_MS = 300).
 */
const TOOL_DONE_DELAY_MS = 300;

/**
 * Silence after last event before emitting agentStatus "waiting".
 * Matches TEXT_IDLE_DELAY_MS = 5 000 in parser.ts.
 */
const WAITING_DELAY_MS = 5_000;

// ── Timer maps (module-level, same pattern as parser.ts) ──────────────────
const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();

function cancelTimer(id: number, map: Map<number, ReturnType<typeof setTimeout>>): void {
  const t = map.get(id);
  if (t) { clearTimeout(t); map.delete(id); }
}

function scheduleWaiting(agent: TrackedAgent, emit: (msg: ServerMessage) => void): void {
  cancelTimer(agent.id, waitingTimers);
  waitingTimers.set(
    agent.id,
    setTimeout(() => {
      waitingTimers.delete(agent.id);
      agent.isWaiting = true;
      agent.activity = "waiting";
      emit({ type: "agentStatus", id: agent.id, status: "waiting" });
    }, WAITING_DELAY_MS),
  );
}

// ── Role extraction ────────────────────────────────────────────────────────

/**
 * Normalise a raw role string to lowercase-hyphen form.
 * Examples: "Eng Manager" → "eng-manager", "QA" → "qa"
 */
export function normaliseRole(raw: string): string {
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "gstack"
  );
}

/** Extract the agent role from a parsed analytics record. */
export function extractRole(record: Record<string, unknown>): string {
  const raw = String(
    record.role ?? record.agent ?? record.agentName ?? record.skill ?? "gstack",
  );
  return normaliseRole(raw);
}

/** Extract session identifier (or null if absent). */
export function extractSessionId(record: Record<string, unknown>): string | null {
  const id = record.sessionId ?? record.session_id;
  return typeof id === "string" && id ? id : null;
}

/** Extract timestamp in Unix ms (falls back to Date.now()). */
export function extractTimestamp(record: Record<string, unknown>): number {
  const ts = record.ts ?? record.timestamp;
  if (typeof ts === "number") return ts;
  if (typeof ts === "string") {
    const parsed = Date.parse(ts);
    if (!isNaN(parsed)) return parsed;
  }
  return Date.now();
}

// ── Tool status builder ────────────────────────────────────────────────────

/**
 * Build an agentToolStart "status" string whose prefix matches the
 * STATUS_TO_TOOL map in the UI's toolUtils.ts, so extractToolName()
 * returns the correct tool name and isReadingTool() picks the right sprite.
 */
function buildToolStatus(tool: string, record: Record<string, unknown>): string {
  switch (tool) {
    // ── Reading animation ─────────────────────────────────────────────────
    case "read":
    case "cat": {
      const f = shortPath(record.path ?? record.file ?? record.file_path ?? "");
      return `Reading ${f || "file"}`;
    }
    case "grep":
    case "find":
      return "Searching code";
    case "glob":
    case "ls":
      return "Searching files";
    case "web_search":
    case "websearch":
    case "search":
      return "Searching web results"; // prefix "Searching web" → WebSearch
    case "web_fetch":
    case "webfetch":
    case "fetch":
    case "browse":
      return "Fetching web content"; // prefix "Fetching" → WebFetch

    // ── Typing animation ──────────────────────────────────────────────────
    case "write":
    case "create": {
      const f = shortPath(record.path ?? record.file ?? record.file_path ?? "");
      return `Writing ${f || "file"}`;
    }
    case "edit": {
      const f = shortPath(record.path ?? record.file ?? record.file_path ?? "");
      return `Editing ${f || "file"}`;
    }
    default: {
      // bash / shell / exec / run / test / anything else
      const cmd = String(record.command ?? record.cmd ?? "").slice(0, 30);
      return cmd ? `Running: ${cmd}` : `Running ${tool}`;
    }
  }
}

function shortPath(p: unknown): string {
  if (typeof p !== "string" || !p) return "";
  return p.replace(/\\/g, "/").split("/").pop() || p;
}

// ── Main parser ────────────────────────────────────────────────────────────

/**
 * Process one line from ~/.gstack/analytics.jsonl.
 * Emits the same ServerMessage types as processTranscriptLine() in parser.ts.
 */
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

  const toolRaw = String(
    record.tool ?? record.toolName ?? record.tool_name ?? "",
  ).toLowerCase();
  const eventType = String(record.type ?? "");

  if (toolRaw) {
    // ── Tool event ─────────────────────────────────────────────────────────
    // Analytics entries represent completed calls, so we show the animation
    // briefly then auto-complete it, matching how the real transcript parser
    // emits agentToolStart then agentToolDone after the tool returns.

    const toolId = `gstack-${agent.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const status = buildToolStatus(toolRaw, record);

    cancelTimer(agent.id, waitingTimers);
    agent.isWaiting = false;

    emit({ type: "agentStatus", id: agent.id, status: "active" });
    emit({ type: "agentToolStart", id: agent.id, toolId, status });

    agent.activeTools.set(toolId, { toolId, toolName: toolRaw, status });
    agent.activeToolNames.set(toolId, toolRaw);

    // Auto-complete after a visible animation window
    setTimeout(() => {
      agent.activeTools.delete(toolId);
      agent.activeToolNames.delete(toolId);
      setTimeout(() => {
        emit({ type: "agentToolDone", id: agent.id, toolId });
        scheduleWaiting(agent, emit);
      }, TOOL_DONE_DELAY_MS);
    }, TOOL_VISIBLE_MS);

  } else if (
    eventType === "turn_end" ||
    eventType === "done" ||
    eventType === "idle"
  ) {
    // ── Turn-end event ─────────────────────────────────────────────────────
    cancelTimer(agent.id, waitingTimers);
    if (agent.activeTools.size > 0) {
      agent.activeTools.clear();
      agent.activeToolNames.clear();
      emit({ type: "agentToolsClear", id: agent.id });
    }
    agent.isWaiting = true;
    agent.activity = "waiting";
    emit({ type: "agentStatus", id: agent.id, status: "waiting" });

  } else {
    // ── Message / thinking / unknown — pulse active briefly ───────────────
    cancelTimer(agent.id, waitingTimers);
    agent.isWaiting = false;
    emit({ type: "agentStatus", id: agent.id, status: "active" });
    scheduleWaiting(agent, emit);
  }
}
