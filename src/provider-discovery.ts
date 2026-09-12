import type { ProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";

import {
  buildAntigravityProviderCatalog,
  GOOGLE_ANTIGRAVITY_AUTH_MARKER,
} from "./index.js";
import { probeAgy } from "./probe.js";

const providerId = "google-antigravity-cli";

const providerDiscovery: ProviderPlugin = {
  id: providerId,
  label: "Google Antigravity CLI",
  docsPath: "/gateway/cli-backends",
  auth: [],
  staticCatalog: {
    order: "simple",
    run: async () => ({ provider: buildAntigravityProviderCatalog(providerId) }),
  },
  resolveSyntheticAuth: () =>
    probeAgy().ok
      ? {
          apiKey: GOOGLE_ANTIGRAVITY_AUTH_MARKER,
          source: "local agy runtime",
          mode: "api-key",
        }
      : null,
};

export default providerDiscovery;
