import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAntigravityCommand } from "./commands.js";

function makeDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-cmd-"));
  fs.mkdirSync(path.join(dir, "conversations"), { recursive: true });
  return dir;
}

function seedSummary(dataDir: string, id: string, title: string, modified = "2026-09-01T00:00:00Z") {
  const dbPath = path.join(dataDir, "conversation_summaries.db");
  const isNew = !fs.existsSync(dbPath);
  const db = new DatabaseSync(dbPath);
  if (isNew) {
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
  }
  db.prepare(
    `INSERT INTO conversation_summaries (conversation_id, title, last_modified_time, workspace_uris, last_user_input_time, app_data_dir)
     VALUES (?, ?, ?, '[]', ?, 'antigravity-cli')`,
  ).run(id, title, modified, modified);
  db.close();
}

function ctx(args = "") {
  return { args, config: {}, commandBody: `/antigravity ${args}` } as any;
}

describe("/antigravity command", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = makeDataDir();
  });
  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  function cmd() {
    return buildAntigravityCommand({ ANTIGRAVITY_USER_DATA_DIR: dataDir } as any);
  }

  it("returns the help text when called with no args or `help`", async () => {
    const out1 = await cmd().handler(ctx(""));
    const out2 = await cmd().handler(ctx("help"));
    expect(out1.text).toMatch(/\/antigravity list/);
    expect(out2.text).toMatch(/\/antigravity reset/);
  });

  it("list surfaces recent conversations newest-first", async () => {
    seedSummary(dataDir, "aaaa1234", "Older chat", "2026-08-01T10:00:00Z");
    seedSummary(dataDir, "bbbb5678", "Newer chat", "2026-09-08T10:00:00Z");
    const out = await cmd().handler(ctx("list"));
    expect(out.text).toMatch(/bbbb5678.*Newer chat/);
    const text = out.text ?? "";
    expect(text.indexOf("bbbb5678")).toBeLessThan(text.indexOf("aaaa1234"));
  });

  it("list honours an explicit N", async () => {
    for (let i = 0; i < 5; i += 1) {
      seedSummary(dataDir, `conv-${i}`, `Chat ${i}`, `2026-09-${String(i + 1).padStart(2, "0")}T00:00:00Z`);
    }
    const out = await cmd().handler(ctx("list 2"));
    expect(out.text).toMatch(/2 of 5/);
  });

  it("status reports the db size and step count", async () => {
    const conversationId = "12345678-abcd-abcd-abcd-abcdef123456";
    seedSummary(dataDir, conversationId, "Some chat");
    const dbPath = path.join(dataDir, "conversations", `${conversationId}.db`);
    fs.writeFileSync(dbPath, Buffer.alloc(500_000));
    const out = await cmd().handler(ctx(`status ${conversationId}`));
    expect(out.text).toMatch(/0\.50 MB/);
    expect(out.text).toMatch(new RegExp(conversationId));
  });

  it("status reports missing state when the db doesn't exist", async () => {
    const out = await cmd().handler(ctx("status never-existed-1234"));
    expect(out.text).toMatch(/no agy state/);
  });

  it("reset renames the db to a .bak sibling and reports the backup path", async () => {
    const conversationId = "abcd1234-abcd-abcd-abcd-abcdef123456";
    const dbPath = path.join(dataDir, "conversations", `${conversationId}.db`);
    fs.writeFileSync(dbPath, Buffer.from("stale"));
    const out = await cmd().handler(ctx(`reset ${conversationId}`));
    expect(out.text).toMatch(/Reset agy state/);
    expect(out.text).toMatch(/\.reset-\d+\.bak/);
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it("reset is a no-op when the db is already missing", async () => {
    const out = await cmd().handler(ctx("reset does-not-exist-1234"));
    expect(out.text).toMatch(/already fresh/);
  });

  it("unknown subcommand returns an error payload with help text", async () => {
    const out = await cmd().handler(ctx("foo"));
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/unknown subcommand.*\/antigravity list/s);
  });
});
