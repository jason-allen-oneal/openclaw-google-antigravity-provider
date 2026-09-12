// Custom transcript-tools for the google-antigravity-cli plugin.
//
// Registered via `api.registerTool(factory, { names })` from index.ts.
// Codex ships seven of these; we ship three — the ones that are useful
// without an app-server: read agy's on-disk conversation catalog, get a
// specific transcript, and forcibly drop the CLI binding for the
// current turn so the next agy invocation starts a fresh conversation
// (the resume-guard cap does this automatically for oversized dbs, but
// a user may want to trigger it explicitly).

import fsp from "node:fs/promises";
import path from "node:path";
import type {
  AnyAgentTool,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolveAntigravityDataDir } from "./backend.js";
import {
  conversationSummaryLabel,
  readAntigravityConversationSummaries,
  readAntigravityConversationTranscript,
  summaryPrimaryCwd,
  type AntigravityConversationSummary,
} from "./session-catalog-sources.js";

// Plain JSON-schema literals rather than a typebox import. The plugin
// runtime loader doesn't hoist arbitrary transitive deps out of
// openclaw's node_modules, so importing `typebox` here throws
// `Cannot find module 'typebox'` at plugin load time and takes the
// whole plugin down with it (provider, session catalog, everything).
// `openclaw/plugin-sdk` accepts any TSchema-shaped object — the
// literals below match what `Type.Object(...)` would produce.
type SchemaLiteral = Record<string, unknown>;
const ListParams: SchemaLiteral = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 100 },
    search: { type: "string", maxLength: 200 },
  },
};
type ListParamsType = { limit?: number; search?: string };

const ReadParams: SchemaLiteral = {
  type: "object",
  additionalProperties: false,
  required: ["conversationId"],
  properties: {
    conversationId: { type: "string", minLength: 8, maxLength: 64 },
    limit: { type: "integer", minimum: 1, maximum: 500 },
  },
};
type ReadParamsType = { conversationId: string; limit?: number };

const ResetParams: SchemaLiteral = {
  type: "object",
  additionalProperties: false,
  required: ["conversationId"],
  properties: {
    conversationId: { type: "string", minLength: 8, maxLength: 64 },
  },
};
type ResetParamsType = { conversationId: string };

function jsonResult<T>(details: T): {
  content: Array<{ type: "text"; text: string }>;
  details: T;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
    details,
  };
}

function summariseSummary(row: AntigravityConversationSummary) {
  return {
    conversationId: row.conversationId,
    label: conversationSummaryLabel(row),
    cwd: summaryPrimaryCwd(row),
    stepCount: row.stepCount,
    status: row.status,
    lastModifiedMs: row.lastModifiedMs,
    lastUserInputMs: row.lastUserInputMs,
    killed: row.killed,
  };
}

// Matches openclaw's approach: `list` and `read` are safe for any
// requester (they only read agy's own state); `reset_binding` mutates
// on-disk state and is owner-only. Returning [] from the factory
// suppresses registration for that context.
function isOwner(ctx: OpenClawPluginToolContext): boolean {
  return ctx.senderIsOwner === true;
}

export function createAntigravityTools(
  ctx: OpenClawPluginToolContext,
  env: NodeJS.ProcessEnv = process.env,
): AnyAgentTool[] {
  const dataDir = resolveAntigravityDataDir(env);

  const listTool: AnyAgentTool = {
    name: "antigravity_conversations_list",
    label: "Antigravity Conversations",
    description:
      "List agy conversations from ~/.gemini/antigravity-cli/conversation_summaries.db. Newest first. Optional `search` matches title, preview, id or workspace path.",
    parameters: ListParams,
    execute: async (_id, rawParams) => {
      const params = (rawParams ?? {}) as ListParamsType;
      const limit = params.limit ?? 20;
      const search = params.search?.trim().toLowerCase() ?? "";
      const all = readAntigravityConversationSummaries(dataDir);
      const filtered = search
        ? all.filter((row) => {
            const hay = [row.title, row.preview, row.conversationId, ...row.workspaceUris]
              .join(" ")
              .toLowerCase();
            return hay.includes(search);
          })
        : all;
      const rows = filtered
        .sort((a, b) => (b.lastModifiedMs ?? 0) - (a.lastModifiedMs ?? 0))
        .slice(0, limit)
        .map(summariseSummary);
      return jsonResult({
        summary: `agy conversations: ${rows.length} of ${all.length}`,
        conversations: rows,
      });
    },
  };

  const readTool: AnyAgentTool = {
    name: "antigravity_conversation_read",
    label: "Antigravity Conversation Read",
    description:
      "Read one agy conversation's transcript. Returns typed items (userMessage, agentMessage, toolCall, toolResult, other) — the same shape openclaw's sidebar renders, decoded from agy's SQLite step_payload protobuf.",
    parameters: ReadParams,
    execute: async (_id, rawParams) => {
      const params = rawParams as ReadParamsType;
      const conversationId = params.conversationId.trim();
      if (!conversationId) throw new Error("conversationId is required");
      const items = await readAntigravityConversationTranscript({
        dataDir,
        conversationId,
        limit: params.limit ?? 200,
      });
      return jsonResult({
        summary: `agy transcript: ${items.length} items from ${conversationId}`,
        conversationId,
        items,
      });
    },
  };

  const resetTool: AnyAgentTool = {
    name: "antigravity_reset_binding",
    label: "Antigravity Reset Binding",
    description:
      "Force agy to start a fresh conversation on its next turn by backing up (renaming) the on-disk SQLite for the named conversation. The catch-up hook re-seeds the recent openclaw transcript, so the user-visible chat continues without a break. The backup keeps the old state recoverable.",
    parameters: ResetParams,
    execute: async (_id, rawParams) => {
      if (!isOwner(ctx)) {
        throw new Error("antigravity_reset_binding requires owner context");
      }
      const params = rawParams as ResetParamsType;
      const conversationId = params.conversationId.trim();
      if (!conversationId) throw new Error("conversationId is required");
      const dbPath = path.join(dataDir, "conversations", `${conversationId}.db`);
      const backupPath = `${dbPath}.reset-${Date.now()}.bak`;
      try {
        await fsp.rename(dbPath, backupPath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          return jsonResult({
            summary: `no agy state for ${conversationId} — already fresh`,
            conversationId,
            reset: false,
          });
        }
        throw error;
      }
      return jsonResult({
        summary: `agy state for ${conversationId} moved to ${backupPath}; next turn will start a fresh conversation`,
        conversationId,
        reset: true,
        backupPath,
      });
    },
  };

  return [listTool, readTool, resetTool];
}

// Exported factory suitable for `api.registerTool(...)`.
export function antigravityToolsFactory(
  env: NodeJS.ProcessEnv = process.env,
): OpenClawPluginToolFactory {
  return (ctx) => createAntigravityTools(ctx, env);
}
