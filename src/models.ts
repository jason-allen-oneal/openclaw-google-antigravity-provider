import { spawn } from "node:child_process";

export type ModelInputModality = "text" | "image";

export type AntigravityModel = {
  readonly id: string;
  readonly name: string;
  readonly reasoning: boolean;
  readonly contextWindow: number;
  readonly input: readonly ModelInputModality[];
};

// Baseline list registered when `agy models` cannot be reached (agy missing,
// user not signed in, tests, or offline). Deliberately small: enough for the
// plugin to expose *something* usable, without pretending to know the full
// live catalog.
export const STATIC_MODEL_FALLBACK: readonly AntigravityModel[] = [
  // Gemini families are exposed as one entry each; effort routes through
  // openclaw's thinking-level slider → `agy --effort <low|medium|high>`.
  {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    reasoning: true,
    contextWindow: 1_000_000,
    input: ["text", "image"],
  },
  {
    id: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    reasoning: true,
    contextWindow: 1_000_000,
    input: ["text", "image"],
  },
  {
    id: "gemini-3.6-flash",
    name: "Gemini 3.6 Flash",
    reasoning: true,
    contextWindow: 1_000_000,
    input: ["text", "image"],
  },
  {
    id: "gemini-3.1-pro",
    name: "Gemini 3.1 Pro",
    reasoning: true,
    contextWindow: 1_000_000,
    input: ["text", "image"],
  },
  // Non-Gemini families come as a single ID from agy so nothing to collapse.
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (Thinking)",
    reasoning: true,
    contextWindow: 200_000,
    input: ["text", "image"],
  },
  {
    id: "claude-opus-4-6-thinking",
    name: "Claude Opus 4.6 (Thinking)",
    reasoning: true,
    contextWindow: 200_000,
    input: ["text", "image"],
  },
  {
    id: "gpt-oss-120b-medium",
    name: "GPT-OSS 120B (Medium)",
    reasoning: true,
    contextWindow: 128_000,
    input: ["text"],
  },
];

// Gemini rows in `agy models` come as three effort-baked IDs per family
// (`gemini-3.8-flash-high`, `-medium`, `-low`). Collapse them to the base
// family ID so the openclaw picker shows one row per family and the
// thinking-level slider drives `--effort` at execution time.
const GEMINI_EFFORT_SUFFIX = /-(?:high|medium|low)$/;

function stripGeminiEffortSuffix(id: string): string {
  if (!id.startsWith("gemini-")) return id;
  return id.replace(GEMINI_EFFORT_SUFFIX, "");
}

function humanizeBaseId(id: string): string {
  // `gemini-3.8-flash` → `Gemini 3.8 Flash`
  return id
    .split("-")
    .map((seg) => (seg.length ? seg[0]!.toUpperCase() + seg.slice(1) : seg))
    .join(" ");
}

// `agy models` phones home to Google. Observed 15-20s on cold cache; 30s
// gives headroom for slow networks without stalling the picker indefinitely.
export const DEFAULT_LIVE_TIMEOUT_MS = 30_000;
export const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1_000;

export function deriveContextWindow(id: string): number {
  if (id.startsWith("gemini-")) return 1_000_000;
  if (id.startsWith("claude-")) return 200_000;
  if (id.startsWith("gpt-")) return 128_000;
  return 200_000;
}

export function deriveReasoning(id: string, name = ""): boolean {
  // Every currently exposed agy model is reasoning-capable — either via an
  // explicit effort suffix (-high/-medium/-low) after collapse, a Thinking
  // variant, or a bare Gemini family (whose effort now flows through the
  // slider → `agy --effort`).
  if (/-(?:high|medium|low)$/.test(id)) return true;
  if (/thinking/i.test(id) || /thinking/i.test(name)) return true;
  if (id.startsWith("gemini-")) return true;
  return false;
}

// agy has no image attachment channel: `--input-format stream-json` rejects
// non-text content blocks ("stream input content block type \"image\" is not
// supported"). Images reach the model as staged file paths appended to the
// prompt, which agy opens with its own `view_file` tool. That only produces a
// useful answer on a vision-capable family — GPT-OSS 120B asks for the colors
// back instead of reading the file, so it stays text-only.
export function deriveInput(id: string): readonly ModelInputModality[] {
  if (id.startsWith("gemini-") || id.startsWith("claude-")) return ["text", "image"];
  return ["text"];
}

export function deriveModelMetadata(
  id: string,
  name?: string,
): Omit<AntigravityModel, "id"> {
  return {
    name: name ?? id,
    reasoning: deriveReasoning(id, name ?? ""),
    contextWindow: deriveContextWindow(id),
    input: deriveInput(id),
  };
}

export function parseAgyModelsOutput(text: string): AntigravityModel[] {
  const models: AntigravityModel[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const rawId = line.slice(0, tab).trim();
    const rawName = line.slice(tab + 1).trim();
    if (!rawId || /\s/.test(rawId) || !rawName) continue;

    const collapsedId = stripGeminiEffortSuffix(rawId);
    if (seen.has(collapsedId)) continue;
    seen.add(collapsedId);

    // Collapsed rows lose the effort qualifier from the label, e.g.
    // "Gemini 3.8 Flash (High)" → "Gemini 3.8 Flash". Non-Gemini rows keep
    // their original label untouched.
    const displayName =
      collapsedId !== rawId
        ? rawName.replace(/\s*\((?:High|Medium|Low)\)\s*$/i, "").trim() ||
          humanizeBaseId(collapsedId)
        : rawName;

    models.push({
      id: collapsedId,
      name: displayName,
      reasoning: deriveReasoning(collapsedId, displayName),
      contextWindow: deriveContextWindow(collapsedId),
      input: deriveInput(collapsedId),
    });
  }
  return models;
}

export type AgyModelsResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

export type AgyModelsRunner = (options: {
  command: string;
  timeoutMs: number;
  signal?: AbortSignal;
}) => Promise<AgyModelsResult>;

// Real runner: non-blocking spawn, honors AbortSignal, kills on timeout.
export const runAgyModels: AgyModelsRunner = ({ command, timeoutMs, signal }) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const child = spawn(command, ["models"], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      clearTimeout(timer);
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      cleanup();
      reject(new Error(`agy models timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    signal?.addEventListener("abort", onAbort);
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code ?? 0,
      });
    });
  });

// Module-level cache. In-flight promise dedupes concurrent callers; a
// successful fetch stays warm for TTL; on refresh error we prefer the last
// known good over the static fallback.
type CacheEntry = {
  models: readonly AntigravityModel[];
  fetchedAt: number;
  expiresAt: number;
};
let cache: CacheEntry | null = null;
let inFlight: Promise<readonly AntigravityModel[] | null> | null = null;

export function clearAntigravityModelsCache(): void {
  cache = null;
  inFlight = null;
}

export type FetchAntigravityModelsOptions = {
  command?: string;
  timeoutMs?: number;
  ttlMs?: number;
  signal?: AbortSignal;
  runner?: AgyModelsRunner;
  now?: () => number;
};

async function fetchFresh(
  options: FetchAntigravityModelsOptions,
): Promise<readonly AntigravityModel[] | null> {
  const runner = options.runner ?? runAgyModels;
  try {
    const result = await runner({
      command: options.command ?? "agy",
      timeoutMs: options.timeoutMs ?? DEFAULT_LIVE_TIMEOUT_MS,
      signal: options.signal,
    });
    if (result.exitCode !== 0) return null;
    const parsed = parseAgyModelsOutput(`${result.stdout}\n${result.stderr}`);
    return parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

export type LiveAntigravityModels = {
  readonly models: readonly AntigravityModel[];
  readonly source: "live" | "cache";
  readonly fetchedAt: number;
  readonly expiresAt: number;
};

// Returns cached or freshly fetched models. Null means "no known live list
// and no cached fallback" — callers should fall back to STATIC_MODEL_FALLBACK.
export async function getLiveAntigravityModels(
  options: FetchAntigravityModelsOptions = {},
): Promise<LiveAntigravityModels | null> {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  const currentTime = now();

  if (cache && cache.expiresAt > currentTime) {
    return { ...cache, source: "cache" };
  }

  if (!inFlight) {
    inFlight = fetchFresh(options).finally(() => {
      inFlight = null;
    });
  }

  const fetched = await inFlight;
  const settleTime = now();

  if (fetched) {
    cache = {
      models: fetched,
      fetchedAt: settleTime,
      expiresAt: settleTime + ttlMs,
    };
    return { ...cache, source: "live" };
  }

  // Fresh fetch failed. Prefer stale cache over signaling "no live catalog".
  if (cache) {
    return { ...cache, source: "cache" };
  }

  return null;
}
