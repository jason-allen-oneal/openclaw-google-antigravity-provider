import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAntigravityDataDir, resolveCachedConversationId } from "./backend.js";
import { summaryPrimaryCwd } from "./session-catalog-sources.js";

const CID = "83d95bb9-6a61-4ea5-a70d-aad251c22f9b";
const tmpDirs: string[] = [];

function makeCache(entries: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-xplat-"));
  tmpDirs.push(dir);
  const cachePath = path.join(dir, "last_conversations.json");
  fs.writeFileSync(cachePath, JSON.stringify(entries), "utf8");
  return cachePath;
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("summaryPrimaryCwd across platforms", () => {
  it("keeps POSIX paths unchanged and decodes percent-escapes", () => {
    expect(summaryPrimaryCwd({ workspaceUris: ["file:///home/chris/proj"] } as any)).toBe(
      "/home/chris/proj",
    );
    expect(
      summaryPrimaryCwd({ workspaceUris: ["file:///home/chris/my%20proj"] } as any),
    ).toBe("/home/chris/my proj");
  });

  it("preserves the host for UNC URIs instead of dropping it", () => {
    // Hand-decoding url.pathname yielded "/share/proj" and lost the server.
    const out = summaryPrimaryCwd({ workspaceUris: ["file://server/share/proj"] } as any);
    expect(out).toContain("server");
    expect(out).not.toBe("/share/proj");
  });

  it("passes through bare paths and returns undefined with no workspace", () => {
    expect(summaryPrimaryCwd({ workspaceUris: ["/plain/path"] } as any)).toBe("/plain/path");
    expect(summaryPrimaryCwd({ workspaceUris: [] } as any)).toBeUndefined();
  });

  it("does not leave a leading slash before a Windows drive letter", () => {
    // On win32 fileURLToPath yields `C:\\Users\\chris\\proj`. On POSIX the
    // drive-letter form is not a real local path, so only assert the bug
    // signature we fixed where the platform can produce it.
    const out = summaryPrimaryCwd({ workspaceUris: ["file:///C:/Users/chris/proj"] } as any);
    if (process.platform === "win32") expect(out).toBe("C:\\Users\\chris\\proj");
    else expect(typeof out).toBe("string");
  });
});

describe("resolveCachedConversationId key matching", () => {
  it("matches an exactly-spelled cwd", async () => {
    const cachePath = makeCache({ "/work/proj": CID });
    await expect(resolveCachedConversationId({ cachePath, cwd: "/work/proj" })).resolves.toBe(
      CID,
    );
  });

  it("tolerates a trailing separator on the cached key", async () => {
    const cachePath = makeCache({ [`${path.sep}work${path.sep}proj${path.sep}`]: CID });
    await expect(
      resolveCachedConversationId({ cachePath, cwd: `${path.sep}work${path.sep}proj` }),
    ).resolves.toBe(CID);
  });

  it("ignores entries for other directories", async () => {
    const cachePath = makeCache({ "/work/other": CID });
    await expect(
      resolveCachedConversationId({ cachePath, cwd: "/work/proj" }),
    ).resolves.toBeUndefined();
  });

  it("rejects values that are not conversation uuids", async () => {
    const cachePath = makeCache({ "/work/proj": "not-a-uuid" });
    await expect(
      resolveCachedConversationId({ cachePath, cwd: "/work/proj" }),
    ).resolves.toBeUndefined();
  });

  it("matches case-insensitively only where the filesystem is", async () => {
    const cachePath = makeCache({ "/Work/Proj": CID });
    const result = await resolveCachedConversationId({ cachePath, cwd: "/work/proj" });
    const caseInsensitive =
      process.platform === "win32" || process.platform === "darwin";
    expect(result).toBe(caseInsensitive ? CID : undefined);
  });

  it("treats a malformed cache file as empty instead of crashing the turn", async () => {
    // agy writes the cache synchronously at turn end, but a killed / crashed
    // process can leave it truncated. Before the fix, JSON.parse throwing
    // here propagated all the way up to `captureSessionId`, terminating
    // the run with an unhandled rejection.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cache-corrupt-"));
    tmpDirs.push(dir);
    const cachePath = path.join(dir, "last_conversations.json");
    fs.writeFileSync(cachePath, '{"/work/proj":"5f6f6f6', "utf8");
    await expect(
      resolveCachedConversationId({ cachePath, cwd: "/work/proj" }),
    ).resolves.toBeUndefined();
  });

  it("returns undefined for a top-level JSON array (schema mismatch)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cache-array-"));
    tmpDirs.push(dir);
    const cachePath = path.join(dir, "last_conversations.json");
    fs.writeFileSync(cachePath, '["not","an","object"]', "utf8");
    await expect(
      resolveCachedConversationId({ cachePath, cwd: "/work/proj" }),
    ).resolves.toBeUndefined();
  });
});

describe("resolveAntigravityDataDir", () => {
  it("defaults under the home directory and honours ~ expansion", () => {
    const home = path.join(path.sep, "home", "chris");
    expect(resolveAntigravityDataDir({ HOME: home })).toBe(
      path.join(home, ".gemini", "antigravity-cli"),
    );
    expect(resolveAntigravityDataDir({ HOME: home, ANTIGRAVITY_USER_DATA_DIR: "~" })).toBe(home);
    expect(
      resolveAntigravityDataDir({ HOME: home, ANTIGRAVITY_USER_DATA_DIR: "~/agy" }),
    ).toBe(path.join(home, "agy"));
  });

  it("falls back to os.homedir() when HOME is unset (the Windows case)", () => {
    expect(resolveAntigravityDataDir({})).toBe(
      path.join(os.homedir(), ".gemini", "antigravity-cli"),
    );
  });
});
