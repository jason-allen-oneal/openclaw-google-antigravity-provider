// Workspace bootstrap delivery for agy conversations.
//
// openclaw only resolves workspace bootstrap files when the backend can
// transport a system prompt:
//
//   bootstrapRouting = skipsTurnPreparation || !canTransportSystemPrompt(cfg)
//     ? void 0 : await resolveWorkspaceBootstrapRouting({...})
//
// and canTransportSystemPrompt requires one of systemPromptArg,
// systemPromptFileArg or systemPromptFileConfigKey. agy has no system-prompt
// flag to point any of them at, and it does not read an AGENTS.md from the
// working directory on its own. Left alone, an agy turn therefore runs on agy's
// built-in agent prompt and ignores the workspace instructions that give an
// openclaw agent its behaviour on every other provider.
//
// So this module reads the same files openclaw would and hands them to agy in
// the prompt. The filenames mirror openclaw's WORKSPACE_BOOTSTRAP_FILENAMES,
// in its order.

import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

// openclaw's WORKSPACE_BOOTSTRAP_FILENAMES, minus BOOTSTRAP.md.
//
// BOOTSTRAP.md is not standing guidance. openclaw drives it as a dedicated
// one-time run that tells the agent "Please read BOOTSTRAP.md from the
// workspace now and follow it before replying normally", and the file is
// deleted once bootstrap completes ("user deletes canonical BOOTSTRAP.md after
// completion"). Shipping it as permanent workspace instructions would invite
// agy to re-run a bootstrap procedure on ordinary turns, so it is left out.
export const WORKSPACE_BOOTSTRAP_FILENAMES = [
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "MEMORY.md",
] as const;

// The block travels inside the prompt argument, so it competes with the OS
// argv ceiling. openclaw's own reseed can already spend ~12,199 chars on the
// same turn, and Windows caps the whole command line near 32,767.
export const DEFAULT_WORKSPACE_CONTEXT_MAX_CHARS = 16_000;
export const WINDOWS_WORKSPACE_CONTEXT_MAX_CHARS = 6_000;

export function defaultWorkspaceContextMaxChars(
  platform: NodeJS.Platform = process.platform,
): number {
  return platform === "win32"
    ? WINDOWS_WORKSPACE_CONTEXT_MAX_CHARS
    : DEFAULT_WORKSPACE_CONTEXT_MAX_CHARS;
}

export type WorkspaceBootstrapFile = {
  readonly name: string;
  readonly content: string;
};

export type ReadFile = (filePath: string) => Promise<string>;

const defaultReadFile: ReadFile = (filePath) => fsp.readFile(filePath, "utf8");

// Missing files are the normal case — every one of these is optional — so a
// read failure is skipped rather than surfaced.
export async function readWorkspaceBootstrapFiles(
  workspaceDir: string,
  readFile: ReadFile = defaultReadFile,
): Promise<WorkspaceBootstrapFile[]> {
  const out: WorkspaceBootstrapFile[] = [];
  for (const name of WORKSPACE_BOOTSTRAP_FILENAMES) {
    let raw: string;
    try {
      raw = await readFile(path.join(workspaceDir, name));
    } catch {
      continue;
    }
    const content = typeof raw === "string" ? raw.trim() : "";
    if (content) out.push({ name, content });
  }
  return out;
}

// Identity of the instruction set currently on disk. Editing AGENTS.md, adding
// SOUL.md, or deleting a file all change it, which is what re-triggers delivery
// to a conversation that is otherwise still healthy.
export function workspaceBootstrapFingerprint(
  files: readonly WorkspaceBootstrapFile[],
): string {
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    hash.update(file.name).update("\0").update(file.content).update("\0");
  }
  return hash.digest("hex").slice(0, 32);
}

export type BuildWorkspaceContextParams = {
  readonly workspaceDir: string;
  readonly agentId?: string;
  readonly files: readonly WorkspaceBootstrapFile[];
  readonly maxChars?: number;
};

// Renders the block agy receives. Returns undefined when the workspace has no
// instructions worth sending.
export function buildWorkspaceContextBlock(
  params: BuildWorkspaceContextParams,
): string | undefined {
  if (params.files.length === 0) return undefined;
  const maxChars = params.maxChars ?? defaultWorkspaceContextMaxChars();

  // Earlier files win: openclaw's ordering puts the operating instructions
  // (AGENTS.md) ahead of persona, and MEMORY.md last, so truncation drops the
  // most incidental content first.
  const sections: string[] = [];
  let used = 0;
  const omitted: string[] = [];
  for (const file of params.files) {
    const header = `--- ${file.name} ---`;
    const candidate = `${header}\n${file.content}`;
    if (used + candidate.length <= maxChars) {
      sections.push(candidate);
      used += candidate.length + 2;
      continue;
    }
    const remaining = maxChars - used - header.length - 2;
    // Only bother truncating when a useful amount of the file survives.
    if (remaining > 200) {
      sections.push(
        `${header}\n${file.content.slice(0, remaining).trimEnd()}\n[truncated]`,
      );
      used = maxChars;
      continue;
    }
    omitted.push(file.name);
  }
  if (sections.length === 0) return undefined;

  const agent = params.agentId?.trim();
  return [
    `These are the OpenClaw workspace instructions for${agent ? ` agent "${agent}"` : " this agent"}.`,
    "They define how you are expected to behave here and take precedence over your own default persona.",
    `Workspace: ${params.workspaceDir}`,
    ...(omitted.length > 0
      ? [`[Omitted to stay within budget: ${omitted.join(", ")}.]`]
      : []),
    "",
    "<workspace_instructions>",
    sections.join("\n\n"),
    "</workspace_instructions>",
  ].join("\n");
}

// Tracks which agy conversation already received the workspace block, so it is
// sent once per conversation rather than every turn.
//
// Keyed per agent *and* workspace: openclaw is multi-agent, each agent resolves
// its own workspace directory, and two agents in one gateway must not consume
// each other's delivery state.
export class WorkspaceContextDeliveryTracker {
  private readonly delivered = new Map<string, string>();
  private readonly pending = new Map<string, string>();

  static key(agentId: string | undefined, workspaceDir: string): string {
    return `${agentId?.trim() || "-"}::${workspaceDir}`;
  }

  // `conversationId` is the agy conversation currently bound to this
  // workspace, or undefined when none exists yet.
  // `conversationId` is the agy conversation currently bound to this
  // workspace, or undefined when none exists yet. `fingerprint` identifies the
  // instruction set on disk, so an edit re-delivers into a live conversation.
  shouldSend(
    agentId: string | undefined,
    workspaceDir: string,
    conversationId: string | undefined,
    fingerprint = "",
  ): boolean {
    const key = WorkspaceContextDeliveryTracker.key(agentId, workspaceDir);
    const stamp = `${conversationId ?? ""}::${fingerprint}`;
    if (!conversationId) {
      // No conversation yet: this turn creates one, and it needs the block.
      this.pending.set(key, fingerprint);
      return true;
    }
    if (this.pending.get(key) === fingerprint) {
      // The previous turn sent this exact instruction set and this is the
      // conversation it created, so that history already carries it.
      this.pending.delete(key);
      this.delivered.set(key, stamp);
      return false;
    }
    this.pending.delete(key);
    if (this.delivered.get(key) === stamp) return false;
    // Either a different conversation (binding lost or replaced) or edited
    // instructions. Both mean this conversation has not seen what is on disk.
    this.delivered.set(key, stamp);
    return true;
  }

  reset(): void {
    this.delivered.clear();
    this.pending.clear();
  }
}
