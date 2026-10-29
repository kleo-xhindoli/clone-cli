#!/usr/bin/env node
/**
 * OneCal clone CLI: lists or deletes OneCal clone events in one calendar.
 *
 *   npm start                      interactive
 *   npm start -- --op list --provider google --calendar-id primary
 *
 * Flags pre-fill prompts; the destructive confirmation is always interactive.
 */
import { subYears, addYears } from "./core/dates.js";
import pc from "picocolors";
import {
  askAccessToken,
  askCalDavCredentials,
  askCalDavRange,
  askCalendarId,
  askMode,
  askOperation,
  askProvider,
  confirmDeletion,
  prompts,
  type Answers,
  type CalDavRange,
  type Operation,
  type Prefilled,
} from "./cli/prompts.js";
import { log, status } from "./cli/ui.js";
import type { DeleteMode } from "./core/pipeline.js";
import { HttpError } from "./http/client.js";
import { FileLogger, timestampForFilename } from "./logging/file-logger.js";
import { CalDavProvider } from "./providers/caldav.js";
import { GoogleProvider } from "./providers/google.js";
import { OutlookProvider } from "./providers/outlook.js";
import type { CloneProvider, ProviderName } from "./providers/types.js";
import { runDelete } from "./ops/delete.js";
import { runList } from "./ops/list.js";

const HELP = `
OneCal clone CLI

Usage:
  onecal-clone-cli [options]

Options (each one skips the matching prompt):
  --op <list|delete>              Operation to run
  --provider <google|outlook|caldav>
  --calendar-id <id>              Calendar ID (CalDAV: the calendar URL)
  --mode <batch|single>           Delete mode
  --range <1y|all>                CalDAV only: time window to scan
  --log-dir <path>                Where to write the JSONL request log
  -h, --help                      Show this help

Environment:
  CLONE_CLI_ACCESS_TOKEN          Google / Outlook access token
  CLONE_CLI_CALDAV_SERVER_URL     CalDAV server URL
  CLONE_CLI_CALDAV_USERNAME       CalDAV username
  CLONE_CLI_CALDAV_PASSWORD       CalDAV app password
  CLONE_CLI_LOG_DIR               Same as --log-dir (default ~/.onecal-clone-cli/logs)
`;

function parseArgs(argv: string[]): Prefilled & { help?: boolean; logDir?: string } {
  const out: Prefilled & { help?: boolean; logDir?: string } = {};
  const take = (i: number) => {
    const v = argv[i + 1];
    if (!v || v.startsWith("--")) throw new Error(`Missing value for ${argv[i]}`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-h":
      case "--help":
        out.help = true;
        break;
      case "--op":
        out.op = expectOneOf(take(i), ["list", "delete"]) as Operation;
        i++;
        break;
      case "--provider":
        out.provider = expectOneOf(take(i), ["google", "outlook", "caldav"]) as ProviderName;
        i++;
        break;
      case "--calendar-id":
        out.calendarId = take(i);
        i++;
        break;
      case "--mode":
        out.mode = expectOneOf(take(i), ["batch", "single"]) as DeleteMode;
        i++;
        break;
      case "--range":
        out.range = expectOneOf(take(i), ["1y", "all"]) as CalDavRange;
        i++;
        break;
      case "--log-dir":
        out.logDir = take(i);
        i++;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  out.accessToken = process.env.CLONE_CLI_ACCESS_TOKEN || undefined;
  out.caldavServerUrl = process.env.CLONE_CLI_CALDAV_SERVER_URL || undefined;
  out.caldavUsername = process.env.CLONE_CLI_CALDAV_USERNAME || undefined;
  out.caldavPassword = process.env.CLONE_CLI_CALDAV_PASSWORD || undefined;
  return out;
}

function expectOneOf(value: string, allowed: string[]): string {
  if (!allowed.includes(value)) throw new Error(`Expected one of ${allowed.join(", ")} but got "${value}"`);
  return value;
}

async function collectAnswers(pre: Prefilled, providerLabelHint: (p: ProviderName) => string): Promise<Answers> {
  const op = await askOperation(pre.op);
  const provider = await askProvider(pre.provider);
  const calendarId = await askCalendarId(provider, pre.calendarId);
  const answers: Answers = { op, provider, calendarId };

  if (provider === "caldav") {
    answers.caldav = await askCalDavCredentials(pre);
    answers.range = await askCalDavRange(pre.range);
  } else {
    answers.accessToken = await askAccessToken(pre.accessToken);
  }
  if (op === "delete") {
    answers.mode = await askMode(providerLabelHint(provider), pre.mode);
  }
  return answers;
}

function buildProvider(answers: Answers, logger: FileLogger): CloneProvider {
  const onRetry = ({ attempt, maxAttempts, status: code, delayMs }: { attempt: number; maxAttempts: number; status?: number; delayMs: number }) => {
    log.warn(`Request ${code ? `failed with ${code}` : "hit a network error"}; retrying in ${(delayMs / 1000).toFixed(1)}s (attempt ${attempt + 1}/${maxAttempts})`);
  };
  switch (answers.provider) {
    case "google":
      return new GoogleProvider({ accessToken: answers.accessToken!, logger, onRetry });
    case "outlook":
      return new OutlookProvider({ accessToken: answers.accessToken!, logger, onRetry });
    case "caldav": {
      const now = new Date();
      const timeRange = answers.range === "all" ? undefined : { start: subYears(now, 1).toISOString(), end: addYears(now, 1).toISOString() };
      return new CalDavProvider({
        credentials: answers.caldav!,
        logger,
        timeRange,
        onRetry,
        onParseWarning: (message) => log.warn(message),
      });
    }
  }
}

const BATCH_HINTS: Record<ProviderName, string> = {
  google: "one multipart batch request per 50 deletes",
  outlook: "one Graph $batch request per 20 deletes",
  caldav: "no batch API; runs 5 DELETE requests at a time",
};

async function main(): Promise<number> {
  const pre = parseArgs(process.argv.slice(2));
  if (pre.help) {
    process.stdout.write(HELP);
    return 0;
  }

  prompts.intro(pc.bgCyan(pc.black(" OneCal clone CLI ")));
  const answers = await collectAnswers(pre, (p) => BATCH_HINTS[p]);

  const runName = `${timestampForFilename()}_${answers.op}_${answers.provider}`;
  const logger = new FileLogger({ dir: pre.logDir, name: runName });
  logger.info("run.start", { op: answers.op, provider: answers.provider, calendarId: answers.calendarId, mode: answers.mode, range: answers.range });
  log.info(`Full request/response log: ${logger.path}`);

  const provider = buildProvider(answers, logger);

  status.set(`Connecting to ${provider.label} and looking up the calendar…`);
  let calendar;
  try {
    calendar = await provider.getCalendar(answers.calendarId);
  } finally {
    status.clear();
  }
  log.success(`Calendar found: ${pc.bold(calendar.name)} (${calendar.id})`);

  if (answers.op === "list") {
    await runList({ provider, calendar, logger, runName });
    prompts.outro("Done. Nothing was modified.");
    return 0;
  }

  const confirmed = await confirmDeletion({
    calendarName: calendar.name,
    provider: provider.label,
    calendarId: calendar.id,
    mode: answers.mode!,
    logPath: logger.path,
  });
  if (!confirmed) {
    logger.info("run.aborted", { reason: "confirmation not given" });
    prompts.cancel("Aborted. Nothing was deleted.");
    return 130;
  }
  logger.info("run.confirmed", {});

  const summary = await runDelete({
    provider,
    calendar,
    mode: answers.mode!,
    logger,
    onAuthExpired: async () => {
      if (!process.stdin.isTTY) return false;
      const secret = await prompts.password({
        message: `Paste a fresh ${provider.credentialLabel} to continue, or leave empty to stop`,
      });
      if (prompts.isCancel(secret) || !secret || !String(secret).trim()) return false;
      provider.updateCredentials(String(secret).trim());
      return true;
    },
  });
  const ok = summary.counts.failed === 0 && summary.listingComplete && !summary.stoppedReason;
  prompts.outro(ok ? pc.green("Finished without failures.") : pc.yellow("Finished with problems; see the summary above and the log file."));
  return ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    status.clear();
    if (err instanceof HttpError) {
      if (err.status === 401) {
        log.error("Unauthorized (401): the access token is invalid, expired, or lacks calendar scope.");
      } else if (err.status === 403) {
        log.error(`Forbidden (403): ${err.message}`);
      } else {
        log.error(err.message);
      }
    } else {
      log.error(err instanceof Error ? err.message : String(err));
    }
    log.plain(pc.dim("Details for this failure are in the request log (see the path printed above, if any)."));
    process.exit(1);
  });
