// MediaUnderstandingProvider for image description via agy.
//
// Agy's Gemini + Claude models handle vision natively; openclaw stages
// images for our regular CLI backend by writing them into the workspace
// and appending the path to the prompt. Here we expose the same
// capability as a one-shot provider so any openclaw feature that wants
// image understanding (e.g. inline image tools in another provider's
// turn) can delegate to agy — no need to route the whole conversation
// through us.
//
// The invocation is deliberately lightweight: single-shot `agy --print`
// with a fresh scratch workspace, no `--conversation`, no MCP bridge.
// Agy sees just the image path and the description prompt, replies once,
// exits.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MediaUnderstandingProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";
import { resolveAntigravityDataDir } from "./backend.js";

// The Request/Result types aren't re-exported from the SDK barrel we
// depend on, so mirror the fields we actually read. Keep in sync with
// packages/plugin-sdk/dist/src/media-understanding/types.d.ts —
// tests pin the fields we consume.
type ImageDescriptionRequest = {
  buffer: Buffer;
  fileName: string;
  mime?: string;
  prompt?: string;
  maxTokens?: number;
  timeoutMs: number;
  profile?: string;
  preferredProfile?: string;
  authStore?: unknown;
  agentDir: string;
  cfg: unknown;
  model: string;
  provider: string;
};
type ImageDescriptionResult = { text: string; model?: string };
type ImagesDescriptionRequest = ImageDescriptionRequest & {
  images: Array<{ buffer: Buffer; fileName: string; mime?: string }>;
};
type ImagesDescriptionResult = { text: string; model?: string };

export const ANTIGRAVITY_MEDIA_UNDERSTANDING_ID = "google-antigravity-cli";

const DEFAULT_VISION_MODEL = "gemini-3.7-flash";
const DEFAULT_PROMPT =
  "Describe the attached image in detail. Cover subject, composition, notable objects, any visible text, and inferred context. Reply in plain prose.";

function safeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 128) || "image.bin";
}

function extForMime(mime?: string, fallback?: string): string {
  if (fallback && /\.\w{2,5}$/.test(fallback)) return fallback.slice(fallback.lastIndexOf("."));
  switch ((mime ?? "").toLowerCase()) {
    case "image/png": return ".png";
    case "image/jpeg":
    case "image/jpg": return ".jpg";
    case "image/webp": return ".webp";
    case "image/heic": return ".heic";
    case "image/heif": return ".heif";
    case "image/tiff": return ".tiff";
    case "image/gif": return ".gif";
    default: return ".bin";
  }
}

async function runAgy(options: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
}): Promise<string> {
  const { command, args, cwd, env, timeoutMs } = options;
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d: Buffer) => errChunks.push(d));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    }, timeoutMs);
    timer.unref();
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(chunks).toString("utf8");
      if (code === 0) return resolve(stdout);
      const stderr = Buffer.concat(errChunks).toString("utf8").trim();
      const reason = signal ? `killed by ${signal}` : `exited ${code}`;
      reject(new Error(`agy image-description ${reason}: ${stderr || "(no stderr)"}`));
    });
  });
}

// Extract user-facing prose from agy's `stream-json` output or fall back
// to raw stdout if agy was run in text mode.
function extractProse(stdout: string): string {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const collected: string[] = [];
  for (const line of lines) {
    if (line.startsWith("{") && line.endsWith("}")) {
      try {
        const evt = JSON.parse(line) as { type?: string; text?: string; delta?: string; content?: string };
        const piece = evt.text ?? evt.delta ?? evt.content;
        if (typeof piece === "string" && piece.trim()) {
          collected.push(piece);
        }
        continue;
      } catch {
        // fall through — probably plain text on that line
      }
    }
    collected.push(line);
  }
  return collected.join("\n").trim();
}

export function buildAntigravityMediaUnderstandingProvider(options: {
  readonly resolveCommand?: () => string;
  readonly env?: NodeJS.ProcessEnv;
  readonly run?: typeof runAgy;
} = {}): MediaUnderstandingProviderPlugin {
  const env = options.env ?? process.env;
  const command = options.resolveCommand?.() ?? "agy";
  const execute = options.run ?? runAgy;

  const describeImage = async (
    req: ImageDescriptionRequest,
  ): Promise<ImageDescriptionResult> => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "agy-vision-"),
    );
    try {
      const fileName = safeFileName(req.fileName || `image${extForMime(req.mime)}`);
      const imagePath = path.join(workspace, fileName);
      await fs.writeFile(imagePath, req.buffer);

      const userPrompt = req.prompt?.trim() || DEFAULT_PROMPT;
      const composed = `${userPrompt}\n\nImage file: ${imagePath}`;
      const model = req.model?.trim() || DEFAULT_VISION_MODEL;
      const timeoutMs = Math.max(req.timeoutMs, 5000);
      const timeoutSeconds = Math.ceil(timeoutMs / 1000);
      const timeoutFlag = `${timeoutSeconds}s`;

      const childEnv: NodeJS.ProcessEnv = { ...env };
      // Isolate from any ambient google auth env that might redirect agy.
      delete childEnv.GEMINI_API_KEY;
      delete childEnv.GOOGLE_API_KEY;
      delete childEnv.GOOGLE_APPLICATION_CREDENTIALS;
      // Keep agy off the shared user data dir so a concurrent conversation
      // isn't polluted — use a per-invocation scratch.
      childEnv.ANTIGRAVITY_USER_DATA_DIR = path.join(workspace, ".agy");
      resolveAntigravityDataDir(childEnv); // touch to keep the import in use

      const args = [
        "--print",
        composed,
        "--print-timeout",
        timeoutFlag,
        "--model",
        model,
      ];
      if (model.startsWith("gemini-") && !/-(?:low|medium|high)$/.test(model)) {
        args.push("--effort", "low");
      }
      args.push("--dangerously-skip-permissions");

      const stdout = await execute({
        command,
        args,
        cwd: workspace,
        env: childEnv,
        timeoutMs,
      });
      const text = extractProse(stdout) || "(agy returned no describable text)";
      return { text, model };
    } finally {
      // Log cleanup failures so orphan temp workspaces don't accumulate
      // silently. `rm` on a fresh mkdtemp should always succeed; a
      // failure here means something external (antivirus, still-open
      // file handle) held the dir.
      await fs.rm(workspace, { recursive: true, force: true }).catch((error) => {
        // eslint-disable-next-line no-console
        console.warn(
          `[google-antigravity-cli] failed to clean vision workspace ${workspace}: ${
            (error as Error).message
          }`,
        );
      });
    }
  };

  const describeImages = async (
    req: ImagesDescriptionRequest,
  ): Promise<ImagesDescriptionResult> => {
    // Simple: describe each image sequentially, concatenate the prose.
    // agy has no batch image API so this is the honest interpretation.
    const parts: string[] = [];
    let modelHint: string | undefined;
    for (let i = 0; i < req.images.length; i += 1) {
      const image = req.images[i]!;
      const per = await describeImage({
        buffer: image.buffer,
        fileName: image.fileName,
        mime: image.mime,
        prompt: req.prompt,
        maxTokens: req.maxTokens,
        timeoutMs: req.timeoutMs,
        profile: req.profile,
        preferredProfile: req.preferredProfile,
        authStore: req.authStore,
        agentDir: req.agentDir,
        cfg: req.cfg,
        model: req.model,
        provider: req.provider,
      });
      parts.push(`Image ${i + 1}: ${per.text}`);
      modelHint = modelHint ?? per.model;
    }
    return { text: parts.join("\n\n"), ...(modelHint ? { model: modelHint } : {}) };
  };

  return {
    id: ANTIGRAVITY_MEDIA_UNDERSTANDING_ID,
    capabilities: ["image"],
    defaultModels: { image: DEFAULT_VISION_MODEL },
    describeImage,
    describeImages,
  } as MediaUnderstandingProviderPlugin;
}

// Exported for tests that want to inspect the prose extractor without
// touching agy.
export const _test = { extractProse, safeFileName, extForMime };
