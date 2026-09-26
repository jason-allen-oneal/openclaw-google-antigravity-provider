// Watches agy's stderr for the two terminal markers that the stream-json
// stdout channel doesn't cover, and lets the wrapper synthesise a result event
// so openclaw's parser classifies the run instead of accepting whatever partial
// text made it out.
//
// The parser hook openclaw exposes on `CliBackendPlugin` (`parseJsonlEvent`)
// only sees stdout. When agy dies without emitting `event:"result"` — or
// returns partial output on a `--print-timeout` expiry — openclaw's runner is
// left to guess (either falls through to "empty response" or, worse, accepts
// the pre-death streamed text as the assistant reply). Both markers below
// were introduced in agy 1.2.6:
//
//   AGY_ERROR: {json}     — turn died with a model or agent-side failure;
//                           agy exits code 3 after this line.
//   [agy] print timeout … — --print-timeout expired mid-turn; agy returns
//                           partial stdout and exits code 0.

import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

const AGY_ERROR_PREFIX = "AGY_ERROR:";
const AGY_PRINT_TIMEOUT_PREFIX = "[agy] print timeout";

export type AgyStderrIncident =
  | { kind: "error"; message: string; raw: string }
  | { kind: "print-timeout"; message: string; raw: string };

export interface AgyStderrSniffer {
  latest(): AgyStderrIncident | undefined;
  done(): Promise<void>;
}

// Reads `stderr` line by line and forwards each line unchanged via `forward`
// (so operators / logs see agy's own diagnostics untouched). The returned
// getter yields the highest-severity incident seen so far — a hard error
// always beats a print-timeout warning.
export function sniffAgyStderr(
  stderr: Readable,
  forward: (line: string) => void,
): AgyStderrSniffer {
  let latest: AgyStderrIncident | undefined;
  const rl = createInterface({ input: stderr, crlfDelay: Infinity });

  rl.on("line", (line) => {
    forward(line + "\n");
    if (line.startsWith(AGY_ERROR_PREFIX)) {
      const payload = line.slice(AGY_ERROR_PREFIX.length).trim();
      latest = {
        kind: "error",
        message:
          extractAgyErrorMessage(payload) ??
          "Antigravity CLI reported a terminal error",
        raw: line,
      };
      return;
    }
    // Downgrade to timeout only when nothing worse is already recorded — a
    // later timeout warning shouldn't erase an earlier hard error.
    if (line.startsWith(AGY_PRINT_TIMEOUT_PREFIX) && latest?.kind !== "error") {
      latest = { kind: "print-timeout", message: line.trim(), raw: line };
    }
  });

  const done = new Promise<void>((resolve) => {
    rl.once("close", () => resolve());
  });

  return {
    latest: () => latest,
    done: () => done,
  };
}

// Serialises the sniffed incident as a stream-json record our own
// parseJsonlEvent recognises (event: "result" with status: "ERROR"), so the
// synthesis ties back into the existing error-classification path without a
// second code path on the openclaw side.
export function serializeAgyIncidentAsResult(
  incident: AgyStderrIncident,
): string {
  const errorText =
    incident.kind === "error"
      ? incident.message
      : `agy returned partial output because --print-timeout expired mid-turn: ${incident.message}`;
  return JSON.stringify({
    event: "result",
    result: { status: "ERROR", error: errorText },
  });
}

function extractAgyErrorMessage(payload: string): string | undefined {
  const parsed = tryParseJsonRecord(payload);
  if (!parsed) return payload.trim() || undefined;

  // Prefer a human-readable message; fall back to the short_error stub the CLI
  // emits when the full payload couldn't be assembled.
  let message = "";
  for (const key of ["message", "error", "short_error", "detail"] as const) {
    const value = parsed[key];
    if (typeof value === "string" && value.trim()) {
      message = value.trim();
      break;
    }
  }

  const status: string[] = [];
  for (const [key, label] of [
    ["canonical_status", "status"],
    ["http_code", "http"],
    ["grpc_code", "grpc"],
    ["error_id", "id"],
  ] as const) {
    const value = parsed[key];
    if (value !== undefined && value !== null && value !== "") {
      status.push(`${label}=${String(value)}`);
    }
  }
  if (parsed.retryable === true) status.push("retryable=true");
  else if (parsed.retryable === false) status.push("retryable=false");

  if (!message && status.length === 0) return undefined;
  if (!message) return `Antigravity CLI reported a terminal error (${status.join(", ")})`;
  return status.length ? `${message} (${status.join(", ")})` : message;
}

function tryParseJsonRecord(payload: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}
