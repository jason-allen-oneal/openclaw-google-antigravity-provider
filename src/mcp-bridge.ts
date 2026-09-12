// Bridges OpenClaw's tools into agy over MCP.
//
// OpenClaw runs a loopback HTTP MCP server exposing its own tools and hands the
// CLI child a bearer token:
//
//   { mcpServers: { openclaw: { type: "http",
//       url: "http://127.0.0.1:<port>/mcp", alwaysLoad: true,
//       headers: { Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}" } } } }
//
// claude-cli receives that as `--mcp-config <file>` and gemini-cli through
// `GEMINI_CLI_SYSTEM_SETTINGS_PATH`. agy has neither: verified against agy
// 1.0.14, it reads MCP servers *only* from the HOME-level
// ~/.gemini/config/mcp_config.json. Project-local `.agents/mcp_config.json` is
// discovered and then silently ignored (google-antigravity/antigravity-cli#60),
// and there is no flag or environment variable to redirect the path per run.
//
// So this module takes the config openclaw already materialised for the
// `gemini-system-settings` mode — chosen because that mode injects no CLI args
// and resolves `${OPENCLAW_MCP_TOKEN}` to a literal before writing, which agy
// needs since it performs no placeholder expansion of its own — translates it
// into agy's schema, and merges it into the HOME-level file under a reserved
// key prefix. Entries are removed again when the run finishes.

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Reserved prefix for entries this plugin owns. Anything under it is ours to
// replace or delete; every other key belongs to the user and is preserved.
export const OPENCLAW_MCP_SERVER_PREFIX = "openclaw__";

export function resolveAgyMcpConfigPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const home = env.HOME?.trim() || os.homedir();
  return path.join(home, ".gemini", "config", "mcp_config.json");
}

// agy's server schema differs from the one openclaw materialises:
//   url        -> serverUrl   (agy names the remote transport differently)
//   type/trust -> dropped     (agy infers transport from command vs serverUrl)
//   excludeTools -> disabledTools
// `includeTools` has no agy equivalent and is dropped; agy can only deny.
export function translateServerToAgy(
  server: unknown,
): Record<string, unknown> | undefined {
  if (!server || typeof server !== "object" || Array.isArray(server)) return undefined;
  const src = server as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  if (typeof src.command === "string") out.command = src.command;
  if (Array.isArray(src.args) && src.args.every((a) => typeof a === "string")) {
    out.args = [...(src.args as string[])];
  }
  if (typeof src.cwd === "string") out.cwd = src.cwd;
  if (src.env && typeof src.env === "object" && !Array.isArray(src.env)) out.env = { ...src.env };

  const url = typeof src.url === "string" ? src.url : undefined;
  const serverUrl = typeof src.serverUrl === "string" ? src.serverUrl : url;
  if (serverUrl) out.serverUrl = serverUrl;
  if (src.headers && typeof src.headers === "object" && !Array.isArray(src.headers)) {
    out.headers = { ...src.headers };
  }

  const excluded = Array.isArray(src.excludeTools)
    ? (src.excludeTools as unknown[]).filter((t): t is string => typeof t === "string")
    : [];
  if (excluded.length > 0) out.disabledTools = [...new Set(excluded)].sort();

  // Neither transport present means nothing agy can connect to.
  if (typeof out.command !== "string" && typeof out.serverUrl !== "string") return undefined;
  return out;
}

// Reads openclaw's materialised settings file and returns the agy-shaped,
// prefix-namespaced servers to inject.
export function buildInjectedServers(
  settings: unknown,
): Record<string, Record<string, unknown>> {
  if (!settings || typeof settings !== "object") return {};
  const servers = (settings as { mcpServers?: unknown }).mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, server] of Object.entries(servers as Record<string, unknown>)) {
    const translated = translateServerToAgy(server);
    if (translated) out[`${OPENCLAW_MCP_SERVER_PREFIX}${name}`] = translated;
  }
  return out;
}

function isOwned(key: string): boolean {
  return key.startsWith(OPENCLAW_MCP_SERVER_PREFIX);
}

// Replaces every owned entry with the given set, leaving user entries intact.
// Dropping stale owned entries first is what keeps a crashed run from leaving
// a dead loopback port behind for the next one.
export function mergeAgyMcpServers(
  existing: unknown,
  injected: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  const servers =
    base.mcpServers && typeof base.mcpServers === "object" && !Array.isArray(base.mcpServers)
      ? { ...(base.mcpServers as Record<string, unknown>) }
      : {};
  for (const key of Object.keys(servers)) if (isOwned(key)) delete servers[key];
  Object.assign(servers, injected);
  return { ...base, mcpServers: servers };
}

export function stripOwnedServers(existing: unknown): Record<string, unknown> {
  return mergeAgyMcpServers(existing, {});
}

export function countOwnedServers(existing: unknown): number {
  if (!existing || typeof existing !== "object") return 0;
  const servers = (existing as { mcpServers?: unknown }).mcpServers;
  if (!servers || typeof servers !== "object") return 0;
  return Object.keys(servers as Record<string, unknown>).filter(isOwned).length;
}

export type McpBridgeIo = {
  readonly readFile: (p: string) => Promise<string>;
  readonly writeFile: (p: string, data: string) => Promise<void>;
  readonly mkdir: (p: string) => Promise<void>;
};

const defaultIo: McpBridgeIo = {
  readFile: (p) => fsp.readFile(p, "utf8"),
  // 0o600: the file carries the loopback bearer token.
  writeFile: async (p, data) => {
    const tmp = `${p}.openclaw-${process.pid}.tmp`;
    await fsp.writeFile(tmp, data, { encoding: "utf8", mode: 0o600 });
    try {
      await fsp.rename(tmp, p);
    } catch (error) {
      // Rename can fail for EACCES / EXDEV / EPERM. Clean up the temp so
      // repeated failures don't accumulate under the user's HOME.
      await fsp.unlink(tmp).catch(() => undefined);
      throw error;
    }
  },
  mkdir: async (p) => {
    await fsp.mkdir(p, { recursive: true });
  },
};

async function readJson(io: McpBridgeIo, filePath: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await io.readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    // eslint-disable-next-line no-console
    console.warn(
      `[google-antigravity-cli] mcp-bridge: read failed for ${filePath}: ${
        (error as Error).message
      } — treating as empty`,
    );
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    // Malformed JSON in a settings file we wrote ourselves usually means a
    // concurrent overlapping run left it half-baked. Log so it's obvious in
    // `openclaw gateway logs` — the alternative (silent empty) is what
    // caused the "MCP bridge quietly disabled" audit finding.
    // eslint-disable-next-line no-console
    console.warn(
      `[google-antigravity-cli] mcp-bridge: ignoring malformed JSON at ${filePath}: ${
        (error as Error).message
      }`,
    );
    return {};
  }
}

export type ApplyMcpBridgeParams = {
  /** openclaw's materialised settings file (GEMINI_CLI_SYSTEM_SETTINGS_PATH). */
  readonly settingsPath: string;
  readonly agyConfigPath: string;
  readonly io?: McpBridgeIo;
};

export type McpBridgeResult = {
  readonly injected: number;
  readonly cleanup: () => Promise<void>;
};

// Merges openclaw's MCP servers into agy's HOME-level config and returns a
// cleanup that removes them again. Returns undefined when there is nothing to
// inject, so callers can skip registering a cleanup.
export async function applyOpenClawMcpBridge(
  params: ApplyMcpBridgeParams,
): Promise<McpBridgeResult | undefined> {
  const io = params.io ?? defaultIo;
  const injected = buildInjectedServers(await readJson(io, params.settingsPath));
  if (Object.keys(injected).length === 0) return undefined;

  await io.mkdir(path.dirname(params.agyConfigPath));
  const existing = await readJson(io, params.agyConfigPath);
  await io.writeFile(
    params.agyConfigPath,
    `${JSON.stringify(mergeAgyMcpServers(existing, injected), null, 2)}\n`,
  );

  return {
    injected: Object.keys(injected).length,
    cleanup: async () => {
      // Re-read rather than reusing `existing`: the user may have edited the
      // file during the run, and only the owned entries should disappear.
      const current = await readJson(io, params.agyConfigPath);
      await io.writeFile(
        params.agyConfigPath,
        `${JSON.stringify(stripOwnedServers(current), null, 2)}\n`,
      );
    },
  };
}
