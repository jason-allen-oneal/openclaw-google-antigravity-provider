#!/usr/bin/env node
// Thin wrapper that OpenClaw spawns instead of raw `agy`.
//
// Two jobs:
//
// (1) Strip the openclaw-injected `⟦openclaw:ctx⟧` channel-context blocks
//     from the `--print` argv value. OpenClaw's cli-runner composes the
//     turn prompt with channel context prepended AFTER every registered
//     before_prompt_build hook, so a plugin hook can't remove those
//     blocks. When the backend has native session persistence
//     (agy `--conversation <id>`) that context is duplicate history and
//     compounds every turn — the fix has to sit at the spawn boundary.
//
// (2) Bridge OpenClaw's loopback MCP server into
//     `~/.gemini/config/mcp_config.json` (agy's HOME-level MCP config).
//     OpenClaw runs the MCP capture attempt AFTER our
//     `prepareExecution` returns — it updates
//     `GEMINI_CLI_SYSTEM_SETTINGS_PATH` to point at settings that carry
//     the resolved `x-openclaw-cli-capture-key`. Writing the bridge
//     inside `prepareExecution` reads the pre-capture settings (empty
//     key → auth fails). Writing here reads the post-capture settings.
//
// Everything else (stdio streaming, exit code, signal handling) is
// inherited so OpenClaw's stream-json parser and cancellation still work.

import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { applyOpenClawMcpBridge, resolveAgyMcpConfigPath } from "./mcp-bridge.ts";
import { stripArgvChannelContext } from "./prompt-strip.ts";

function resolveRealAgy(env: NodeJS.ProcessEnv): string {
  return env.OPENCLAW_ANTIGRAVITY_REAL_COMMAND?.trim() || "agy";
}

async function applyBridge(env: NodeJS.ProcessEnv): Promise<(() => Promise<void>) | undefined> {
  if (env.OPENCLAW_ANTIGRAVITY_EXPOSE_TOOLS === "false") return undefined;
  const settingsPath = env.GEMINI_CLI_SYSTEM_SETTINGS_PATH?.trim();
  if (!settingsPath) return undefined;
  try {
    await fsp.access(settingsPath);
  } catch {
    return undefined;
  }
  try {
    const bridged = await applyOpenClawMcpBridge({
      settingsPath,
      agyConfigPath: resolveAgyMcpConfigPath(env),
    });
    return bridged?.cleanup;
  } catch {
    // MCP bridging is an enhancement; a failed write must not stop the
    // turn — agy just runs without OpenClaw tools this time.
    return undefined;
  }
}

async function main(): Promise<never> {
  const strippedArgs = stripArgvChannelContext(process.argv.slice(2));
  const command = resolveRealAgy(process.env);
  const cleanup = await applyBridge(process.env);

  const child = spawn(command, strippedArgs, {
    stdio: "inherit",
    env: process.env,
  });

  const forward = (signal: NodeJS.Signals) => {
    if (!child.killed) child.kill(signal);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => forward(signal));
  }

  return await new Promise<never>((_, reject) => {
    child.on("error", async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `google-antigravity-cli wrapper: failed to spawn "${command}": ${message}\n`,
      );
      await cleanup?.().catch(() => undefined);
      reject(err);
      process.exit(127);
    });
    child.on("exit", async (code, signal) => {
      await cleanup?.().catch(() => undefined);
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exit(code ?? 1);
    });
  });
}

main().catch((err) => {
  process.stderr.write(
    `google-antigravity-cli wrapper: fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});

// Silences an unused-import warning that would otherwise flag `path` when
// bundle configuration excludes the fallback branch above.
void path;
