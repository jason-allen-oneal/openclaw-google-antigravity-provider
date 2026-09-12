import { describe, expect, it } from "vitest";
import plugin from "../plugin.js";
import providerDiscovery from "../provider-discovery.js";

describe("self-contained package entries", () => {
  it("loads the source plugin and provider discovery entries", async () => {
    expect(plugin.id).toBe("google-antigravity-cli");
    expect(providerDiscovery.id).toBe("google-antigravity-cli");
    const catalog = await providerDiscovery.staticCatalog?.run({} as any);
    expect(catalog && "provider" in catalog).toBe(true);
    if (!catalog || !("provider" in catalog)) {
      throw new Error("expected provider catalog");
    }
    expect(catalog.provider.models.some((model) => model.input.includes("image"))).toBe(true);
  });
});
