import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { iterProtobufTextFields } from "./session-catalog-protobuf.js";
import { decodeStepPayload } from "./session-catalog-decoder.js";

export type AntigravityConversationSummary = {
  readonly conversationId: string;
  readonly title: string;
  readonly preview: string;
  readonly stepCount: number;
  readonly lastModifiedMs?: number;
  readonly lastUserInputMs?: number;
  readonly workspaceUris: readonly string[];
  readonly status: string;
  readonly appDataDir: string;
  readonly killed: boolean;
};

// Matches openclaw's SessionCatalogTranscriptItem.type union so the mapper
// in session-catalog.ts can pass `kind` straight through as `type`.
export type AntigravityTranscriptItem = {
  readonly kind: "userMessage" | "agentMessage" | "reasoning" | "toolCall" | "toolResult" | "other";
  readonly text: string;
  readonly timestampMs?: number;
  readonly stepIndex?: number;
};

// Rows agy has never touched for a given field carry Go's zero-value time
// (`0001-01-01T00:00:00Z`). Its epoch offset is ~-62 trillion ms; the
// openclaw session-catalog UI runs `now - createdAt` and renders the delta
// as "X ago", so anything from year 1 AD blows the display up to "30965y
// ago". Reject anything older than a plausible cutoff so the caller can
// fall back or omit the field.
const MIN_VALID_TIMESTAMP_MS = Date.UTC(2000, 0, 1);
// agy writes Go's zero-value time as `0001-01-01 00:00:00+00:00`. Node's
// Date.parse silently reinterprets that non-ISO-strict form as `2001-01-01`
// (a legacy 2-digit-year quirk), so an epoch-only guard sails past. Match
// the raw string too.
const GO_ZERO_TIME_RE = /^000\d-01-01[ T]00:00:00/;

function parseSqliteDatetime(raw: unknown): number | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  if (GO_ZERO_TIME_RE.test(raw)) return undefined;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return undefined;
  if (ms < MIN_VALID_TIMESTAMP_MS) return undefined;
  return ms;
}

function parseWorkspaceUris(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  const trimmed = raw.trim();
  // The column is a JSON array most of the time, occasionally a bare string.
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === "string" && v.length > 0);
    }
    if (typeof parsed === "string" && parsed.length > 0) return [parsed];
  } catch {
    if (trimmed.startsWith("file://")) return [trimmed];
  }
  return [];
}

// Open the shared conversation_summaries.db read-only and return every row
// as a normalized summary. This is the sidebar's data source.
export function readAntigravityConversationSummaries(
  dataDir: string,
): AntigravityConversationSummary[] {
  const summariesPath = path.join(dataDir, "conversation_summaries.db");
  if (!fs.existsSync(summariesPath)) return [];
  const db = new DatabaseSync(summariesPath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `
        SELECT
          conversation_id, title, preview, step_count,
          last_modified_time, last_user_input_time,
          workspace_uris, status, app_data_dir, killed
        FROM conversation_summaries
        ORDER BY last_modified_time DESC
      `,
      )
      .all() as ReadonlyArray<Record<string, unknown>>;
    const out: AntigravityConversationSummary[] = [];
    for (const row of rows) {
      const conversationId =
        typeof row.conversation_id === "string" ? row.conversation_id.trim() : "";
      if (!conversationId) continue;
      out.push({
        conversationId,
        title: typeof row.title === "string" ? row.title : "",
        preview: typeof row.preview === "string" ? row.preview : "",
        stepCount: typeof row.step_count === "number" ? row.step_count : 0,
        lastModifiedMs: parseSqliteDatetime(row.last_modified_time),
        lastUserInputMs: parseSqliteDatetime(row.last_user_input_time),
        workspaceUris: parseWorkspaceUris(row.workspace_uris),
        status: typeof row.status === "string" ? row.status : "",
        appDataDir: typeof row.app_data_dir === "string" ? row.app_data_dir : "",
        killed: Boolean(row.killed),
      });
    }
    return out;
  } finally {
    db.close();
  }
}

export function conversationSummaryLabel(summary: AntigravityConversationSummary): string {
  const cleanTitle = summary.title.trim();
  if (cleanTitle) return cleanTitle;
  const previewFirstLine = summary.preview.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const stripped = previewFirstLine.replace(/^Conversation Title:\s*/i, "").trim();
  if (stripped) return stripped;
  return summary.conversationId.slice(0, 8);
}

export function summaryPrimaryCwd(
  summary: AntigravityConversationSummary,
): string | undefined {
  const first = summary.workspaceUris[0];
  if (!first) return undefined;
  if (!first.startsWith("file://")) return first;
  // fileURLToPath is platform-native: on Windows it yields `C:\\Users\\...`
  // and `\\\\server\\share`, where hand-decoding `url.pathname` yields
  // `/C:/Users/...` and silently drops the UNC host.
  try {
    return fileURLToPath(first);
  } catch {
    // Rejected as a local path (e.g. a UNC host seen on a POSIX host, which
    // fileURLToPath refuses). Keep the host so the value stays recognizable.
    try {
      const url = new URL(first);
      const decoded = decodeURIComponent(url.pathname);
      return url.hostname ? `//${url.hostname}${decoded}` : decoded || first;
    } catch {
      return first;
    }
  }
}

// history.jsonl carries the clean human-typed prompt for every turn. The
// per-conversation `.db` step blobs only encode assistant/tool activity in
// their opaque protobuf, so the user's original message is best sourced
// from this file. Each JSONL row is
//   {"display": "<text>", "timestamp": <ms>, "workspace": "<path>",
//    "conversationId"?: "<uuid>"}.
// Older rows omit conversationId; those are matched to the "root" of a
// workspace and skipped here.
type HistoryPrompt = {
  readonly conversationId: string;
  readonly text: string;
  readonly timestampMs?: number;
};

async function readHistoryFile(historyPath: string): Promise<HistoryPrompt[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(historyPath, "utf8");
  } catch {
    return [];
  }
  const out: HistoryPrompt[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !line.startsWith("{")) continue;
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== "object") continue;
    const conversationId =
      typeof record.conversationId === "string" ? record.conversationId.trim() : "";
    const display = typeof record.display === "string" ? record.display : "";
    if (!conversationId || !display) continue;
    const timestamp =
      typeof record.timestamp === "number" && Number.isFinite(record.timestamp)
        ? record.timestamp
        : undefined;
    out.push({ conversationId, text: display, ...(timestamp ? { timestampMs: timestamp } : {}) });
  }
  return out;
}

export type StepBlobKind = "step_payload" | "render_info" | "metadata";

export type StepBlobText = {
  readonly stepIndex: number;
  readonly kind: StepBlobKind;
  readonly text: string;
};

// The schemaless protobuf walker surfaces every text-like field in a
// step blob — including field tags, tool/hook names, bot ids, UUIDs and
// filesystem paths that the sidebar would show as garbage. Real transcript
// text ("Hello! How can I help you today?", "[Notice] All your subagents
// have been stopped …") always contains a space between words; the noise
// almost never does. Use "has a space between letters" as the primary
// positive signal, with pattern-based rejects for the remaining cases.
const CONTROL_MARKER_RE = /<<<[A-Z_]+>>>/;
const TOOL_CALL_FRAME_RE = /^[a-z][a-z0-9_]*\([^)]{0,60}\)$/;
const SNAKE_CASE_IDENT_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
const BOT_ID_RE = /^bot-[0-9a-f-]{16,}$/i;
const UUID_CHAIN_RE = /^[$"\s]*[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}([$"\s]+[0-9a-fA-F-]{8,})*[$"\s]*$/;

// Strip leading protobuf tag / length bytes that the walker leaked into the
// decoded string — they render as control glyphs in the UI and defeat
// deduplication (`\x12\x0euser_information` ≠ `user_information`).
function stripBinaryPrefix(text: string): string {
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    // Keep normal whitespace; drop anything else below the printable range.
    if (code === 0x09 || code === 0x0a || code === 0x0d) break;
    if (code >= 0x20) break;
    i += 1;
  }
  return i > 0 ? text.slice(i) : text;
}

// Reject the specific string shapes the walker surfaces that a reader
// would recognize as agy internals rather than dialog.
export function looksLikeTranscriptNoise(text: string): boolean {
  if (CONTROL_MARKER_RE.test(text)) return true;
  if (TOOL_CALL_FRAME_RE.test(text)) return true;
  if (SNAKE_CASE_IDENT_RE.test(text)) return true;
  if (BOT_ID_RE.test(text)) return true;
  if (UUID_CHAIN_RE.test(text)) return true;
  // Pure hex / base64-ish blobs, negative int64 ids, path-only entries.
  if (/^[0-9a-fA-F-]{32,}$/.test(text)) return true;
  if (/^-?\d{10,}$/.test(text)) return true;
  if (/^\/[A-Za-z_.-][^\s]*$/.test(text)) return true;
  // Any embedded control byte (outside tab/newline/CR) means the walker
  // picked up a proto tag or length prefix inside a real string.
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) return true;
  // Real dialog always has a space between two letters somewhere. Base64
  // tokens, identifiers, packed proto fields and paths never do.
  if (!/[A-Za-z][^\S\n\r]+[A-Za-z]/.test(text)) return true;
  return false;
}

function walkStepBlob(blob: Uint8Array, kind: StepBlobKind, stepIndex: number): StepBlobText[] {
  const candidates = new Set<string>();
  for (const text of iterProtobufTextFields(blob, { minLength: 16 })) {
    const cleaned = stripBinaryPrefix(text).trim();
    if (!cleaned) continue;
    if (looksLikeTranscriptNoise(cleaned)) continue;
    candidates.add(cleaned);
  }
  // Prefer the shortest clean form: if `X` contains a shorter `Y` we already
  // kept, drop `X` — it's the same content plus a leaked proto tag or id
  // suffix. Iterating shortest-first keeps `Y` and evicts the wrappers.
  const sorted = Array.from(candidates).sort((a, b) => a.length - b.length);
  const kept: string[] = [];
  for (const s of sorted) {
    if (kept.some((k) => s.includes(k))) continue;
    kept.push(s);
  }
  return kept.map((text) => ({ stepIndex, kind, text }));
}

// Compact display for a decoded tool call. Codex/claude sidebars render
// tool calls as `name(args)` on one line with the human-readable summary
// underneath; keep the same shape so the agy transcript sits next to
// theirs without visual drift.
function formatToolCallText(name: string, args?: string, summary?: string): string {
  const argPreview = summarizeArgs(args);
  const head = argPreview ? `${name}(${argPreview})` : `${name}()`;
  return summary && summary !== name ? `${head}\n${summary}` : head;
}

function summarizeArgs(raw?: string): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  // agy's args field is JSON in practice. Prefer the "main" argument
  // (CommandLine / TargetFile / AbsolutePath / DirectoryPath / Query).
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      for (const key of [
        "CommandLine", "TargetFile", "AbsolutePath", "DirectoryPath",
        "Query", "Url", "url", "path", "file",
      ]) {
        const v = (parsed as Record<string, unknown>)[key];
        if (typeof v === "string" && v.length > 0) {
          return v.length > 80 ? `${v.slice(0, 77)}...` : v;
        }
      }
    }
  } catch {
    // fall through — non-JSON args (a raw shell command, for instance)
  }
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
}

// Best-effort transcript reconstruction. Combines the user prompts from
// history.jsonl with the schemaless protobuf text extraction of the
// conversation's step BLOBs, ordered by step index. Returned items are
// suitable for a `SessionsCatalogReadResult.items[]` array.
export async function readAntigravityConversationTranscript(params: {
  readonly dataDir: string;
  readonly conversationId: string;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}): Promise<AntigravityTranscriptItem[]> {
  const { dataDir, conversationId, limit, signal } = params;
  const dbPath = path.join(dataDir, "conversations", `${conversationId}.db`);
  const historyPath = path.join(dataDir, "history.jsonl");

  const userPrompts = (await readHistoryFile(historyPath)).filter(
    (row) => row.conversationId === conversationId,
  );

  const merged: AntigravityTranscriptItem[] = [];
  let sawDecodedUser = false;
  if (fs.existsSync(dbPath)) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db
        .prepare(
          `SELECT idx, step_payload, render_info, metadata
           FROM steps
           ORDER BY idx ASC`,
        )
        .all() as ReadonlyArray<Record<string, unknown>>;
      for (const row of rows) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const idx = typeof row.idx === "number" ? row.idx : 0;
        const payload = row.step_payload instanceof Uint8Array ? row.step_payload : undefined;
        const render = row.render_info instanceof Uint8Array ? row.render_info : undefined;
        const meta = row.metadata instanceof Uint8Array ? row.metadata : undefined;

        // Prefer the structured decoder — it knows agy's cortex_pb field
        // numbers for user turns, agent turns, tool calls and system
        // notices, so it emits clean typed items instead of raw strings.
        const decoded = payload ? decodeStepPayload(payload, idx) : undefined;
        if (decoded) {
          const ts =
            "timestampMs" in decoded && decoded.timestampMs !== undefined
              ? { timestampMs: decoded.timestampMs }
              : {};
          if (decoded.kind === "userMessage") {
            merged.push({ kind: "userMessage", text: decoded.text, stepIndex: idx, ...ts });
            sawDecodedUser = true;
          } else if (decoded.kind === "agentMessage") {
            merged.push({ kind: "agentMessage", text: decoded.text, stepIndex: idx, ...ts });
          } else if (decoded.kind === "toolCall") {
            merged.push({
              kind: "toolCall",
              text: formatToolCallText(decoded.toolName, decoded.args, decoded.summary),
              stepIndex: idx,
              ...ts,
            });
            if (decoded.output) {
              merged.push({ kind: "toolResult", text: decoded.output, stepIndex: idx, ...ts });
            }
          } else if (decoded.kind === "systemNotice") {
            const prefix = decoded.summary ? `${decoded.summary}\n\n` : "";
            merged.push({ kind: "other", text: prefix + decoded.text, stepIndex: idx, ...ts });
          }
          // decoded.kind === "empty" → consumed but silent; do NOT walk.
          continue;
        }

        // Unknown step_type — surface any prose the schemaless walker
        // finds so exotic step kinds still show *something*.
        for (const source of [
          { blob: payload, kind: "step_payload" as const },
          { blob: render, kind: "render_info" as const },
          { blob: meta, kind: "metadata" as const },
        ]) {
          if (!source.blob) continue;
          for (const item of walkStepBlob(source.blob, source.kind, idx)) {
            merged.push({ kind: "other", text: item.text, stepIndex: idx });
          }
        }
      }
    } finally {
      db.close();
    }
  }

  // history.jsonl carries the clean user prompt with a timestamp. Only fall
  // back to it when the structured decoder didn't already yield user turns
  // (e.g., corrupted db or a conversation from an older agy version).
  // Prepended in oldest-first order so the transcript still reads
  // chronologically.
  if (!sawDecodedUser) {
    const promptsSorted = userPrompts
      .slice()
      .sort((a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0));
    const historyItems: AntigravityTranscriptItem[] = promptsSorted.map((p) => ({
      kind: "userMessage",
      text: p.text,
      ...(p.timestampMs !== undefined ? { timestampMs: p.timestampMs } : {}),
    }));
    merged.unshift(...historyItems);
  }

  // openclaw's sidebar displays items[0] at the bottom (its own render
  // path renders the array top-down, but the scroll frame flips visually
  // so the last item ends up at the top of the pane). Handing it a
  // chronological array shows oldest-at-bottom / latest-at-top which
  // reads inverted; reverse to newest-first so the pane matches the
  // standard chat convention (oldest at top, latest at bottom). If a
  // `limit` is set, keep the most-recent N.
  merged.reverse();
  return typeof limit === "number" ? merged.slice(0, limit) : merged;
}
