import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  availableEffortsForModel,
  buildGoogleAntigravityCliBackend,
  clampEffortForModel,
  DEFAULT_MAX_RESUME_DB_BYTES,
  dropOversizedResume,
  GOOGLE_ANTIGRAVITY_MODEL_ALIASES,
  GOOGLE_ANTIGRAVITY_PROVIDER_ID,
  mapThinkingLevelToAgyEffort,
  normalizeGoogleAntigravityBackendConfig,
  parseGoogleAntigravityJsonlEvent,
  resolveGoogleAntigravityExecutionArgs,
} from "./backend.js";

describe("google-antigravity-cli CLI backend", () => {
  it("declares the CLI backend structure with 30m0s default timeout and parseJsonlEvent", () => {
    const backend = buildGoogleAntigravityCliBackend();

    expect(backend.id).toBe(GOOGLE_ANTIGRAVITY_PROVIDER_ID);
    expect(backend.nativeToolMode).toBe("always-on");
    expect(backend.ownsNativeCompaction).toBe(true);
    expect(typeof (backend as any).parseJsonlEvent).toBe("function");
    // command is now node's own execPath (spawning the strip-wrapper) so
    // openclaw's ctx blocks get removed before agy sees them. wrapper path
    // is prepended to args + resumeArgs.
    expect(backend.config.command).toBe(process.execPath);
    expect(backend.config.args?.[0]).toMatch(/agy-strip-wrapper\.(?:js|ts)$/);
    expect(backend.config.args?.slice(1)).toEqual([
      "--print",
      "{prompt}",
      "--print-timeout",
      "30m0s",
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
    ]);
    expect(backend.config.resumeArgs?.[0]).toMatch(/agy-strip-wrapper\.(?:js|ts)$/);
    expect(backend.config.resumeArgs?.slice(1)).toEqual([
      "--conversation",
      "{sessionId}",
      "--print",
      "{prompt}",
      "--print-timeout",
      "30m0s",
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
    ]);
    expect(backend.config).toEqual(
      expect.objectContaining({
        input: "arg",
        output: "jsonl",
        modelArg: "--model",
        sessionMode: "existing",
        serialize: true,
      }),
    );
    expect(GOOGLE_ANTIGRAVITY_MODEL_ALIASES).toMatchObject({
      flash: "gemini-3.7-flash",
      pro: "gemini-3.1-pro",
      "pro-high": "gemini-3.1-pro-high",
      sonnet: "claude-sonnet-4-6",
    });
  });

  it("declares workspace-scoped image staging so agy can view_file the staged paths", () => {
    // agy has no image flag and its stream-json input rejects image content
    // blocks, so openclaw appends staged image paths to the prompt (the
    // imageArg-unset path). "workspace" keeps them inside the directory agy
    // is allowed to open.
    const backend = buildGoogleAntigravityCliBackend("google-antigravity-cli", {});
    expect(backend.config.imagePathScope).toBe("workspace");
    expect(backend.config.imageArg).toBeUndefined();
  });

  it("dynamically resolves --print-timeout and optional streaming flags", () => {
    const baseArgs = ["--print", "{prompt}", "--print-timeout", "30m0s"];

    // 1. Model-specific timeout with default stream-json
    const res1 = resolveGoogleAntigravityExecutionArgs({
      config: {
        agents: {
          defaults: {
            models: {
              "google-antigravity-cli/gemini-3.7-flash": {
                params: { timeoutSeconds: 900 },
              },
            },
          },
        },
      } as any,
      workspaceDir: "/tmp",
      provider: GOOGLE_ANTIGRAVITY_PROVIDER_ID,
      modelId: "google-antigravity-cli/gemini-3.7-flash",
      authProfileId: undefined,
      thinkingLevel: undefined,
      executionMode: "agent",
      useResume: false,
      baseArgs,
    });
    expect(res1).toEqual([
      "--print",
      "{prompt}",
      "--print-timeout",
      "900s",
      "--dangerously-skip-permissions",
      "--output-format",
      "stream-json",
      // Base Gemini id with no slider value: agy requires an effort, so the
      // default is supplied rather than omitted.
      "--effort",
      "low",
    ]);

    // 2. Custom print timeout in plugin config
    const res2 = resolveGoogleAntigravityExecutionArgs({
      config: {
        plugins: {
          entries: {
            "google-antigravity-cli": {
              config: {
                stream: true,
                printTimeout: "15m0s",
              },
            },
          },
        },
      } as any,
      workspaceDir: "/tmp",
      provider: GOOGLE_ANTIGRAVITY_PROVIDER_ID,
      modelId: "gemini-3.7-flash",
      authProfileId: undefined,
      thinkingLevel: undefined,
      executionMode: "agent",
      useResume: false,
      baseArgs,
    });
    expect(res2).toEqual([
      "--print",
      "{prompt}",
      "--print-timeout",
      "15m0s",
      "--dangerously-skip-permissions",
      "--output-format",
      "stream-json",
      "--effort",
      "low",
    ]);

    // 3. Streaming explicitly disabled
    const res3 = resolveGoogleAntigravityExecutionArgs({
      config: {
        plugins: {
          entries: {
            "google-antigravity-cli": {
              config: {
                stream: false,
              },
            },
          },
        },
      } as any,
      workspaceDir: "/tmp",
      provider: GOOGLE_ANTIGRAVITY_PROVIDER_ID,
      modelId: "gemini-3.7-flash",
      authProfileId: undefined,
      thinkingLevel: undefined,
      executionMode: "agent",
      useResume: false,
      baseArgs,
    });
    expect(res3).toEqual([
      "--print",
      "{prompt}",
      "--print-timeout",
      "30m0s",
      "--dangerously-skip-permissions",
      "--effort",
      "low",
    ]);

    const backend = buildGoogleAntigravityCliBackend();
    const res4 = resolveGoogleAntigravityExecutionArgs({
      config: {
        plugins: {
          entries: {
            "google-antigravity-cli": { config: { stream: false } },
          },
        },
      } as any,
      workspaceDir: "/tmp",
      provider: GOOGLE_ANTIGRAVITY_PROVIDER_ID,
      modelId: "gemini-3.7-flash",
      authProfileId: undefined,
      thinkingLevel: undefined,
      executionMode: "agent",
      useResume: false,
      baseArgs: backend.config.args ?? [],
    });
    expect(res4).not.toContain("--output-format");
  });

  describe("model aliases", () => {
    it("keeps effort-naming shortcuts pointed at effort-baked ids", () => {
      // Collapsing these to the base family would drop the level the user
      // asked for and hand control back to the slider.
      expect(GOOGLE_ANTIGRAVITY_MODEL_ALIASES["flash-high"]).toBe("gemini-3.7-flash-high");
      expect(GOOGLE_ANTIGRAVITY_MODEL_ALIASES["flash-low"]).toBe("gemini-3.7-flash-low");
      expect(GOOGLE_ANTIGRAVITY_MODEL_ALIASES["pro-high"]).toBe("gemini-3.1-pro-high");
      expect(GOOGLE_ANTIGRAVITY_MODEL_ALIASES["pro-low"]).toBe("gemini-3.1-pro-low");
    });

    it("leaves bare shortcuts on the base family for the slider to drive", () => {
      expect(GOOGLE_ANTIGRAVITY_MODEL_ALIASES.flash).toBe("gemini-3.7-flash");
      expect(GOOGLE_ANTIGRAVITY_MODEL_ALIASES.pro).toBe("gemini-3.1-pro");
    });

    it("resolves every alias target to a real agy model id", () => {
      // `agy models` rows, plus the effort-baked variants it publishes.
      const real = new Set([
        "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.1-pro",
        "gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low",
        "gemini-3.7-flash-high", "gemini-3.7-flash-medium", "gemini-3.7-flash-low",
        "gemini-3.6-flash-high", "gemini-3.6-flash-medium", "gemini-3.6-flash-low",
        "gemini-3.1-pro-high", "gemini-3.1-pro-low",
        "claude-sonnet-4-6", "claude-opus-4-6-thinking", "gpt-oss-120b-medium",
      ]);
      for (const [alias, target] of Object.entries(GOOGLE_ANTIGRAVITY_MODEL_ALIASES)) {
        expect(real.has(target), `${alias} -> ${target}`).toBe(true);
      }
    });
  });

  describe("thinking level → --effort mapping", () => {
    it("maps openclaw's 8 levels to agy's 3", () => {
      expect(mapThinkingLevelToAgyEffort("off")).toBe("low");
      expect(mapThinkingLevelToAgyEffort("minimal")).toBe("low");
      expect(mapThinkingLevelToAgyEffort("low")).toBe("low");
      expect(mapThinkingLevelToAgyEffort("medium")).toBe("medium");
      expect(mapThinkingLevelToAgyEffort("adaptive")).toBe("medium");
      expect(mapThinkingLevelToAgyEffort("high")).toBe("high");
      expect(mapThinkingLevelToAgyEffort("xhigh")).toBe("high");
      expect(mapThinkingLevelToAgyEffort("max")).toBe("high");
    });

    it("returns undefined for missing or unrecognized levels", () => {
      expect(mapThinkingLevelToAgyEffort(undefined)).toBeUndefined();
      expect(mapThinkingLevelToAgyEffort("mystery")).toBeUndefined();
    });
  });

  describe("resolveGoogleAntigravityExecutionArgs --effort injection", () => {
    const baseArgs = ["--print", "{prompt}", "--print-timeout", "30m0s"];

    it("appends --effort for a base-family model when the slider maps", () => {
      const args = resolveGoogleAntigravityExecutionArgs({
        config: undefined as any,
        workspaceDir: "/tmp",
        provider: GOOGLE_ANTIGRAVITY_PROVIDER_ID,
        modelId: "google-antigravity-cli/gemini-3.8-flash",
        authProfileId: undefined,
        thinkingLevel: "high",
        executionMode: "agent",
        useResume: false,
        baseArgs,
      });
      expect(args).toContain("--effort");
      expect(args[args.indexOf("--effort") + 1]).toBe("high");
    });

    it("skips --effort when the model id already bakes an effort suffix", () => {
      const args = resolveGoogleAntigravityExecutionArgs({
        config: undefined as any,
        workspaceDir: "/tmp",
        provider: GOOGLE_ANTIGRAVITY_PROVIDER_ID,
        modelId: "gemini-3.8-flash-medium",
        authProfileId: undefined,
        thinkingLevel: "high",
        executionMode: "agent",
        useResume: false,
        baseArgs,
      });
      expect(args).not.toContain("--effort");
    });

    it("falls back to low when the slider is off, unset, or unrecognized", () => {
      // A collapsed Gemini base id is not in agy's own catalog, so agy rejects
      // it without an effort: `--model gemini-3.8-flash requires --effort`.
      // Omitting the flag here would fail every request.
      for (const thinkingLevel of [undefined, "off", "mystery"]) {
        const args = resolveGoogleAntigravityExecutionArgs({
          config: undefined as any,
          workspaceDir: "/tmp",
          provider: GOOGLE_ANTIGRAVITY_PROVIDER_ID,
          modelId: "gemini-3.8-flash",
          authProfileId: undefined,
          thinkingLevel: thinkingLevel as any,
          executionMode: "agent",
          useResume: false,
          baseArgs,
        });
        expect(args).toContain("--effort");
        expect(args[args.indexOf("--effort") + 1]).toBe("low");
      }
    });

    it("clamps a requested effort onto what the family actually offers", () => {
      // agy: `gemini-3.1-pro has no "medium" effort (available: low, high)`.
      // Ties break downward so a medium slider does not silently buy `high`.
      for (const level of ["medium", "adaptive"]) {
        const args = resolveGoogleAntigravityExecutionArgs({
          config: undefined as any,
          workspaceDir: "/tmp",
          provider: GOOGLE_ANTIGRAVITY_PROVIDER_ID,
          modelId: "google-antigravity-cli/gemini-3.1-pro",
          authProfileId: undefined,
          thinkingLevel: level as any,
          executionMode: "agent",
          useResume: false,
          baseArgs,
        });
        expect(args[args.indexOf("--effort") + 1]).toBe("low");
      }
    });

    it("leaves supported efforts untouched", () => {
      expect(clampEffortForModel("gemini-3.1-pro", "high")).toBe("high");
      expect(clampEffortForModel("gemini-3.1-pro", "low")).toBe("low");
      expect(clampEffortForModel("gemini-3.1-pro", "medium")).toBe("low");
      // Flash families publish all three levels.
      expect(clampEffortForModel("gemini-3.7-flash", "medium")).toBe("medium");
      expect(availableEffortsForModel("gemini-3.7-flash")).toEqual([
        "low",
        "medium",
        "high",
      ]);
    });

    it("never sends --effort to families that reject it", () => {
      // agy: `--effort is not supported for model "claude-sonnet-4-6"`.
      // GPT-OSS carries its level in the id, so it needs nothing injected.
      for (const modelId of [
        "claude-sonnet-4-6",
        "claude-opus-4-6-thinking",
        "gpt-oss-120b-medium",
      ]) {
        const args = resolveGoogleAntigravityExecutionArgs({
          config: undefined as any,
          workspaceDir: "/tmp",
          provider: GOOGLE_ANTIGRAVITY_PROVIDER_ID,
          modelId: `google-antigravity-cli/${modelId}`,
          authProfileId: undefined,
          thinkingLevel: "high",
          executionMode: "agent",
          useResume: false,
          baseArgs,
        });
        expect(args).not.toContain("--effort");
      }
    });

    it("respects an --effort already present in baseArgs", () => {
      const args = resolveGoogleAntigravityExecutionArgs({
        config: undefined as any,
        workspaceDir: "/tmp",
        provider: GOOGLE_ANTIGRAVITY_PROVIDER_ID,
        modelId: "gemini-3.8-flash",
        authProfileId: undefined,
        thinkingLevel: "high",
        executionMode: "agent",
        useResume: false,
        baseArgs: [...baseArgs, "--effort", "low"],
      });
      const first = args.indexOf("--effort");
      expect(first).toBeGreaterThan(-1);
      expect(args[first + 1]).toBe("low");
      // Only one occurrence.
      expect(args.lastIndexOf("--effort")).toBe(first);
    });
  });

  it("normalizes output mode to jsonl when streaming is configured", () => {
    const backend = buildGoogleAntigravityCliBackend();
    const normalized = normalizeGoogleAntigravityBackendConfig(backend.config, {
      backendId: GOOGLE_ANTIGRAVITY_PROVIDER_ID,
      config: {
        plugins: {
          entries: {
            "google-antigravity-cli": {
              config: {
                stream: true,
              },
            },
          },
        },
      } as any,
    });

    expect(normalized.output).toBe("jsonl");
    expect((normalized as any).resumeOutput).toBe("jsonl");
  });

  it("normalizes output mode to text when streaming is disabled", () => {
    const backend = buildGoogleAntigravityCliBackend();
    const normalized = normalizeGoogleAntigravityBackendConfig(backend.config, {
      backendId: GOOGLE_ANTIGRAVITY_PROVIDER_ID,
      config: {
        plugins: {
          entries: {
            "google-antigravity-cli": { config: { stream: false } },
          },
        },
      } as any,
    });

    expect(normalized.output).toBe("text");
    expect((normalized as any).resumeOutput).toBe("text");
  });

  describe("parseGoogleAntigravityJsonlEvent", () => {
    const ctx = {
      backendId: GOOGLE_ANTIGRAVITY_PROVIDER_ID,
      backend: buildGoogleAntigravityCliBackend().config,
    };

    it("parses init event as sessionId", () => {
      const line = JSON.stringify({
        event: "init",
        conversation_id: "9277298e-cc25-4e13-a4bf-a98358aeef34",
        init: { model: "gemini-3.7-flash-high" },
      });
      const parsed = parseGoogleAntigravityJsonlEvent(line, ctx);
      expect(parsed).toEqual({
        kind: "sessionId",
        sessionId: "9277298e-cc25-4e13-a4bf-a98358aeef34",
      });
    });

    it("parses thinking and text deltas from step_update", () => {
      // Thinking delta
      const thinkingLine = JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 2,
          step_type: "thinking",
          thought_delta: "Analyzing problem constraints...",
        },
      });
      expect(parseGoogleAntigravityJsonlEvent(thinkingLine, ctx)).toEqual({
        kind: "thinking",
        text: "Analyzing problem constraints...",
      });

      // Text delta
      const textLine = JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 2,
          step_type: "agent_response",
          text_delta: "The answer is 42.",
        },
      });
      expect(parseGoogleAntigravityJsonlEvent(textLine, ctx)).toEqual({
        kind: "text",
        text: "The answer is 42.",
      });
    });

    it("parses tool start and result lifecycle from step_update", () => {
      // Tool Start
      const toolStartLine = JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "9277298e-cc25-4e13-a4bf-a98358aeef34",
          step_index: 3,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "view_file",
          tool_info: {
            name: "view_file",
            parameters: { AbsolutePath: "transcript.jsonl" },
          },
        },
      });
      expect(parseGoogleAntigravityJsonlEvent(toolStartLine, ctx)).toEqual({
        kind: "toolStart",
        toolCallId: "call_3",
        name: "view_file",
        args: { AbsolutePath: "transcript.jsonl" },
      });

      // Tool Result
      const toolDoneLine = JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "9277298e-cc25-4e13-a4bf-a98358aeef34",
          step_index: 3,
          state: "DONE",
          step_type: "tool",
          tool_name: "view_file",
          tool_info: {
            name: "view_file",
            parameters: { AbsolutePath: "transcript.jsonl" },
            output: "4 lines, 2594 bytes",
          },
        },
      });
      expect(parseGoogleAntigravityJsonlEvent(toolDoneLine, ctx)).toEqual({
        kind: "toolResult",
        toolCallId: "call_3",
        name: "view_file",
        isError: false,
        result: "4 lines, 2594 bytes",
      });
    });

    it("parses terminal result and usage metrics", () => {
      const line = JSON.stringify({
        event: "result",
        result: {
          conversation_id: "9277298e-cc25-4e13-a4bf-a98358aeef34",
          status: "SUCCESS",
          response: "Final solution text",
          usage: {
            input_tokens: 19525,
            output_tokens: 315,
            thinking_tokens: 224,
            cache_read_tokens: 0,
            total_tokens: 19840,
          },
        },
      });
      const parsed = parseGoogleAntigravityJsonlEvent(line, ctx);
      expect(parsed).toEqual({
        kind: "result",
        text: "Final solution text",
        sessionId: "9277298e-cc25-4e13-a4bf-a98358aeef34",
        usage: {
          input: 19525,
          output: 315,
          cacheRead: 0,
          total: 19840,
        },
      });

      // Status ERROR with response text
      const errorWithResponseLine = JSON.stringify({
        event: "result",
        result: {
          conversation_id: "9277298e-cc25-4e13-a4bf-a98358aeef34",
          status: "ERROR",
          response: "Recovered partial answer text",
          error: "Permission denied for read_file",
        },
      });
      expect(parseGoogleAntigravityJsonlEvent(errorWithResponseLine, ctx)).toEqual({
        kind: "result",
        text: "Recovered partial answer text",
        sessionId: "9277298e-cc25-4e13-a4bf-a98358aeef34",
        usage: undefined,
      });
    });
  });

  it("forwards ANTIGRAVITY_USER_DATA_DIR and clears raw Google API credentials", async () => {
    const backend = buildGoogleAntigravityCliBackend("google-antigravity-cli", {
      ANTIGRAVITY_USER_DATA_DIR: " /tmp/antigravity-profile ",
      GEMINI_API_KEY: "secret",
    });

    const prepared = await backend.prepareExecution?.({
      workspaceDir: "/tmp/workspace",
      provider: GOOGLE_ANTIGRAVITY_PROVIDER_ID,
      modelId: "gemini-3.7-flash",
    });

    expect(prepared).toEqual(
      expect.objectContaining({
        env: {
          ANTIGRAVITY_USER_DATA_DIR: "/tmp/antigravity-profile",
          // Propagated so the strip-wrapper can decide whether to bridge
          // openclaw's MCP tools into agy's ~/.gemini/config/mcp_config.json.
          OPENCLAW_ANTIGRAVITY_EXPOSE_TOOLS: "true",
        },
        clearEnv: [
          "GEMINI_API_KEY",
          "GOOGLE_API_KEY",
          "GOOGLE_APPLICATION_CREDENTIALS",
          "GOOGLE_CLOUD_PROJECT",
          "GOOGLE_CLOUD_PROJECT_ID",
        ],
      }),
    );
  });

  describe("permission mode", () => {
    const baseArgs = ["--print", "{prompt}", "--dangerously-skip-permissions"];
    const run = (permissionMode?: string) =>
      resolveGoogleAntigravityExecutionArgs({
        config: permissionMode
          ? ({
              plugins: {
                entries: {
                  "google-antigravity-cli": { config: { permissionMode } },
                },
              },
            } as any)
          : (undefined as any),
        workspaceDir: "/tmp",
        provider: GOOGLE_ANTIGRAVITY_PROVIDER_ID,
        modelId: "claude-sonnet-4-6",
        authProfileId: undefined,
        thinkingLevel: undefined,
        executionMode: "agent",
        useResume: false,
        baseArgs,
      });

    it("defaults to skip, because headless agy cannot prompt for permissions", () => {
      // agy: "a tool required the read_file permission that headless mode
      // cannot prompt for, so it was auto-denied".
      const args = run();
      expect(args).toContain("--dangerously-skip-permissions");
      expect(args).not.toContain("--sandbox");
    });

    it("swaps in --sandbox when asked", () => {
      const args = run("sandbox");
      expect(args).toContain("--sandbox");
      expect(args).not.toContain("--dangerously-skip-permissions");
    });

    it("sends neither flag in settings mode, deferring to permissions.allow", () => {
      const args = run("settings");
      expect(args).not.toContain("--sandbox");
      expect(args).not.toContain("--dangerously-skip-permissions");
    });

    it("falls back to skip for an unrecognized mode", () => {
      expect(run("nonsense")).toContain("--dangerously-skip-permissions");
    });

    it("never emits both permission flags at once", () => {
      for (const mode of [undefined, "skip", "sandbox", "settings", "bogus"]) {
        const args = run(mode);
        const count =
          args.filter((a) => a === "--dangerously-skip-permissions").length +
          args.filter((a) => a === "--sandbox").length;
        expect(count).toBeLessThanOrEqual(1);
      }
    });
  });

  describe("compaction contract", () => {
    it("claims native compaction without offering a manual control operation", () => {
      // agy has no compaction command: its slash-command surface is
      // /agents /changelog /config /credits /effort /help /hooks /model
      // /permissions /skills /usage. A "summarise this conversation" prompt
      // appends a turn rather than shrinking one, so declaring manualCompaction
      // would report success for work that never happened. Same shape as the
      // bundled google-gemini-cli backend.
      const backend = buildGoogleAntigravityCliBackend("google-antigravity-cli", {});
      expect(backend.ownsNativeCompaction).toBe(true);
      expect((backend as any).manualCompaction).toBeUndefined();
    });
  });

});

describe("dropOversizedResume — resume guard", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-resume-guard-"));
    fs.mkdirSync(path.join(dataDir, "conversations"));
  });
  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  function writeDb(id: string, bytes: number) {
    fs.writeFileSync(
      path.join(dataDir, "conversations", `${id}.db`),
      Buffer.alloc(bytes),
    );
  }

  it("leaves args untouched when the resumed db is under the limit", () => {
    writeDb("abc", 1_000_000);
    const out = dropOversizedResume(
      ["--conversation", "abc", "--print", "hi"],
      dataDir,
      DEFAULT_MAX_RESUME_DB_BYTES,
    );
    expect(out.dropped).toBeUndefined();
    expect(out.args).toEqual(["--conversation", "abc", "--print", "hi"]);
  });

  it("strips `--conversation <id>` (and only that pair) when the db is over the limit", () => {
    writeDb("bloated", 5_000_000);
    const out = dropOversizedResume(
      ["--conversation", "bloated", "--print", "hi", "--effort", "high"],
      dataDir,
      DEFAULT_MAX_RESUME_DB_BYTES,
    );
    expect(out.dropped).toEqual({ conversationId: "bloated", bytes: 5_000_000 });
    expect(out.args).toEqual(["--print", "hi", "--effort", "high"]);
  });

  it("leaves args untouched when there is no --conversation flag", () => {
    const out = dropOversizedResume(
      ["--print", "hi"],
      dataDir,
      DEFAULT_MAX_RESUME_DB_BYTES,
    );
    expect(out.dropped).toBeUndefined();
    expect(out.args).toEqual(["--print", "hi"]);
  });

  it("leaves the placeholder `{sessionId}` alone (openclaw hasn't substituted yet)", () => {
    const out = dropOversizedResume(
      ["--conversation", "{sessionId}", "--print", "hi"],
      dataDir,
      DEFAULT_MAX_RESUME_DB_BYTES,
    );
    expect(out.dropped).toBeUndefined();
    expect(out.args).toEqual(["--conversation", "{sessionId}", "--print", "hi"]);
  });

  it("leaves args untouched when the conversation db doesn't exist yet", () => {
    const out = dropOversizedResume(
      ["--conversation", "will-be-created", "--print", "hi"],
      dataDir,
      DEFAULT_MAX_RESUME_DB_BYTES,
    );
    expect(out.dropped).toBeUndefined();
    expect(out.args).toEqual(["--conversation", "will-be-created", "--print", "hi"]);
  });
});

describe("resolveGoogleAntigravityExecutionArgs — resume guard integration", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-exec-args-"));
    fs.mkdirSync(path.join(dataDir, "conversations"));
  });
  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  it("drops --conversation when the bound db exceeds the configured cap", () => {
    fs.writeFileSync(
      path.join(dataDir, "conversations", "huge.db"),
      Buffer.alloc(3_000_000),
    );
    const out = resolveGoogleAntigravityExecutionArgs(
      {
        baseArgs: ["--conversation", "huge", "--print", "hi"],
        modelId: "gemini-3.7-flash",
        provider: GOOGLE_ANTIGRAVITY_PROVIDER_ID,
        config: {},
      } as any,
      { dataDir },
    );
    expect(out).not.toContain("--conversation");
    expect(out).not.toContain("huge");
  });

  it("keeps --conversation when maxResumeDbBytes=false disables the guard", () => {
    fs.writeFileSync(
      path.join(dataDir, "conversations", "huge.db"),
      Buffer.alloc(3_000_000),
    );
    const out = resolveGoogleAntigravityExecutionArgs(
      {
        baseArgs: ["--conversation", "huge", "--print", "hi"],
        modelId: "gemini-3.7-flash",
        provider: GOOGLE_ANTIGRAVITY_PROVIDER_ID,
        config: {
          plugins: {
            entries: {
              [GOOGLE_ANTIGRAVITY_PROVIDER_ID]: { config: { maxResumeDbBytes: false } },
            },
          },
        },
      } as any,
      { dataDir },
    );
    expect(out).toContain("--conversation");
    expect(out).toContain("huge");
  });
});
