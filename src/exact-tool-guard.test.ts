import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { generateGuardPlugin } from "./exact-tool-guard.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

async function run(input: string, tools = ["read"]): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "guard-test-")); roots.push(root);
  await generateGuardPlugin(root, "test-server", tools);
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "guard.cjs")], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("error", reject);
    child.stdin.on("error", () => {});
    child.on("close", (code) => { code === 0 ? resolve(JSON.parse(out).decision) : reject(new Error(`guard exited ${code}`)); });
    child.stdin.end(input);
  });
}

const request = (name = "call_mcp_tool", server = "test-server", tool = "read") => JSON.stringify({ toolCall: { name, args: { ServerName: server, ToolName: tool } } });

describe("exact tool guard subprocess", () => {
  it("permits only the selected tool on the selected server", async () => {
    expect(await run(request())).toBe("allow");
    expect(await run(request("call_mcp_tool", "ambient-server"))).toBe("deny");
    expect(await run(request("call_mcp_tool", "test-server", "exec"))).toBe("deny");
  });
  it("blocks native actions and the empty cap", async () => {
    expect(await run(request("manage_task"))).toBe("deny");
    expect(await run(request(), [])).toBe("deny");
  });
  it("fails closed on malformed, missing, or oversized input", async () => {
    for (const input of ["not json", "{}", "null", " ".repeat(66000)]) expect(await run(input)).toBe("deny");
  });
});
