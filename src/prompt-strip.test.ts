import { describe, expect, it } from "vitest";
import {
  findPrintArg,
  stripArgvChannelContext,
  stripOpenClawChannelContext,
} from "./prompt-strip.js";

const sample = `Conversation info: ⟦openclaw:ctx⟧
{"chat_id":"telegram:1295149631","message_id":"44041","sender":{"id":"1295149631","name":"Chris"},"timestamp":"Fri 2026-09-04 15:39:08 GMT+2"}

Conversation context (chronological, selected for current message): ⟦openclaw:ctx⟧
#session:abc User: Keep going
#session:def OpenClaw: Delivered translations for bg, sk, hr, ca.
#session:ghi User: Can u do a check?

Active goal: Translate Nova_Core.md into as many world languages as possible — advance; keep active until fully achieved.

Btw I updated the agy plugin, can you see the openclaw tools now?`;

describe("stripOpenClawChannelContext", () => {
  it("removes the three openclaw-injected blocks", () => {
    const out = stripOpenClawChannelContext(sample);
    expect(out).toBe(
      "Btw I updated the agy plugin, can you see the openclaw tools now?",
    );
  });

  it("passes through prompts that have no openclaw ctx marker", () => {
    const raw = "Hello agy, please summarise this codebase.";
    expect(stripOpenClawChannelContext(raw)).toBe(raw);
  });

  it("does not strip user text that merely mentions Conversation info without the marker", () => {
    const raw =
      "Conversation info: I want to log conversation metadata in my app.\n\nHere is my draft.";
    expect(stripOpenClawChannelContext(raw)).toBe(raw);
  });

  it("is idempotent — running twice yields the same output", () => {
    const once = stripOpenClawChannelContext(sample);
    const twice = stripOpenClawChannelContext(once);
    expect(twice).toBe(once);
  });

  it("keeps Active goal appendix's text intact when there is no matching marker", () => {
    const raw = "Note that the Active goal: field in JIRA can be blank.";
    expect(stripOpenClawChannelContext(raw)).toBe(raw);
  });

  it("collapses only leftover blank lines from the removal, not user-provided ones", () => {
    const raw = `Conversation info: ⟦openclaw:ctx⟧
{"chat_id":"x"}

Hello

world`;
    expect(stripOpenClawChannelContext(raw)).toBe("Hello\n\nworld");
  });

  it("handles empty input safely", () => {
    expect(stripOpenClawChannelContext("")).toBe("");
  });
});

describe("findPrintArg", () => {
  it("locates --print's value", () => {
    const args = ["--conversation", "abc", "--print", "hello there"];
    expect(findPrintArg(args)).toEqual({ index: 3, value: "hello there" });
  });

  it("accepts the -p and --prompt aliases", () => {
    expect(findPrintArg(["-p", "x"])?.value).toBe("x");
    expect(findPrintArg(["--prompt", "y"])?.value).toBe("y");
  });

  it("returns undefined when no --print is present", () => {
    expect(findPrintArg(["--conversation", "abc"])).toBeUndefined();
  });
});

describe("stripArgvChannelContext", () => {
  it("rewrites only the --print value and leaves other args untouched", () => {
    const args = [
      "--conversation",
      "abc",
      "--print",
      sample,
      "--print-timeout",
      "30m0s",
    ];
    const out = stripArgvChannelContext(args);
    expect(out[0]).toBe("--conversation");
    expect(out[1]).toBe("abc");
    expect(out[2]).toBe("--print");
    expect(out[3]).toBe(
      "Btw I updated the agy plugin, can you see the openclaw tools now?",
    );
    expect(out[4]).toBe("--print-timeout");
    expect(out[5]).toBe("30m0s");
    expect(out.length).toBe(args.length);
  });

  it("returns the argv unchanged when the --print value has no ctx marker", () => {
    const args = ["--print", "hello"];
    expect(stripArgvChannelContext(args)).toEqual(args);
  });
});
