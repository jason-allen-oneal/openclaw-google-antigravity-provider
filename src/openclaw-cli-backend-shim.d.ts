// openclaw 2026.9.x still ships `registerCliBackend` and executes CLI backends
// (the bundled google/anthropic plugins register their own), but it no longer
// publishes type declarations for the `openclaw/plugin-sdk/cli-backend`
// subpath — the runtime export survives, the `.d.ts` does not. The types now
// live only in a content-hashed internal chunk with no stable import path.
//
// These structural declarations mirror the shipped definitions so this plugin
// keeps compiling. Same approach `src/session-catalog.ts` already takes for
// the gateway-protocol types. Drop this file if a future release re-publishes
// the subpath's declarations.
declare module "openclaw/plugin-sdk/cli-backend" {
  export type CliBackendThinkingLevel =
    | "off"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "adaptive"
    | "max";

  export type CliBackendExecutionMode = "agent" | "side-question";

  export type CliBackendNativeToolMode = "none" | "always-on" | "selectable";

  export type CliBackendConfig = {
    command: string;
    args?: string[];
    output?: "json" | "text" | "jsonl";
    resumeOutput?: "json" | "text" | "jsonl";
    jsonlDialect?: "claude-stream-json" | "gemini-stream-json";
    liveSession?: "claude-stdio";
    input?: "arg" | "stdin";
    maxPromptArgChars?: number;
    env?: Record<string, string>;
    clearEnv?: string[];
    modelArg?: string;
    modelAliases?: Record<string, string>;
    sessionArgs?: string[];
    resumeArgs?: string[];
    forkArg?: string;
    resumeAtArg?: string;
    sessionMode?: "always" | "existing" | "none";
    sessionIdFields?: string[];
    systemPromptArg?: string;
    systemPromptFileArg?: string;
    systemPromptFileConfigArg?: string;
    systemPromptFileConfigKey?: string;
    systemPromptMode?: "append" | "replace";
    systemPromptWhen?: "first" | "always" | "never";
    /** Flag used to pass image paths. `"@"` prefixes them into the prompt. */
    imageArg?: string;
    /** How to pass multiple images. */
    imageMode?: "repeat" | "list";
    /** Where staged image files live before the CLI is handed them. */
    imagePathScope?: "temp" | "workspace";
    serialize?: boolean;
    reseedFromRawTranscriptWhenUncompacted?: boolean;
    freshSessionRecovery?: "replace-binding" | "invalidated-only";
    reliability?: Record<string, unknown>;
  };

  export type CliBackendNormalizeConfigContext = {
    config?: Record<string, unknown>;
    backendId: string;
    agentId?: string;
  };

  export type CliBackendResolveExecutionArgsContext = {
    config?: Record<string, unknown>;
    workspaceDir: string;
    provider: string;
    modelId: string;
    authProfileId?: string;
    thinkingLevel?: CliBackendThinkingLevel;
    executionMode?: CliBackendExecutionMode;
    useResume: boolean;
    baseArgs: readonly string[];
  };

  export type CliBackendPlugin = {
    id: string;
    modelProvider?: string;
    config: CliBackendConfig;
    liveTest?: { defaultModelRef?: string };
    nativeToolMode?: CliBackendNativeToolMode;
    ownsNativeCompaction?: boolean;
    normalizeConfig?: (
      config: CliBackendConfig,
      context?: CliBackendNormalizeConfigContext,
    ) => CliBackendConfig;
    resolveExecutionArgs?: (context: CliBackendResolveExecutionArgsContext) => string[];
    // Loosely typed on purpose: the real contract carries
    // CliBackendPrepareExecutionContext/CliBackendPreparedExecution, which have
    // no published declarations to mirror. `any` keeps this assignable to the
    // shipped type in both directions.
    prepareExecution?: (ctx: any) => any;
    [key: string]: any;
  };
}
