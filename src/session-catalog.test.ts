import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildAntigravitySessionCatalog,
  conversationIdFromSessionKey,
  isAntigravitySessionKey,
  sessionKeyForConversation,
} from "./session-catalog.js";
import { looksLikeTranscriptNoise } from "./session-catalog-sources.js";

function makeTempDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-catalog-test-"));
}

function seedSummariesDb(
  dataDir: string,
  rows: ReadonlyArray<{
    conversationId: string;
    title?: string;
    preview?: string;
    stepCount?: number;
    workspaceUris?: string[];
    lastModified?: string;
    lastUserInput?: string;
    status?: string;
    killed?: boolean;
    appDataDir?: string;
  }>,
) {
  const dbPath = path.join(dataDir, "conversation_summaries.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT "",
      preview TEXT NOT NULL DEFAULT "",
      step_count INTEGER NOT NULL DEFAULT 0,
      last_modified_time DATETIME NOT NULL,
      workspace_uris TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT "",
      source TEXT NOT NULL DEFAULT "",
      project_id TEXT NOT NULL DEFAULT "",
      agent_name TEXT NOT NULL DEFAULT "",
      parent_conversation_id TEXT NOT NULL DEFAULT "",
      nesting_depth INTEGER NOT NULL DEFAULT 0,
      battle_id TEXT NOT NULL DEFAULT "",
      winning_conversation_id TEXT NOT NULL DEFAULT "",
      not_fully_idle NUMERIC NOT NULL DEFAULT false,
      killed NUMERIC NOT NULL DEFAULT false,
      last_user_input_time DATETIME NOT NULL,
      last_user_input_step_index INTEGER NOT NULL DEFAULT -1,
      app_data_dir TEXT NOT NULL DEFAULT ""
    )
  `);
  const stmt = db.prepare(
    `INSERT INTO conversation_summaries (
        conversation_id, title, preview, step_count,
        last_modified_time, workspace_uris, status,
        killed, last_user_input_time, app_data_dir
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    stmt.run(
      row.conversationId,
      row.title ?? "",
      row.preview ?? "",
      row.stepCount ?? 0,
      row.lastModified ?? "2026-09-01T00:00:00Z",
      JSON.stringify(row.workspaceUris ?? []),
      row.status ?? "",
      row.killed ? 1 : 0,
      row.lastUserInput ?? row.lastModified ?? "2026-09-01T00:00:00Z",
      row.appDataDir ?? "antigravity-cli",
    );
  }
  db.close();
}

async function seedHistory(
  dataDir: string,
  rows: ReadonlyArray<{ conversationId: string; display: string; timestamp: number }>,
) {
  const historyPath = path.join(dataDir, "history.jsonl");
  const lines = rows
    .map((row) =>
      JSON.stringify({
        display: row.display,
        timestamp: row.timestamp,
        workspace: "/tmp",
        conversationId: row.conversationId,
      }),
    )
    .join("\n");
  await fsp.writeFile(historyPath, lines + "\n", "utf8");
}

describe("session key helpers", () => {
  it("round-trips", () => {
    const id = "1712cb0a-9d94-4bd0-9db5-99f95702ba9f";
    const key = sessionKeyForConversation(id);
    expect(isAntigravitySessionKey(key)).toBe(true);
    expect(conversationIdFromSessionKey(key)).toBe(id);
  });

  it("rejects unrelated keys", () => {
    expect(isAntigravitySessionKey("harness:codex:abc")).toBe(false);
    expect(conversationIdFromSessionKey("harness:codex:abc")).toBeUndefined();
  });
});

describe("looksLikeTranscriptNoise", () => {
  it("rejects openclaw internal control markers leaked from proto blobs", () => {
    expect(looksLikeTranscriptNoise("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>")).toBe(true);
    expect(looksLikeTranscriptNoise("<<<END_OPENCLAW_INTERNAL_CONTEXT>>>")).toBe(true);
  });

  it("rejects bare tool-call frames the walker mistakes for text", () => {
    expect(looksLikeTranscriptNoise("command()")).toBe(true);
    expect(looksLikeTranscriptNoise("execute_url(https://example.com)")).toBe(true);
    expect(looksLikeTranscriptNoise("escalate_admin(*)")).toBe(true);
    expect(looksLikeTranscriptNoise("mcp()")).toBe(true);
  });

  it("rejects agy hook and prompt-component identifiers", () => {
    // These leak from step metadata as bare snake_case tokens.
    expect(looksLikeTranscriptNoise("idle_subagent_guard")).toBe(true);
    expect(looksLikeTranscriptNoise("request_artifact_feedback_stop")).toBe(true);
    expect(looksLikeTranscriptNoise("conversation_transcript")).toBe(true);
    expect(looksLikeTranscriptNoise("user_information")).toBe(true);
    expect(looksLikeTranscriptNoise("terminal_sandbox")).toBe(true);
  });

  it("rejects bot ids, uuid chains and negative int64 ids", () => {
    expect(
      looksLikeTranscriptNoise("bot-f799263c-26c4-42db-9bef-b0c26389e17f"),
    ).toBe(true);
    expect(
      looksLikeTranscriptNoise("78021a83-6f38-4d2f-9d5c-1a2b3c4d5e6f"),
    ).toBe(true);
    expect(
      looksLikeTranscriptNoise("$78021a83-6f38-4d2f-9d5c-1a2b3c4d5e6f"),
    ).toBe(true);
    expect(looksLikeTranscriptNoise("-3750763034362895579")).toBe(true);
  });

  it("rejects bare filesystem paths that leak from workspace metadata", () => {
    expect(
      looksLikeTranscriptNoise("/Users/christopher/.gemini/antigravity-cli/skills"),
    ).toBe(true);
    expect(looksLikeTranscriptNoise("/tmp/workspace")).toBe(true);
  });

  it("rejects long pure-hex blobs", () => {
    expect(
      looksLikeTranscriptNoise("deadbeefcafebabe0123456789abcdef"),
    ).toBe(true);
  });

  it("rejects strings without any spaces (base64 tokens, packed protos)", () => {
    // Real dialog has spaces. Everything else the walker surfaces doesn't.
    expect(looksLikeTranscriptNoise("vX-gaof4Icqc3boPnLyXwQo")).toBe(true);
    expect(
      looksLikeTranscriptNoise(
        "$4fade6a6-30b1-4a68-8be2-69c066c80135\"$a45ba7aa-a1a4-4c11-9e11-d00fdfd3cb6a",
      ),
    ).toBe(true);
  });

  it("keeps real prose so genuine transcript text survives", () => {
    expect(
      looksLikeTranscriptNoise("Hello! How can I help you today?"),
    ).toBe(false);
    expect(
      looksLikeTranscriptNoise("Please summarize this repo carefully."),
    ).toBe(false);
    expect(
      looksLikeTranscriptNoise("Here is a code snippet: `foo(bar)`"),
    ).toBe(false);
    // A single UUID inside a real sentence is fine.
    expect(
      looksLikeTranscriptNoise(
        "See conversation 78021a83-6f38-4d2f-9d5c-1a2b3c4d5e6f for details.",
      ),
    ).toBe(false);
    // System notices ship as bracketed prose.
    expect(
      looksLikeTranscriptNoise(
        "[Notice] All your subagents and background tasks have been stopped.",
      ),
    ).toBe(false);
  });
});

describe("SessionCatalogProvider list()", () => {
  let dataDir = "";
  beforeEach(() => {
    dataDir = makeTempDataDir();
  });
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns an empty local host with sessions:[] when the data dir has no summaries", async () => {
    const provider = buildAntigravitySessionCatalog({ dataDir });
    const hosts = await provider.list({});
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.hostId).toBe("google-antigravity-cli-local");
    expect(hosts[0]?.sessions).toEqual([]);
  });

  it("drops go zero-value timestamps (0001-01-01) so the UI doesn't render '30965y ago'", async () => {
    // agy writes `0001-01-01 00:00:00+00:00` for last_user_input_time on
    // conversations without recorded user input. Left unfiltered, it parses
    // to a year-1-AD ms value that breaks the sidebar's `now - createdAt`
    // display.
    seedSummariesDb(dataDir, [
      {
        conversationId: "zero-time",
        title: "Bootstrap probe",
        lastModified: "2026-09-04T10:00:00Z",
        lastUserInput: "0001-01-01 00:00:00+00:00",
      },
    ]);
    const provider = buildAntigravitySessionCatalog({ dataDir });
    const hosts = await provider.list({});
    const session = hosts[0]?.sessions[0];
    expect(session?.threadId).toBe("zero-time");
    // Fell back to last_modified_time instead of the zero-value input time.
    expect(session?.createdAt).toBe(Date.parse("2026-09-04T10:00:00Z"));
    expect(session?.updatedAt).toBe(Date.parse("2026-09-04T10:00:00Z"));
    // Never in negative epoch territory.
    expect(session?.createdAt ?? 0).toBeGreaterThan(Date.UTC(2000, 0, 1));
  });

  it("surfaces conversations sorted by most-recent modification", async () => {
    seedSummariesDb(dataDir, [
      {
        conversationId: "1111",
        title: "Alpha task",
        stepCount: 3,
        workspaceUris: ["file:///tmp/alpha"],
        lastModified: "2026-09-01T10:00:00Z",
      },
      {
        conversationId: "2222",
        title: "",
        preview: "Conversation Title: Beta task",
        stepCount: 12,
        workspaceUris: ["file:///tmp/beta"],
        lastModified: "2026-09-04T10:00:00Z",
      },
    ]);
    const provider = buildAntigravitySessionCatalog({ dataDir });
    const hosts = await provider.list({});
    const sessions = hosts[0]?.sessions ?? [];
    expect(sessions.map((s) => s.threadId)).toEqual(["2222", "1111"]);
    expect(sessions[0]?.name).toBe("Beta task");
    expect(sessions[0]?.cwd).toBe("/tmp/beta");
    expect(sessions[0]?.canContinue).toBe(true);
    expect(sessions[0]?.archived).toBe(false);
  });

  it("filters by search substring across title, preview, id, workspace", async () => {
    seedSummariesDb(dataDir, [
      { conversationId: "abcd1234", title: "Fix Telegram bug" },
      { conversationId: "efgh5678", title: "Unrelated" },
    ]);
    const provider = buildAntigravitySessionCatalog({ dataDir });
    const hosts = await provider.list({ search: "telegram" });
    expect(hosts[0]?.sessions.map((s) => s.threadId)).toEqual(["abcd1234"]);
  });
});

describe("SessionCatalogProvider read()", () => {
  let dataDir = "";
  beforeEach(() => {
    dataDir = makeTempDataDir();
    fs.mkdirSync(path.join(dataDir, "conversations"), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns an empty transcript when the conversation db is missing", async () => {
    const provider = buildAntigravitySessionCatalog({ dataDir });
    const result = await provider.read({ threadId: "does-not-exist", hostId: "google-antigravity-cli-local" });
    expect(result.threadId).toBe("does-not-exist");
    expect(result.items).toEqual([]);
  });

  it("surfaces user prompts from history.jsonl even without a step db", async () => {
    await seedHistory(dataDir, [
      { conversationId: "abcd", display: "Please summarize this repo carefully.", timestamp: 1_000 },
      { conversationId: "abcd", display: "Now add a follow-up test and rerun.", timestamp: 2_000 },
      { conversationId: "other", display: "Ignore me.", timestamp: 3_000 },
    ]);
    const provider = buildAntigravitySessionCatalog({ dataDir });
    const result = await provider.read({ threadId: "abcd", hostId: "google-antigravity-cli-local" });
    const userTexts = result.items
      .filter((item) => item.type === "userMessage")
      .map((item) => item.text);
    // Newest-first order — the sidebar renders items[0] such that
    // reverse-chronological delivery lands as chronological display
    // (latest at bottom, oldest at top). See the comment on the
    // final reverse() in readAntigravityConversationTranscript.
    expect(userTexts).toEqual([
      "Now add a follow-up test and rerun.",
      "Please summarize this repo carefully.",
    ]);
  });
});

describe("SessionCatalogProvider copyToGatewaySession()", () => {
  let dataDir = "";
  beforeEach(() => {
    dataDir = makeTempDataDir();
  });
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns the conversation label as displayName when the summary exists", async () => {
    seedSummariesDb(dataDir, [
      { conversationId: "abcd1234", title: "Rebuild release pipeline" },
    ]);
    const provider = buildAntigravitySessionCatalog({ dataDir });
    const result = await (provider as any).copyToGatewaySession({
      threadId: "abcd1234",
      hostId: "google-antigravity-cli-local",
    });
    expect(result).toEqual({ displayName: "Rebuild release pipeline" });
  });

  it("returns an empty hint when no summary is on disk", async () => {
    const provider = buildAntigravitySessionCatalog({ dataDir });
    const result = await (provider as any).copyToGatewaySession({
      threadId: "unknown-conversation",
      hostId: "google-antigravity-cli-local",
    });
    expect(result).toEqual({});
  });

  it("rejects an empty conversation id", async () => {
    const provider = buildAntigravitySessionCatalog({ dataDir });
    await expect(
      (provider as any).copyToGatewaySession({ threadId: "", hostId: "google-antigravity-cli-local" }),
    ).rejects.toThrow(/conversation id/);
  });
});

describe("SessionCatalogProvider continueSession()", () => {
  it("returns a session key bound to the conversation id", async () => {
    const provider = buildAntigravitySessionCatalog({ dataDir: "/tmp/does-not-matter" });
    const result = await provider.continueSession!({
      threadId: "9277298e-cc25-4e13-a4bf-a98358aeef34",
      hostId: "google-antigravity-cli-local",
    });
    expect(result.sessionKey).toBe(
      "harness:google-antigravity-cli:9277298e-cc25-4e13-a4bf-a98358aeef34",
    );
    expect(result.conversationBinding?.data).toBeDefined();
  });

  it("rejects an empty conversation id", async () => {
    const provider = buildAntigravitySessionCatalog({ dataDir: "/tmp/does-not-matter" });
    await expect(
      provider.continueSession!({ threadId: "", hostId: "google-antigravity-cli-local" }),
    ).rejects.toThrow(/conversation id/);
  });
});
