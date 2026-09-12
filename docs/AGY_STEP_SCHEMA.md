# Reversing agy's on-disk conversation format

Google's Antigravity CLI (`agy`) stores every conversation as a SQLite
database under `~/.gemini/antigravity-cli/conversations/<uuid>.db`. The
`steps` table holds one row per turn/event; each row's `step_payload`
column is an opaque **protobuf** blob whose schema Google has not
published. This document records what we learned reversing enough of it
to render user/assistant/tool-call transcripts in the openclaw sidebar.

Everything here is **empirical** — derived from inspecting real
conversations against a running `agy` binary. Field numbers can change
across releases; treat the schema as a moving target and validate
against fresh data when adding to `session-catalog-decoder.ts`.

## Methodology

We didn't have a `.proto` file. We got here in three passes.

### 1. Confirm the format and locate the descriptors

`file /Users/christopher/.local/bin/agy` reports a Go-compiled Mach-O
binary. Go protobuf-generated code embeds each `FileDescriptorProto` as
a raw byte slice in `.rodata`. Every descriptor starts with the
length-prefixed `name` field (`0x0a <len> "<path>.proto"`), so we can
enumerate them with a byte-level scan:

```bash
python3 - <<'PY'
import re
data = open('/Users/christopher/.local/bin/agy', 'rb').read()
for m in re.finditer(rb'\x0a([\x01-\x7f])(([A-Za-z0-9_./]+)?\.proto)', data):
    L = m.group(1)[0]
    if len(m.group(2)) == L:
        print(f"{m.start():#x}  {m.group(2).decode()}")
PY
```

That surfaces ~280 candidate offsets. Relevant packages: `jetski/cortex_pb`,
`jetski/dev_pb`, `jetski/chat_pb`, `jetski/prompt_pb`, `jetski/hooks_pb`.
The core conversation types live in **`cortex_pb`** (~731 message names,
extractable with `LC_ALL=C strings … | grep -oE 'cortex_pb\.[A-Za-z0-9_]*'`).

### 2. Try to extract the FileDescriptorProto

Not all of them decode cleanly. For each candidate offset, we did a
binary search for the smallest window that parses as a valid
`google.protobuf.FileDescriptorProto`:

```python
from google.protobuf import descriptor_pb2

def try_parse(buf):
    fdp = descriptor_pb2.FileDescriptorProto()
    try:
        fdp.ParseFromString(buf)
        return fdp
    except Exception:
        return None
```

This yields ~59 usable `FileDescriptorProto`s including `remoting_pb`,
`analytics_pb`, `context_module_pb`, `codeium_common_pb`. **`cortex_pb`
itself does not decode this way** — Google appears to split its
descriptor across non-contiguous regions of `.rodata`, or store it in a
different form. Every attempt from 1 KB windows up to 60 MB returned
`DecodeError`.

If you find a way to extract `cortex_pb`'s FDP cleanly, please replace
the empirical field map below with generated bindings.

### 3. Empirically map fields by inspecting real blobs

Since the FDP wouldn't cooperate, we fell back to inspecting
`step_payload` blobs directly. For each `step_type` that appeared in a
conversation, we picked one representative row and walked its wire
format with a pure-Python recursive decoder that tries every
length-delimited field as (a) UTF-8 string, (b) nested message,
(c) neither. Read the raw dump next to `sqlite3 <db> "SELECT step_type
FROM steps ORDER BY idx"` to identify which fields carry the payload
and which are metadata.

The `session-catalog-decoder.ts` module implements the resulting field
map. `session-catalog-decoder.test.ts` builds synthesized blobs from
the same wire primitives so the map has protection from silent
drift — if a future agy release renumbers a field, the corresponding
test fails immediately.

## Table layout

```
steps(
  idx integer primary key,
  step_type integer,      -- role marker (see below)
  status integer,
  metadata blob,          -- small, mostly session/timestamp
  render_info blob,       -- UI rendering hints (colors, icons)
  step_payload blob,      -- the actual content — what we decode
  step_format integer,    -- always 3 in observed samples
  ...
)
```

`step_payload` is `cortex_pb.<something>` — an outer wrapper that
always carries:

```
#1  varint    step_type          (mirrors the column)
#4  varint    step_format        (always 3)
#5  msg       StepMetadata       (timestamps, ids, session refs)
#20 msg       AgentMessage       (present when step_type = 15)
#19 msg       UserMessage        (present when step_type = 14)
… kind-specific fields …
```

## `step_type` map (empirical)

| step_type | Meaning                    | Content field(s)                       |
| ---------:| -------------------------- | -------------------------------------- |
|   `14`    | User turn                  | `#19.#2` = prompt text                 |
|   `15`    | Agent turn (text)          | `#20.#1` streamed, `#20.#8` accumulated |
|   `15`    | Agent turn (tool announce) | `#20.#7` = { `#2` name, `#3` args }. **Duplicated by the following execution step — suppress.** |
|   `21`    | Tool call: `run_command`   | Metadata `#5.#4`, stdout at `#28.#21.#1` |
|   `5`     | Tool call: `replace_file_content` (edits) | Metadata `#5.#4`, output at `#28.#21.#1` |
|   `7`     | Tool call: edit variant    | Same shape as 5 / 21                   |
|   `8`     | Tool call: `view_file`     | Metadata `#5.#4`, contents at `#14.#4` |
|   `9`     | Tool call: `list_dir`      | Metadata `#5.#4`, entries at `#15.#3.{#1 name, #4 size, #2 is_dir}` |
|   `132`   | Tool call: `manage_task`   | Metadata `#5.#4`, text at `#140.#2.#1` |
|   `17`    | Model error / invalid tool call | `#24.#3.#1` = human message; `.#2` details |
|   `23`    | Trajectory metadata (title/summary) | No user-facing content — mark empty |
|   `98`    | Session heartbeat / handshake | No content — mark empty              |
|   `101`   | System / task notification | `#114.#1` framed line, `#114.#2.{#1 short label, #2 body}` |

## Tool-call metadata (uniform across step_types 5, 7, 8, 9, 21, 132)

```
#5.#4 msg  ToolInvocation
  #1 string    invocation_id  (short opaque token)
  #2 string    tool_name      ("run_command", "view_file", "list_dir", ...)
  #3 string    arguments_json (JSON blob — the raw args the model sent)
  #7 msg       tool-specific spec (parsed args, provider-side)
  #9 string    tool_name (duplicate, occasionally different casing)

#5.#30 string  short_title    ("Git status")
#5.#31 string  active_summary ("Checking git status in openclaw")
```

The **result** field varies by tool:

| Tool                    | Field          | Shape                                |
| ----------------------- | -------------- | ------------------------------------ |
| run_command / edits     | `#28.#21.#1`   | stdout / stderr (string)             |
| view_file               | `#14.#4`       | file contents (string)               |
| list_dir                | `#15.#3.…`     | repeated dirent { name, size?, is_dir? } |
| manage_task             | `#140.#2.#1`   | task status text block               |

## Adding a new tool

1. Trigger the tool in a real `agy` session.
2. Read the resulting row: `sqlite3 <db> "SELECT idx, step_type FROM
   steps ORDER BY idx DESC LIMIT 5"` — spot the new step_type.
3. Dump the payload with the Python walker in
   [`docs/scripts/dump-step.py`](scripts/dump-step.py) *(add on
   demand)* to find the output field.
4. Extend the `switch (stepType)` block in
   `src/session-catalog-decoder.ts` and add a test in
   `session-catalog-decoder.test.ts` using synthesized bytes.

## Known limitations

- **`cortex_pb` FDP not extracted** — if we could get it, we could use
  `protobufjs` to generate proper bindings and stop chasing field
  numbers by hand.
- **No timestamp on decoded items.** `step_payload` carries a
  timestamp under `#5.#1.#1` (seconds) and `#5.#1.#2` (nanos), but the
  openclaw catalog UI currently doesn't render it. We surface only the
  `history.jsonl`-derived timestamps for fallback user turns.
- **Streamed vs. final agent text.** For long assistant turns, agy
  writes many type-15 rows with incremental chunks. We prefer `#20.#8`
  (accumulated) and treat `#20.#1` as a chunk; that means partial
  streaming is not visible in the transcript — you see the finished
  turn.
- **No tool-result ↔ tool-call pairing across steps.** For run_command
  we get the output on the same step; for manage_task, the "task
  finished" notification arrives several steps later as a type-101.
  Currently they render in temporal order (both surface, not linked).

## References

- `src/session-catalog-decoder.ts` — the decoder itself.
- `src/session-catalog-decoder.test.ts` — synthetic-blob tests that
  pin every field number.
- `src/session-catalog-sources.ts` — walker used as a fallback for
  step_types not in the decoder.
- Prior art:
  [agentgrep](https://github.com/loop-labs/agentgrep) `adapters/antigravity_cli.py`
  (uses a similar schemaless walk approach).
