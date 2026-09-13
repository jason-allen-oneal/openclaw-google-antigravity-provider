import fs from "node:fs/promises";
import path from "node:path";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function generateGuardPlugin(rootDir: string, allowedServerName: string, allowedToolNames: readonly string[]): Promise<void> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(allowedServerName) ||
      allowedToolNames.some((name) => !/^[a-zA-Z0-9_.:-]{1,200}$/.test(name))) {
    throw new Error("Invalid exact tool guard policy");
  }
  await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
  await fs.chmod(rootDir, 0o700);
  const guardPath = path.join(rootDir, "guard.cjs");
  const script = `"use strict";
const server = ${JSON.stringify(allowedServerName)};
const tools = new Set(${JSON.stringify([...new Set(allowedToolNames)])});
let size = 0;
let finished = false;
const chunks = [];
function decide(allow) {
  if (finished) return;
  finished = true;
  process.stdin.pause();
  process.stdout.write(JSON.stringify({decision: allow ? "allow" : "deny", reason: "OpenClaw exact tool cap"}) + "\\n", () => process.exit(0));
}
process.stdin.on("data", (chunk) => {
  size += chunk.length;
  if (size > 65536) return decide(false);
  chunks.push(chunk);
});
process.stdin.on("error", () => decide(false));
process.stdin.on("end", () => {
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const call = input && input.toolCall;
    const args = call && call.args;
    decide(Boolean(call && call.name === "call_mcp_tool" && args && !Array.isArray(args) && args.ServerName === server && tools.has(args.ToolName)));
  } catch { decide(false); }
});
setTimeout(() => decide(false), 1500).unref();
`;
  await fs.writeFile(guardPath, script, { mode: 0o600 });
  await fs.writeFile(path.join(rootDir, "plugin.json"), JSON.stringify({
    name: allowedServerName, description: "Host-owned exact tool execution policy",
  }), { mode: 0o600 });
  await fs.writeFile(path.join(rootDir, "hooks.json"), JSON.stringify({
    "openclaw-exact-cap": { PreToolUse: [{ matcher: "*", hooks: [{
      type: "command", command: `${shellQuote(process.execPath)} ${shellQuote(guardPath)}`, timeout: 3,
    }] }] },
  }), { mode: 0o600 });
}
