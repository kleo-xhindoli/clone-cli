/**
 * Console output: timestamped log lines plus a single live status line at the
 * bottom that keeps ticking (spinner + elapsed time) so a long request never
 * looks stuck. On non-TTY output the status line degrades to plain lines.
 */
import pc from "picocolors";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function clock(): string {
  return new Date().toTimeString().slice(0, 8);
}

export function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${m}m ${s}s`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

class StatusLine {
  private text = "";
  private startedAt = 0;
  private lastActivityAt = 0;
  private timer?: NodeJS.Timeout;
  private frame = 0;
  private rendered = false;
  private lastPlain = "";
  private readonly isTTY = Boolean(process.stderr.isTTY);

  set(text: string): void {
    this.text = text;
    this.lastActivityAt = Date.now();
    if (!this.startedAt) this.startedAt = Date.now();
    if (!this.isTTY) {
      if (text !== this.lastPlain) {
        process.stderr.write(`${pc.dim(clock())}  … ${text}\n`);
        this.lastPlain = text;
      }
      return;
    }
    if (!this.timer) {
      this.timer = setInterval(() => this.render(), 120);
      this.timer.unref();
    }
    this.render();
  }

  /** Marks activity (a response arrived) without changing the text. */
  touch(): void {
    this.lastActivityAt = Date.now();
  }

  clear(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.erase();
    this.text = "";
    this.startedAt = 0;
  }

  /** Temporarily hides the line so another writer can print. */
  erase(): void {
    if (this.isTTY && this.rendered) {
      process.stderr.write("\r\x1b[2K");
      this.rendered = false;
    }
  }

  redraw(): void {
    if (this.isTTY && this.text) this.render();
  }

  private render(): void {
    if (!this.isTTY || !this.text) return;
    this.frame = (this.frame + 1) % FRAMES.length;
    const elapsed = formatDuration(Date.now() - this.startedAt);
    const idle = Date.now() - this.lastActivityAt;
    const idleNote = idle > 8000 ? pc.yellow(`  (no response for ${formatDuration(idle)}, still waiting…)`) : "";
    const line = `${pc.cyan(FRAMES[this.frame])} ${this.text} ${pc.dim(`[${elapsed}]`)}${idleNote}`;
    const width = process.stderr.columns || 120;
    process.stderr.write(`\r\x1b[2K${truncateAnsi(line, width - 1)}`);
    this.rendered = true;
  }
}

function truncateAnsi(text: string, max: number): string {
  // Good enough: strip escape codes to measure, cut the raw string if too long.
  const visible = text.replace(/\x1b\[[0-9;]*m/g, "");
  if (visible.length <= max) return text;
  return visible.slice(0, max - 1) + "…";
}

export const status = new StatusLine();

function write(line: string): void {
  status.erase();
  process.stderr.write(line + "\n");
  status.redraw();
}

export const log = {
  info(message: string): void {
    write(`${pc.dim(clock())}  ${pc.blue("ℹ")} ${message}`);
  },
  step(message: string): void {
    write(`${pc.dim(clock())}  ${pc.cyan("▸")} ${message}`);
  },
  success(message: string): void {
    write(`${pc.dim(clock())}  ${pc.green("✔")} ${message}`);
  },
  warn(message: string): void {
    write(`${pc.dim(clock())}  ${pc.yellow("⚠")} ${pc.yellow(message)}`);
  },
  error(message: string): void {
    write(`${pc.dim(clock())}  ${pc.red("✖")} ${pc.red(message)}`);
  },
  plain(message = ""): void {
    write(message);
  },
};

/** Renders a two-column key/value block. */
export function keyValueBlock(rows: Array<[string, string]>): string {
  const width = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `  ${pc.dim(k.padEnd(width))}  ${v}`).join("\n");
}

/** Renders a simple fixed-width table. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => (c ?? "").padEnd(widths[i])).join("  ");
  return [pc.bold(line(headers)), pc.dim(widths.map((w) => "─".repeat(w)).join("  ")), ...rows.map(line)].join("\n");
}

/** Short status text for the listing phase: which page is in flight and what has been retrieved so far. */
export function describeListingProgress(info: {
  phase: "fetching" | "done";
  page: number;
  totalPages?: number;
  totalClones: number;
  totalCancelled?: number;
}): string {
  const unit = info.totalPages !== undefined ? "chunk" : "page";
  const where = info.totalPages !== undefined ? `${info.page}/${info.totalPages}` : String(info.page);
  const sofar = `${info.totalClones} clone(s) retrieved so far${info.totalCancelled ? `, ${info.totalCancelled} cancelled ignored` : ""}`;
  if (info.phase === "fetching") {
    return info.page === 0 ? `Querying calendar for event list… (${sofar})` : `Reading ${unit} ${where}… ${sofar}`;
  }
  return `${unit} ${where} done, ${sofar}`;
}

/** One line per listing page: what was read, what was kept, what was ignored and why. */
export function describePage(info: {
  page: number;
  totalPages?: number;
  itemsOnPage: number;
  clonesOnPage: number;
  ignoredOnPage: number;
  cancelledOnPage?: number;
  totalClones: number;
}): string {
  const ignored: string[] = [];
  if (info.cancelledOnPage) ignored.push(`${info.cancelledOnPage} cancelled (already deleted)`);
  const other = info.ignoredOnPage - (info.cancelledOnPage ?? 0);
  if (other > 0) ignored.push(`${other} not a clone`);
  const ignoredText = ignored.length ? `, ignored ${ignored.join(" + ")}` : "";
  const where = info.totalPages !== undefined ? `Chunk ${info.page}/${info.totalPages}` : `Page ${info.page}`;
  return `${where}: ${info.itemsOnPage} events read, ${info.clonesOnPage} clone(s) found${ignoredText} (total clones ${info.totalClones})`;
}

export function truncateText(text: string | undefined, max: number): string {
  if (!text) return "";
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}
