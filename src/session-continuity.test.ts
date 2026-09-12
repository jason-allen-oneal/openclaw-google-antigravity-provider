import { describe, expect, it } from "vitest";
import {
  buildCrossProviderCatchUp,
  extractMessageText,
  findLastOwnAssistantIndex,
  renderCatchUpMessage,
} from "./session-continuity.js";

const AGY = "google-antigravity-cli";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (provider: string, text: string) => ({
  role: "assistant",
  provider,
  content: [{ type: "text", text }],
});

describe("extractMessageText", () => {
  it("reads plain strings and text blocks, ignoring non-text content", () => {
    expect(extractMessageText("hello")).toBe("hello");
    expect(
      extractMessageText([
        { type: "thinking", thinking: "hidden" },
        { type: "text", text: "visible" },
        { type: "toolCall", name: "bash" },
      ]),
    ).toBe("visible");
    expect(extractMessageText(undefined)).toBe("");
  });
});

describe("renderCatchUpMessage", () => {
  it("labels user, assistant and compaction summaries", () => {
    expect(renderCatchUpMessage(user("hi"))).toBe("User: hi");
    expect(renderCatchUpMessage(assistant("openrouter", "yo"))).toBe("Assistant: yo");
    expect(
      renderCatchUpMessage({ role: "compactionSummary", summary: "earlier stuff" }),
    ).toBe("Compaction summary: earlier stuff");
  });

  it("drops tool traffic and empty messages", () => {
    expect(renderCatchUpMessage({ role: "toolResult", content: "out" })).toBeUndefined();
    expect(renderCatchUpMessage(user("   "))).toBeUndefined();
  });
});

describe("findLastOwnAssistantIndex", () => {
  it("finds our newest assistant turn and ignores other providers", () => {
    const messages = [
      user("a"),
      assistant(AGY, "first"),
      user("b"),
      assistant("openrouter", "other"),
    ];
    expect(findLastOwnAssistantIndex(messages, AGY)).toBe(1);
  });

  it("returns -1 when this provider has never spoken", () => {
    expect(findLastOwnAssistantIndex([user("a"), assistant("openrouter", "x")], AGY)).toBe(-1);
  });

  it("matches provider ids case-insensitively", () => {
    expect(findLastOwnAssistantIndex([assistant("Google-Antigravity-CLI", "x")], AGY)).toBe(0);
  });
});

describe("buildCrossProviderCatchUp", () => {
  it("stays silent on the first switch-in so it cannot duplicate the reseed", () => {
    // No agy assistant turn yet => openclaw has no binding to reuse and
    // reseeds the transcript itself.
    const messages = [user("hello"), assistant("openrouter", "hi there"), user("next")];
    expect(buildCrossProviderCatchUp({ messages, providerId: AGY })).toBeUndefined();
  });

  it("stays silent on consecutive agy turns", () => {
    const messages = [user("a"), assistant(AGY, "answer")];
    expect(buildCrossProviderCatchUp({ messages, providerId: AGY })).toBeUndefined();
  });

  it("injects the turns that ran on another provider while agy was away", () => {
    const messages = [
      user("start"),
      assistant(AGY, "agy replied"),
      user("ask openrouter something"),
      assistant("openrouter", "openrouter replied"),
      user("and more"),
      assistant("openrouter", "second openrouter reply"),
    ];
    const out = buildCrossProviderCatchUp({ messages, providerId: AGY });
    expect(out).toBeDefined();
    expect(out).toContain("<turns_you_missed>");
    expect(out).toContain("User: ask openrouter something");
    expect(out).toContain("Assistant: openrouter replied");
    expect(out).toContain("Assistant: second openrouter reply");
    // Nothing from before our own last turn leaks in.
    expect(out).not.toContain("start");
    expect(out).not.toContain("agy replied");
  });

  it("does not replay the current prompt when it is already staged in the transcript", () => {
    const messages = [
      assistant(AGY, "earlier"),
      assistant("openrouter", "interim"),
      user("what is next?"),
    ];
    const out = buildCrossProviderCatchUp({
      messages,
      providerId: AGY,
      currentPrompt: "what is next?",
    });
    expect(out).toContain("Assistant: interim");
    expect(out).not.toContain("User: what is next?");
  });

  it("returns undefined when only unrenderable messages are missing", () => {
    const messages = [
      assistant(AGY, "earlier"),
      { role: "toolResult", content: "tool output" },
    ];
    expect(buildCrossProviderCatchUp({ messages, providerId: AGY })).toBeUndefined();
  });

  it("keeps the newest turns when the budget is exceeded and says what it dropped", () => {
    const messages = [
      assistant(AGY, "earlier"),
      assistant("openrouter", `old ${"x".repeat(400)}`),
      assistant("openrouter", `mid ${"y".repeat(400)}`),
      assistant("openrouter", "newest reply"),
    ];
    const out = buildCrossProviderCatchUp({ messages, providerId: AGY, maxChars: 500 })!;
    expect(out).toContain("newest reply");
    expect(out).toContain("older turn(s) omitted");
    expect(out).not.toContain("old xxx");
  });

  it("never exceeds the budget even with a single oversized turn", () => {
    const messages = [
      assistant(AGY, "earlier"),
      assistant("openrouter", "z".repeat(5_000)),
    ];
    const out = buildCrossProviderCatchUp({ messages, providerId: AGY, maxChars: 400 })!;
    // Header and wrapper are small and fixed; the body itself is capped.
    const body = out.slice(out.indexOf("<turns_you_missed>"));
    expect(body.length).toBeLessThan(400 + 100);
  });

  it("handles an empty or malformed transcript without throwing", () => {
    expect(buildCrossProviderCatchUp({ messages: [], providerId: AGY })).toBeUndefined();
    expect(
      buildCrossProviderCatchUp({ messages: [null, undefined, 42], providerId: AGY }),
    ).toBeUndefined();
  });
});
