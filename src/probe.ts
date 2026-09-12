import { spawnSync, type SpawnSyncReturns } from "node:child_process";

export const REQUIRED_AGY_FLAGS = [
  "--print",
  "--model",
  "--print-timeout",
];

export type AgyProbeResult =
  | { ok: true; helpText: string }
  | { ok: false; reason: string };

function toText(value: unknown): string {
  if (typeof value === "string") return value;
  return value ? (value as Buffer).toString("utf8") : "";
}

// `agy --help` phones home to Google (version + catalog warm-up) and can
// take 30-45s on a cold cache — impractical inside a synchronous auth
// wizard. Detect the binary via `which` / `where` instead, which is instant.
// Full flag validation runs lazily against cached help output if provided.
export function runAgyExistsCheck(command = "agy"): SpawnSyncReturns<string> {
  const which = process.platform === "win32" ? "where" : "which";
  return spawnSync(which, [command], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
  });
}

// Preserved for callers that want the full help text (e.g. maintenance
// commands). Uses a generous timeout because agy contacts Google.
export function runAgyHelp(command = "agy"): SpawnSyncReturns<string> {
  return spawnSync(command, ["--help"], {
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
}

export function probeAgy(
  runner: () => SpawnSyncReturns<string> = () => runAgyExistsCheck(),
): AgyProbeResult {
  const result = runner();
  if (result.error) {
    return {
      ok: false,
      reason: `agy CLI not found on PATH: ${result.error.message}`,
    };
  }
  const stdout = toText(result.stdout).trim();
  const stderr = toText(result.stderr).trim();

  // Legacy runner shape (agy --help): status 0 + flag list in stdout.
  // Backwards-compat for callers/tests that inject the full help output.
  if (stdout.startsWith("Usage:") || REQUIRED_AGY_FLAGS.some((flag) => stdout.includes(flag))) {
    if (result.status !== 0) {
      return {
        ok: false,
        reason: stderr
          ? `agy exited with status ${String(result.status)}: ${stderr}`
          : `agy exited with status ${String(result.status)}`,
      };
    }
    const helpText = [stdout, stderr].join("\n").trim();
    const missingFlags = REQUIRED_AGY_FLAGS.filter((flag) => !helpText.includes(flag));
    if (missingFlags.length > 0) {
      return {
        ok: false,
        reason: `agy --help is missing required flags: ${missingFlags.join(", ")}`,
      };
    }
    return { ok: true, helpText };
  }

  // New runner shape (which agy): status 0 + resolved path in stdout.
  if (result.status !== 0) {
    return {
      ok: false,
      reason: stderr
        ? `agy not found on PATH (exit ${String(result.status)}): ${stderr}`
        : `agy not found on PATH (exit ${String(result.status)}). Install from https://antigravity.google/download and sign in with \`agy\`.`,
    };
  }
  return { ok: true, helpText: stdout };
}
