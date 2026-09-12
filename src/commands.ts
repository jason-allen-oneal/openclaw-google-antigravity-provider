// /antigravity slash command with a small subcommand tree.
//
// Registered via `api.registerCommand(...)`. Codex exposes a rich
// `openclaw codex …` surface; we keep this minimal — the value is
// letting the user run `/antigravity reset <id>` from any chat surface
// without dropping into a terminal for `openclaw sessions compact`
// gymnastics.

import fs from "node:fs";
import path from "node:path";
import type { OpenClawPluginCommandDefinition } from "openclaw/plugin-sdk/plugin-entry";
import { resolveAntigravityDataDir } from "./backend.js";
import {
  conversationSummaryLabel,
  readAntigravityConversationSummaries,
  summaryPrimaryCwd,
} from "./session-catalog-sources.js";

const HELP_LINES = [
  "/antigravity list [N]         — show the N most-recent agy conversations (default 10)",
  "/antigravity status <id>      — show size + step count for a conversation",
  "/antigravity reset <id>       — back up and drop the on-disk agy state so the next turn starts fresh",
  "/antigravity help             — this text",
];

export function buildAntigravityCommand(
  env: NodeJS.ProcessEnv = process.env,
): OpenClawPluginCommandDefinition {
  return {
    name: "antigravity",
    description: "Inspect and reset local agy conversation state",
    acceptsArgs: true,
    requireAuth: true,
    // Codex ships `agentPromptGuidance` to steer the model toward its
    // slash surface when the model would otherwise walk the owner
    // through a terminal recipe. Same pattern: the model should prefer
    // `/antigravity reset` over dictating `openclaw sessions compact`
    // when only agy's side of the context needs a reset.
    agentPromptGuidance: [
      {
        text: "When only the agy CLI backing state needs a reset (Gemini reports a huge cacheRead, or the sidebar shows an inflated context specifically for a google-antigravity-cli chat), prefer `/antigravity reset <conversationId>` over telling the owner to run `openclaw sessions compact --max-lines N`. The slash command backs up the on-disk agy SQLite and lets the catch-up hook re-seed recent turns; the openclaw transcript stays intact.",
        surfaces: ["openclaw_main"],
      },
      {
        text: "Use `/antigravity list` and `/antigravity status <id>` to inspect what's on disk before recommending a reset. Reserve `openclaw sessions compact` for cases where the openclaw side of the transcript is itself too large.",
        surfaces: ["openclaw_main"],
      },
    ],
    handler: async (ctx) => {
      const args = (ctx.args ?? "").trim();
      const [sub, ...rest] = args.split(/\s+/).filter(Boolean);
      const restStr = rest.join(" ").trim();
      const dataDir = resolveAntigravityDataDir(env);

      if (!sub || sub === "help") {
        return { text: HELP_LINES.join("\n") };
      }

      if (sub === "list") {
        const n = Number.parseInt(rest[0] ?? "10", 10);
        const limit = Number.isFinite(n) && n > 0 ? Math.min(n, 100) : 10;
        const all = readAntigravityConversationSummaries(dataDir);
        const rows = all
          .sort((a, b) => (b.lastModifiedMs ?? 0) - (a.lastModifiedMs ?? 0))
          .slice(0, limit);
        if (rows.length === 0) return { text: "No agy conversations recorded." };
        const lines = rows.map((r) => {
          const when = r.lastModifiedMs ? new Date(r.lastModifiedMs).toISOString() : "unknown";
          const cwd = summaryPrimaryCwd(r) ?? "";
          const cwdHint = cwd ? ` [${cwd}]` : "";
          return `• ${r.conversationId} — ${conversationSummaryLabel(r)} (${r.stepCount} steps, ${when})${cwdHint}`;
        });
        return {
          text: `agy conversations (${rows.length} of ${all.length}):\n${lines.join("\n")}`,
        };
      }

      if (sub === "status") {
        if (!restStr) return { text: "usage: /antigravity status <conversationId>" };
        const conversationId = restStr;
        const dbPath = path.join(dataDir, "conversations", `${conversationId}.db`);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(dbPath);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") return { text: `no agy state at ${dbPath}` };
          return {
            text: `cannot inspect ${dbPath}: ${(error as Error).message}`,
            isError: true,
          };
        }
        const summary = readAntigravityConversationSummaries(dataDir).find(
          (r) => r.conversationId === conversationId,
        );
        const label = summary ? conversationSummaryLabel(summary) : "(no summary row)";
        const steps = summary?.stepCount ?? 0;
        return {
          text: [
            `agy conversation ${conversationId}`,
            `  label: ${label}`,
            `  db:    ${dbPath}`,
            `  size:  ${(stat.size / 1_000_000).toFixed(2)} MB`,
            `  steps: ${steps}`,
          ].join("\n"),
        };
      }

      if (sub === "reset") {
        if (!restStr) return { text: "usage: /antigravity reset <conversationId>" };
        const conversationId = restStr;
        const dbPath = path.join(dataDir, "conversations", `${conversationId}.db`);
        if (!fs.existsSync(dbPath)) {
          return { text: `no agy state at ${dbPath} — already fresh` };
        }
        const backupPath = `${dbPath}.reset-${Date.now()}.bak`;
        fs.renameSync(dbPath, backupPath);
        return {
          text: [
            `Reset agy state for ${conversationId}.`,
            `Backup: ${backupPath}`,
            `The next turn will start a fresh agy conversation; the catch-up hook will re-seed the recent openclaw transcript.`,
          ].join("\n"),
        };
      }

      return {
        text: `unknown subcommand: ${sub}\n${HELP_LINES.join("\n")}`,
        isError: true,
      };
    },
  };
}
