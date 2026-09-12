// Structured decoder for agy's `steps.step_payload` protobuf blobs.
//
// See docs/AGY_STEP_SCHEMA.md for how the field map below was reversed.
// Only the fields we actually surface to the openclaw sidebar are named;
// unknown / unhandled step types fall through to the schemaless walker in
// session-catalog-sources.ts so nothing is silently dropped.

export type DecodedStep =
  | {
      readonly kind: "userMessage";
      readonly stepIndex: number;
      readonly text: string;
      readonly timestampMs?: number;
    }
  | {
      readonly kind: "agentMessage";
      readonly stepIndex: number;
      readonly text: string;
      readonly timestampMs?: number;
    }
  | {
      readonly kind: "toolCall";
      readonly stepIndex: number;
      readonly toolName: string;
      readonly args?: string;
      readonly summary?: string;
      readonly output?: string;
      readonly timestampMs?: number;
    }
  | {
      readonly kind: "systemNotice";
      readonly stepIndex: number;
      readonly text: string;
      readonly summary?: string;
      readonly timestampMs?: number;
    }
  // Recognized step type that has no user-visible content (e.g. an agy
  // internal handshake, or a duplicated tool-call announcement whose
  // executed sibling is already surfaced separately). Callers should
  // treat this as "consumed" and NOT fall back to the schemaless walker,
  // otherwise raw JSON args bleed into the transcript.
  | { readonly kind: "empty"; readonly stepIndex: number };

type WireField = {
  readonly number: number;
  readonly wire: number;
  readonly value: bigint | Uint8Array;
};

function readVarint(view: Uint8Array, offset: number): { value: bigint; next: number } | null {
  let value = 0n;
  let shift = 0n;
  let next = offset;
  while (next < view.length) {
    const byte = view[next]!;
    next += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next };
    shift += 7n;
    if (shift > 63n) return null;
  }
  return null;
}

// Parse one level of protobuf wire fields. Fields are returned in the order
// they appear; a caller that needs a specific field uses `pickField` /
// `pickString`. Malformed byte streams truncate cleanly instead of throwing.
function parseFields(bytes: Uint8Array): WireField[] {
  const out: WireField[] = [];
  let cursor = 0;
  while (cursor < bytes.length) {
    const tag = readVarint(bytes, cursor);
    if (!tag) break;
    cursor = tag.next;
    const number = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    if (number <= 0) break;
    if (wire === 0) {
      const v = readVarint(bytes, cursor);
      if (!v) break;
      cursor = v.next;
      out.push({ number, wire, value: v.value });
    } else if (wire === 2) {
      const len = readVarint(bytes, cursor);
      if (!len) break;
      cursor = len.next;
      const n = Number(len.value);
      if (n < 0 || cursor + n > bytes.length) break;
      out.push({ number, wire, value: bytes.subarray(cursor, cursor + n) });
      cursor += n;
    } else if (wire === 1) {
      if (cursor + 8 > bytes.length) break;
      cursor += 8;
    } else if (wire === 5) {
      if (cursor + 4 > bytes.length) break;
      cursor += 4;
    } else {
      break; // groups (3/4) — unused by cortex_pb.
    }
  }
  return out;
}

function pickField(fields: readonly WireField[], number: number): WireField | undefined {
  for (const f of fields) if (f.number === number) return f;
  return undefined;
}

function pickBytes(fields: readonly WireField[], number: number): Uint8Array | undefined {
  const f = pickField(fields, number);
  return f && f.wire === 2 ? (f.value as Uint8Array) : undefined;
}

function pickVarint(fields: readonly WireField[], number: number): number | undefined {
  const f = pickField(fields, number);
  return f && f.wire === 0 ? Number(f.value as bigint) : undefined;
}

const decoder = new TextDecoder("utf-8", { fatal: false });

function pickString(fields: readonly WireField[], number: number): string | undefined {
  const raw = pickBytes(fields, number);
  if (!raw) return undefined;
  const s = decoder.decode(raw).trim();
  return s.length > 0 ? s : undefined;
}

function parseChild(fields: readonly WireField[], number: number): WireField[] | undefined {
  const raw = pickBytes(fields, number);
  if (!raw) return undefined;
  return parseFields(raw);
}

// agy stores the step creation timestamp at #5.#1.{#1 seconds, #2 nanos}
// (google.protobuf.Timestamp shape). Combine into a JS ms value or
// return undefined when either the container or the seconds field is
// missing.
function pickTimestampMs(top: readonly WireField[]): number | undefined {
  const meta = parseChild(top, 5);
  const ts = meta ? parseChild(meta, 1) : undefined;
  if (!ts) return undefined;
  const seconds = pickVarint(ts, 1);
  const nanos = pickVarint(ts, 2) ?? 0;
  if (seconds === undefined) return undefined;
  const ms = seconds * 1000 + Math.floor(nanos / 1_000_000);
  // Guard against Go zero-value time (0001-01-01) that would blow up the UI.
  if (ms < Date.UTC(2000, 0, 1)) return undefined;
  return ms;
}

// step_type → decoder. See docs/AGY_STEP_SCHEMA.md for the field-number
// reasoning; anything not in this table falls through to the caller.
export function decodeStepPayload(
  bytes: Uint8Array,
  stepIndex: number,
): DecodedStep | undefined {
  const top = parseFields(bytes);
  const stepType = pickVarint(top, 1);
  if (stepType === undefined) return undefined;
  const timestampMs = pickTimestampMs(top);
  const ts = timestampMs !== undefined ? { timestampMs } : {};

  switch (stepType) {
    case 14: {
      // User turn. Real prompt text is at #19.#2; #19.#3.#1 is a duplicate
      // wrapper. #19.#12 carries workspace context we deliberately skip.
      const container = parseChild(top, 19);
      if (!container) return undefined;
      const text = pickString(container, 2)
        ?? pickString(parseChild(container, 3) ?? [], 1);
      if (!text) return undefined;
      return { kind: "userMessage", stepIndex, text, ...ts };
    }
    case 15: {
      // Agent turn. Two variants share step_type 15:
      //   a) pure text — content at #20.#1 / #20.#8
      //   b) tool-call announcement — content at #20.#7 (name + args JSON),
      //      always followed by an executed sibling step (type 5/8/9/21/…)
      //      that surfaces the same call plus its output. Suppress (b) so
      //      the transcript doesn't render the same call twice.
      const container = parseChild(top, 20);
      if (!container) return undefined;
      if (pickBytes(container, 7) !== undefined) {
        return { kind: "empty", stepIndex };
      }
      const primary = pickString(container, 1);
      const accumulated = pickString(container, 8);
      const text = accumulated && (!primary || accumulated.length >= primary.length)
        ? accumulated
        : primary;
      if (!text) return { kind: "empty", stepIndex };
      return { kind: "agentMessage", stepIndex, text, ...ts };
    }
    case 23:
    case 98: {
      // Trajectory metadata / heartbeat. No user-visible content.
      return { kind: "empty", stepIndex };
    }
    case 5:
    case 7:
    case 8:
    case 9:
    case 21:
    case 132: {
      // Every tool call kind writes its metadata into #5.#4 (name at .#2/#9,
      // args JSON at .#3) with a human summary at #5.#31 / #5.#30. The
      // result blob lives at a per-tool-kind field: run_command uses #28,
      // view_file uses #14, list_dir uses #15, manage_task uses #140.
      const meta = parseChild(top, 5);
      const inner = meta ? parseChild(meta, 4) : undefined;
      const toolName = inner
        ? pickString(inner, 2) ?? pickString(inner, 9)
        : undefined;
      const args = inner ? pickString(inner, 3) : undefined;
      const summary = meta ? pickString(meta, 31) ?? pickString(meta, 30) : undefined;
      if (!toolName) return undefined;

      let output: string | undefined;
      if (stepType === 5 || stepType === 7 || stepType === 21) {
        // run_command / replace_file_content / edit — stdout at #28.#21.#1
        const rc = parseChild(top, 28);
        const ri = rc ? parseChild(rc, 21) : undefined;
        output = ri ? pickString(ri, 1) : undefined;
      } else if (stepType === 8) {
        // view_file — contents at #14.#4
        const rc = parseChild(top, 14);
        output = rc ? pickString(rc, 4) : undefined;
      } else if (stepType === 9) {
        // list_dir — dirent list at #15, formatted as `name\tsize` lines.
        const rc = parseChild(top, 15);
        if (rc) {
          const lines: string[] = [];
          for (const f of rc) {
            if (f.number !== 3 || f.wire !== 2) continue;
            const entry = parseFields(f.value as Uint8Array);
            const name = pickString(entry, 1);
            const size = pickVarint(entry, 4);
            if (!name) continue;
            lines.push(size !== undefined ? `${name}\t${size}` : name);
          }
          if (lines.length > 0) output = lines.join("\n");
        }
      } else if (stepType === 132) {
        // manage_task — text summary at #140.#2.#1
        const rc = parseChild(top, 140);
        const ri = rc ? parseChild(rc, 2) : undefined;
        output = ri ? pickString(ri, 1) : undefined;
      }

      return {
        kind: "toolCall",
        stepIndex,
        toolName,
        ...(args ? { args } : {}),
        ...(summary ? { summary } : {}),
        ...(output ? { output } : {}),
        ...ts,
      };
    }
    case 17: {
      // Model produced an invalid tool call. Not a real tool call — surface
      // the human error message as agent text so the transcript stays
      // linear.
      const container = parseChild(top, 24);
      const inner = container ? parseChild(container, 3) : undefined;
      const message = inner
        ? pickString(inner, 1) ?? pickString(inner, 9) ?? pickString(inner, 2)
        : undefined;
      if (!message) return undefined;
      return { kind: "agentMessage", stepIndex, text: message, ...ts };
    }
    case 101: {
      // System / task notification. #114.#2.#2 is the full body; #114.#2.#1
      // is a short label ("Git status finished"). #114.#1 is the wire-level
      // `[Message] timestamp=… content=…` framing.
      const container = parseChild(top, 114);
      const inner = container ? parseChild(container, 2) : undefined;
      const summary = inner ? pickString(inner, 1) : undefined;
      const body = inner ? pickString(inner, 2) : undefined;
      const framed = container ? pickString(container, 1) : undefined;
      const text = body ?? framed;
      if (!text) return undefined;
      return {
        kind: "systemNotice",
        stepIndex,
        text,
        ...(summary ? { summary } : {}),
        ...ts,
      };
    }
    default:
      return undefined;
  }
}
