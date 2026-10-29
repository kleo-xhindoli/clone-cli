/**
 * Google Calendar batch (multipart/mixed) request builder and response
 * parser. Mirrors mono/apps/sync-service/src/calendar-providers/google/batch-request.ts
 * but is self-contained and uses CRLF line endings throughout.
 */

export const GOOGLE_BATCH_URL = "https://www.googleapis.com/batch/calendar/v3";
export const GOOGLE_BATCH_BOUNDARY = "batch_onecal_clone_cli";

export interface BatchPart {
  id: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path relative to /calendar/v3, e.g. "calendars/primary/events/abc". */
  path: string;
}

export interface BatchPartResponse {
  id: string;
  status: number;
  body: string;
}

export function buildGoogleBatchBody(parts: BatchPart[], boundary = GOOGLE_BATCH_BOUNDARY): string {
  const sections = parts.map((part) => {
    const path = `/calendar/v3/${part.path.replace(/^\/+/, "")}`;
    return [
      `--${boundary}`,
      `Content-Type: application/http`,
      `Content-ID: <${part.id}>`,
      ``,
      `${part.method} ${path}`,
      ``,
      ``,
    ].join("\r\n");
  });
  return sections.join("") + `--${boundary}--\r\n`;
}

export function boundaryFromContentType(contentType: string | undefined): string | null {
  if (!contentType) return null;
  const match = /boundary="?([^";]+)"?/i.exec(contentType);
  return match ? match[1] : null;
}

/**
 * Parses a multipart/mixed batch response. Each part looks like:
 *
 *   --boundary
 *   Content-Type: application/http
 *   Content-ID: <response-ID>
 *
 *   HTTP/1.1 204 No Content
 *   Header: value
 *
 *   {body}
 */
export function parseGoogleBatchResponse(text: string, boundary: string): BatchPartResponse[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const chunks = normalized
    .split(`--${boundary}`)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk && chunk !== "--");

  return chunks.map((chunk) => {
    const idMatch = /Content-ID:\s*<?(?:response-)?([^>\s]+)>?/i.exec(chunk);
    const statusMatch = /HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(chunk);
    if (!idMatch || !statusMatch) {
      throw new Error(`Could not parse batch part:\n${chunk.slice(0, 300)}`);
    }
    // Body is everything after the inner response's header block.
    const afterStatus = chunk.slice(statusMatch.index);
    const blank = afterStatus.indexOf("\n\n");
    const body = blank === -1 ? "" : afterStatus.slice(blank + 2).trim();
    return { id: idMatch[1], status: Number(statusMatch[1]), body };
  });
}
