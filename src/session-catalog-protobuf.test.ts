import { describe, expect, it } from "vitest";
import { iterProtobufTextFields } from "./session-catalog-protobuf.js";

// Field number 1, wire type 2 (length-delimited), length prefix as varint.
function encodeString(fieldNumber: number, text: string): Uint8Array {
  const tag = (fieldNumber << 3) | 2;
  const bytes = new TextEncoder().encode(text);
  const parts: number[] = [];
  const encodeVarint = (n: number) => {
    while (n > 0x7f) {
      parts.push((n & 0x7f) | 0x80);
      n >>>= 7;
    }
    parts.push(n & 0x7f);
  };
  encodeVarint(tag);
  encodeVarint(bytes.length);
  return new Uint8Array([...parts, ...bytes]);
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

describe("iterProtobufTextFields", () => {
  it("extracts a single printable string field", () => {
    const buf = encodeString(1, "Hello, this is a printable field of length > 16.");
    expect([...iterProtobufTextFields(buf)]).toEqual([
      "Hello, this is a printable field of length > 16.",
    ]);
  });

  it("skips fields shorter than minLength", () => {
    const short = encodeString(1, "too short");
    expect([...iterProtobufTextFields(short, { minLength: 16 })]).toEqual([]);
  });

  it("descends into nested submessages", () => {
    const inner = encodeString(3, "Nested printable payload extracted from inside a message.");
    const outer = encodeString(2, new TextDecoder("utf-8").decode(inner));
    // outer encodes `inner` as a string; the walker sees the outer bytes,
    // detects a valid protobuf tag inside, and recurses.
    const found = [...iterProtobufTextFields(outer, { minLength: 20 })];
    expect(found).toContain("Nested printable payload extracted from inside a message.");
  });

  it("rejects binary blobs that are mostly non-printable", () => {
    // Raw 0xff bytes wrapped in a wire-type-2 field. Strict UTF-8 decode
    // rejects this and the printable-ratio guard rejects it independently.
    const junk = new Uint8Array(64).fill(0xff);
    const buf = new Uint8Array([0x0a, junk.length, ...junk]);
    expect([...iterProtobufTextFields(buf)]).toEqual([]);
  });

  it("recovers cleanly from truncated varints", () => {
    const truncated = new Uint8Array([0x0a, 0xff, 0xff]); // tag + partial length
    expect([...iterProtobufTextFields(truncated)]).toEqual([]);
  });

  it("handles concatenated fields in order", () => {
    const a = encodeString(1, "First long-enough payload string one.");
    const b = encodeString(2, "Second long-enough payload string two.");
    const c = encodeString(3, "Third long-enough payload string three.");
    const found = [...iterProtobufTextFields(concatBytes(a, b, c))];
    expect(found).toEqual([
      "First long-enough payload string one.",
      "Second long-enough payload string two.",
      "Third long-enough payload string three.",
    ]);
  });
});
