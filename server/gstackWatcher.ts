/**
 * GstackWatcher — tails ~/.gstack/analytics/skill-usage.jsonl for new lines.
 *
 * Lifecycle:
 *   1. Polls every 3 s until the file appears (logs waiting message once).
 *   2. Once found, reads existing content then hands off to chokidar for
 *      incremental tailing on every "change" event.
 *   3. If the file disappears, falls back to polling again.
 *
 * Emits:
 *   "line" (rawLine: string) — one complete JSON line from the analytics log
 */

import { watch } from "chokidar";
import { existsSync, statSync, openSync, readSync, closeSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { EventEmitter } from "events";

function resolveGstackLogPath(): string {
  // Windows: use USERPROFILE; Mac/Linux: use HOME (both fall back to os.homedir())
  const home =
    process.platform === "win32"
      ? (process.env.USERPROFILE ?? homedir())
      : (process.env.HOME ?? homedir());
  return join(home, ".gstack", "analytics", "skill-usage.jsonl");
}

const POLL_INTERVAL_MS = 3_000;

export class GstackWatcher extends EventEmitter {
  /** Resolved path to the analytics log */
  readonly filePath: string;

  private offset = 0;
  private lineBuffer = "";
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private fileWatcher: ReturnType<typeof watch> | null = null;
  private waitLogged = false;

  constructor() {
    super();
    this.filePath = resolveGstackLogPath();
  }

  start(): void {
    this.beginPolling();
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.fileWatcher?.close();
    this.fileWatcher = null;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private beginPolling(): void {
    if (!this.waitLogged) {
      console.log(`[gstack] waiting for analytics log at ${this.filePath}...`);
      this.waitLogged = true;
    }
    this.pollTimer = setInterval(() => this.checkForFile(), POLL_INTERVAL_MS);
    this.checkForFile(); // immediate first attempt
  }

  private checkForFile(): void {
    if (!existsSync(this.filePath)) return;

    // File found — stop polling and switch to chokidar
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    console.log(`[gstack] watching analytics log at ${this.filePath}`);
    this.readNewLines(); // catch up on any existing content

    this.fileWatcher = watch(this.filePath, { ignoreInitial: true });

    this.fileWatcher.on("change", () => this.readNewLines());

    // If the file is deleted, fall back to polling
    this.fileWatcher.on("unlink", () => {
      this.fileWatcher?.close();
      this.fileWatcher = null;
      this.offset = 0;
      this.lineBuffer = "";
      console.log(`[gstack] analytics log removed — resuming poll...`);
      this.waitLogged = false;
      this.beginPolling();
    });
  }

  private readNewLines(): void {
    try {
      const stat = statSync(this.filePath);
      if (stat.size <= this.offset) return;

      const buf = Buffer.alloc(stat.size - this.offset);
      const fd = openSync(this.filePath, "r");
      readSync(fd, buf, 0, buf.length, this.offset);
      closeSync(fd);

      this.offset = stat.size;
      const text = this.lineBuffer + buf.toString("utf-8");
      const lines = text.split("\n");
      this.lineBuffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.trim()) this.emit("line", line);
      }
    } catch {
      /* file may be transiently unreadable */
    }
  }
}
