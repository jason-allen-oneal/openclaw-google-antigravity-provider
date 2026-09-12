import { describe, expect, it } from "vitest";
import { decodeStepPayload } from "./session-catalog-decoder.js";

// Minimal proto wire-format encoders. Enough to synthesize the specific
// field shapes agy writes into `steps.step_payload` — see
// docs/AGY_STEP_SCHEMA.md for the field map these tests assert against.
function varint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return out;
}
function tag(field: number, wire: number): number[] {
  return varint((field << 3) | wire);
}
function bytesField(field: number, value: Uint8Array): number[] {
  return [...tag(field, 2), ...varint(value.length), ...value];
}
function stringField(field: number, s: string): number[] {
  return bytesField(field, new TextEncoder().encode(s));
}
function varintField(field: number, n: number): number[] {
  return [...tag(field, 0), ...varint(n)];
}
function msg(field: number, inner: number[]): number[] {
  return bytesField(field, new Uint8Array(inner));
}
function build(inner: number[]): Uint8Array {
  return new Uint8Array(inner);
}

describe("decodeStepPayload", () => {
  it("returns undefined for an unknown step_type", () => {
    const buf = build([...varintField(1, 999)]);
    expect(decodeStepPayload(buf, 0)).toBeUndefined();
  });

  it("decodes a user turn (step_type 14) from #19.#2", () => {
    const buf = build([
      ...varintField(1, 14),
      ...msg(19, [...stringField(2, "Hey, fix the merge conflict.")]),
    ]);
    expect(decodeStepPayload(buf, 3)).toEqual({
      kind: "userMessage",
      stepIndex: 3,
      text: "Hey, fix the merge conflict.",
    });
  });

  it("prefers the accumulated agent text (#20.#8) over the streamed chunk (#20.#1)", () => {
    const buf = build([
      ...varintField(1, 15),
      ...msg(20, [
        ...stringField(1, "Hello"),
        ...stringField(8, "Hello! How can I help you today?"),
      ]),
    ]);
    expect(decodeStepPayload(buf, 5)).toEqual({
      kind: "agentMessage",
      stepIndex: 5,
      text: "Hello! How can I help you today?",
    });
  });

  it("suppresses the type-15 tool-call announcement variant (has #20.#7)", () => {
    // agy emits type 15 twice for a tool call: once as an announcement
    // (this shape), once as the executed sibling step. Only the sibling
    // should surface, otherwise the transcript renders the call twice.
    const buf = build([
      ...varintField(1, 15),
      ...msg(20, [
        ...msg(7, [
          ...stringField(2, "list_dir"),
          ...stringField(3, '{"DirectoryPath":"/tmp"}'),
        ]),
      ]),
    ]);
    expect(decodeStepPayload(buf, 2)).toEqual({ kind: "empty", stepIndex: 2 });
  });

  it("decodes a run_command tool call with args and output", () => {
    const argsJson = '{"CommandLine":"git status","Cwd":"/tmp"}';
    const buf = build([
      ...varintField(1, 21),
      ...msg(5, [
        ...msg(4, [
          ...stringField(2, "run_command"),
          ...stringField(3, argsJson),
        ]),
        ...stringField(31, "Checking git status"),
      ]),
      ...msg(28, [
        ...msg(21, [...stringField(1, "On branch main\nnothing to commit")]),
      ]),
    ]);
    expect(decodeStepPayload(buf, 7)).toEqual({
      kind: "toolCall",
      stepIndex: 7,
      toolName: "run_command",
      args: argsJson,
      summary: "Checking git status",
      output: "On branch main\nnothing to commit",
    });
  });

  it("decodes a view_file tool call with output at #14.#4", () => {
    const buf = build([
      ...varintField(1, 8),
      ...msg(5, [
        ...msg(4, [
          ...stringField(2, "view_file"),
          ...stringField(3, '{"AbsolutePath":"/tmp/x"}'),
        ]),
      ]),
      ...msg(14, [...stringField(4, "file contents here")]),
    ]);
    const out = decodeStepPayload(buf, 4);
    expect(out?.kind).toBe("toolCall");
    if (out?.kind === "toolCall") {
      expect(out.toolName).toBe("view_file");
      expect(out.output).toBe("file contents here");
    }
  });

  it("assembles a list_dir output from #15 entries", () => {
    const buf = build([
      ...varintField(1, 9),
      ...msg(5, [
        ...msg(4, [
          ...stringField(2, "list_dir"),
          ...stringField(3, '{"DirectoryPath":"/tmp"}'),
        ]),
      ]),
      ...msg(15, [
        ...msg(3, [...stringField(1, "a.txt"), ...varintField(4, 12)]),
        ...msg(3, [...stringField(1, "b.txt"), ...varintField(4, 30)]),
        ...msg(3, [...stringField(1, "subdir"), ...varintField(2, 1)]),
      ]),
    ]);
    const out = decodeStepPayload(buf, 6);
    expect(out?.kind).toBe("toolCall");
    if (out?.kind === "toolCall") {
      expect(out.output).toBe("a.txt\t12\nb.txt\t30\nsubdir");
    }
  });

  it("decodes a type-101 system notice preferring the inner body", () => {
    const buf = build([
      ...varintField(1, 101),
      ...msg(114, [
        ...stringField(1, "[Message] timestamp=… content=Task finished"),
        ...msg(2, [
          ...stringField(1, "Git status finished"),
          ...stringField(2, "Task id \"task-6\" finished with exit code 0."),
        ]),
      ]),
    ]);
    expect(decodeStepPayload(buf, 9)).toEqual({
      kind: "systemNotice",
      stepIndex: 9,
      text: 'Task id "task-6" finished with exit code 0.',
      summary: "Git status finished",
    });
  });

  it("promotes type-17 model errors to an agent message", () => {
    const buf = build([
      ...varintField(1, 17),
      ...msg(24, [
        ...msg(3, [
          ...stringField(1, "The model produced an invalid tool call."),
        ]),
      ]),
    ]);
    expect(decodeStepPayload(buf, 8)).toEqual({
      kind: "agentMessage",
      stepIndex: 8,
      text: "The model produced an invalid tool call.",
    });
  });

  it("extracts the step timestamp from #5.#1.{#1 seconds, #2 nanos}", () => {
    const expectedMs = Date.UTC(2026, 0, 15, 12, 0, 0, 500);
    const seconds = Math.floor(expectedMs / 1000);
    const nanos = (expectedMs % 1000) * 1_000_000;
    const buf = build([
      ...varintField(1, 15),
      ...msg(5, [...msg(1, [...varintField(1, seconds), ...varintField(2, nanos)])]),
      ...msg(20, [...stringField(8, "hello world")]),
    ]);
    const out = decodeStepPayload(buf, 0);
    expect(out?.kind).toBe("agentMessage");
    if (out?.kind === "agentMessage") {
      expect(out.timestampMs).toBe(expectedMs);
    }
  });

  it("drops zero-value timestamps (Go's 0001-01-01) so the UI doesn't render year 1", () => {
    // The Go zero-value time serializes to seconds < 0. Encoding a small
    // positive value that would come out sub-2000 exercises the guard.
    const buf = build([
      ...varintField(1, 15),
      ...msg(5, [...msg(1, [...varintField(1, 946684799)])]), // 2000-01-01 - 1s
      ...msg(20, [...stringField(8, "hello world")]),
    ]);
    const out = decodeStepPayload(buf, 0);
    if (out?.kind === "agentMessage") {
      expect(out.timestampMs).toBeUndefined();
    }
  });

  it("marks type-23 / type-98 as empty so they don't leak metadata", () => {
    expect(decodeStepPayload(build([...varintField(1, 23)]), 0)).toEqual({
      kind: "empty",
      stepIndex: 0,
    });
    expect(decodeStepPayload(build([...varintField(1, 98)]), 1)).toEqual({
      kind: "empty",
      stepIndex: 1,
    });
  });
});
