/**
 * Interactive flow. Every answer can be pre-filled by a flag or environment
 * variable (see index.ts) so a support engineer can repeat a run quickly, but
 * the final destructive confirmation is always asked interactively.
 */
import * as p from "@clack/prompts";
import pc from "picocolors";
import type { ProviderName } from "../providers/types.js";
import type { DeleteMode } from "../core/pipeline.js";

export type Operation = "list" | "delete";
export type CalDavRange = "1y" | "all";

export interface Prefilled {
  op?: Operation;
  provider?: ProviderName;
  calendarId?: string;
  accessToken?: string;
  mode?: DeleteMode;
  range?: CalDavRange;
  caldavServerUrl?: string;
  caldavUsername?: string;
  caldavPassword?: string;
}

export interface Answers {
  op: Operation;
  provider: ProviderName;
  calendarId: string;
  accessToken?: string;
  caldav?: { serverUrl: string; username: string; password: string };
  mode?: DeleteMode;
  range?: CalDavRange;
}

function bail(value: unknown): asserts value is Exclude<typeof value, symbol> {
  if (p.isCancel(value)) {
    p.cancel("Cancelled. Nothing was changed.");
    process.exit(130);
  }
}

const required = (label: string) => (value: string | undefined) => (value?.trim() ? undefined : `${label} is required`);

export async function askOperation(pre?: Operation): Promise<Operation> {
  if (pre) return pre;
  const op = await p.select({
    message: "What would you like to do?",
    options: [
      { value: "list", label: "List clone events", hint: "read-only: shows every OneCal clone in a calendar" },
      { value: "delete", label: "Delete clone events", hint: "destructive: removes every OneCal clone from a calendar" },
    ],
  });
  bail(op);
  return op as Operation;
}

export async function askProvider(pre?: ProviderName): Promise<ProviderName> {
  if (pre) return pre;
  const provider = await p.select({
    message: "Which calendar provider is the calendar on?",
    options: [
      { value: "google", label: "Google" },
      { value: "outlook", label: "Outlook" },
      { value: "caldav", label: "CalDAV", hint: "iCloud, Fastmail, Nextcloud, Zoho, …" },
    ],
  });
  bail(provider);
  return provider as ProviderName;
}

export async function askCalendarId(provider: ProviderName, pre?: string): Promise<string> {
  if (pre) return pre;
  const hints: Record<ProviderName, { message: string; placeholder: string }> = {
    google: { message: "Google calendar ID", placeholder: "user@example.com or ...@group.calendar.google.com" },
    outlook: { message: "Outlook calendar ID", placeholder: "AAMkAG… (Graph calendar id)" },
    caldav: { message: "CalDAV calendar URL", placeholder: "https://caldav.example.com/user/calendars/abc/" },
  };
  const id = await p.text({ ...hints[provider], validate: required("Calendar ID") });
  bail(id);
  return (id as string).trim();
}

export async function askAccessToken(pre?: string): Promise<string> {
  if (pre) return pre;
  const token = await p.password({ message: "Access token (input is hidden)", validate: required("Access token") });
  bail(token);
  return (token as string).trim();
}

export async function askCalDavCredentials(pre: Prefilled): Promise<{ serverUrl: string; username: string; password: string }> {
  let serverUrl = pre.caldavServerUrl;
  if (!serverUrl) {
    const value = await p.text({
      message: "CalDAV server URL",
      placeholder: "https://caldav.icloud.com",
      validate: (v) => {
        if (!v?.trim()) return "Server URL is required";
        try {
          new URL(v.trim());
        } catch {
          return "Enter a full URL including https://";
        }
        return undefined;
      },
    });
    bail(value);
    serverUrl = (value as string).trim();
  }
  let username = pre.caldavUsername;
  if (!username) {
    const value = await p.text({ message: "CalDAV username / login email", validate: required("Username") });
    bail(value);
    username = (value as string).trim();
  }
  let password = pre.caldavPassword;
  if (!password) {
    const value = await p.password({ message: "CalDAV app password (input is hidden)", validate: required("Password") });
    bail(value);
    password = value as string;
  }
  return { serverUrl, username, password };
}

export async function askMode(batchHint: string, pre?: DeleteMode): Promise<DeleteMode> {
  if (pre) return pre;
  const mode = await p.select({
    message: "How should the clones be deleted?",
    options: [
      { value: "batch", label: "Batch", hint: batchHint },
      { value: "single", label: "Non-batch", hint: "one DELETE request per clone, slower but easier to troubleshoot" },
    ],
  });
  bail(mode);
  return mode as DeleteMode;
}

export async function askCalDavRange(pre?: CalDavRange): Promise<CalDavRange> {
  if (pre) return pre;
  const range = await p.select({
    message: "Which time range should be scanned for clones?",
    options: [
      { value: "1y", label: "1 year back to 1 year ahead", hint: "same window the sync service uses" },
      { value: "all", label: "Entire calendar", hint: "slower on big calendars" },
    ],
  });
  bail(range);
  return range as CalDavRange;
}

export async function confirmDeletion(details: {
  calendarName: string;
  provider: string;
  calendarId: string;
  mode: DeleteMode;
  logPath: string;
}): Promise<boolean> {
  p.note(
    [
      `${pc.dim("Calendar name")}  ${pc.bold(details.calendarName)}`,
      `${pc.dim("Provider     ")}  ${details.provider}`,
      `${pc.dim("Calendar ID  ")}  ${details.calendarId}`,
      `${pc.dim("Mode         ")}  ${details.mode === "batch" ? "batch" : "non-batch"}`,
      `${pc.dim("Log file     ")}  ${details.logPath}`,
      "",
      pc.red("Every OneCal clone event in this calendar will be permanently deleted."),
      pc.dim("Real (non-clone) events are never touched."),
    ].join("\n"),
    "Final confirmation"
  );
  const typed = await p.text({
    message: `Type ${pc.bold("delete")} to confirm, or anything else to abort`,
    placeholder: "delete",
  });
  bail(typed);
  return (typed as string).trim().toLowerCase() === "delete";
}

export { p as prompts };
