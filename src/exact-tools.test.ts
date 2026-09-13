import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EXACT_CAP_ENV, prepareExactToolExecution, restrictExecutionArgs, scopedMcpServer, validateExactCap } from "./exact-tools.ts";

const captured = {
  mcpServers: {
    openclaw: { url: "http://127.0.0.1:12345/mcp", headers: { Authorization: "Bearer test-only", "x-openclaw-cli-capture-key": "test-attempt" } },
    ambient: { command: "must-not-run" },
  },
};

describe("exact Antigravity tool cap", () => {
  it("rejects native or malformed caps instead of weakening them", () => {
    for (const value of [undefined, {}, { native: ["read"], openClaw: [] }, { native: [], openClaw: ["*"] }]) {
      expect(() => validateExactCap(value)).toThrow();
    }
    expect(validateExactCap({ native: [], openClaw: ["read", "read"] })).toEqual({ native: [], openClaw: ["read"] });
  });

  it("drops resumed authority and rejects alternate agent selection", () => {
    expect(restrictExecutionArgs(["--conversation", "old", "--dangerously-skip-permissions", "--print", "hello"]))
      .toEqual(["--print", "hello", "--disable-slash-commands"]);
    for (const flag of ["--agent", "-agent=other", "--add-dir", "-project", "--input-format", "--", "--mcp-config=other", "--plugins", "--hooks=other", "--resume", "--disable-slash-commands=false", "unexpected"]) {
      expect(() => restrictExecutionArgs([flag])).toThrow();
    }
  });

  it("preserves prompt values and only an explicitly matched wrapper prefix", () => {
    const args = ["/private/wrapper.js", "--print", "--agent is text here", "--model=model", "--sandbox"];
    expect(restrictExecutionArgs(args, args[0])).toEqual([...args, "--disable-slash-commands"]);
    expect(() => restrictExecutionArgs(args, "/different/wrapper.js")).toThrow();
  });

  it("copies only the host capture transport and requires bound headers", () => {
    expect(scopedMcpServer(captured, "unique")).toEqual({ name: "unique", serverUrl: captured.mcpServers.openclaw.url, headers: captured.mcpServers.openclaw.headers });
    for (const server of [
      { url: "https://example.com/mcp", headers: captured.mcpServers.openclaw.headers },
      { url: captured.mcpServers.openclaw.url, headers: { Authorization: "Bearer test-only" } },
      { url: captured.mcpServers.openclaw.url, headers: { ...captured.mcpServers.openclaw.headers, Authorization: "Bearer " } },
      { url: captured.mcpServers.openclaw.url, headers: { Authorization: "Bearer ${TOKEN}", "x-openclaw-cli-capture-key": "test" } },
    ]) expect(() => scopedMcpServer({ mcpServers: { openclaw: server } }, "unique")).toThrow();
  });

  it("rejects unverified CLI versions before staging a restricted agent", async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "agy-version-test-"));
    try {
      const command = path.join(fixture, "agy-version");
      await fs.writeFile(command, "#!/bin/sh\nprintf '1.2.2\\n'\n", { mode: 0o700 });
      await expect(prepareExactToolExecution({ command, args: [], env: {
        ...process.env, [EXACT_CAP_ENV]: JSON.stringify({ native: [], openClaw: [] }),
      } })).rejects.toThrow("verified agy 1.2.1");
    } finally { await fs.rm(fixture, { recursive: true, force: true }); }
  });

  it("materializes an isolated agent and removes its private transport on cleanup", async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "agy-cap-test-"));
    try {
      const command = path.join(fixture, "agy-version");
      await fs.writeFile(command, "#!/bin/sh\nprintf '1.2.1\\n'\n", { mode: 0o700 });
      const settingsPath = path.join(fixture, "settings.json");
      await fs.writeFile(settingsPath, JSON.stringify(captured), { mode: 0o600 });
      const prepared = await prepareExactToolExecution({ command, args: ["--print", "test"], env: { ...process.env, [EXACT_CAP_ENV]: JSON.stringify({ native: [], openClaw: ["read"] }), GEMINI_CLI_SYSTEM_SETTINGS_PATH: settingsPath } });
      const root = prepared.args.at(-1)!;
      const agentName = prepared.args[prepared.args.indexOf("--agent") + 1]!;
      const agentPath = path.join(root, ".agents", "agents", `${agentName}.md`);
      const raw = await fs.readFile(agentPath, "utf8");
      expect(raw).toContain('"inheritCustomizations": false');
      expect(raw).toContain('"excludeDefaultComponents": true');
      expect(raw).not.toContain("must-not-run");
      expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(agentPath)).mode & 0o777).toBe(0o600);
      await prepared.cleanup();
      await expect(fs.stat(root)).rejects.toThrow();
    } finally { await fs.rm(fixture, { recursive: true, force: true }); }
  });
});
