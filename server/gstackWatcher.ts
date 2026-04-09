import { statSync, openSync, readSync, closeSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { EventEmitter } from "events";

function getGstackLogPath(): string {
  if (process.platform === "win32" && process.env.USERPROFILE) {
    return join(process.env.USERPROFILE, ".gstack", "analytics.jsonl");
  }
  return join(homedir(), ".gstack", "analytics.jsonl");
}

export const GSTACK_LOG_PATH = getGstackLogPath();
const POLL_INTERVAL_MS = 3_000;

export class GstackWatcher extends EventEmitter {
  private offset = 0;
  private lineBuffer = "";
  private interval: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private waitLogged = false;
  readonly path = GSTACK_LOG_PATH;

  start(): void {
    if (this.interval) return;
    this.check();
    this.interval = setInterval(() => this.check(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private check(): void {
    if (!existsSync(this.path)) {
      if (!this.waitLogged) {
        console.log("[gstack] waiting for analytics log...");
        this.waitLogged = true;
      }
      return;
    }

    if (!this.started) {
      console.log(`[gstack] watching analytics log at ${this.path}`);
      this.started = true;
    }

    try {
      const stat = statSync(this.path);
      if (stat.size <= this.offset) return;

      const buf = Buffer.alloc(stat.size - this.offset);
      const fd = openSync(this.path, "r");
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
      /* file may be unreadable */
    }
  }
}
