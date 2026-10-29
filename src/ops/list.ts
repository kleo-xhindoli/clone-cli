import { writeFileSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { collectClones } from "../core/pipeline.js";
import type { FileLogger } from "../logging/file-logger.js";
import type { CalendarInfo, CloneEvent, CloneProvider } from "../providers/types.js";
import { describeListingProgress, describePage, keyValueBlock, log, status, table, truncateText } from "../cli/ui.js";

const PREVIEW_ROWS = 50;

export async function runList(options: {
  provider: CloneProvider;
  calendar: CalendarInfo;
  logger: FileLogger;
  runName: string;
}): Promise<{ clones: CloneEvent[]; exportPath: string }> {
  const { provider, calendar, logger, runName } = options;

  log.step(`Listing OneCal clones in ${pc.bold(calendar.name)} (${provider.label})`);
  status.set("Requesting first page of events…");
  logger.info("op.list.start", { provider: provider.name, calendarId: calendar.id, calendarName: calendar.name });

  const startedAt = Date.now();
  let clones: CloneEvent[];
  try {
    clones = await collectClones(provider, calendar.id, (info) => {
      status.set(describeListingProgress(info));
      if (info.phase === "done") log.info(describePage(info));
    });
  } finally {
    status.clear();
  }

  const exportPath = join(logger.directory, `${runName}_clones.json`);
  writeFileSync(exportPath, JSON.stringify({ calendar, provider: provider.name, count: clones.length, clones }, null, 2));
  logger.info("op.list.done", { count: clones.length, exportPath, durationMs: Date.now() - startedAt });

  log.success(`Found ${pc.bold(String(clones.length))} clone event(s) in ${formatSeconds(Date.now() - startedAt)}`);
  log.plain();

  if (clones.length) {
    const rows = clones.slice(0, PREVIEW_ROWS).map((c) => [
      truncateText(c.id, 44),
      truncateText(c.title, 32),
      truncateText(c.start, 25),
      c.isRecurring ? "yes" : c.recurringEventId ? "exception" : "",
      truncateText(c.syncId, 26),
    ]);
    log.plain(table(["Event ID", "Title", "Start", "Recurring", "Sync ID"], rows));
    if (clones.length > PREVIEW_ROWS) {
      log.plain(pc.dim(`  … ${clones.length - PREVIEW_ROWS} more not shown`));
    }
    log.plain();

    const bySync = new Map<string, number>();
    for (const c of clones) bySync.set(c.syncId ?? "(no sync id)", (bySync.get(c.syncId ?? "(no sync id)") ?? 0) + 1);
    log.plain(pc.bold("Clones per sync config"));
    log.plain(keyValueBlock([...bySync.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, String(v)])));
    log.plain();
  }

  log.plain(keyValueBlock([
    ["Full list (JSON)", exportPath],
    ["Request log", logger.path],
  ]));
  return { clones, exportPath };
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}
