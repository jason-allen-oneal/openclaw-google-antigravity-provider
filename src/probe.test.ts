import { describe, expect, it } from "vitest";
import { probeAgy, REQUIRED_AGY_FLAGS } from "./probe.js";

describe("probeAgy", () => {
  it("succeeds when all required flags are present", () => {
    const mockRunner = () => ({
      status: 0,
      stdout: "Usage: agy [options]\n--print\n--model\n--print-timeout",
      stderr: "",
      output: [],
      pid: 1234,
      signal: null,
    });

    const result = probeAgy(mockRunner);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.helpText).toContain("--print-timeout");
    }
  });

  it("fails when required flags are missing", () => {
    const mockRunner = () => ({
      status: 0,
      stdout: "Usage: agy [options]\n--print\n--model",
      stderr: "",
      output: [],
      pid: 1234,
      signal: null,
    });

    const result = probeAgy(mockRunner);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("missing required flags: --print-timeout");
    }
  });

  it("reports not-found when the existence check exits non-zero", () => {
    const mockRunner = () => ({
      status: 1,
      stdout: "",
      stderr: "command not found",
      output: [],
      pid: 1234,
      signal: null,
    });

    const result = probeAgy(mockRunner);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("not found on PATH");
    }
  });

  it("succeeds when `which agy` returns a resolved path", () => {
    const mockRunner = () => ({
      status: 0,
      stdout: "/usr/local/bin/agy\n",
      stderr: "",
      output: [],
      pid: 1234,
      signal: null,
    });
    const result = probeAgy(mockRunner);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.helpText).toContain("/usr/local/bin/agy");
    }
  });
});
