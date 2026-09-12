import { describe, expect, it } from "vitest";
import {
  buildWorkspaceContextBlock,
  workspaceBootstrapFingerprint,
  defaultWorkspaceContextMaxChars,
  readWorkspaceBootstrapFiles,
  WORKSPACE_BOOTSTRAP_FILENAMES,
  WorkspaceContextDeliveryTracker,
} from "./workspace-bootstrap.js";

const CID_A = "83d95bb9-6a61-4ea5-a70d-aad251c22f9b";
const CID_B = "11112222-3333-4444-5555-666677778888";

describe("WORKSPACE_BOOTSTRAP_FILENAMES", () => {
  it("mirrors openclaw's list and order", () => {
    expect([...WORKSPACE_BOOTSTRAP_FILENAMES]).toEqual([
      "AGENTS.md",
      "SOUL.md",
      "IDENTITY.md",
      "USER.md",
      "MEMORY.md",
    ]);
  });

  it("excludes BOOTSTRAP.md, which is a one-time flow and gets deleted", () => {
    // openclaw drives BOOTSTRAP.md as a dedicated run ("read BOOTSTRAP.md ...
    // and follow it before replying normally") and the file is removed once
    // bootstrap completes. Shipping it as standing instructions would invite
    // agy to re-run bootstrap on ordinary turns.
    expect([...WORKSPACE_BOOTSTRAP_FILENAMES]).not.toContain("BOOTSTRAP.md");
  });
});

describe("workspaceBootstrapFingerprint", () => {
  it("is stable for identical instruction sets", () => {
    const a = [{ name: "AGENTS.md", content: "x" }];
    expect(workspaceBootstrapFingerprint(a)).toBe(workspaceBootstrapFingerprint([...a]));
  });

  it("changes when a file is edited, added, or removed", () => {
    const base = [{ name: "AGENTS.md", content: "x" }];
    const edited = [{ name: "AGENTS.md", content: "y" }];
    const added = [...base, { name: "SOUL.md", content: "z" }];
    const f = workspaceBootstrapFingerprint(base);
    expect(workspaceBootstrapFingerprint(edited)).not.toBe(f);
    expect(workspaceBootstrapFingerprint(added)).not.toBe(f);
    expect(workspaceBootstrapFingerprint([])).not.toBe(f);
  });
});

describe("readWorkspaceBootstrapFiles", () => {
  it("returns present, non-empty files in openclaw's order", async () => {
    const files = await readWorkspaceBootstrapFiles("/ws", async (p) => {
      if (p.endsWith("AGENTS.md")) return "be terse";
      if (p.endsWith("SOUL.md")) return "  friendly  ";
      if (p.endsWith("USER.md")) return "   "; // whitespace only => skipped
      throw new Error("ENOENT");
    });
    expect(files).toEqual([
      { name: "AGENTS.md", content: "be terse" },
      { name: "SOUL.md", content: "friendly" },
    ]);
  });

  it("returns [] when the workspace has none of them", async () => {
    expect(
      await readWorkspaceBootstrapFiles("/ws", async () => {
        throw new Error("ENOENT");
      }),
    ).toEqual([]);
  });
});

describe("buildWorkspaceContextBlock", () => {
  const files = [
    { name: "AGENTS.md", content: "always answer in one sentence" },
    { name: "SOUL.md", content: "you are called Ada" },
  ];

  it("renders every file with the workspace and agent named", () => {
    const out = buildWorkspaceContextBlock({
      workspaceDir: "/ws/main",
      agentId: "main",
      files,
    })!;
    expect(out).toContain('agent "main"');
    expect(out).toContain("Workspace: /ws/main");
    expect(out).toContain("--- AGENTS.md ---");
    expect(out).toContain("always answer in one sentence");
    expect(out).toContain("--- SOUL.md ---");
    expect(out).toContain("you are called Ada");
    expect(out).toContain("<workspace_instructions>");
  });

  it("returns undefined when there is nothing to send", () => {
    expect(
      buildWorkspaceContextBlock({ workspaceDir: "/ws", files: [] }),
    ).toBeUndefined();
  });

  it("keeps the earliest files and names what it dropped", () => {
    const big = [
      { name: "AGENTS.md", content: "a".repeat(600) },
      { name: "MEMORY.md", content: "m".repeat(600) },
    ];
    const out = buildWorkspaceContextBlock({
      workspaceDir: "/ws",
      files: big,
      maxChars: 700,
    })!;
    expect(out).toContain("--- AGENTS.md ---");
    expect(out).toMatch(/Omitted to stay within budget|truncated/);
  });

  it("uses a tighter budget on Windows than elsewhere", () => {
    expect(defaultWorkspaceContextMaxChars("win32")).toBeLessThan(
      defaultWorkspaceContextMaxChars("linux"),
    );
  });
});

describe("WorkspaceContextDeliveryTracker", () => {
  it("sends once for a new conversation, then stays quiet", () => {
    const t = new WorkspaceContextDeliveryTracker();
    // Turn 1: no agy conversation exists yet.
    expect(t.shouldSend("main", "/ws", undefined)).toBe(true);
    // Turn 2: the conversation created by turn 1 already carries the block.
    expect(t.shouldSend("main", "/ws", CID_A)).toBe(false);
    expect(t.shouldSend("main", "/ws", CID_A)).toBe(false);
  });

  it("resends when the instructions on disk change", () => {
    const t = new WorkspaceContextDeliveryTracker();
    t.shouldSend("main", "/ws", undefined, "fp1");
    expect(t.shouldSend("main", "/ws", CID_A, "fp1")).toBe(false);
    // AGENTS.md edited, or BOOTSTRAP.md deleted: the live conversation still
    // carries the old copy, so send the new one.
    expect(t.shouldSend("main", "/ws", CID_A, "fp2")).toBe(true);
    expect(t.shouldSend("main", "/ws", CID_A, "fp2")).toBe(false);
  });

  it("resends when the conversation is replaced (binding lost)", () => {
    const t = new WorkspaceContextDeliveryTracker();
    t.shouldSend("main", "/ws", undefined);
    t.shouldSend("main", "/ws", CID_A);
    expect(t.shouldSend("main", "/ws", CID_B)).toBe(true);
    expect(t.shouldSend("main", "/ws", CID_B)).toBe(false);
  });

  it("keeps resending while no conversation gets created", () => {
    const t = new WorkspaceContextDeliveryTracker();
    expect(t.shouldSend("main", "/ws", undefined)).toBe(true);
    expect(t.shouldSend("main", "/ws", undefined)).toBe(true);
  });

  it("tracks each agent and workspace separately", () => {
    const t = new WorkspaceContextDeliveryTracker();
    // main settles into conversation A.
    t.shouldSend("main", "/ws/main", undefined);
    t.shouldSend("main", "/ws/main", CID_A);
    expect(t.shouldSend("main", "/ws/main", CID_A)).toBe(false);
    // A second agent must not inherit main's delivery state.
    expect(t.shouldSend("research", "/ws/research", CID_A)).toBe(true);
    // Nor must the same agent in a different workspace.
    expect(t.shouldSend("main", "/ws/other", CID_A)).toBe(true);
  });

  it("treats a missing agent id as its own bucket without throwing", () => {
    const t = new WorkspaceContextDeliveryTracker();
    expect(t.shouldSend(undefined, "/ws", CID_A)).toBe(true);
    expect(t.shouldSend(undefined, "/ws", CID_A)).toBe(false);
  });
});
