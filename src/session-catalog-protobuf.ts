// Schemaless protobuf text extractor for opaque agy step blobs.
//
// Google has not published a `.proto` schema for the per-conversation
// `steps.step_payload`, `render_info`, or metadata BLOBs stored under
// ~/.gemini/antigravity-cli/conversations/*.db. Prior art
// (agentgrep/adapters/antigravity_cli.py, ag-donald/Antigravity-Database-Manager)
// walks the wire format and collects the length-delimited fields that
// happen to be printable UTF-8. That is what this module does.
//
// This yields USER PROMPT text, ASSISTANT TEXT, and TOOL CALL PARAMETERS
// with high fidelity; low-level binary payloads (embeddings, hashes,
// timestamps) are ignored. Field ordering is preserved so callers can
// map runs back to their originating step index.

const MIN_TEXT_LENGTH = 16;
const PRINTABLE_RATIO_THRESHOLD = 0.85;

function readVarint(view: Uint8Array, offset: number): { value: bigint; next: number } | null {
  let value = 0n;
  let shift = 0n;
  let next = offset;
  while (next < view.length) {
    const byte = view[next]!;
    next += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value, next };
    }
    shift += 7n;
    if (shift > 63n) {
      return null; // malformed varint
    }
  }
  return null;
}

function isProbablyPrintableUtf8(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  let printable = 0;
  for (const byte of bytes) {
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d) {
      printable += 1;
      continue;
    }
    if (byte >= 0x20 && byte < 0x7f) {
      printable += 1;
      continue;
    }
    if (byte >= 0x80) {
      // treat multi-byte UTF-8 starter/continuation as printable
      printable += 1;
      continue;
    }
  }
  return printable / bytes.length >= PRINTABLE_RATIO_THRESHOLD;
}

function decodeUtf8Strict(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

// Walks a protobuf-encoded byte slice recursively, yielding each length-delimited
// field whose payload decodes as printable UTF-8 at least `minLength` bytes long.
// Nested submessages are walked; nested payloads that fail to be a valid protobuf
// but do parse as UTF-8 are still emitted. Malformed varints stop the walk of
// the current slice cleanly.
export function* iterProtobufTextFields(
  bytes: Uint8Array,
  options: { minLength?: number; maxDepth?: number } = {},
): Iterable<string> {
  const minLength = options.minLength ?? MIN_TEXT_LENGTH;
  const maxDepth = options.maxDepth ?? 12;
  yield* walk(bytes, 0, maxDepth, minLength);
}

function* walk(
  view: Uint8Array,
  depth: number,
  maxDepth: number,
  minLength: number,
): Iterable<string> {
  if (depth > maxDepth) return;
  let cursor = 0;
  while (cursor < view.length) {
    const tag = readVarint(view, cursor);
    if (!tag) return;
    cursor = tag.next;
    const wireType = Number(tag.value & 0x7n);

    switch (wireType) {
      case 0: {
        // varint
        const next = readVarint(view, cursor);
        if (!next) return;
        cursor = next.next;
        break;
      }
      case 1: {
        // 64-bit
        if (cursor + 8 > view.length) return;
        cursor += 8;
        break;
      }
      case 2: {
        // length-delimited: bytes, string, or embedded message
        const lengthVarint = readVarint(view, cursor);
        if (!lengthVarint) return;
        cursor = lengthVarint.next;
        const length = Number(lengthVarint.value);
        if (length < 0 || cursor + length > view.length) return;
        const slice = view.subarray(cursor, cursor + length);
        cursor += length;

        // Try to decode as a submessage first (recurse) — this surfaces
        // strings nested inside message wrappers without duplicating the
        // outer bytes as garbage text.
        let recursed = false;
        if (length >= 2 && depth < maxDepth) {
          const firstByte = slice[0]!;
          const firstWire = firstByte & 0x7;
          if (firstWire <= 5 && (firstByte >> 3) > 0) {
            yield* walk(slice, depth + 1, maxDepth, minLength);
            recursed = true;
          }
        }

        if (length >= minLength && isProbablyPrintableUtf8(slice)) {
          const decoded = decodeUtf8Strict(slice);
          if (decoded !== null && decoded.trim().length >= minLength) {
            yield decoded;
          }
        }

        if (!recursed) {
          // no-op — the printable check above already handled emission
        }
        break;
      }
      case 5: {
        // 32-bit
        if (cursor + 4 > view.length) return;
        cursor += 4;
        break;
      }
      default:
        // unknown wire type (3 and 4 are deprecated group start/end)
        return;
    }
  }
}
