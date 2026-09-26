import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  serializeAgyIncidentAsResult,
  sniffAgyStderr,
  type AgyStderrIncident,
} from "./agy-stderr-sniff.js";

// A helper that feeds `lines` through the sniffer as-if they arrived on a
// child's stderr and returns the final incident + everything the sniffer
// forwarded to stderr (so we can assert the forward path is byte-transparent).
async function runSniffer(lines: readonly string[]) {
  const forwarded: string[] = [];
  const stream = Readable.from(lines.map((line) => line + "\n"));
  const sniffer = sniffAgyStderr(stream, (chunk) => forwarded.push(chunk));
  await sniffer.done();
  return { incident: sniffer.latest(), forwarded };
}

describe("sniffAgyStderr", () => {
  it("passes through stderr verbatim when nothing terminal shows up", async () => {
    const { incident, forwarded } = await runSniffer([
      "some agy warning",
      "another log line",
    ]);
    expect(incident).toBeUndefined();
    expect(forwarded.join("")).toBe("some agy warning\nanother log line\n");
  });

  it("captures an AGY_ERROR line with a rich JSON payload", async () => {
    const payload = JSON.stringify({
      message: "quota exceeded for gemini-3.7-flash",
      canonical_status: "RESOURCE_EXHAUSTED",
      http_code: 429,
      retryable: true,
      error_id: "err_abc123",
    });
    const { incident, forwarded } = await runSniffer([
      "starting turn",
      `AGY_ERROR: ${payload}`,
    ]);
    expect(incident?.kind).toBe("error");
    expect(incident?.message).toBe(
      "quota exceeded for gemini-3.7-flash (status=RESOURCE_EXHAUSTED, http=429, id=err_abc123, retryable=true)",
    );
    // Forwarding must be transparent — an operator watching stderr sees exactly what agy wrote.
    expect(forwarded.join("")).toContain("AGY_ERROR: ");
    expect(forwarded.join("")).toContain(payload);
  });

  it("falls back to short_error when the full payload is missing", async () => {
    const { incident } = await runSniffer([
      'AGY_ERROR: {"short_error":"api unreachable"}',
    ]);
    expect(incident?.kind).toBe("error");
    expect(incident?.message).toBe("api unreachable");
  });

  it("treats non-JSON AGY_ERROR payloads as opaque error text", async () => {
    const { incident } = await runSniffer(["AGY_ERROR: something exploded"]);
    expect(incident?.kind).toBe("error");
    expect(incident?.message).toBe("something exploded");
  });

  it("falls back to a generic message when payload is JSON but empty", async () => {
    const { incident } = await runSniffer(["AGY_ERROR: {}"]);
    expect(incident?.kind).toBe("error");
    expect(incident?.message).toBe("Antigravity CLI reported a terminal error");
  });

  it("captures a print-timeout warning as a distinct incident kind", async () => {
    const { incident } = await runSniffer([
      "[agy] print timeout after 30m0s with turn in progress; returning partial output",
    ]);
    expect(incident?.kind).toBe("print-timeout");
    expect(incident?.message).toContain("print timeout");
  });

  it("prefers a later AGY_ERROR over an earlier print-timeout warning", async () => {
    const { incident } = await runSniffer([
      "[agy] print timeout after 30m0s with turn in progress; returning partial output",
      'AGY_ERROR: {"short_error":"backend down"}',
    ]);
    expect(incident?.kind).toBe("error");
    expect(incident?.message).toBe("backend down");
  });

  it("does not downgrade an earlier error when a print-timeout arrives later", async () => {
    const { incident } = await runSniffer([
      'AGY_ERROR: {"short_error":"first failure"}',
      "[agy] print timeout after 30m0s with turn in progress; returning partial output",
    ]);
    expect(incident?.kind).toBe("error");
    expect(incident?.message).toBe("first failure");
  });

  it("keeps only the most recent AGY_ERROR when several arrive", async () => {
    const { incident } = await runSniffer([
      'AGY_ERROR: {"short_error":"first"}',
      'AGY_ERROR: {"short_error":"second"}',
    ]);
    expect(incident?.kind).toBe("error");
    expect(incident?.message).toBe("second");
  });
});

describe("serializeAgyIncidentAsResult", () => {
  it("wraps a hard error as a stream-json ERROR result our parser recognises", () => {
    const incident: AgyStderrIncident = {
      kind: "error",
      message: "quota exceeded",
      raw: "AGY_ERROR: ...",
    };
    const line = serializeAgyIncidentAsResult(incident);
    // Must round-trip to the exact shape parseGoogleAntigravityJsonlEvent
    // recognises: event=result, result.status=ERROR, result.error=<message>.
    const parsed = JSON.parse(line);
    expect(parsed).toEqual({
      event: "result",
      result: { status: "ERROR", error: "quota exceeded" },
    });
  });

  it("annotates print-timeout incidents so the failure trail explains the cause", () => {
    const incident: AgyStderrIncident = {
      kind: "print-timeout",
      message: "[agy] print timeout after 30m0s",
      raw: "[agy] print timeout after 30m0s",
    };
    const parsed = JSON.parse(serializeAgyIncidentAsResult(incident));
    expect(parsed.event).toBe("result");
    expect(parsed.result.status).toBe("ERROR");
    expect(parsed.result.error).toContain("--print-timeout expired");
    expect(parsed.result.error).toContain("[agy] print timeout after 30m0s");
  });
});
