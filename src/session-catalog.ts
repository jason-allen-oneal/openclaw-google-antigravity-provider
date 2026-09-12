// Registers a SessionCatalogProvider that surfaces existing agy
// conversations in OpenClaw's sidebar and reads their transcripts.
//
// Read-only integration: we never mutate agy's data directory. `archive`,
// rename, delete are intentionally omitted. Continue is supported by
// binding the openclaw session to the conversation id; the existing CLI
// backend resumes via `agy --conversation <id>`.

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type {
  SessionCatalogContinueProviderParams,
  SessionCatalogContinueProviderResult,
  SessionCatalogListProviderParams,
  SessionCatalogProvider,
  SessionCatalogReadProviderParams,
} from "openclaw/plugin-sdk/session-catalog";
import { resolveAntigravityDataDir } from "./backend.js";

// The gateway-protocol schema types (LocalSessionCatalogHost, LocalSessionsCatalogReadResult)
// aren't re-exported from a public plugin-sdk subpath in 2026.8.1, so we
// declare structural equivalents locally — the SDK validates the returned
// values against the schema, this only exists to keep this file type-safe.
type LocalSessionCatalogHost = {
  hostId: string;
  label: string;
  kind: "gateway" | "node";
  connected: boolean;
  canStartTerminal?: boolean;
  sessions: Array<LocalSessionEntry>;
  nextCursor?: string;
  error?: { code: string; message: string };
};
type LocalSessionEntry = {
  threadId: string;
  name?: string;
  cwd?: string;
  status: string;
  createdAt?: number;
  updatedAt?: number;
  recencyAt?: number;
  source?: string;
  modelProvider?: string;
  customGroup?: string;
  archived: boolean;
  canContinue: boolean;
  canArchive: boolean;
  canOpenTerminal?: boolean;
};
type LocalTranscriptItem = {
  type: "userMessage" | "agentMessage" | "reasoning" | "toolCall" | "toolResult" | "other";
  text?: string;
  timestamp?: string;
  truncated?: boolean;
};
type LocalSessionsCatalogReadResult = {
  hostId: string;
  label?: string;
  threadId: string;
  items: LocalTranscriptItem[];
  nextCursor?: string;
};
import {
  conversationSummaryLabel,
  readAntigravityConversationSummaries,
  readAntigravityConversationTranscript,
  summaryPrimaryCwd,
  type AntigravityConversationSummary,
} from "./session-catalog-sources.js";

export const ANTIGRAVITY_SESSION_CATALOG_ID = "google-antigravity-cli";
export const ANTIGRAVITY_SESSION_HOST_ID = "google-antigravity-cli-local";
const SESSION_KEY_PREFIX = "harness:google-antigravity-cli:";
const READ_ITEM_TEXT_CAP = 4_000;
const READ_DEFAULT_LIMIT = 200;
const SEARCH_MAX_ROWS = 200;

function normalizeSearch(raw?: string): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

function matchesSearch(summary: AntigravityConversationSummary, search: string): boolean {
  if (!search) return true;
  const haystack = [
    summary.title,
    summary.preview,
    summary.conversationId,
    ...summary.workspaceUris,
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(search);
}

function summaryToSessionEntry(
  summary: AntigravityConversationSummary,
): LocalSessionEntry {
  const label = conversationSummaryLabel(summary);
  const cwd = summaryPrimaryCwd(summary);
  const updated = summary.lastModifiedMs;
  const created = summary.lastUserInputMs ?? summary.lastModifiedMs;
  const status = summary.killed ? "archived" : "idle";
  return {
    threadId: summary.conversationId,
    name: label,
    cwd,
    status,
    createdAt: created,
    updatedAt: updated,
    recencyAt: summary.lastUserInputMs ?? summary.lastModifiedMs,
    source: "agy",
    modelProvider: ANTIGRAVITY_SESSION_CATALOG_ID,
    archived: summary.killed,
    canContinue: !summary.killed,
    canArchive: false,
    canOpenTerminal: false,
    customGroup: summary.appDataDir || undefined,
  };
}

function buildLocalHost(
  sessions: LocalSessionEntry[],
  nextCursor?: string,
): LocalSessionCatalogHost {
  return {
    hostId: ANTIGRAVITY_SESSION_HOST_ID,
    label: "Antigravity (local)",
    kind: "gateway",
    connected: true,
    canStartTerminal: false,
    sessions,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

function truncateForItem(text: string): { text: string; truncated: boolean } {
  if (text.length <= READ_ITEM_TEXT_CAP) return { text, truncated: false };
  return { text: `${text.slice(0, READ_ITEM_TEXT_CAP)}\n… (truncated)`, truncated: true };
}

function iso(ms?: number): string | undefined {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return undefined;
  try {
    return new Date(ms).toISOString();
  } catch {
    return undefined;
  }
}

export function sessionKeyForConversation(conversationId: string): string {
  return `${SESSION_KEY_PREFIX}${conversationId}`;
}

export function conversationIdFromSessionKey(sessionKey: string): string | undefined {
  if (!sessionKey.startsWith(SESSION_KEY_PREFIX)) return undefined;
  return sessionKey.slice(SESSION_KEY_PREFIX.length) || undefined;
}

export function buildAntigravitySessionCatalog(params?: {
  env?: NodeJS.ProcessEnv;
  dataDir?: string;
}): SessionCatalogProvider {
  const dataDir =
    params?.dataDir ?? resolveAntigravityDataDir(params?.env ?? process.env);

  const list = async (
    listParams: SessionCatalogListProviderParams,
  ): Promise<LocalSessionCatalogHost[]> => {
    const search = normalizeSearch(listParams.search);
    const limit = Math.max(1, Math.min(listParams.limitPerHost ?? SEARCH_MAX_ROWS, SEARCH_MAX_ROWS));
    let summaries: AntigravityConversationSummary[];
    try {
      summaries = readAntigravityConversationSummaries(dataDir);
    } catch (error) {
      return [
        {
          hostId: ANTIGRAVITY_SESSION_HOST_ID,
          label: "Antigravity (local)",
          kind: "gateway",
          connected: false,
          sessions: [],
          error: {
            code: "read_failed",
            message: `Cannot read Antigravity conversation summaries: ${(error as Error).message}`,
          },
        },
      ];
    }
    const filtered = summaries.filter((summary) => matchesSearch(summary, search));
    const sessions = filtered.slice(0, limit).map((summary) => summaryToSessionEntry(summary));
    const host = buildLocalHost(sessions);
    listParams.onHost?.(host);
    return [host];
  };

  const read = async (
    readParams: SessionCatalogReadProviderParams,
  ): Promise<LocalSessionsCatalogReadResult> => {
    const conversationId = readParams.threadId?.trim();
    if (!conversationId) {
      return {
        hostId: ANTIGRAVITY_SESSION_HOST_ID,
        threadId: "",
        items: [],
      };
    }
    const limit = Math.max(1, Math.min(readParams.limit ?? READ_DEFAULT_LIMIT, 1000));
    try {
      const transcript = await readAntigravityConversationTranscript({
        dataDir,
        conversationId,
        limit,
      });
      const items = transcript.map((item) => {
        const trimmed = truncateForItem(item.text);
        const base = {
          type: item.kind,
          text: trimmed.text,
          ...(trimmed.truncated ? { truncated: true } : {}),
        } as LocalTranscriptItem;
        const ts = iso(item.timestampMs);
        return ts ? { ...base, timestamp: ts } : base;
      });
      return {
        hostId: ANTIGRAVITY_SESSION_HOST_ID,
        label: "Antigravity (local)",
        threadId: conversationId,
        items,
      };
    } catch (error) {
      return {
        hostId: ANTIGRAVITY_SESSION_HOST_ID,
        threadId: conversationId,
        items: [
          {
            type: "other",
            text: `Failed to read agy transcript: ${(error as Error).message}`,
          },
        ],
      };
    }
  };

  const continueSession = async (
    continueParams: SessionCatalogContinueProviderParams,
  ): Promise<SessionCatalogContinueProviderResult> => {
    const conversationId = continueParams.threadId?.trim();
    if (!conversationId) {
      throw new Error("google-antigravity-cli: continue requires a conversation id");
    }
    const sessionKey = sessionKeyForConversation(conversationId);
    return {
      sessionKey,
      conversationBinding: {
        summary: `Resume Antigravity conversation ${conversationId.slice(0, 8)}…`,
        detachHint:
          "Detaching will leave the agy conversation on disk; use `agy --conversation " +
          conversationId +
          "` to resume from the CLI.",
        data: {
          antigravity: {
            conversationId,
            dataDir,
          },
        },
      },
    };
  };

  // Cross-runtime import: openclaw seeds a fresh Gateway session with
  // this catalog's transcript (fetched via the `read` above) so the user
  // can continue in any model/provider available in openclaw — including
  // ones agy itself cannot route to. Our contribution is the display hint;
  // openclaw drives the transcript-import handshake automatically.
  const copyToGatewaySession = async (
    copyParams: SessionCatalogContinueProviderParams,
  ): Promise<{ displayName?: string; preferredModel?: string }> => {
    const conversationId = copyParams.threadId?.trim();
    if (!conversationId) {
      throw new Error("google-antigravity-cli: copy requires a conversation id");
    }
    let displayName: string | undefined;
    try {
      const summaries = readAntigravityConversationSummaries(dataDir);
      const summary = summaries.find((row) => row.conversationId === conversationId);
      if (summary) displayName = conversationSummaryLabel(summary);
    } catch {
      // Missing/unreadable summaries are non-fatal; the caller uses a
      // generic default when displayName is absent.
    }
    return displayName ? { displayName } : {};
  };

  return {
    id: ANTIGRAVITY_SESSION_CATALOG_ID,
    label: "Antigravity CLI",
    list,
    read,
    continueSession,
    copyToGatewaySession,
  } as SessionCatalogProvider;
}

export function registerAntigravitySessionCatalog(
  api: OpenClawPluginApi,
  options?: { env?: NodeJS.ProcessEnv; dataDir?: string },
): void {
  // Mirror codex's `sessionCatalog.enabled` toggle so users can turn the
  // native discovery off without losing the provider / CLI backend /
  // slash command. Defaults to enabled; users who set it to `false`
  // explicitly opt out.
  const pluginConfig =
    (api as { pluginConfig?: Record<string, unknown> }).pluginConfig ?? undefined;
  const sessionCatalog = pluginConfig?.sessionCatalog as
    | { enabled?: boolean }
    | undefined;
  if (sessionCatalog?.enabled === false) return;
  api.registerSessionCatalog({
    // The catalog reads the user's Antigravity store even when OpenClaw is
    // running with an isolated process HOME. The provider supplies an
    // explicit dataDir when configured; this declaration tells the loader it
    // will not fall back to the isolated process HOME implicitly.
    supportsProcessHomeIsolation: true,
    ...buildAntigravitySessionCatalog(options),
  });
}

// Aliases used by the CLI backend to check whether a session key came
// from this catalog (so backend.prepareExecution can pull the
// conversationId out and pass `--conversation` to agy).
export function isAntigravitySessionKey(sessionKey: string): boolean {
  return sessionKey.startsWith(SESSION_KEY_PREFIX);
}

// Small helper exposed for src/backend.ts and future tooling.
export function extractConversationBindingData(
  data: unknown,
): { conversationId?: string; dataDir?: string } | undefined {
  if (!data || typeof data !== "object") return undefined;
  const container = (data as Record<string, unknown>).antigravity;
  if (!container || typeof container !== "object") return undefined;
  const record = container as Record<string, unknown>;
  const conversationId =
    typeof record.conversationId === "string" ? record.conversationId : undefined;
  const dataDir = typeof record.dataDir === "string" ? record.dataDir : undefined;
  return { conversationId, dataDir };
}
