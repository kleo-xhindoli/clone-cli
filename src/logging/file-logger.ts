/**
 * JSONL troubleshooting log. Every HTTP request and response, plus the
 * CLI's own milestones, is appended as one JSON object per line.
 * Authorization headers and passwords are redacted before writing.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  kind: string;
  message?: string;
  [key: string]: unknown;
}

const REDACTED = "<redacted>";
const SENSITIVE_HEADERS = ["authorization", "proxy-authorization", "cookie", "set-cookie"];
const SENSITIVE_KEYS = ["password", "accessToken", "access_token", "token", "refresh_token", "refreshToken"];

export function redact<T>(value: T): T {
  return redactInner(value, 0) as T;
}

function redactInner(value: unknown, depth: number): unknown {
  if (depth > 12) return "<depth limit>";
  if (Array.isArray(value)) return value.map((v) => redactInner(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const lower = key.toLowerCase();
      if (SENSITIVE_HEADERS.includes(lower) || SENSITIVE_KEYS.includes(key)) {
        out[key] = REDACTED;
      } else {
        out[key] = redactInner(val, depth + 1);
      }
    }
    return out;
  }
  if (typeof value === "string" && /^Bearer\s+\S+/i.test(value)) return "Bearer " + REDACTED;
  if (typeof value === "string" && /^Basic\s+\S+/i.test(value)) return "Basic " + REDACTED;
  return value;
}

export function defaultLogDir(): string {
  return process.env.CLONE_CLI_LOG_DIR || join(homedir(), ".onecal-clone-cli", "logs");
}

export function timestampForFilename(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
}

export class FileLogger {
  readonly path: string;
  private readonly dir: string;

  constructor(options: { dir?: string; name: string }) {
    this.dir = options.dir ?? defaultLogDir();
    mkdirSync(this.dir, { recursive: true });
    this.path = join(this.dir, `${options.name}.jsonl`);
  }

  /** Directory this run's files live in (log + any exported lists). */
  get directory(): string {
    return this.dir;
  }

  write(level: LogLevel, kind: string, data: Record<string, unknown> = {}): void {
    const entry: LogEntry = { ts: new Date().toISOString(), level, kind, ...redact(data) };
    try {
      appendFileSync(this.path, JSON.stringify(entry) + "\n");
    } catch {
      // Logging must never take the operation down.
    }
  }

  info(kind: string, data: Record<string, unknown> = {}): void {
    this.write("info", kind, data);
  }
  warn(kind: string, data: Record<string, unknown> = {}): void {
    this.write("warn", kind, data);
  }
  error(kind: string, data: Record<string, unknown> = {}): void {
    this.write("error", kind, data);
  }
  debug(kind: string, data: Record<string, unknown> = {}): void {
    this.write("debug", kind, data);
  }
}

/** A logger that discards everything; used in tests. */
export class NullLogger extends FileLogger {
  constructor() {
    super({ dir: join(process.env.TMPDIR || "/tmp", "onecal-clone-cli-null"), name: "null" });
  }
  override write(): void {}
}
