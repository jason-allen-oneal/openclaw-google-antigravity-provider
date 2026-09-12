import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAntigravityTools } from "./tools.js";

function makeDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-tools-"));
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

describe("antigravity custom tools", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = makeDataDir();
  });
  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  function tools(overrideEnv: Record<string, string> = {}) {
    return createAntigravityTools(
      { senderIsOwner: true } as any,
      { ANTIGRAVITY_USER_DATA_DIR: dataDir, ...overrideEnv } as any,
    );
  }

  it("lists agy conversations newest-first with a summary line", async () => {
    seedSummary(dataDir, "old-conv-id", "Older chat", "2026-08-01T10:00:00Z");
    seedSummary(dataDir, "new-conv-id", "Newer chat", "2026-09-08T10:00:00Z");
    const [list] = tools();
    const result = await list!.execute("call1", {}, undefined, () => {});
    const details = (result as any).details;
    expect(details.summary).toBe("agy conversations: 2 of 2");
    expect(details.conversations.map((c: any) => c.conversationId)).toEqual([
      "new-conv-id",
      "old-conv-id",
    ]);
  });

  it("filters the list by search substring", async () => {
    seedSummary(dataDir, "aa", "Fix telegram bug");
    seedSummary(dataDir, "bb", "Unrelated work");
    const [list] = tools();
    const result = await list!.execute("call1", { search: "telegram" }, undefined, () => {});
    const details = (result as any).details;
    expect(details.conversations).toHaveLength(1);
    expect(details.conversations[0].label).toBe("Fix telegram bug");
  });

  it("read tool returns an empty transcript when the conversation db is missing", async () => {
    const [, read] = tools();
    const result = await read!.execute(
      "call1",
      { conversationId: "does-not-exist-1234" },
      undefined,
      () => {},
    );
    const details = (result as any).details;
    expect(details.conversationId).toBe("does-not-exist-1234");
    expect(details.items).toEqual([]);
  });

  it("reset_binding renames the on-disk db and reports the backup path", async () => {
    const conversationId = "12345678-abcd-abcd-abcd-abcdef123456";
    const dbPath = path.join(dataDir, "conversations", `${conversationId}.db`);
    fs.writeFileSync(dbPath, Buffer.from("polluted data"));
    const [, , reset] = tools();
    const result = await reset!.execute("call1", { conversationId }, undefined, () => {});
    const details = (result as any).details;
    expect(details.reset).toBe(true);
    expect(details.backupPath).toMatch(new RegExp(`\\.reset-\\d+\\.bak$`));
    expect(fs.existsSync(dbPath)).toBe(false);
    expect(fs.existsSync(details.backupPath)).toBe(true);
  });

  it("reset_binding is a no-op when there's no existing db", async () => {
    const [, , reset] = tools();
    const result = await reset!.execute(
      "call1",
      { conversationId: "never-existed-1234" },
      undefined,
      () => {},
    );
    expect((result as any).details.reset).toBe(false);
  });

  it("reset_binding refuses to run when the sender is not the owner", async () => {
    const nonOwnerTools = createAntigravityTools(
      { senderIsOwner: false } as any,
      { ANTIGRAVITY_USER_DATA_DIR: dataDir } as any,
    );
    const reset = nonOwnerTools.find((t) => t.name === "antigravity_reset_binding")!;
    await expect(
      reset.execute("call1", { conversationId: "abcd1234" }, undefined, () => {}),
    ).rejects.toThrow(/owner/i);
  });
});
