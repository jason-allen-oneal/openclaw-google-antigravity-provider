import {
  definePluginEntry,
  type OpenClawPluginApi,
  type OpenClawPluginDefinition,
  type ProviderAuthContext,
  type ProviderRuntimeModel,
  type UnifiedModelCatalogEntry,
  type ProviderPlugin,
  type UnifiedModelCatalogProviderContext,
} from "openclaw/plugin-sdk/plugin-entry";
import path from "node:path";
import {
  buildGoogleAntigravityCliBackend,
  GOOGLE_ANTIGRAVITY_DEFAULT_MODEL_REF,
  GOOGLE_ANTIGRAVITY_PROVIDER_ID,
  resolveAntigravityDataDir,
  resolveCachedConversationId,
} from "./backend.js";
import {
  clearAntigravityModelsCache,
  DEFAULT_LIVE_TIMEOUT_MS,
  deriveModelMetadata,
  getLiveAntigravityModels,
  STATIC_MODEL_FALLBACK,
  type AntigravityModel,
} from "./models.js";
import { probeAgy, type AgyProbeResult } from "./probe.js";
import {
  buildCrossProviderCatchUp,
  defaultCatchUpMaxChars,
} from "./session-continuity.js";
import {
  buildWorkspaceContextBlock,
  defaultWorkspaceContextMaxChars,
  readWorkspaceBootstrapFiles,
  workspaceBootstrapFingerprint,
  WorkspaceContextDeliveryTracker,
} from "./workspace-bootstrap.js";
import { registerAntigravitySessionCatalog } from "./session-catalog.js";
import { antigravityToolsFactory } from "./tools.js";
import { buildAntigravityCommand } from "./commands.js";
import { buildAntigravityMediaUnderstandingProvider } from "./media-understanding.js";

export const GOOGLE_ANTIGRAVITY_AUTH_MARKER = "antigravity-local-session";

// Compile-time list. `staticCatalog` returns this; the live list is fetched
// on demand via `getLiveAntigravityModels()`.
export const MODEL_DEFINITIONS: readonly AntigravityModel[] = STATIC_MODEL_FALLBACK;

// True when `modelId` is something agy could actually accept as `--model`.
// Openclaw's picker enumerates `agents.defaults.models` keys and asks the
// provider to resolve each one; without this guard the wildcard routing key
// `google-antigravity-cli/*` gets materialised into a synthetic "*" model
// row (name `*`, 200K context from the fallback branch of
// deriveContextWindow). agy would reject `--model *` at spawn time anyway,
// so filtering here just hides a picker artefact.
export function isRoutableAgyModelId(modelId: unknown): boolean {
  if (typeof modelId !== "string") return false;
  const trimmed = modelId.trim();
  if (trimmed.length === 0) return false;
  // Every currently exposed agy model is a lowercase slug. Requiring an
  // alphanumeric first character also prevents a model value from being
  // interpreted as another CLI option after `--model`.
  return /^[a-z0-9][a-z0-9._-]*$/.test(trimmed);
}

function buildRuntimeModel(providerId: string, modelId: string): ProviderRuntimeModel {
  const meta = deriveModelMetadata(modelId);
  return {
    id: modelId,
    name: meta.name,
    provider: providerId,
    api: "google-generative-ai",
    baseUrl: "http://antigravity.local",
    reasoning: meta.reasoning,
    input: [...meta.input],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: meta.contextWindow,
    maxTokens: 65_536,
  };
}

async function buildAntigravityConfigPatch(
  providerId = GOOGLE_ANTIGRAVITY_PROVIDER_ID,
  existingAllow?: readonly string[],
): Promise<Record<string, unknown>> {
  // OpenClaw's `/models` picker (`src/auto-reply/reply/commands-models.ts`,
  // v2026.8.1) instantiates its auth checker with
  // `allowPluginSyntheticAuth: false`, which means our plugin-declared
  // `syntheticAuthRefs` is ignored in that code path. The synthetic-auth
  // check then falls back to requiring
  // `providerConfig.models.length > 0`. Without that, `/models` never
  // surfaces this provider, even though its plugin-registered catalog is
  // populated. Snapshot the current live catalog (or the static fallback)
  // into `models.providers.<id>.models[]` so the picker sees it.
  const live = shouldSkipLiveFetch(process.env)
    ? null
    : await getLiveAntigravityModels();
  const models = live?.models ?? STATIC_MODEL_FALLBACK;
  const modelRefs = models.map((model) => `${providerId}/${model.id}`);
  return {
    models: {
      providers: {
        [providerId]: {
          baseUrl: "http://antigravity.local",
          api: "google-generative-ai",
          models: models.map((model) => ({
            id: model.id,
            name: model.name,
            reasoning: model.reasoning,
            input: [...model.input],
            contextWindow: model.contextWindow,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          })),
        },
      },
    },
    agents: {
      defaults: {
        models: {
          // Wildcard mapping routes every Antigravity model ID through the
          // CLI backend, so new models Google ships without a plugin release
          // pick up the same routing automatically.
          [`${providerId}/*`]: { agentRuntime: { id: providerId } },
        },
        ...(existingAllow
          ? {
              modelPolicy: {
                allow: [...new Set([...existingAllow, ...modelRefs])],
              },
            }
          : {}),
      },
    },
  };
}

export function buildAntigravityProviderCatalog(
  providerId = GOOGLE_ANTIGRAVITY_PROVIDER_ID,
) {
  return {
    baseUrl: "http://antigravity.local",
    apiKey: GOOGLE_ANTIGRAVITY_AUTH_MARKER,
    api: "google-generative-ai" as const,
    agentRuntime: { id: providerId },
    models: MODEL_DEFINITIONS.map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: [...model.input],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.contextWindow,
      maxTokens: 65_536,
      agentRuntime: { id: providerId },
    })),
  };
}

function shouldSkipLiveFetch(env: NodeJS.ProcessEnv): boolean {
  // Match bundled plugins (deepinfra, openrouter): keep tests offline so
  // catalog tests don't shell out to a real `agy` binary.
  return env.NODE_ENV === "test" || Boolean(env.VITEST);
}

function toCatalogEntry(
  providerId: string,
  model: AntigravityModel,
  source: UnifiedModelCatalogEntry["source"],
  timestamps?: { fetchedAt: number; expiresAt: number },
): UnifiedModelCatalogEntry {
  return {
    kind: "text",
    provider: providerId,
    model: model.id,
    label: model.name,
    source,
    capabilities: {
      reasoning: model.reasoning,
      input: [...model.input],
      contextWindow: model.contextWindow,
    },
    ...(timestamps ?? {}),
  };
}

export function buildModelCatalogRows(
  providerId: string,
  source: UnifiedModelCatalogEntry["source"] = "static",
  models: readonly AntigravityModel[] = MODEL_DEFINITIONS,
): UnifiedModelCatalogEntry[] {
  return models.map((model) => toCatalogEntry(providerId, model, source));
}

export type BuildGoogleAntigravityProviderOptions = {
  probe?: () => AgyProbeResult;
};

export function buildGoogleAntigravityProvider(
  providerId = GOOGLE_ANTIGRAVITY_PROVIDER_ID,
  options: BuildGoogleAntigravityProviderOptions = {},
): ProviderPlugin {
  const runProbe = options.probe ?? probeAgy;
  return {
    id: providerId,
    label: "Google Antigravity CLI",
    docsPath: "/gateway/cli-backends",
    envVars: ["ANTIGRAVITY_USER_DATA_DIR"],
    auth: [
      {
        id: "custom",
        label: "Google Antigravity CLI",
        hint: "Delegate text inference to a local signed-in agy CLI",
        kind: "custom",
        run: async (ctx: ProviderAuthContext) => {
          await ctx.prompter.note(
            [
              "OpenClaw delegates agent turns to the local agy --print harness.",
              "OpenClaw binds each chat to its own persistent Antigravity conversation and resumes it by id.",
              "The harness supports process cancellation and Antigravity's native tools.",
              "Antigravity owns Google authentication and session state.",
            ].join("\n"),
            "Google Antigravity CLI",
          );

          if (
            !(await ctx.prompter.confirm({
              message: "Configure the local Antigravity agy runtime?",
              initialValue: false,
            }))
          ) {
            return { profiles: [] };
          }

          const result = runProbe();
          if (!result.ok) {
            throw new Error(result.reason);
          }

          const existingAllow = ctx.config.agents?.defaults?.modelPolicy?.allow;
          return {
            profiles: [
              {
                profileId: `${providerId}:local`,
                credential: {
                  type: "api_key",
                  provider: providerId,
                  key: GOOGLE_ANTIGRAVITY_AUTH_MARKER,
                },
              },
            ],
            defaultModel: GOOGLE_ANTIGRAVITY_DEFAULT_MODEL_REF,
            configPatch: await buildAntigravityConfigPatch(providerId, existingAllow),
            notes: [
              "Uses the local signed-in agy runtime. OpenClaw does not import or persist Antigravity OAuth tokens.",
              "Prompts are passed through agy --print as command-line arguments.",
              "Persistent Antigravity conversation ids are stored in the normal OpenClaw CLI session binding.",
            ],
          };
        },
      },
    ],
    wizard: {
      setup: {
        choiceId: providerId,
        choiceLabel: "Google Antigravity CLI",
        choiceHint: "Delegate text inference to a local signed-in agy CLI",
        groupId: providerId,
        groupLabel: "Google Antigravity CLI",
        groupHint: "Local CLI runtime",
        methodId: "custom",
      },
    },
    resolveSyntheticAuth: () => {
      if (!runProbe().ok) return null;
      return {
        apiKey: GOOGLE_ANTIGRAVITY_AUTH_MARKER,
        source: "local agy runtime",
        mode: "api-key",
      };
    },
    staticCatalog: {
      order: "simple",
      run: async () => ({ provider: buildAntigravityProviderCatalog(providerId) }),
    },
    resolveDynamicModel: ({ modelId }: { modelId: string }) =>
      isRoutableAgyModelId(modelId) ? buildRuntimeModel(providerId, modelId) : undefined,
    // Any well-formed model id is routable — the plugin forwards it verbatim
    // to `agy --model`. Reject wildcard/globby ids so an openclaw routing key
    // like `google-antigravity-cli/*` in `agents.defaults.models` cannot be
    // materialised into a fake "*" model row in the picker.
    isModernModelRef: ({ modelId }: { modelId: string }) => isRoutableAgyModelId(modelId),
  };
}

export async function listGoogleAntigravityCatalog(
  ctx: UnifiedModelCatalogProviderContext,
): Promise<readonly UnifiedModelCatalogEntry[] | null> {
  if (shouldSkipLiveFetch(ctx.env ?? process.env)) return null;

  const live = await getLiveAntigravityModels({
    timeoutMs: ctx.timeoutMs ?? DEFAULT_LIVE_TIMEOUT_MS,
    signal: ctx.signal,
  });

  if (!live) return null;

  const timestamps = { fetchedAt: live.fetchedAt, expiresAt: live.expiresAt };
  return live.models.map((model) =>
    toCatalogEntry(GOOGLE_ANTIGRAVITY_PROVIDER_ID, model, live.source, timestamps),
  );
}

// A resumed agy conversation only contains turns agy itself ran. When a
// session spends turns on another provider and comes back, openclaw reuses the
// stored binding and sends just the new message, so agy never sees the gap.
// `before_prompt_build` runs on the CLI path with the session transcript, and
// its `prependContext` is folded into the outgoing prompt, which makes it the
// place to hand agy the turns it missed.
// The agy conversation currently bound to this workspace, read from agy's own
// cwd -> conversation cache. undefined means the next turn starts a fresh one.
async function currentConversationId(cwd: string): Promise<string | undefined> {
  const dataDir = resolveAntigravityDataDir(process.env);
  return resolveCachedConversationId({
    cachePath: path.join(dataDir, "cache", "last_conversations.json"),
    cwd,
  });
}

export function registerAntigravityCatchUpHook(
  api: OpenClawPluginApi,
  providerId = GOOGLE_ANTIGRAVITY_PROVIDER_ID,
): void {
  const register = (api as { registerHook?: unknown }).registerHook;
  // Older gateways within our supported range may not expose registerHook.
  // Catch-up is an enhancement, so degrade to the previous behaviour instead
  // of failing plugin load.
  if (typeof register !== "function") return;

  const tracker = new WorkspaceContextDeliveryTracker();

  // Narrow the openclaw hook payload shape at the boundary. The SDK's
  // BeforePromptBuild types aren't re-exported from `plugin-entry`; using
  // structural checks here avoids taking a hard dependency on an internal
  // subpath that could rename between releases.
  const readString = (v: unknown): string | undefined =>
    typeof v === "string" ? v : undefined;
  const asRecord = (v: unknown): Record<string, unknown> | undefined =>
    v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;

  api.registerHook(
    "before_prompt_build",
    (async (rawEvent: unknown, rawCtx: unknown) => {
      const event = asRecord(rawEvent) ?? {};
      const ctx = asRecord(rawCtx) ?? {};
      // Only our own turns: another provider's turn needs no agy catch-up.
      const eventProvider = readString(ctx.modelProviderId)?.trim().toLowerCase();
      if (eventProvider !== providerId) return;

      const blocks: string[] = [];

      // Workspace instructions first: they frame everything that follows.
      // `ctx.workspaceDir` is resolved per run, so a multi-agent gateway gets
      // each agent's own workspace rather than a shared one.
      const workspaceDir = readString(ctx.workspaceDir)?.trim() ?? "";
      const agentId = readString(ctx.agentId);
      if (workspaceDir) {
        try {
          const conversationId = await currentConversationId(workspaceDir);
          // Read first so an edit to the instructions re-delivers into a
          // conversation that is otherwise still healthy.
          const files = await readWorkspaceBootstrapFiles(workspaceDir);
          const fingerprint = workspaceBootstrapFingerprint(files);
          if (
            files.length > 0 &&
            tracker.shouldSend(agentId, workspaceDir, conversationId, fingerprint)
          ) {
            const block = buildWorkspaceContextBlock({
              workspaceDir,
              agentId,
              files,
              maxChars: defaultWorkspaceContextMaxChars(),
            });
            if (block) blocks.push(block);
          }
        } catch {
          // Workspace context is an enhancement; a turn is still valid without
          // it, so a read failure must not take the turn down.
        }
      }

      const messages = Array.isArray(event.messages) ? event.messages : [];
      const catchUp = buildCrossProviderCatchUp({
        messages,
        providerId,
        currentPrompt: readString(event.prompt),
        maxChars: defaultCatchUpMaxChars(),
      });
      if (catchUp) blocks.push(catchUp);

      return blocks.length > 0 ? { prependContext: blocks.join("\n\n") } : undefined;
    }) as never,
    // OpenClaw 2026.8.x+ requires `name` on every hook registration; without
    // it plugin registration fails with `hook registration missing name`.
    { name: `${providerId}:catch-up-and-workspace-context` } as never,
  );
}

// Wrap each `api.register*` block so one failing registration can't take
// the rest of the plugin down. This is the same guard codex uses for its
// conversation-binding hooks — a broken tool factory now degrades to
// "that specific surface is missing" instead of "the whole provider is
// offline" (the class of failure the typebox regression exhibited).
function safeRegister(label: string, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(
      `[google-antigravity-cli] ${label} failed to register: ${
        (error as Error).message
      }`,
    );
  }
}

const plugin: OpenClawPluginDefinition = definePluginEntry({
  id: GOOGLE_ANTIGRAVITY_PROVIDER_ID,
  name: "Google Antigravity CLI Provider",
  description: "Persistent agent turns through a local Google Antigravity agy CLI",
  register(api: OpenClawPluginApi) {
    // Hot-reload on config edits — matches the codex/team-reports pattern.
    // Every key under our config affects backend behavior (permission mode,
    // MCP bridge state, resume guard, session-catalog visibility), so
    // restart on any change under the prefix and let openclaw's reload
    // machinery re-run register() with the new snapshot.
    safeRegister("reload", () => {
      if (typeof (api as { registerReload?: unknown }).registerReload !== "function") return;
      (api as {
        registerReload: (opts: { restartPrefixes: string[] }) => void;
      }).registerReload({
        restartPrefixes: [`plugins.entries.${GOOGLE_ANTIGRAVITY_PROVIDER_ID}.config`],
      });
    });
    // Auto-enable the plugin when the user has configured a
    // `google-antigravity-cli` model provider — same UX the google /
    // openai / xai plugins ship. Declaratively hinted via manifest
    // `autoEnableWhenConfiguredProviders`; the probe adds a defense-
    // in-depth check that at least one model row is populated so a
    // half-written config doesn't flip the plugin on.
    safeRegister("auto-enable-probe", () => {
      if (
        typeof (api as { registerAutoEnableProbe?: unknown }).registerAutoEnableProbe !==
        "function"
      )
        return;
      (api as {
        registerAutoEnableProbe: (
          probe: (input: { config: Record<string, unknown> }) => string | null,
        ) => void;
      }).registerAutoEnableProbe(({ config }) => {
        const providers =
          ((config?.models as Record<string, unknown> | undefined)?.providers as
            | Record<string, unknown>
            | undefined) ?? undefined;
        const provider = providers?.[GOOGLE_ANTIGRAVITY_PROVIDER_ID] as
          | { models?: unknown[] }
          | undefined;
        if (provider && Array.isArray(provider.models) && provider.models.length > 0) {
          return `google-antigravity-cli provider configured with ${provider.models.length} model(s)`;
        }
        return null;
      });
    });
    safeRegister("provider", () =>
      api.registerProvider(buildGoogleAntigravityProvider("google-antigravity-cli")),
    );
    safeRegister("cli-backend", () =>
      api.registerCliBackend(buildGoogleAntigravityCliBackend("google-antigravity-cli")),
    );
    safeRegister("model-catalog", () =>
      api.registerModelCatalogProvider({
        provider: "google-antigravity-cli",
        kinds: ["text"],
        staticCatalog: () =>
          buildModelCatalogRows("google-antigravity-cli", "static", STATIC_MODEL_FALLBACK),
        liveCatalog: listGoogleAntigravityCatalog,
      }),
    );
    // Surfaces existing agy conversations (read-only) in the OpenClaw
    // sidebar. Continues resume via `agy --conversation <id>` through
    // the CLI backend registered above.
    safeRegister("session-catalog", () => registerAntigravitySessionCatalog(api));
    safeRegister("catch-up-hook", () => registerAntigravityCatchUpHook(api));
    // Custom transcript tools — any agent can call these to inspect
    // agy state (`antigravity_conversations_list`, `_read`) or force
    // a fresh binding (`antigravity_reset_binding`, owner-only).
    safeRegister("transcript-tools", () => {
      if (typeof (api as { registerTool?: unknown }).registerTool !== "function") return;
      (api as {
        registerTool: (
          factory: ReturnType<typeof antigravityToolsFactory>,
          opts?: { names?: string[] },
        ) => void;
      }).registerTool(antigravityToolsFactory(), {
        names: [
          "antigravity_conversations_list",
          "antigravity_conversation_read",
          "antigravity_reset_binding",
        ],
      });
    });
    // /antigravity slash command — list / status / reset agy conversations
    // without having to open a terminal.
    safeRegister("slash-command", () => {
      if (typeof (api as { registerCommand?: unknown }).registerCommand !== "function") return;
      (api as {
        registerCommand: (cmd: ReturnType<typeof buildAntigravityCommand>) => void;
      }).registerCommand(buildAntigravityCommand());
    });
    // Media understanding — front agy's native vision (Gemini / Claude
    // through agy) as a one-shot describeImage provider so any openclaw
    // feature that needs image understanding can delegate to us without
    // routing a whole conversation through the harness.
    safeRegister("media-understanding", () => {
      if (
        typeof (api as { registerMediaUnderstandingProvider?: unknown })
          .registerMediaUnderstandingProvider !== "function"
      )
        return;
      (api as {
        registerMediaUnderstandingProvider: (
          provider: ReturnType<typeof buildAntigravityMediaUnderstandingProvider>,
        ) => void;
      }).registerMediaUnderstandingProvider(
        buildAntigravityMediaUnderstandingProvider(),
      );
    });
  },
});

export { clearAntigravityModelsCache };
export default plugin;
