import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { generateGuardPlugin } from "./exact-tool-guard.ts";

export const EXACT_CAP_ENV = "OPENCLAW_ANTIGRAVITY_EXACT_TOOL_CAP";
export type ExactToolCap = { native: string[]; openClaw: string[] };

export function validateExactCap(value: unknown): ExactToolCap {
  const cap = value as Partial<ExactToolCap> | null;
  if (!cap || !Array.isArray(cap.native) || cap.native.length !== 0 ||
      !Array.isArray(cap.openClaw) || cap.openClaw.length > 1000 ||
      cap.openClaw.some((name) => typeof name !== "string" || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(name))) {
    throw new Error("Antigravity restricted runs require an exact MCP-only tool cap");
  }
  return { native: [], openClaw: [...new Set(cap.openClaw)].sort() };
}

// Fresh agent selection is essential: an older conversation may own broader tools.
export function restrictExecutionArgs(args: readonly string[], wrapperPath?: string): string[] {
  const result: string[] = [];
  const valueFlags = new Set(["--print", "--prompt", "--p", "--model", "--effort", "--output-format", "--print-timeout"]);
  const boolFlags = new Set(["--sandbox", "--disable-slash-commands"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (i === 0 && wrapperPath && arg === wrapperPath) { result.push(arg); continue; }
    const rawFlag = arg.split("=", 1)[0]!;
    const flag = rawFlag.startsWith("-") ? `--${rawFlag.replace(/^-+/, "")}` : rawFlag;
    const inlineValue = arg.includes("=");
    if (flag === "--conversation") {
      if (!inlineValue) {
        if (i + 1 >= args.length || args[i + 1]!.startsWith("-")) throw new Error("Missing Antigravity conversation argument");
        i++;
      }
      continue;
    }
    if (["--continue", "--c", "--dangerously-skip-permissions"].includes(flag)) continue;
    if (valueFlags.has(flag)) {
      result.push(arg);
      if (!inlineValue) {
        if (i + 1 >= args.length) throw new Error("Missing Antigravity execution argument");
        result.push(args[++i]!);
      }
      continue;
    }
    if (boolFlags.has(flag) && !inlineValue) { result.push(arg); continue; }
    // Unknown current or future switches must not add plugins, tools, hooks,
    // workspace roots, a different agent, or a resumed conversation.
    throw new Error("Unsupported Antigravity argument in a restricted run");
  }
  if (!result.includes("--disable-slash-commands")) result.push("--disable-slash-commands");
  return result;
}

export function scopedMcpServer(settings: unknown, name: string): Record<string, unknown> {
  const source = (settings as { mcpServers?: Record<string, any> })?.mcpServers?.openclaw;
  if (!source || typeof source.url !== "string" || !source.headers || typeof source.headers !== "object") {
    throw new Error("Antigravity exact cap requires the host's captured MCP transport");
  }
  let url: URL;
  try { url = new URL(source.url); } catch { throw new Error("Invalid host MCP transport URL"); }
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/mcp") {
    throw new Error("Antigravity exact cap requires a loopback host MCP transport");
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(source.headers)) {
    if (typeof value !== "string" || value.includes("${") || /[\r\n]/.test(value)) {
      throw new Error("Antigravity exact-cap transport headers are not materialized");
    }
    headers[key] = value;
  }
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  if (!/^Bearer \S+$/.test(normalized.authorization ?? "") || !normalized["x-openclaw-cli-capture-key"]?.trim()) {
    throw new Error("Antigravity exact cap requires an active host capture binding");
  }
  // Do not merge global MCP configuration or carry other server definitions.
  return { name, serverUrl: url.href, headers };
}

export async function prepareExactToolExecution(params: {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
}): Promise<{ args: string[]; cleanup: () => Promise<void> }> {
  const encoded = params.env[EXACT_CAP_ENV];
  if (!encoded || encoded.length > 256000) throw new Error("Missing Antigravity exact cap");
  const cap = validateExactCap(JSON.parse(encoded));
  const args = restrictExecutionArgs(params.args);
  const { stdout } = await promisify(execFile)(params.command, ["--version"], {
    env: params.env, timeout: 10000, maxBuffer: 4096,
  });
  // Exact enforcement is a version-specific contract, not a semver promise.
  if (stdout.trim() !== "1.2.1") {
    throw new Error("Antigravity exact tool caps currently require verified agy 1.2.1");
  }
  // agy silently omits MCP servers with long names; keep the per-run alias short.
  const id = `oc-${randomBytes(8).toString("hex")}`;
  let settings: unknown;
  if (cap.openClaw.length > 0) {
    try { settings = JSON.parse(await fs.readFile(params.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH ?? "", "utf8")); }
    catch { throw new Error("Cannot read the captured host MCP settings for this restricted run"); }
  }
  const servers = cap.openClaw.length > 0 ? [scopedMcpServer(settings, id)] : [];
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agy-cap-"));
  const cleanup = () => fs.rm(root, { recursive: true, force: true });
  try {
    await fs.chmod(root, 0o700);
    const agentDir = path.join(root, ".agents", "agents");
    await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
    const guardDir = path.join(root, "guard");
    await generateGuardPlugin(guardDir, id, cap.openClaw);
    const agent = {
      name: id, description: "Host-scoped OpenClaw agent", mainAgent: true, subagent: false,
      excludeDefaultComponents: true, inheritCustomizations: false, inheritMcp: false,
      tools: [], mcpServers: servers, plugins: [guardDir],
    };
    const body = `You are Morrow, running a host-scoped OpenClaw task. Follow the host instructions in the request. ` +
      `All actions must use the MCP server named ${id}. Its available tools are ${cap.openClaw.join(", ") || "none"}. ` +
      `Use call_mcp_tool with that exact server name; native actions and other servers are unavailable. ` +
      `Do not start background work; complete the requested task synchronously.\n`;
    await fs.writeFile(path.join(agentDir, `${id}.md`), `---\n${JSON.stringify(agent, null, 2)}\n---\n${body}`, { mode: 0o600 });
    return { args: [...args, "--agent", id, "--add-dir", root], cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
