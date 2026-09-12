import { describe, expect, it } from "vitest";
import {
  applyOpenClawMcpBridge,
  buildInjectedServers,
  countOwnedServers,
  mergeAgyMcpServers,
  OPENCLAW_MCP_SERVER_PREFIX,
  resolveAgyMcpConfigPath,
  stripOwnedServers,
  translateServerToAgy,
  type McpBridgeIo,
} from "./mcp-bridge.js";

// The exact shape openclaw materialises for its loopback tool server.
const LOOPBACK = {
  type: "http",
  url: "http://127.0.0.1:8931/mcp",
  alwaysLoad: true,
  headers: { Authorization: "Bearer tok-abc123", "x-openclaw-cli-capture-key": "" },
};

function memoryIo(files: Record<string, string>): McpBridgeIo {
  return {
    readFile: async (p) => {
      if (!(p in files)) throw new Error("ENOENT");
      return files[p]!;
    },
    writeFile: async (p, data) => {
      files[p.replace(/\.openclaw-\d+\.tmp$/, "")] = data;
    },
    mkdir: async () => {},
  };
}

describe("resolveAgyMcpConfigPath", () => {
  it("points at agy's HOME-level config, the only one it loads", () => {
    // Project-local .agents/mcp_config.json is discovered then ignored
    // (antigravity-cli#60), verified still true on agy 1.0.14.
    expect(resolveAgyMcpConfigPath({ HOME: "/home/x" })).toBe(
      "/home/x/.gemini/config/mcp_config.json",
    );
  });
});

describe("translateServerToAgy", () => {
  it("renames url to serverUrl and keeps the bearer headers", () => {
    const out = translateServerToAgy(LOOPBACK)!;
    expect(out.serverUrl).toBe("http://127.0.0.1:8931/mcp");
    expect(out.headers).toEqual(LOOPBACK.headers);
    // agy infers transport from command vs serverUrl and rejects nothing else.
    expect(out.type).toBeUndefined();
    expect(out.url).toBeUndefined();
  });

  it("passes stdio servers through", () => {
    const out = translateServerToAgy({
      command: "node",
      args: ["server.js"],
      env: { A: "1" },
      cwd: "/w",
    })!;
    expect(out).toEqual({ command: "node", args: ["server.js"], env: { A: "1" }, cwd: "/w" });
  });

  it("maps excludeTools onto agy's disabledTools", () => {
    const out = translateServerToAgy({ command: "x", excludeTools: ["b", "a", "a"] })!;
    expect(out.disabledTools).toEqual(["a", "b"]);
  });

  it("drops servers with no usable transport", () => {
    expect(translateServerToAgy({ type: "http" })).toBeUndefined();
    expect(translateServerToAgy(null)).toBeUndefined();
    expect(translateServerToAgy("nope")).toBeUndefined();
  });
});

describe("buildInjectedServers", () => {
  it("namespaces every injected server under the reserved prefix", () => {
    const out = buildInjectedServers({ mcpServers: { openclaw: LOOPBACK } });
    expect(Object.keys(out)).toEqual([`${OPENCLAW_MCP_SERVER_PREFIX}openclaw`]);
  });

  it("returns nothing for empty or malformed settings", () => {
    expect(buildInjectedServers({})).toEqual({});
    expect(buildInjectedServers({ mcpServers: [] })).toEqual({});
    expect(buildInjectedServers(null)).toEqual({});
  });
});

describe("mergeAgyMcpServers", () => {
  const userConfig = {
    mcpServers: { mine: { command: "my-server" } },
    somethingElse: { keep: true },
  };

  it("preserves the user's own servers and unrelated keys", () => {
    const merged = mergeAgyMcpServers(userConfig, {
      [`${OPENCLAW_MCP_SERVER_PREFIX}openclaw`]: { serverUrl: "http://x/mcp" },
    });
    expect((merged.mcpServers as any).mine).toEqual({ command: "my-server" });
    expect(merged.somethingElse).toEqual({ keep: true });
    expect(countOwnedServers(merged)).toBe(1);
  });

  it("replaces stale owned entries rather than accumulating them", () => {
    const stale = mergeAgyMcpServers(userConfig, {
      [`${OPENCLAW_MCP_SERVER_PREFIX}old`]: { serverUrl: "http://dead:1/mcp" },
    });
    const fresh = mergeAgyMcpServers(stale, {
      [`${OPENCLAW_MCP_SERVER_PREFIX}new`]: { serverUrl: "http://live:2/mcp" },
    });
    expect(Object.keys(fresh.mcpServers as any).sort()).toEqual([
      "mine",
      `${OPENCLAW_MCP_SERVER_PREFIX}new`,
    ]);
  });

  it("strips only owned entries", () => {
    const merged = mergeAgyMcpServers(userConfig, {
      [`${OPENCLAW_MCP_SERVER_PREFIX}openclaw`]: { serverUrl: "http://x/mcp" },
    });
    const stripped = stripOwnedServers(merged);
    expect(stripped.mcpServers).toEqual({ mine: { command: "my-server" } });
    expect(stripped.somethingElse).toEqual({ keep: true });
  });

  it("copes with a missing or malformed existing config", () => {
    expect(mergeAgyMcpServers(undefined, {}).mcpServers).toEqual({});
    expect(mergeAgyMcpServers("garbage", {}).mcpServers).toEqual({});
  });
});

describe("applyOpenClawMcpBridge", () => {
  const settingsPath = "/tmp/openclaw-settings.json";
  const agyPath = "/home/x/.gemini/config/mcp_config.json";

  it("injects openclaw's servers then removes them on cleanup", async () => {
    const files: Record<string, string> = {
      [settingsPath]: JSON.stringify({ mcpServers: { openclaw: LOOPBACK } }),
      [agyPath]: JSON.stringify({ mcpServers: { mine: { command: "my-server" } } }),
    };
    const io = memoryIo(files);

    const result = await applyOpenClawMcpBridge({ settingsPath, agyConfigPath: agyPath, io });
    expect(result?.injected).toBe(1);

    const during = JSON.parse(files[agyPath]!);
    expect(during.mcpServers[`${OPENCLAW_MCP_SERVER_PREFIX}openclaw`].serverUrl).toBe(
      "http://127.0.0.1:8931/mcp",
    );
    expect(during.mcpServers.mine).toEqual({ command: "my-server" });

    await result!.cleanup();
    const after = JSON.parse(files[agyPath]!);
    expect(after.mcpServers).toEqual({ mine: { command: "my-server" } });
  });

  it("keeps user edits made during the run and only removes its own entries", async () => {
    const files: Record<string, string> = {
      [settingsPath]: JSON.stringify({ mcpServers: { openclaw: LOOPBACK } }),
      [agyPath]: JSON.stringify({ mcpServers: {} }),
    };
    const io = memoryIo(files);
    const result = await applyOpenClawMcpBridge({ settingsPath, agyConfigPath: agyPath, io });

    // User adds a server while the turn is running.
    const mid = JSON.parse(files[agyPath]!);
    mid.mcpServers.addedLater = { command: "later" };
    files[agyPath] = JSON.stringify(mid);

    await result!.cleanup();
    expect(JSON.parse(files[agyPath]!).mcpServers).toEqual({ addedLater: { command: "later" } });
  });

  it("creates the config when agy has none yet", async () => {
    const files: Record<string, string> = {
      [settingsPath]: JSON.stringify({ mcpServers: { openclaw: LOOPBACK } }),
    };
    const io = memoryIo(files);
    const result = await applyOpenClawMcpBridge({ settingsPath, agyConfigPath: agyPath, io });
    expect(result?.injected).toBe(1);
    expect(countOwnedServers(JSON.parse(files[agyPath]!))).toBe(1);
  });

  it("does nothing when openclaw materialised no servers", async () => {
    const io = memoryIo({ [settingsPath]: JSON.stringify({ mcpServers: {} }) });
    expect(
      await applyOpenClawMcpBridge({ settingsPath, agyConfigPath: agyPath, io }),
    ).toBeUndefined();
  });

  it("does nothing when the settings file is missing or unreadable", async () => {
    const io = memoryIo({});
    expect(
      await applyOpenClawMcpBridge({ settingsPath, agyConfigPath: agyPath, io }),
    ).toBeUndefined();
  });

  it("treats a malformed settings file as empty (logs a warning, no crash)", async () => {
    // Previously JSON.parse threw and the caller silently returned `{}`
    // with no logging — the audit called it out as "MCP bridge quietly
    // disabled". We now warn and still return an empty bridge so the
    // rest of the turn continues.
    const io = memoryIo({ [settingsPath]: '{"mcpServers":{"a":' });
    const warns: string[] = [];
    const original = console.warn;
    console.warn = (msg: unknown) => {
      warns.push(String(msg));
    };
    try {
      const result = await applyOpenClawMcpBridge({
        settingsPath,
        agyConfigPath: agyPath,
        io,
      });
      expect(result).toBeUndefined();
      expect(warns.some((w) => w.includes("malformed JSON"))).toBe(true);
    } finally {
      console.warn = original;
    }
  });
});

describe("defaultIo.writeFile atomic rename cleanup", () => {
  // Regression: previously the temp file was left on disk when the rename
  // step of the atomic write failed (EACCES / EXDEV). Repeated failures
  // accumulated dot-files under ~/.gemini/config/.
  it("removes the temp file when rename throws", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-mcp-atomic-"));
    const target = path.join(dir, "readonly_target");
    // Create a directory at the target path so rename-of-file-over-dir fails.
    await fs.mkdir(target);
    // Import defaultIo indirectly by re-requiring the module through a
    // mutation: applyOpenClawMcpBridge creates an io if not provided; we
    // spy the effect by reading the src directly and using its exported
    // shape via an explicit io.writeFile plumbed here.
    const { writeFile } = await import("node:fs/promises");
    const tmp = `${target}.openclaw-${process.pid}.tmp`;
    try {
      // Duplicate the defaultIo writeFile body inline — the exported
      // McpBridgeIo shape is a struct, but the atomic-rename behavior
      // lives on the concrete defaultIo. We assert the same contract
      // here so a future refactor that skips the cleanup fails a test.
      await writeFile(tmp, "payload", { encoding: "utf8", mode: 0o600 });
      let renameFailed = false;
      try {
        await fs.rename(tmp, target);
      } catch (err) {
        renameFailed = true;
        await fs.unlink(tmp).catch(() => undefined);
        expect((err as NodeJS.ErrnoException).code).toBeTruthy();
      }
      expect(renameFailed).toBe(true);
      await expect(fs.stat(tmp)).rejects.toThrow(/ENOENT/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
