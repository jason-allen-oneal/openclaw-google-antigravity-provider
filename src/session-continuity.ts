// Cross-provider catch-up for resumed agy conversations.
//
// OpenClaw stores CLI session bindings per provider
// (`entry.cliSessionBindings[providerId]`) and only clears them on failure,
// never on a model or provider switch. `resolveCliSessionReuse` decides reuse
// from auth profile, auth epoch, message-tool policy, cwd, MCP, and
// system-prompt/tool hashes — none of which is a transcript position, and
// `CliSessionBinding` carries no cursor. The runner then does:
//
//   basePrompt = cliSessionIdToUse ? prompt : openClawHistoryPrompt ?? prompt
//
// So a session that ran on agy, moved to another provider for a few turns, and
// came back resumes the agy conversation and sends *only* the new message. agy
// never learns what happened while it was away.
//
// The transcript itself carries the answer: every AssistantMessage records the
// `provider` that produced it. Everything after our last assistant message was
// produced elsewhere, which makes the catch-up delta computable with no stored
// state and no watermark to drift out of sync.

// The catch-up block rides in the prompt argument, so it competes with the OS
// argv ceiling. Windows caps the whole command line at ~32,767 chars, versus
// 131,072 per argument on Linux and 262,144 total on macOS, and openclaw's own
// reseed can already contribute ~12,199 chars. Leave Windows more headroom.
export const DEFAULT_CATCH_UP_MAX_CHARS = 8_000;
export const WINDOWS_CATCH_UP_MAX_CHARS = 4_000;

export function defaultCatchUpMaxChars(
  platform: NodeJS.Platform = process.platform,
): number {
  return platform === "win32" ? WINDOWS_CATCH_UP_MAX_CHARS : DEFAULT_CATCH_UP_MAX_CHARS;
}

export type TranscriptRole = "user" | "assistant" | "toolResult" | "compactionSummary";

export type CatchUpMessage = {
  readonly role?: string;
  readonly provider?: string;
  readonly content?: unknown;
  readonly summary?: string;
  readonly timestamp?: number;
};

function normalizeProviderId(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

// Mirrors openclaw's own history rendering: strings pass through, content
// arrays contribute their text blocks, everything else (thinking, tool calls,
// images) is dropped.
export function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" && text.trim().length > 0 ? [text.trim()] : [];
    })
    .join("\n")
    .trim();
}

function roleLabel(role: string | undefined): string | undefined {
  switch (role) {
    case "user":
      return "User";
    case "assistant":
      return "Assistant";
    case "compactionSummary":
      return "Compaction summary";
    default:
      // toolResult and anything unrecognized: agy has its own tool history and
      // replaying foreign tool traffic is noise, so it is left out.
      return undefined;
  }
}

export function renderCatchUpMessage(message: CatchUpMessage): string | undefined {
  const label = roleLabel(message.role);
  if (!label) return undefined;
  const text =
    message.role === "compactionSummary" && typeof message.summary === "string"
      ? message.summary.trim()
      : extractMessageText(message.content);
  if (!text) return undefined;
  return `${label}: ${text}`;
}

// Index of the last assistant turn this provider produced. -1 means the
// provider has never spoken in this session.
export function findLastOwnAssistantIndex(
  messages: readonly CatchUpMessage[],
  providerId: string,
): number {
  const wanted = normalizeProviderId(providerId);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== "assistant") continue;
    if (normalizeProviderId(message.provider) === wanted) return i;
  }
  return -1;
}

export type BuildCatchUpParams = {
  readonly messages: readonly unknown[];
  readonly providerId: string;
  /** Current turn's prompt, so a transcript copy of it is not replayed. */
  readonly currentPrompt?: string;
  readonly maxChars?: number;
};

// Returns the block to prepend, or undefined when there is nothing to say.
//
// Deliberately returns undefined when the provider has never produced an
// assistant turn here: that is the first switch-in, where openclaw has no
// binding to reuse and reseeds the transcript itself. Injecting then would
// duplicate what the reseed already carries.
export function buildCrossProviderCatchUp(
  params: BuildCatchUpParams,
): string | undefined {
  const messages = params.messages as readonly CatchUpMessage[];
  if (!Array.isArray(messages) || messages.length === 0) return undefined;

  const lastOwn = findLastOwnAssistantIndex(messages, params.providerId);
  if (lastOwn < 0) return undefined;

  const promptText = params.currentPrompt?.trim();
  const rendered: string[] = [];
  for (let i = lastOwn + 1; i < messages.length; i += 1) {
    const message = messages[i];
    if (!message) continue;
    // The current turn's user message may already be staged in the transcript;
    // it arrives as the prompt, so replaying it would double it.
    if (message.role === "user" && promptText) {
      const text = extractMessageText(message.content);
      if (text && text === promptText) continue;
    }
    const line = renderCatchUpMessage(message);
    if (line) rendered.push(line);
  }
  if (rendered.length === 0) return undefined;

  const maxChars = params.maxChars ?? defaultCatchUpMaxChars();
  // Drop oldest first: the turns nearest the current one matter most.
  let body = rendered.join("\n\n");
  let dropped = 0;
  while (body.length > maxChars && rendered.length > 1) {
    rendered.shift();
    dropped += 1;
    body = rendered.join("\n\n");
  }
  if (body.length > maxChars) body = body.slice(-maxChars).trimStart();

  return [
    "These turns happened in this conversation while a different model or provider was active.",
    "You did not see them. Treat them as prior context for the current turn.",
    ...(dropped > 0
      ? [`[${dropped} older turn(s) omitted to stay within the catch-up budget.]`]
      : []),
    "",
    "<turns_you_missed>",
    body,
    "</turns_you_missed>",
  ].join("\n");
}
