import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildGoogleAntigravityProvider,
  buildModelCatalogRows,
  default as plugin,
  GOOGLE_ANTIGRAVITY_AUTH_MARKER,
  listGoogleAntigravityCatalog,
  MODEL_DEFINITIONS,
  registerAntigravityCatchUpHook,
} from "./index.js";
import { GOOGLE_ANTIGRAVITY_PROVIDER_ID } from "./backend.js";
import {
  clearAntigravityModelsCache,
  STATIC_MODEL_FALLBACK,
} from "./models.js";

describe("buildGoogleAntigravityProvider", () => {
  it("registers provider metadata and synthetic auth marker", () => {
    const provider = buildGoogleAntigravityProvider(GOOGLE_ANTIGRAVITY_PROVIDER_ID, {
      probe: () => ({ ok: true, helpText: "--print --model --print-timeout" }),
    });

    expect(provider.id).toBe(GOOGLE_ANTIGRAVITY_PROVIDER_ID);
    expect(provider.resolveSyntheticAuth?.({} as any)).toEqual({
      apiKey: GOOGLE_ANTIGRAVITY_AUTH_MARKER,
      source: "local agy runtime",
      mode: "api-key",
    });
  });

  it("returns null synthetic auth when agy probe fails", () => {
    const provider = buildGoogleAntigravityProvider(GOOGLE_ANTIGRAVITY_PROVIDER_ID, {
      probe: () => ({ ok: false, reason: "agy not found" }),
    });
    expect(provider.resolveSyntheticAuth?.({} as any)).toBeNull();
  });

  it("persists the local marker and extends an existing model allowlist", async () => {
    const provider = buildGoogleAntigravityProvider(GOOGLE_ANTIGRAVITY_PROVIDER_ID, {
      probe: () => ({ ok: true, helpText: "--print --model --print-timeout" }),
    });
    const result = await provider.auth?.[0]?.run({
      config: {
        agents: { defaults: { modelPolicy: { allow: ["openai/*"] } } },
      },
      prompter: {
        note: async () => undefined,
        confirm: async () => true,
      },
    } as any);

    expect(result?.profiles).toEqual([
      {
        profileId: `${GOOGLE_ANTIGRAVITY_PROVIDER_ID}:local`,
        credential: {
          type: "api_key",
          provider: GOOGLE_ANTIGRAVITY_PROVIDER_ID,
          key: GOOGLE_ANTIGRAVITY_AUTH_MARKER,
        },
      },
    ]);
    expect(result?.configPatch?.agents?.defaults?.modelPolicy?.allow).toEqual(
      expect.arrayContaining([
        "openai/*",
        `${GOOGLE_ANTIGRAVITY_PROVIDER_ID}/gemini-3.7-flash`,
      ]),
    );
  });

  it("resolves dynamic models with derived metadata for any id", () => {
    const provider = buildGoogleAntigravityProvider();

    const gemini = provider.resolveDynamicModel?.({ modelId: "gemini-3.7-flash" } as any);
    expect(gemini).toEqual(
      expect.objectContaining({
        id: "gemini-3.7-flash",
        provider: GOOGLE_ANTIGRAVITY_PROVIDER_ID,
        contextWindow: 1_000_000,
        reasoning: true,
      }),
    );

    // Unknown-to-us Gemini id still resolves (heuristic).
    const future = provider.resolveDynamicModel?.({ modelId: "gemini-9.0-flash-high" } as any);
    expect(future).toEqual(
      expect.objectContaining({ contextWindow: 1_000_000, reasoning: true }),
    );

    // Claude and GPT get correct context windows (previously hardcoded to 1M).
    const claude = provider.resolveDynamicModel?.({ modelId: "claude-sonnet-4-6" } as any);
    expect(claude).toEqual(expect.objectContaining({ contextWindow: 200_000 }));
    const gpt = provider.resolveDynamicModel?.({ modelId: "gpt-oss-120b-medium" } as any);
    expect(gpt).toEqual(expect.objectContaining({ contextWindow: 128_000 }));
  });

  it("accepts real agy ids and rejects wildcard/globby routing keys", () => {
    const provider = buildGoogleAntigravityProvider();
    expect(provider.isModernModelRef?.({ modelId: "gemini-3.8-flash-high" } as any)).toBe(true);
    expect(provider.isModernModelRef?.({ modelId: "" } as any)).toBe(false);
    // Openclaw's `agents.defaults.models` routing wildcards get enumerated
    // as candidate model refs; the picker asks the provider about each key.
    // Accepting `*` (or `provider/*`) would materialise a synthetic model
    // row named `*` in the /models picker.
    expect(provider.isModernModelRef?.({ modelId: "*" } as any)).toBe(false);
    expect(provider.isModernModelRef?.({ modelId: "google-antigravity-cli/*" } as any)).toBe(false);
    expect(provider.isModernModelRef?.({ modelId: "gemini/*" } as any)).toBe(false);
    expect(provider.isModernModelRef?.({ modelId: "--conversation" } as any)).toBe(false);
    expect(provider.isModernModelRef?.({ modelId: "gemini model" } as any)).toBe(false);
    expect(provider.isModernModelRef?.({ modelId: "Gemini-3.7-Flash" } as any)).toBe(false);
  });

  it("returns undefined from resolveDynamicModel for non-routable ids", () => {
    const provider = buildGoogleAntigravityProvider();
    expect(provider.resolveDynamicModel?.({ modelId: "*" } as any)).toBeUndefined();
    expect(provider.resolveDynamicModel?.({ modelId: "" } as any)).toBeUndefined();
    expect(
      provider.resolveDynamicModel?.({ modelId: "google-antigravity-cli/*" } as any),
    ).toBeUndefined();
  });
});

describe("buildModelCatalogRows", () => {
  it("maps static definitions to unified catalog entries", () => {
    const rows = buildModelCatalogRows(GOOGLE_ANTIGRAVITY_PROVIDER_ID);
    expect(rows.length).toBe(MODEL_DEFINITIONS.length);
    expect(rows.every((row) => row.kind === "text")).toBe(true);
    expect(rows.every((row) => row.provider === GOOGLE_ANTIGRAVITY_PROVIDER_ID)).toBe(true);
    expect(rows.every((row) => row.source === "static")).toBe(true);
    const sonnet = rows.find((row) => row.model === "claude-sonnet-4-6");
    expect(sonnet?.capabilities).toEqual(
      expect.objectContaining({ reasoning: true, contextWindow: 200_000 }),
    );
  });
});

describe("listGoogleAntigravityCatalog", () => {
  afterEach(() => {
    clearAntigravityModelsCache();
    vi.unstubAllEnvs();
  });

  it("returns null when running under vitest to keep tests offline", async () => {
    // VITEST is set by the runner. Test the belt-and-braces NODE_ENV path too.
    vi.stubEnv("NODE_ENV", "test");
    const result = await listGoogleAntigravityCatalog({
      env: { ...process.env, NODE_ENV: "test" },
    } as any);
    expect(result).toBeNull();
  });

  it("returns null when live fetch cannot be reached and no cache exists", async () => {
    const result = await listGoogleAntigravityCatalog({
      env: { PATH: "/nonexistent" },
      timeoutMs: 500,
    } as any);
    expect(result).toBeNull();
  });
});

describe("STATIC_MODEL_FALLBACK", () => {
  it("only lists real agy model ids", () => {
    // The static fallback must not include IDs that agy has since dropped
    // (this used to include gemini-3.5-flash-*).
    for (const model of STATIC_MODEL_FALLBACK) {
      expect(model.id).not.toMatch(/gemini-3\.5-flash/);
    }
  });
});

describe("plugin lifecycle registration", () => {
  it("registers hot reload and configured-provider auto-enable hooks", () => {
    const registerReload = vi.fn();
    const registerAutoEnableProbe = vi.fn();
    expect(plugin.register).toBeDefined();
    if (!plugin.register) throw new Error("expected plugin register function");
    plugin.register({
      registerReload,
      registerAutoEnableProbe,
      registerProvider: vi.fn(),
      registerCliBackend: vi.fn(),
      registerModelCatalogProvider: vi.fn(),
      on: vi.fn(),
    } as any);

    expect(registerReload).toHaveBeenCalledWith({
      restartPrefixes: ["plugins.entries.google-antigravity-cli.config"],
    });
    const probe = registerAutoEnableProbe.mock.calls[0]?.[0];
    expect(typeof probe).toBe("function");
    expect(probe({ config: {} })).toBeNull();
    expect(
      probe({
        config: {
          models: {
            providers: {
              "google-antigravity-cli": { models: [{ id: "gemini-3.7-flash" }] },
            },
          },
        },
      }),
    ).toMatch(/configured with 1 model/);
  });

  it("registers before_prompt_build through the typed hook API", () => {
    const on = vi.fn();
    registerAntigravityCatchUpHook({ on } as any);

    expect(on).toHaveBeenCalledWith(
      "before_prompt_build",
      expect.any(Function),
      expect.objectContaining({
        registrationId: "google-antigravity-cli:catch-up-and-workspace-context",
      }),
    );
  });
});
