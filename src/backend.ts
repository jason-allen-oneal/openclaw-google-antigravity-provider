import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { DEFAULT_PRINT_TIMEOUT, formatGoDuration } from "./config.js";
import { applyOpenClawMcpBridge, resolveAgyMcpConfigPath } from "./mcp-bridge.js";
import { EXACT_CAP_ENV, restrictExecutionArgs, validateExactCap } from "./exact-tools.ts";

type CliBackendPlugin = Parameters<OpenClawPluginApi["registerCliBackend"]>[0];
type CliBackendConfig = CliBackendPlugin["config"];
type CliBackendNormalizeConfigContext = Parameters<
  NonNullable<CliBackendPlugin["normalizeConfig"]>
>[1];
type CliBackendResolveExecutionArgsContext = Parameters<
  NonNullable<CliBackendPlugin["resolveExecutionArgs"]>
>[0];

export const GOOGLE_ANTIGRAVITY_PROVIDER_ID = "google-antigravity-cli";

// How agy is allowed to run tools. agy cannot prompt for a permission in
// headless `--print` mode — it auto-denies and returns
//   "a tool required the \"read_file\" permission that headless mode cannot
//    prompt for, so it was auto-denied"
// so *some* policy has to be chosen up front.
//
//   skip     `--dangerously-skip-permissions`; auto-approves every tool.
//            Default, because it is the only mode that works out of the box.
//   sandbox  `--sandbox`; agy runs with terminal restrictions enabled.
//   settings neither flag; agy falls back to `permissions.allow` in
//            ~/.gemini/antigravity-cli/settings.json, which is the least
//            privileged option but needs rules for the tools you expect.
export type AntigravityPermissionMode = "skip" | "sandbox" | "settings";

export const SKIP_PERMISSIONS_FLAG = "--dangerously-skip-permissions";
export const SANDBOX_FLAG = "--sandbox";
export const DEFAULT_PERMISSION_MODE: AntigravityPermissionMode = "skip";

export function resolvePermissionMode(
  value: unknown,
): AntigravityPermissionMode {
  return value === "sandbox" || value === "settings" || value === "skip"
    ? value
    : DEFAULT_PERMISSION_MODE;
}

// Rewrites whichever permission flag the base args carry into the configured
// mode, so a user override is honoured without the caller having to know which
// flag the defaults happened to ship with.
export function applyPermissionMode(
  args: readonly string[],
  mode: AntigravityPermissionMode,
): string[] {
  const stripped = args.filter(
    (arg) => arg !== SKIP_PERMISSIONS_FLAG && arg !== SANDBOX_FLAG,
  );
  if (mode === "skip") stripped.push(SKIP_PERMISSIONS_FLAG);
  else if (mode === "sandbox") stripped.push(SANDBOX_FLAG);
  return stripped;
}
export const GOOGLE_ANTIGRAVITY_DEFAULT_MODEL_REF =
  "google-antigravity-cli/gemini-3.7-flash";

export const GOOGLE_ANTIGRAVITY_MODEL_ALIASES: Record<string, string> = {
  // Bare shortcuts map to the base family, where the thinking-level slider
  // supplies the effort at execution time. Shortcuts that *name* an effort
  // resolve to the matching effort-baked id instead — collapsing them to the
  // base family would drop the level the user explicitly asked for and let
  // the slider silently override it.
  flash: "gemini-3.7-flash",
  "flash-high": "gemini-3.7-flash-high",
  "flash-medium": "gemini-3.7-flash-medium",
  "flash-low": "gemini-3.7-flash-low",
  pro: "gemini-3.1-pro",
  // agy publishes Pro as high/low only — there is no `gemini-3.1-pro-medium`.
  "pro-low": "gemini-3.1-pro-low",
  "pro-high": "gemini-3.1-pro-high",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-6-thinking",
  gpt: "gpt-oss-120b-medium",
  // Base identity aliases (canonical).
  "gemini-3.8-flash": "gemini-3.8-flash",
  "gemini-3.7-flash": "gemini-3.7-flash",
  "gemini-3.6-flash": "gemini-3.6-flash",
  "gemini-3.1-pro": "gemini-3.1-pro",
  "claude-sonnet-4-6": "claude-sonnet-4-6",
  "claude-opus-4-6-thinking": "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium": "gpt-oss-120b-medium",
  // Effort-baked identity aliases kept for existing configs: agy still
  // accepts them, and the ID already carries the effort so nothing extra
  // needs to be injected.
  "gemini-3.8-flash-high": "gemini-3.8-flash-high",
  "gemini-3.8-flash-medium": "gemini-3.8-flash-medium",
  "gemini-3.8-flash-low": "gemini-3.8-flash-low",
  "gemini-3.7-flash-high": "gemini-3.7-flash-high",
  "gemini-3.7-flash-medium": "gemini-3.7-flash-medium",
  "gemini-3.7-flash-low": "gemini-3.7-flash-low",
  "gemini-3.6-flash-high": "gemini-3.6-flash-high",
  "gemini-3.6-flash-medium": "gemini-3.6-flash-medium",
  "gemini-3.6-flash-low": "gemini-3.6-flash-low",
  "gemini-3.1-pro-low": "gemini-3.1-pro-low",
  "gemini-3.1-pro-high": "gemini-3.1-pro-high",
  // Legacy dotted aliases from earlier README examples.
  "claude-sonnet-4.6": "claude-sonnet-4-6",
  "claude-opus-4.6": "claude-opus-4-6-thinking",
  "gpt-oss-120b": "gpt-oss-120b-medium",
};

export type AgyEffort = "low" | "medium" | "high";

// Effort used when a model needs `--effort` but openclaw gave us no usable
// thinking level. agy has no "off", so the slider being off or unset lands on
// its cheapest setting rather than silently upgrading the request.
export const DEFAULT_AGY_EFFORT: AgyEffort = "low";

// Openclaw exposes eight canonical thinking levels; agy accepts three.
// `off`/`minimal`/`low` → `low`, `medium`/`adaptive` → `medium`,
// `high`/`xhigh`/`max` → `high`. An unrecognized or missing level returns
// `undefined`; callers that must supply an effort fall back to
// DEFAULT_AGY_EFFORT.
export function mapThinkingLevelToAgyEffort(
  level?: string,
): AgyEffort | undefined {
  switch (level) {
    case "off":
    case "minimal":
    case "low":
      return "low";
    case "medium":
    case "adaptive":
      return "medium";
    case "high":
    case "xhigh":
    case "max":
      return "high";
    default:
      return undefined;
  }
}

// Effort-baked model IDs (e.g. `gemini-3.7-flash-high`) already carry the
// level via the ID itself; injecting `--effort` on top is redundant. Keep
// the injection behavior strictly opt-in per model.
export function modelIdHasBakedEffort(modelId: string): boolean {
  if (!modelId.startsWith("gemini-")) return false;
  return /-(?:high|medium|low)$/.test(modelId);
}

// Only the Gemini families take `--effort`. agy rejects the flag outright for
// the others:
//   invalid model selection (--model "claude-sonnet-4-6" --effort "high"):
//   --effort is not supported for model "claude-sonnet-4-6"
// GPT-OSS is published as `gpt-oss-120b-medium`, i.e. its level is part of the
// id, so it needs nothing injected either.
export function modelSupportsEffortFlag(modelId: string): boolean {
  return modelId.startsWith("gemini-");
}

// Collapsed Gemini base ids do not exist in agy's own catalog — `agy models`
// only lists the effort-baked rows — so agy refuses to run them bare:
//   --model gemini-3.7-flash requires --effort (available: low, medium, high)
// Any Gemini id without a baked suffix therefore *must* carry `--effort`.
export function modelRequiresEffortFlag(modelId: string): boolean {
  return modelSupportsEffortFlag(modelId) && !modelIdHasBakedEffort(modelId);
}

const EFFORT_ORDER: readonly AgyEffort[] = ["low", "medium", "high"];

// Not every family offers all three levels. `agy models` lists Pro as only
// `gemini-3.1-pro-high` and `gemini-3.1-pro-low`, and agy rejects the middle:
//   invalid model selection (--model "gemini-3.1-pro" --effort "medium"):
//   gemini-3.1-pro has no "medium" effort (available: low, high)
// Families absent from this map are assumed to offer all three, which matches
// every Flash row agy currently publishes.
const MODEL_AVAILABLE_EFFORTS: Record<string, readonly AgyEffort[]> = {
  "gemini-3.1-pro": ["low", "high"],
};

export function availableEffortsForModel(modelId: string): readonly AgyEffort[] {
  return MODEL_AVAILABLE_EFFORTS[modelId] ?? EFFORT_ORDER;
}

// Snap a requested effort onto what the family actually supports. Ties break
// downward, so a `medium` slider on Pro resolves to `low` rather than silently
// upgrading the request to `high`.
export function clampEffortForModel(modelId: string, effort: AgyEffort): AgyEffort {
  const available = availableEffortsForModel(modelId);
  if (available.includes(effort)) return effort;
  const target = EFFORT_ORDER.indexOf(effort);
  let best = available[0]!;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of available) {
    const distance = Math.abs(EFFORT_ORDER.indexOf(candidate) - target);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

const CONVERSATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function resolveHomeDir(env: NodeJS.ProcessEnv): string {
  return normalizeOptionalString(env.HOME) ?? os.homedir();
}

export function resolveAntigravityDataDir(env: NodeJS.ProcessEnv): string {
  const homeDir = resolveHomeDir(env);
  const configured = normalizeOptionalString(env.ANTIGRAVITY_USER_DATA_DIR);
  if (!configured) return path.join(homeDir, ".gemini", "antigravity-cli");
  if (configured === "~") return homeDir;
  if (configured.startsWith("~/")) return path.join(homeDir, configured.slice(2));
  return path.resolve(configured);
}

export async function readConversationCache(
  cachePath: string,
): Promise<Record<string, string> | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(cachePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  // agy writes this file synchronously at turn end but a killed / crashed
  // process can leave it truncated. Treat malformed JSON the same as
  // "cache missing" — the caller falls back to launching a fresh
  // conversation instead of crashing the turn.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(
      `[google-antigravity-cli] ignoring malformed conversation cache at ${cachePath}: ${
        (error as Error).message
      }`,
    );
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, string>;
}

// Windows and macOS both default to case-insensitive filesystems, so agy and
// openclaw can name the same directory differently (`C:\\Users\\Chris` vs
// `c:\\users\\chris`). Windows additionally accepts either separator. An exact
// string miss here is not cosmetic: it makes captureSessionId throw, which
// drops the session binding, restarts the agy conversation every turn, and
// with it the accumulated prompt cache.
const CASE_INSENSITIVE_FS =
  process.platform === "win32" || process.platform === "darwin";

function normalizeCwdKey(value: string): string {
  // path.normalize is platform-native, so it unifies separators on Windows
  // and leaves POSIX paths alone. Trailing separators are dropped so
  // `/work` and `/work/` compare equal.
  const normalized = path.normalize(value).replace(/[\\/]+$/, "");
  return CASE_INSENSITIVE_FS ? normalized.toLowerCase() : normalized;
}

function validConversationId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return CONVERSATION_ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

export async function resolveCachedConversationId(params: {
  cachePath: string;
  cwd: string;
}): Promise<string | undefined> {
  const cache = await readConversationCache(params.cachePath);
  if (!cache) return undefined;
  const cwdCandidates = new Set<string>([params.cwd, path.resolve(params.cwd)]);
  try {
    cwdCandidates.add(await fs.realpath(params.cwd));
  } catch {}

  // Exact match first: cheapest, and authoritative when agy wrote the key
  // exactly as openclaw spells it.
  for (const cwd of cwdCandidates) {
    const exact = validConversationId(cache[cwd]);
    if (exact) return exact;
  }

  // Then a normalized sweep for separator, trailing-slash, and case drift.
  const wanted = new Set([...cwdCandidates].map(normalizeCwdKey));
  for (const [key, value] of Object.entries(cache)) {
    if (!wanted.has(normalizeCwdKey(key))) continue;
    const match = validConversationId(value);
    if (match) return match;
  }
  return undefined;
}

function resolvePluginConfig(
  cfg?: Record<string, any>,
  providerId?: string,
): Record<string, any> | undefined {
  return (
    cfg?.plugins?.entries?.[providerId ?? GOOGLE_ANTIGRAVITY_PROVIDER_ID]?.config ??
    cfg?.plugins?.entries?.[GOOGLE_ANTIGRAVITY_PROVIDER_ID]?.config
  );
}

export type ParsedCliBackendEvent =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | {
      kind: "toolStart";
      toolCallId: string;
      name: string;
      args?: Record<string, unknown>;
    }
  | {
      kind: "toolResult";
      toolCallId: string;
      name?: string;
      isError?: boolean;
      result?: unknown;
    }
  | {
      kind: "result";
      text?: string;
      sessionId?: string;
      usage?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        total?: number;
      };
      errorText?: string;
    }
  | { kind: "sessionId"; sessionId: string };

export function parseGoogleAntigravityJsonlEvent(
  line: string,
  _ctx?: { backendId: string; backend: Readonly<CliBackendConfig> },
): ParsedCliBackendEvent | readonly ParsedCliBackendEvent[] | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("{")) {
    return null;
  }

  let record: any;
  try {
    record = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!record || typeof record !== "object") {
    return null;
  }

  const events: ParsedCliBackendEvent[] = [];

  // 1. Session initialization
  if (record.event === "init" && typeof record.conversation_id === "string") {
    events.push({ kind: "sessionId", sessionId: record.conversation_id });
  }

  // 2. Incremental step updates (thinking, text, and tools)
  if (record.event === "step_update" && record.step_update) {
    const step = record.step_update;

    // Reasoning / thinking deltas
    const thoughtDelta =
      step.thought_delta ??
      step.thinking_delta ??
      step.reasoning_delta ??
      (step.step_type === "thinking" ? (step.delta ?? step.text) : undefined);
    if (typeof thoughtDelta === "string" && thoughtDelta.length > 0) {
      events.push({ kind: "thinking", text: thoughtDelta });
    }

    // Response text deltas
    const textDelta =
      step.text_delta ??
      (step.step_type === "agent_response" ? (step.delta ?? step.text_delta) : undefined);
    if (typeof textDelta === "string" && textDelta.length > 0) {
      events.push({ kind: "text", text: textDelta });
    }

    // Tool execution lifecycle
    if (step.step_type === "tool") {
      const toolCallId = `call_${step.step_index ?? Date.now()}`;
      const toolName = step.tool_name ?? step.tool_info?.name ?? "tool";

      if (step.state === "ACTIVE") {
        events.push({
          kind: "toolStart",
          toolCallId,
          name: toolName,
          args: step.tool_info?.parameters,
        });
      } else if (step.state === "DONE" || step.state === "ERROR") {
        events.push({
          kind: "toolResult",
          toolCallId,
          name: toolName,
          isError: step.state === "ERROR",
          result: step.tool_info?.output ?? step.output,
        });
      }
    }
  }

  // 3. Terminal result or execution failure
  if (record.event === "result" && record.result) {
    const res = record.result;
    const usage = res.usage
      ? {
          input: typeof res.usage.input_tokens === "number" ? res.usage.input_tokens : undefined,
          output: typeof res.usage.output_tokens === "number" ? res.usage.output_tokens : undefined,
          cacheRead:
            typeof res.usage.cache_read_tokens === "number"
              ? res.usage.cache_read_tokens
              : undefined,
          total: typeof res.usage.total_tokens === "number" ? res.usage.total_tokens : undefined,
        }
      : undefined;

    if (res.status === "ERROR" || res.status === "FAILED") {
      if (typeof res.response === "string" && res.response.trim().length > 0) {
        events.push({
          kind: "result",
          text: res.response,
          sessionId: typeof res.conversation_id === "string" ? res.conversation_id : undefined,
          usage,
        });
      } else {
        events.push({
          kind: "result",
          errorText: res.error || res.message || "Antigravity CLI execution error",
        });
      }
    } else {
      events.push({
        kind: "result",
        text:
          typeof res.response === "string" ? res.response : "",
        sessionId: typeof res.conversation_id === "string" ? res.conversation_id : undefined,
        usage,
      });
    }
  }

  if (events.length === 0) {
    return typeof record.event === "string" ? [] : null;
  }
  if (events.length === 1) return events[0];
  return events;
}

export function normalizeGoogleAntigravityBackendConfig(
  config: CliBackendConfig,
  context?: CliBackendNormalizeConfigContext,
): CliBackendConfig {
  const cfg = context?.config as Record<string, any> | undefined;
  const pluginConfig = resolvePluginConfig(cfg, context?.backendId);
  const backendConfig =
    (context?.backendId ? cfg?.agents?.defaults?.cliBackends?.[context.backendId] : undefined) ??
    cfg?.agents?.defaults?.cliBackends?.[GOOGLE_ANTIGRAVITY_PROVIDER_ID] ??
    pluginConfig;

  const streamEnabled =
    backendConfig?.stream === true ||
    backendConfig?.streaming === true ||
    backendConfig?.output === "jsonl" ||
    backendConfig?.outputFormat === "stream-json" ||
    pluginConfig?.stream === true ||
    pluginConfig?.streaming === true;

  const streamDisabled =
    backendConfig?.stream === false ||
    backendConfig?.streaming === false ||
    pluginConfig?.stream === false ||
    pluginConfig?.streaming === false ||
    backendConfig?.output === "text" ||
    backendConfig?.outputFormat === "text";

  if (streamDisabled) {
    return {
      ...config,
      output: "text",
      resumeOutput: "text",
    };
  }

  if (streamEnabled) {
    return {
      ...config,
      output: "jsonl",
      resumeOutput: "jsonl",
    };
  }

  return config;
}

// agy stores every subagent invocation, every task-status update and every
// `manage_task` result forever in the conversation's SQLite (see the
// step_type histogram in docs/AGY_STEP_SCHEMA.md — a chat with a lot of
// background work can hit millions of tokens of replay just from that).
// When we `--conversation <id>` into such a DB agy replays *everything*
// on the next turn, blowing the model's context window. Above this
// byte threshold we drop `--conversation` so agy starts a fresh
// conversation; the openclaw catch-up hook then re-seeds the recent
// turns it needs to keep going.
export const DEFAULT_MAX_RESUME_DB_BYTES = 2_000_000;

export function resumeGuardEnabled(
  pluginConfig: Record<string, any> | undefined,
  backendConfig: Record<string, any> | undefined,
): { enabled: boolean; limitBytes: number } {
  const raw =
    backendConfig?.maxResumeDbBytes ??
    pluginConfig?.maxResumeDbBytes;
  if (raw === false) return { enabled: false, limitBytes: 0 };
  const n = typeof raw === "number" && raw > 0 ? raw : DEFAULT_MAX_RESUME_DB_BYTES;
  return { enabled: true, limitBytes: n };
}

// If `--conversation <id>` is in `args` and its SQLite on disk is over
// `limitBytes`, strip both tokens so agy starts a fresh conversation.
// Returns the resulting args and, on drop, the conversation id + size for
// logging.
export function dropOversizedResume(
  args: readonly string[],
  dataDir: string,
  limitBytes: number,
): { args: string[]; dropped?: { conversationId: string; bytes: number } } {
  const flagIdx = args.indexOf("--conversation");
  if (flagIdx < 0 || flagIdx + 1 >= args.length) return { args: [...args] };
  const conversationId = args[flagIdx + 1]!;
  if (!conversationId || conversationId.startsWith("{")) return { args: [...args] };
  const dbPath = path.join(dataDir, "conversations", `${conversationId}.db`);
  let bytes = 0;
  try {
    bytes = fsSync.statSync(dbPath).size;
  } catch {
    // Missing db: let agy handle it (it'll recreate). Don't strip — the
    // caller may have deliberately named a conversation that will be
    // created on this run.
    return { args: [...args] };
  }
  if (bytes <= limitBytes) return { args: [...args] };
  const next = args.slice(0, flagIdx).concat(args.slice(flagIdx + 2));
  return { args: next, dropped: { conversationId, bytes } };
}

export function resolveGoogleAntigravityExecutionArgs(
  context: CliBackendResolveExecutionArgsContext,
  options: { dataDir?: string; env?: NodeJS.ProcessEnv } = {},
): string[] {
  const cfg = context.config as Record<string, any> | undefined;
  const providerId = context.provider || GOOGLE_ANTIGRAVITY_PROVIDER_ID;
  const pluginConfig = resolvePluginConfig(cfg, providerId);
  const backendConfig =
    cfg?.agents?.defaults?.cliBackends?.[providerId] ??
    cfg?.agents?.defaults?.cliBackends?.[GOOGLE_ANTIGRAVITY_PROVIDER_ID] ??
    pluginConfig;

  const configuredTimeout =
    backendConfig?.printTimeout ??
    pluginConfig?.printTimeout ??
    cfg?.agents?.defaults?.models?.[context.modelId]?.params?.timeoutSeconds ??
    cfg?.agents?.defaults?.models?.[`${providerId}/*`]?.params?.timeoutSeconds ??
    cfg?.agents?.defaults?.models?.[`${GOOGLE_ANTIGRAVITY_PROVIDER_ID}/*`]?.params?.timeoutSeconds ??
    cfg?.agents?.defaults?.timeoutSeconds;

  const timeoutStr = formatGoDuration(configuredTimeout, DEFAULT_PRINT_TIMEOUT);
  let args = applyPermissionMode(
    context.baseArgs,
    resolvePermissionMode(
      backendConfig?.permissionMode ?? pluginConfig?.permissionMode,
    ),
  );

  const guard = resumeGuardEnabled(pluginConfig, backendConfig);
  if (guard.enabled) {
    const dataDir = options.dataDir ?? resolveAntigravityDataDir(options.env ?? process.env);
    const guarded = dropOversizedResume(args, dataDir, guard.limitBytes);
    args = guarded.args;
    if (guarded.dropped) {
      // eslint-disable-next-line no-console
      console.warn(
        `[google-antigravity-cli] dropping --conversation ${guarded.dropped.conversationId} ` +
          `(${(guarded.dropped.bytes / 1_000_000).toFixed(1)}MB > ${(guard.limitBytes / 1_000_000).toFixed(1)}MB cap); ` +
          `agy will start a fresh conversation and openclaw's catch-up hook will re-seed recent turns.`,
      );
    }
  }
  const timeoutIndex = args.indexOf("--print-timeout");

  if (timeoutIndex !== -1 && timeoutIndex + 1 < args.length) {
    args[timeoutIndex + 1] = timeoutStr;
  } else {
    args.push("--print-timeout", timeoutStr);
  }

  // Streaming/JSONL mode is enabled by default to capture conversation IDs and live deltas
  const streamDisabled =
    backendConfig?.stream === false ||
    backendConfig?.streaming === false ||
    pluginConfig?.stream === false ||
    pluginConfig?.streaming === false ||
    backendConfig?.output === "text" ||
    backendConfig?.outputFormat === "text";

  if (streamDisabled) {
    const outputIndex = args.indexOf("--output-format");
    if (outputIndex !== -1) {
      args.splice(outputIndex, outputIndex + 1 < args.length ? 2 : 1);
    }
  } else if (!args.includes("--output-format")) {
    args.push("--output-format", "stream-json");
  }

  // Wire openclaw's thinking-level slider into agy's `--effort` flag. Only
  // collapsed Gemini base ids take the flag, and for them it is mandatory —
  // agy refuses to run them without it. Every other family either rejects
  // `--effort` outright (Claude) or bakes its level into the id (GPT-OSS,
  // effort-suffixed Gemini rows), so they get nothing injected.
  const rawModelId = context.modelId?.trim() ?? "";
  const modelIdWithoutProvider = rawModelId.includes("/")
    ? rawModelId.slice(rawModelId.lastIndexOf("/") + 1)
    : rawModelId;
  if (
    modelRequiresEffortFlag(modelIdWithoutProvider) &&
    !args.includes("--effort")
  ) {
    // The slider being off or unset resolves to DEFAULT_AGY_EFFORT rather
    // than omitting the flag, which would make agy reject the run.
    const requested =
      mapThinkingLevelToAgyEffort(context.thinkingLevel) ?? DEFAULT_AGY_EFFORT;
    args.push("--effort", clampEffortForModel(modelIdWithoutProvider, requested));
  }

  if (context.toolAvailability !== undefined) {
    // Exact-cap argv rewriting is only safe when the wrapper that materializes
    // the per-run agent and PreToolUse guard is the configured entrypoint. The
    // wrapper path is an allowed leading token; all other caller-supplied
    // agent/workspace/tool-selection flags remain rejected by the helper.
    const wrapper = resolveAgyWrapperInvocation();
    if (!wrapper.wrapperPath) {
      throw new Error(
        "Antigravity exact tool caps require the scoped CLI wrapper",
      );
    }
    return restrictExecutionArgs(args, wrapper.wrapperPath);
  }
  return args;
}

// Publishing into agy's HOME-level MCP config is a shared-file side effect, so
// it can be turned off without disabling the rest of the backend.
export function exposeOpenClawTools(
  cfg: Record<string, any> | undefined,
  providerId?: string,
): boolean {
  const backendConfig =
    cfg?.agents?.defaults?.cliBackends?.[providerId ?? GOOGLE_ANTIGRAVITY_PROVIDER_ID];
  const pluginConfig = resolvePluginConfig(cfg, providerId);
  const value = backendConfig?.exposeOpenClawTools ?? pluginConfig?.exposeOpenClawTools;
  return value !== false;
}

// Resolves the strip-wrapper's on-disk path. The wrapper lives next to this
// module in dist/. We prepend `node <wrapper>` to the args (instead of
// relying on a `#!/usr/bin/env node` shebang) so exec-bit-less filesystems
// (FAT/exFAT on USB transfers, some Windows shares) don't break spawn.
function resolveAgyWrapperInvocation(): { command: string; wrapperPath: string | null } {
  try {
    const here = fileURLToPath(new URL(".", import.meta.url));
    const wrapper = [
      path.join(here, "agy-strip-wrapper.js"),
      path.join(here, "agy-strip-wrapper.ts"),
    ].find((candidate) => fsSync.existsSync(candidate));
    return wrapper
      ? { command: process.execPath, wrapperPath: wrapper }
      : { command: "agy", wrapperPath: null };
  } catch {
    // If we can't resolve the wrapper (unlikely — the module has to load
    // from somewhere), fall back to spawning raw agy. That drops the
    // context-strip optimisation but preserves core functionality.
    return { command: "agy", wrapperPath: null };
  }
}

type ExactCapWrapperConfigSnapshot = {
  command: string;
  args: readonly string[];
  resumeArgs: readonly string[];
};

function sameStringArray(left: unknown, right: readonly string[]): boolean {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    left.every((value, index) => typeof value === "string" && value === right[index])
  );
}

const EXACT_CAP_CONTINUATION_CONFIG_KEYS = [
  "sessionArgs",
  "forkArg",
  "resumeAtArg",
] as const;

function assertNoExactCapContinuationOverrides(
  value: Record<string, unknown>,
): void {
  for (const key of EXACT_CAP_CONTINUATION_CONFIG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined) {
      throw new Error(
        `Antigravity exact tool caps reject CLI ${key} override`,
      );
    }
  }
}

function assertExactCapBackendConfig(params: {
  backend: CliBackendPlugin;
  backendId: string;
  config: unknown;
  wrapper: { command: string; wrapperPath: string | null };
  snapshot: ExactCapWrapperConfigSnapshot | undefined;
}): void {
  const { backend, backendId, config, wrapper, snapshot } = params;
  const backendConfig = backend.config as {
    command?: unknown;
    args?: unknown;
    resumeArgs?: unknown;
    sessionArgs?: unknown;
    forkArg?: unknown;
    resumeAtArg?: unknown;
  };

  assertNoExactCapContinuationOverrides(backendConfig);

  if (
    !snapshot ||
    !wrapper.wrapperPath ||
    wrapper.command !== process.execPath ||
    snapshot.command !== wrapper.command ||
    snapshot.args[0] !== wrapper.wrapperPath ||
    snapshot.resumeArgs[0] !== wrapper.wrapperPath ||
    backendConfig.command !== snapshot.command ||
    !sameStringArray(backendConfig.args, snapshot.args) ||
    !sameStringArray(backendConfig.resumeArgs, snapshot.resumeArgs)
  ) {
    throw new Error("Antigravity exact tool caps require the scoped CLI wrapper");
  }

  const root = config as {
    agents?: { defaults?: { cliBackends?: unknown } };
  } | undefined;
  const entries = root?.agents?.defaults?.cliBackends;
  if (entries === undefined) return;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    throw new Error("Antigravity exact tool caps reject invalid CLI backend configuration");
  }

  const table = entries as Record<string, unknown>;
  const selected = table[backendId] ?? table[GOOGLE_ANTIGRAVITY_PROVIDER_ID];
  if (selected === undefined) return;
  if (!selected || typeof selected !== "object" || Array.isArray(selected)) {
    throw new Error("Antigravity exact tool caps reject invalid CLI backend configuration");
  }

  const override = selected as Record<string, unknown>;
  assertNoExactCapContinuationOverrides(override);
  const hasOwn = (key: string) => Object.prototype.hasOwnProperty.call(override, key);
  if (hasOwn("command") && override.command !== snapshot.command) {
    throw new Error("Antigravity exact tool caps reject a CLI command override");
  }
  if (hasOwn("args") && !sameStringArray(override.args, snapshot.args)) {
    throw new Error("Antigravity exact tool caps reject a CLI args override");
  }
  if (hasOwn("resumeArgs") && !sameStringArray(override.resumeArgs, snapshot.resumeArgs)) {
    throw new Error("Antigravity exact tool caps reject CLI resume args override");
  }
}

export function buildGoogleAntigravityCliBackend(
  backendId = GOOGLE_ANTIGRAVITY_PROVIDER_ID,
  env: NodeJS.ProcessEnv = process.env,
): CliBackendPlugin {
  const userDataDir = resolveAntigravityDataDir(env);
  const conversationCachePath = path.join(userDataDir, "cache", "last_conversations.json");
  let exactCapWrapperConfigSnapshot: ExactCapWrapperConfigSnapshot | undefined;

  const backend: CliBackendPlugin = {
    id: backendId,
    modelProvider: backendId,
    liveTest: { defaultModelRef: `${backendId}/gemini-3.7-flash` },
    nativeToolMode: "selectable",
    toolAvailabilityEnforcement: "prepare-execution",
    ownsNativeCompaction: true,
    // Ask openclaw to stand up its loopback MCP server and materialise a
    // config for this run. `gemini-system-settings` is the right mode of the
    // three available: it injects no CLI args (agy would reject claude's
    // `--mcp-config`/`--strict-mcp-config`), delivers the path through
    // GEMINI_CLI_SYSTEM_SETTINGS_PATH in the child env where prepareExecution
    // can read it, and resolves `${OPENCLAW_MCP_TOKEN}` to a literal before
    // writing, which agy needs because it performs no placeholder expansion.
    bundleMcp: true,
    bundleMcpMode: "gemini-system-settings",
    normalizeConfig: normalizeGoogleAntigravityBackendConfig,
    resolveExecutionArgs: resolveGoogleAntigravityExecutionArgs,
    prepareExecution: async (ctx) => {
      const cap = ctx.toolAvailability === undefined ? undefined : validateExactCap(ctx.toolAvailability);
      const cwd = (ctx as { cwd?: string; workspaceDir: string }).cwd ?? ctx.workspaceDir;
      let priorConversationId: string | undefined;
      let stagedAtMs = 0;

      if (cap) {
        // The exact-cap acknowledgement is meaningful only when the command
        // that core will launch is our wrapper with the matching wrapper
        // prefix. A raw-agy fallback would otherwise receive the positive
        // acknowledgement but run with its ambient native tools.
        assertExactCapBackendConfig({
          backend,
          backendId,
          config: ctx.config,
          wrapper: resolveAgyWrapperInvocation(),
          snapshot: exactCapWrapperConfigSnapshot,
        });
      }

      // MCP bridge moved to src/agy-strip-wrapper.ts so it can read the
      // POST-capture-attempt `GEMINI_CLI_SYSTEM_SETTINGS_PATH`. openclaw's
      // `prepareCliBundleMcpCaptureAttempt` runs after our `prepareExecution`
      // returns and updates the env var to point at a fresh settings file
      // carrying the resolved `x-openclaw-cli-capture-key`; writing the
      // bridge from here reads the pre-capture file (empty key → agy gets a
      // 401 when it calls the loopback server).
      const exposeTools = exposeOpenClawTools(
        ctx.config as Record<string, any> | undefined,
        backendId,
      );

      return {
        ...(cap ? { toolAvailabilityEnforced: true } : {}),
        ...(normalizeOptionalString(env.ANTIGRAVITY_USER_DATA_DIR)
          ? {
              env: {
                ANTIGRAVITY_USER_DATA_DIR: userDataDir,
                OPENCLAW_ANTIGRAVITY_EXPOSE_TOOLS: String(exposeTools),
                ...(cap ? { [EXACT_CAP_ENV]: JSON.stringify(cap) } : {}),
              },
            }
          : {
              env: {
                OPENCLAW_ANTIGRAVITY_EXPOSE_TOOLS: String(exposeTools),
                ...(cap ? { [EXACT_CAP_ENV]: JSON.stringify(cap) } : {}),
              },
            }),
        clearEnv: [
          ...(cap ? [] : [EXACT_CAP_ENV]),
          "GEMINI_API_KEY",
          "GOOGLE_API_KEY",
          "GOOGLE_APPLICATION_CREDENTIALS",
          "GOOGLE_CLOUD_PROJECT",
          "GOOGLE_CLOUD_PROJECT_ID",
        ],
        beforeExecution: async () => {
          priorConversationId = await resolveCachedConversationId({
            cachePath: conversationCachePath,
            cwd,
          });
          stagedAtMs = Date.now();
        },
        captureSessionId: async (captureCtx: { cwd: string; executionMode?: string }) => {
          // Restricted runs deliberately use a fresh, private agy
          // conversation. Do not bind that transient conversation into the
          // user's OpenClaw session; doing so would make a later unrestricted
          // turn resume a conversation created under the exact-cap guard.
          if (cap || captureCtx.executionMode === "side-question") return;
          const conversationId = await resolveCachedConversationId({
            cachePath: conversationCachePath,
            cwd: captureCtx.cwd,
          });
          if (!conversationId) {
            throw new Error(`Antigravity did not publish a conversation id for ${captureCtx.cwd}`);
          }
          if (conversationId === priorConversationId) {
            throw new Error(`Antigravity did not create a new conversation for ${captureCtx.cwd}`);
          }
          const conversationPath = path.join(
            userDataDir,
            "conversations",
            `${conversationId}.db`,
          );
          let conversationStat;
          try {
            conversationStat = await fs.stat(conversationPath);
          } catch (error) {
            if (isNodeError(error) && error.code === "ENOENT") {
              throw new Error(
                `Antigravity conversation ${conversationId} has no SQLite state`,
                { cause: error },
              );
            }
            throw error;
          }
          if (
            !conversationStat.isFile() ||
            (stagedAtMs > 0 && conversationStat.mtimeMs < stagedAtMs - 2000)
          ) {
            throw new Error(`Antigravity conversation ${conversationId} is not current`);
          }
          return conversationId;
        },
      } as any;
    },
    config: (() => {
      // Point openclaw at `node <wrapper>` instead of raw agy so the
      // openclaw:ctx channel-context blocks openclaw prepends to every turn
      // are removed before agy sees the prompt. agy has its own conversation
      // SQLite (`--conversation <id>`) so re-sending the channel context
      // every turn is duplicate history — see src/prompt-strip.ts.
      const wrap = resolveAgyWrapperInvocation();
      const wrapperPrefix = wrap.wrapperPath ? [wrap.wrapperPath] : [];
      return {
      command: wrap.command,
      args: [
        ...wrapperPrefix,
        "--print",
        "{prompt}",
        "--print-timeout",
        DEFAULT_PRINT_TIMEOUT,
        "--output-format",
        "stream-json",
        "--dangerously-skip-permissions",
      ],
      resumeArgs: [
        ...wrapperPrefix,
        "--conversation",
        "{sessionId}",
        "--print",
        "{prompt}",
        "--print-timeout",
        DEFAULT_PRINT_TIMEOUT,
        "--output-format",
        "stream-json",
        "--dangerously-skip-permissions",
      ],
      output: "jsonl",
      input: "arg",
      // agy exposes no image flag and its stream-json input rejects non-text
      // content blocks, so openclaw stages images and appends their paths to
      // the prompt (the `imageArg`-unset path in its CLI runner). Staging into
      // the workspace keeps them inside the directory agy is allowed to open
      // with `view_file`; the "temp" scope would land outside it.
      imagePathScope: "workspace",
      modelArg: "--model",
      modelAliases: GOOGLE_ANTIGRAVITY_MODEL_ALIASES,
      systemPromptWhen: "first",
      sessionMode: "existing",
      serialize: true,
      };
    })(),
  };

  // Keep an immutable copy of the wrapper-owned argv contract. The live
  // backend config can be normalized or replaced by core before preparation;
  // exact-cap validation must compare against this plugin-owned baseline.
  const configured = backend.config as {
    command?: unknown;
    args?: unknown;
    resumeArgs?: unknown;
  };
  if (
    typeof configured.command === "string" &&
    Array.isArray(configured.args) &&
    Array.isArray(configured.resumeArgs) &&
    configured.args.every((value): value is string => typeof value === "string") &&
    configured.resumeArgs.every((value): value is string => typeof value === "string")
  ) {
    exactCapWrapperConfigSnapshot = {
      command: configured.command,
      args: [...configured.args],
      resumeArgs: [...configured.resumeArgs],
    };
  }

  (backend as any).parseJsonlEvent = parseGoogleAntigravityJsonlEvent;
  // No `manualCompaction`: agy exposes no compaction command. Its slash-command
  // surface is /agents /changelog /config /credits /effort /help /hooks /model
  // /permissions /skills /usage, with nothing that compacts, and `/compact` is
  // answered as ordinary chat. A control operation that merely asked the model
  // to "summarise this conversation" would *append* a summary turn rather than
  // shrink anything, while reporting success to openclaw. The bundled
  // google-gemini-cli backend takes the same shape: `ownsNativeCompaction`
  // without a manual control operation, so `/compact` fails loudly instead of
  // silently doing nothing.

  return backend;
}
