# Google Antigravity Provider for OpenClaw

Production-ready OpenClaw plugin for delegating persistent agent turns and model routing to a local signed-in Google Antigravity (`agy`) CLI. Compatible with OpenClaw 2026.8.x+.

## Features

- **Persistent Multi-turn Agent Sessions:** Full SQLite conversation caching and automatic resume binding across turns.
- **Dynamic Configurable Timeouts:** Automatically derives `--print-timeout` dynamically from `timeoutSeconds` or custom plugin settings (default: `30m0s`), preventing premature agent turn termination.
- **Image Input:** Gemini and Claude models accept images. OpenClaw stages attachments into the workspace and appends their paths to the prompt; `agy` opens them with its own `view_file` tool.
- **Full Model Support:** Gemini 3.8 Flash, Gemini 3.7 Flash, Gemini 3.6 Flash, Gemini 3.1 Pro (effort routed through OpenClaw's thinking-level slider → `agy --effort {low|medium|high}`), Claude Sonnet 4.6 (Thinking), Claude Opus 4.6 (Thinking), GPT-OSS 120B.
- **Synthetic Local Auth:** Seamlessly uses local signed-in `agy` credentials with zero expiring tokens or stored secrets in OpenClaw.
- **Sanitized Execution Environment:** Automatically isolates user data via `ANTIGRAVITY_USER_DATA_DIR` and scrubs conflicting ambient Google API keys.
- **OpenClaw Tools via MCP:** Bridges OpenClaw's loopback MCP server into agy for the duration of each run, so agy can call OpenClaw's own tools and any MCP servers you configure in OpenClaw.
- **Workspace Instructions:** Reads the same bootstrap files OpenClaw does (`AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `BOOTSTRAP.md`, `MEMORY.md`) per agent, and delivers them to agy once per conversation, so agents behave the same here as on any other provider.
- **Duplicate History Removed:** OpenClaw prepends its channel context (`⟦openclaw:ctx⟧` block plus the active goal) to every turn. Agy already has that history in its own conversation SQLite, so a thin wrapper strips those blocks before agy sees the prompt — turning a compounded prompt back into a bounded one.
- **Session Catalog:** Past agy conversations appear in OpenClaw's session sidebar. Continue resumes them via `agy --conversation <id>`; Copy imports a transcript into a fresh OpenClaw session, so you can keep an agy-started thread going in any other model.
- **Preflight Probing:** Validates local `agy` CLI health, executable availability, and required command-line flags on setup.
- **Prompt Caching:** Resuming by conversation id keeps Google's server-side cache warm across turns; `cache_read_tokens` is reported back to OpenClaw as `cacheRead` usage.

## Setup

### 1. Install and sign in to `agy`

The plugin drives whatever `agy` binary is on `$PATH`. Grab the CLI from
Google's downloads page —
[antigravity.google/download#antigravity-cli](https://antigravity.google/download#antigravity-cli) —
then sign in interactively by running `agy` once and completing the Google
flow.

Confirm the account is signed in and eligible before touching OpenClaw:

```bash
agy --print "say hello" --print-timeout 2m0s
```

If that returns text within a couple of minutes, auth is good.

> ⚠️ **Watch for a degraded `agy --help`.** When the account is not signed in
> or the model tier is ineligible, `agy --help` shows a *reduced* flag set that
> omits real flags (`--effort`, `--input-format`, `--json-schema`, `--mode`,
> `--agent`), and passing one fails with Go's
> `flags provided but not defined: -effort`. That looks exactly like the flag
> not existing in that build — it does. The `agy --print` probe above is the
> reliable check.

### 2. Register the plugin with OpenClaw

Point OpenClaw at this plugin directory in `~/.openclaw/openclaw.json`. The
`plugins.load.paths` array can hold either a local checkout of this repository
*or* the `~/.openclaw/agents/<agent>/workspace/skills/google-antigravity-cli`
directory if you `rsync` a built copy into place there.

```json
{
  "plugins": {
    "allow": ["google-antigravity-cli"],
    "load": {
      "paths": [
        "/absolute/path/to/openclaw-google-antigravity-provider"
      ]
    },
    "entries": {
      "google-antigravity-cli": {
        "enabled": true,
        "config": {
          "printTimeout": "30m0s",
          "stream": true,
          "permissionMode": "skip",
          "exposeOpenClawTools": true
        }
      }
    }
  }
}
```

Then restart the gateway:

```bash
openclaw gateway restart
```

### 3. Register the synthetic auth marker with OpenClaw

OpenClaw itself does not persist any Google credentials — agy owns those. But
the picker still needs to know that a synthetic-local provider is available.
The plugin's setup wizard does this for you:

```bash
openclaw models auth login --provider google-antigravity-cli --agent main
```

Answer *"Yes"* when it asks whether to configure the local Antigravity `agy`
runtime. The wizard:

- Runs a fast `which agy` probe (`agy --help` is impractical — it hits Google
  and can take 30–45 s cold).
- Snapshots the current live catalog from `agy models` (falling back to a small
  static list if agy is offline) into `models.providers.google-antigravity-cli`.
- Adds a wildcard route: `agents.defaults.models["google-antigravity-cli/*"]` →
  the CLI backend.
- Widens `agents.defaults.modelPolicy.allow` to include
  `google-antigravity-cli/*` so the models actually reach the picker.

At that point `openclaw models` should list every model row `agy models`
publishes, and the `/models` picker in your channels should show
`google-antigravity-cli` with them under it. Pick one and start chatting.

### 4. Verify end-to-end

Once a channel turn has actually run through agy:

- `openclaw plugins list --json | grep antigravity-cli` should show
  `"status": "loaded"` with **no** `plugins.errors[]` entry in
  `openclaw health --json`.
- The Telegram `/status` card should not show `⚠️ Plugins: … plugin error`.
- `openclaw models list --provider google-antigravity-cli --json` should list
  the collapsed base rows (`gemini-3.8-flash`, `-3.7-flash`, `-3.6-flash`,
  `-3.1-pro`, plus Claude Sonnet 4.6, Claude Opus 4.6, and GPT-OSS 120B).
- To confirm the MCP bridge, ask the agent "list the openclaw MCP tools you
  have" — it should name entries under the `openclaw__` prefix. If it does
  not, `~/.gemini/config/mcp_config.json` will be empty after the turn
  (cleanup is intentional); check `openclaw health --json` for a plugin error
  and re-run `openclaw gateway restart` if you just deployed a code change.

## Configuration Reference

The setup steps above install this plugin with `permissionMode: "skip"`,
streaming on, and MCP bridge on. If you skipped the wizard, or want to
declare the full provider / model / routing shape by hand, this is the
canonical block for `~/.openclaw/openclaw.json`:

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "google-antigravity-cli": {
        "baseUrl": "http://antigravity.local",
        "api": "google-generative-ai",
        "models": [
          { "id": "gemini-3.8-flash", "name": "Gemini 3.8 Flash", "reasoning": true, "input": ["text", "image"] },
          { "id": "gemini-3.7-flash", "name": "Gemini 3.7 Flash", "reasoning": true, "input": ["text", "image"] },
          { "id": "gemini-3.6-flash", "name": "Gemini 3.6 Flash", "reasoning": true, "input": ["text", "image"] },
          { "id": "gemini-3.1-pro", "name": "Gemini 3.1 Pro", "reasoning": true, "input": ["text", "image"] },
          { "id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6 (Thinking)", "reasoning": true, "input": ["text", "image"] },
          { "id": "claude-opus-4-6-thinking", "name": "Claude Opus 4.6 (Thinking)", "reasoning": true, "input": ["text", "image"] },
          { "id": "gpt-oss-120b-medium", "name": "GPT-OSS 120B (Medium)", "reasoning": true, "input": ["text"] }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "timeoutSeconds": 1800,
      "models": {
        "google-antigravity-cli/*": {
          "agentRuntime": {
            "id": "google-antigravity-cli"
          }
        }
      },
      "cliBackends": {
        "google-antigravity-cli": {
          "stream": true
        }
      }
    }
  }
}
```

### Tool Permissions

agy cannot prompt for a tool permission in headless `--print` mode — it
auto-denies and reports that the tool *"required the read_file permission that
headless mode cannot prompt for"* — so a policy has to be chosen up front.
`permissionMode` under the plugin's config selects it:

| Mode | Flag | Behaviour |
| --- | --- | --- |
| `skip` (default) | `--dangerously-skip-permissions` | Auto-approves every tool. The only mode that works with no further setup. |
| `sandbox` | `--sandbox` | agy runs with terminal restrictions enabled. |
| `settings` | *(neither)* | Defers to `permissions.allow` in `~/.gemini/antigravity-cli/settings.json`. Least privileged, but needs a rule for every tool you expect to be used. |

```json
{
  "plugins": {
    "entries": {
      "google-antigravity-cli": {
        "enabled": true,
        "config": { "permissionMode": "sandbox" }
      }
    }
  }
}
```

The default stays `skip` for compatibility and because it is the only mode that
runs unattended out of the box — but it does mean every agy tool call is
auto-approved. Pick `sandbox` or `settings` if that is not acceptable.

### Restricted runs (exact tool caps)

When OpenClaw supplies an exact tool cap, this local release requires **agy
1.2.1**, an empty native-tool selection, and the plugin's normal Node wrapper.
Other CLI versions fail closed until their behavior has been verified.

Each restricted run starts a fresh, private custom agent with only the captured
OpenClaw MCP transport. A generated `PreToolUse` hook allows only the selected
tool names on that run's unique MCP server; native actions and other servers
are denied. Restricted runs remove permission-skipping and conversation-resume
flags, disable slash expansion, and reject unsupported CLI overrides. They do
not use the HOME-level MCP bridge described below. Private agent/transport files
are removed when the child exits. Existing unrestricted routing is unchanged.

The cap is a tool-execution restriction, not filesystem sandboxing or a claim
of root-instruction isolation. The host remains responsible for the authority
of the selected MCP tools. Restricted runs do not use the shared conversation
cache as a fallback for binding the user's session.

### OpenClaw Tools in agy (MCP)

The following shared-config behavior applies to unrestricted runs only.

OpenClaw runs a loopback HTTP MCP server exposing its own tools, and hands the
CLI child a bearer token for it. `claude-cli` receives that as
`--mcp-config <file>` and `gemini-cli` through
`GEMINI_CLI_SYSTEM_SETTINGS_PATH`. agy has neither, so the plugin bridges it.

The backend declares `bundleMcp` with `bundleMcpMode: "gemini-system-settings"`
— the right one of the three available modes, because it injects **no** CLI args
(agy rejects claude's `--mcp-config` / `--strict-mcp-config`), delivers the
config path through the child environment (`GEMINI_CLI_SYSTEM_SETTINGS_PATH`),
and resolves `${OPENCLAW_MCP_TOKEN}` and `${OPENCLAW_MCP_CLI_CAPTURE_KEY}` to
literals before writing, which agy requires since it performs no placeholder
expansion of its own.

The bridge runs in the strip-wrapper rather than `prepareExecution` because
OpenClaw's per-turn capture attempt (`prepareCliBundleMcpCaptureAttempt`)
rewrites `GEMINI_CLI_SYSTEM_SETTINGS_PATH` **after** `prepareExecution` returns
— reading it any earlier gets the pre-capture file with an empty
`x-openclaw-cli-capture-key`, and every MCP call from agy comes back 401. The
wrapper reads the env var at spawn time and thus sees the resolved key.

It then translates the config into agy's schema (`url` → `serverUrl`,
`excludeTools` → `disabledTools`, dropping `type`/`trust`) and merges it into
agy's `mcp_config.json` for the run.

Verified against agy 1.0.14 with a live MCP server behind bearer auth: agy
connected, called the tool, and returned a value only obtainable from the
server.

**It has to be the HOME-level file.** agy loads MCP servers only from
`~/.gemini/config/mcp_config.json`. Project-local `.agents/mcp_config.json` is
discovered and then silently ignored
([antigravity-cli#60](https://github.com/google-antigravity/antigravity-cli/issues/60),
still true on 1.0.14), and no flag or environment variable redirects the path
per run. Consequences, and how they are handled:

- **Your servers are never touched.** Injected entries are namespaced under the
  `openclaw__` prefix; merging replaces only that prefix and removes them again
  when the run ends. Cleanup re-reads the file first, so edits you make during a
  run survive.
- **Stale entries cannot accumulate.** Each run replaces every `openclaw__`
  entry, so a crashed run cannot leave a dead loopback port behind.
- **No concurrent writes.** The backend sets `serialize: true`, so agy runs
  never overlap.
- **The token touches disk briefly.** It is a per-run, loopback-scoped bearer
  token; the file is written `0600` via an atomic rename and the entry is
  deleted afterwards.

Set `exposeOpenClawTools: false` in the plugin config to skip this entirely and
leave agy's MCP config alone:

```json
{
  "plugins": {
    "entries": {
      "google-antigravity-cli": {
        "enabled": true,
        "config": { "exposeOpenClawTools": false }
      }
    }
  }
}
```

Any MCP servers you configure in OpenClaw are forwarded by the same mechanism,
so agy gets those too.

### Subagent History Cap (`maxResumeDbBytes`)

Agy stores every subagent invocation, every `manage_task` transition and
every tool result in the conversation's SQLite forever (see the `step_type`
histogram in [`docs/AGY_STEP_SCHEMA.md`](docs/AGY_STEP_SCHEMA.md) — one
long-running Telegram chat we observed hit **101 rows of `manage_task`
history totaling 1.7 MB**, which agy faithfully replayed every turn and
ballooned Gemini's reported cache-read to 8.2 M tokens on a single reply).
This is agy's own state, not openclaw's channel context — the wrapper strip
never sees it.

To prevent the pileup from compounding indefinitely, the plugin refuses to
`--conversation`-resume any db above a byte threshold. When the cap trips,
the plugin drops `--conversation <id>` from the invocation so agy starts a
fresh conversation for that turn; openclaw's catch-up hook (already
installed) re-seeds the recent transcript on the way in, so the user-visible
conversation continues without a break.

Default cap: **2 MB** (`DEFAULT_MAX_RESUME_DB_BYTES`). Raise or disable it
per-plugin:

```json
{
  "plugins": {
    "entries": {
      "google-antigravity-cli": {
        "enabled": true,
        "config": {
          "maxResumeDbBytes": 5000000
        }
      }
    }
  }
}
```

Set `maxResumeDbBytes: false` to turn the guard off entirely (agy replays
everything, no matter the size). The trigger prints a warning to the
plugin's stderr so you can spot the drop in `openclaw gateway logs`.

### Channel Context Stripping

OpenClaw's cli-runner composes every turn's `--print` value by prepending the
channel-provided context — one `Conversation info: ⟦openclaw:ctx⟧` block, one
`Conversation context (chronological…) ⟦openclaw:ctx⟧` block covering recent
turns, and the `Active goal:` appendix. It does this after every registered
`before_prompt_build` hook has already returned
(`prepare.ts:1856 → renderCurrentPrompt → buildCurrentInboundPrompt`), so a
plugin hook cannot rewrite the prompt to remove those blocks.

For a backend with native session persistence — agy stores the whole
conversation in `~/.gemini/antigravity-cli/conversations/<id>.db` and resumes
via `--conversation <id>` — that channel context is duplicate history: agy
already has it, and re-sending it every turn compounds the SQLite state and
inflates the context. In one Telegram session the same content was recorded
enough times that `openclaw status` reported 942 % of a 1M context window.

The strip-wrapper handles this at the spawn boundary. When OpenClaw spawns
`node <plugin>/dist/agy-strip-wrapper.js <argv>` the wrapper:

1. Finds the `--print` value in argv.
2. Walks it paragraph-by-paragraph (respecting fenced code blocks so an
   `⟦openclaw:ctx⟧` mention *inside* a code block is not stripped) and removes
   the two label-anchored ctx blocks plus the `Active goal:` appendix.
3. Execs the real agy binary with the trimmed argv, inheriting stdio and
   forwarding SIGINT/SIGTERM/SIGHUP so OpenClaw's stream-json parser and turn
   cancellation still work.

Idempotent, no-op when the marker isn't present, and leaves user content
alone — a message that happens to mention "Conversation info" without the
`⟦openclaw:ctx⟧` marker passes through unchanged.

Override the underlying agy binary the wrapper execs by setting
`OPENCLAW_ANTIGRAVITY_REAL_COMMAND`.

### Optional: Real-Time Thought & Text Streaming

To stream thinking and response deltas in real-time to the OpenClaw Web UI, enable `stream: true` under `agents.defaults.cliBackends.google-antigravity-cli`:

```json
{
  "agents": {
    "defaults": {
      "cliBackends": {
        "google-antigravity-cli": {
          "stream": true
        }
      }
    }
  }
}
```

## Model Routing & Effort

`agy models` publishes the Gemini families only as effort-baked rows
(`gemini-3.7-flash-high`, `-medium`, `-low`). The plugin collapses them to one
row per family and supplies the level at execution time, which means `--effort`
handling has to follow agy's rules exactly:

| Model | `--effort` |
| --- | --- |
| Collapsed Gemini base id (`gemini-3.7-flash`) | **Required.** agy refuses to run it bare: `--model gemini-3.7-flash requires --effort` |
| Effort-baked Gemini id (`gemini-3.8-flash-medium`) | Not sent — the level is already in the id |
| Claude (`claude-sonnet-4-6`, `claude-opus-4-6-thinking`) | Never sent. agy: `--effort is not supported for model "claude-sonnet-4-6"` |
| GPT-OSS (`gpt-oss-120b-medium`) | Never sent — the level is part of the id |

Slider mapping: `off`/`minimal`/`low` → `low`, `medium`/`adaptive` → `medium`,
`high`/`xhigh`/`max` → `high`. When the slider is **off or unset**, models that
require an effort get `low` rather than no flag at all.

Levels are also clamped to what a family actually offers. Gemini 3.1 Pro ships
only `low` and `high` (`gemini-3.1-pro has no "medium" effort`), so a `medium`
slider resolves to `low` there — ties break downward so a request is never
silently upgraded to a more expensive level.

Aliases that name an effort (`flash-high`, `pro-low`) resolve to the matching
effort-baked id, so the level you asked for survives instead of being handed
back to the slider. Bare aliases (`flash`, `pro`) stay on the base family.

## Image Input

Gemini and Claude models accept image attachments. GPT-OSS 120B does not and stays
text-only in the catalog.

`agy` has no image flag, and its `--input-format stream-json` channel rejects
non-text content blocks (`stream input content block type "image" is not
supported (only "text")`). So images travel as **file paths**: OpenClaw stages
each attachment into `<workspace>/.openclaw-cli-images/`, appends the absolute
paths to the prompt, and `agy` opens them with its own `view_file` tool.

That is why the backend sets `imagePathScope: "workspace"` and leaves `imageArg`
unset — the `temp` scope would put the files outside the directory `agy` is
allowed to read.

Requirements:

- The model row must declare `"input": ["text", "image"]`. OpenClaw drops
  attachments for any model whose `input` lacks `image`.
- No extra flags are needed; the paths ride along in the prompt.

## Prompt Caching

Caching is owned by Google and survives across separate `agy` invocations, so it
works with the way this plugin shells out once per turn. Measured against
`agy` 1.0.14:

| Turn | Invocation | `input_tokens` | `cache_read_tokens` |
| --- | --- | --- | --- |
| 1 | fresh conversation | 6,013 | 8,093 |
| 2 | `--conversation <id>` | 8,326 | 20,228 |
| 3 | `--conversation <id>` | 11,008 | 32,423 |
| — | fresh conversation | 6,011 | 8,093 |

A brand-new conversation already reads ~8k cached tokens (the shared system
prompt and tool definitions). Resuming by conversation id compounds the hit as
the conversation grows; starting fresh resets it to the baseline.

Nothing needs enabling. What protects the cache is **session binding**: if
`captureSessionId` cannot resolve a new conversation id, OpenClaw starts a fresh
conversation each turn and every turn pays the baseline instead of the
compounded rate. `cache_read_tokens` is surfaced to OpenClaw as `cacheRead`
usage on the terminal result event.

## OpenClaw Compatibility

`registerCliBackend` is **current**, not deprecated. It is still on
`OpenClawPluginApi` in 2026.9.x and the bundled `google` and `anthropic`
extensions register their own CLI backends. The manifest's top-level
`cliBackends[]` is itself the documented *replacement* for the deprecated
`activation.onAgentHarnesses` hint, and this plugin already uses it. The
`agents.defaults.cliBackends` config key in the example above is also still
valid.

One thing did change: the `openclaw/plugin-sdk/cli-backend` and
`plugin-sdk/provider-model-shared` subpaths stopped shipping type declarations
after 2026.7.1. Verified from the published tarballs:

| openclaw | `plugin-sdk/cli-backend.d.ts` |
| --- | --- |
| 2026.7.1 | present |
| 2026.8.1 | **absent** (`.js` only) |
| 2026.9.1 | **absent** (`.js` only) |

The runtime exports survive; the types now live only in a content-hashed
internal chunk with no stable import path, so `tsc` fails with TS7016 on those
imports. That means this plugin never actually compiled against its own declared
minimum of 2026.8.1 — it only built because the lockfile still pinned 2026.7.1.

`src/openclaw-cli-backend-shim.d.ts` declares structural equivalents to keep the
build green, the same approach `src/session-catalog.ts` already takes for the
gateway-protocol types. It is safe on 2026.8.x and 2026.9.x because neither
ships competing declarations. `ProviderPlugin` needs no shim — it is still
exported from `plugin-sdk/plugin-entry`. Delete the shim if a future release
re-publishes the subpath declarations.

## Cross-Provider Continuity

A chat can move between providers — start on OpenRouter in Telegram, switch to
an agy model, switch away again. The three cases behave like this:

| Situation | What OpenClaw does | What the plugin adds |
| --- | --- | --- |
| First switch **to** an agy model | No binding exists, so it reseeds the transcript into the prompt | Nothing — injecting would duplicate the reseed |
| Consecutive agy turns | Resumes `agy --conversation <id>`, sends only the new message | Nothing — agy already has the history |
| Switch **back** to agy after turns elsewhere | Reuses the stored binding and sends only the new message | Injects the turns agy missed |

That third row is the gap this plugin closes. OpenClaw keeps CLI session
bindings per provider (`entry.cliSessionBindings[providerId]`) and clears them
only on failure, never on a model or provider switch.
`resolveCliSessionReuse` decides reuse from auth profile, auth epoch,
message-tool policy, cwd, MCP, and system-prompt/tool hashes — none of which is
a transcript position — and `CliSessionBinding` carries no cursor. The runner
then does:

```js
basePrompt = cliSessionIdToUse ? prompt : openClawHistoryPrompt ?? prompt
```

So without help, a resumed agy conversation silently misses everything that
happened while another provider was answering.

The fix is a `before_prompt_build` hook, which runs on the CLI path with the
session transcript and whose `prependContext` is folded into the outgoing
prompt. Every `AssistantMessage` records the `provider` that produced it, so
the missed turns are simply everything after this provider's most recent
assistant message. That makes the delta **stateless** — no watermark to persist
or drift out of sync — and it self-corrects: if a turn is ever missed, the next
one still computes the gap from the same anchor.

Finding no prior agy assistant turn is exactly the first-switch-in case, so the
hook stays silent there and lets OpenClaw's own reseed do the work. Missed turns
are rendered as `User:` / `Assistant:` lines inside a `<turns_you_missed>`
block, capped at 8,000 chars, dropping oldest-first and saying how many turns it
omitted. Tool traffic is left out, since agy has its own tool history and
replaying another runtime's tool calls is noise.

### Compaction

The backend declares `ownsNativeCompaction` but deliberately offers **no**
manual compaction operation, matching the bundled `google-gemini-cli` backend.
agy has no compaction command — its slash-command surface is `/agents`,
`/changelog`, `/config`, `/credits`, `/effort`, `/help`, `/hooks`, `/model`,
`/permissions`, `/skills`, `/usage`, and `/compact` is answered as ordinary
chat. A control operation that merely asked the model to *"summarise this
conversation"* would **append** a summary turn rather than shrink anything,
while reporting success to OpenClaw. `/compact` therefore fails loudly instead
of silently doing nothing.

### Workspace Instructions

OpenClaw agents get their behaviour from workspace bootstrap files, and by
default none of them reached agy, so an agy turn answered as stock Antigravity
instead of as your agent. The plugin now reads the same files OpenClaw does —
`AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md`, in that order —
and hands them to agy in the prompt.

`BOOTSTRAP.md` is deliberately **excluded**. OpenClaw drives it as a dedicated
one-time run (*"read BOOTSTRAP.md from the workspace now and follow it before
replying normally"*) and the file is deleted once bootstrap completes. Shipping
it as standing instructions would invite agy to re-run a bootstrap procedure on
ordinary turns.

Measured against agy 1.0.14, with an `AGENTS.md` saying *"always answer in
exactly one sentence"* and a `SOUL.md` saying *"you are Ada, dry and precise"*:

| | Reply to "Who are you, and what is 2+2?" |
| --- | --- |
| Without the block | "I am Gemini 3.7 Flash, an AI assistant built by Google (operating as Antigravity here…)" — several sentences |
| With the block | "I am Ada, and the sum of 2 and 2 is 4." |

**Multi-agent aware.** The files are read from `ctx.workspaceDir`, which
OpenClaw resolves per run, so each agent gets its own workspace rather than a
shared one. Delivery is tracked per agent *and* workspace, so two agents in one
gateway never consume each other's state.

**Sent once per agy conversation, not per turn.** Delivery is keyed on the agy
conversation id bound to the workspace *and* a fingerprint of the instructions
on disk, so the block goes out when a conversation is first created and then
stays quiet. It is sent again when either changes:

- the conversation id differs — the binding was lost or replaced, and the new
  conversation has never seen the instructions;
- the fingerprint differs — a file was edited, added, or deleted, so the live
  conversation is carrying a stale copy.

Restarting the gateway clears the in-memory tracker, which costs one extra
delivery and nothing else.

Budget is 16,000 chars (6,000 on Windows, where the whole command line is capped
near 32,767). Earlier files win, since OpenClaw's ordering puts operating
instructions ahead of persona and `MEMORY.md` last, so truncation drops the most
incidental content first and the block names anything it omitted.

Why this is needed rather than using OpenClaw's own system prompt:
`resolveWorkspaceBootstrapRouting` is skipped unless the backend can transport a
system prompt, and `canTransportSystemPrompt` requires `systemPromptArg`,
`systemPromptFileArg`, or `systemPromptFileConfigKey`. agy has no
system-prompt flag for any of them to point at, and it does not read an
`AGENTS.md` from the working directory on its own (verified).

### Known limits

- **The first switch-in is truncated.** OpenClaw's reseed budget for this
  backend is `12288 - 89 = 12,199` chars (the larger context-derived budget is
  `claude-cli`-only), so a long prior chat reaches agy as a truncated tail. That
  budget is OpenClaw's and is not plugin-configurable.
- **OpenClaw's assembled system prompt still does not reach agy**, only the
  workspace files above. There is no flag to transport it, and with
  unrestricted runs agy owns its own tool surface, so OpenClaw's
  tool and channel instructions would describe tools agy does not have.
  Workspace instructions are the part that defines agent behaviour, and those
  now arrive.

## Session Catalog

Past agy conversations appear in OpenClaw's session sidebar under the
"Antigravity CLI" host. Openclaw calls the plugin's registered
`SessionCatalogProvider` (via `api.registerSessionCatalog(...)`) to populate
three actions:

| Verb | What it does |
| --- | --- |
| **List** | Reads `~/.gemini/antigravity-cli/conversation_summaries.db` and returns one row per conversation with title, preview, last-touched time, and the primary workspace `cwd`. Sorted newest-first. |
| **Read** | Rebuilds a transcript for the highlighted conversation. The plugin ships a **structured decoder** (`src/session-catalog-decoder.ts`) that reads agy's per-conversation `steps.step_payload` protobuf blobs directly, emitting typed `userMessage` / `agentMessage` / `toolCall` / `toolResult` / `other` items — same shape codex and claude CLI plugins use, so the transcript renders side-by-side without visual drift. Step types outside the known set fall through to a schemaless walker so nothing is silently dropped. Google does not publish agy's `.proto` files; the field map was reversed from real conversation blobs — see [`docs/AGY_STEP_SCHEMA.md`](docs/AGY_STEP_SCHEMA.md) for the methodology and the field table. |
| **Continue** | Binds the OpenClaw session to that conversation id and resumes it via the existing CLI backend — same `agy --conversation <id>` path used by every other turn. |
| **Copy to new session** | Streams the same transcript into a fresh Gateway-owned session so you can keep an agy-started thread going in *any* model available in OpenClaw's catalog. Bundled `beam` is the only other plugin that ships this hook today. |

Everything is **read-only** on agy's data directory. There is no rename,
archive, or delete surface — agy owns that state and the plugin refuses to
touch it.

Uses Node 22+'s built-in `node:sqlite`, so no additional runtime dependencies
are pulled in.

Known limits:

- The structured decoder covers `step_type` in {5, 7, 8, 9, 14, 15, 17, 21, 23,
  98, 101, 132} — enough for the everyday user/agent/tool-call flow. Rows with
  an unknown `step_type` still render, but they fall back to a heuristic text
  extractor that may occasionally surface a path or JSON blob as its own item.
  Adding a new tool is a ~20-line change in
  [`session-catalog-decoder.ts`](src/session-catalog-decoder.ts) —
  [`docs/AGY_STEP_SCHEMA.md`](docs/AGY_STEP_SCHEMA.md) documents how to
  identify the field numbers.
- Timestamps on decoded rows aren't surfaced yet (agy stores them under
  `#5.#1.{#1 seconds, #2 nanos}` — trivial to wire in when the sidebar needs
  it).
- The `list` output is refreshed on every sidebar poll and is not cached; on a
  home directory with thousands of conversations this may add a few tens of
  milliseconds per refresh.

## Tools & Slash Command

The plugin registers three tools any agent can call, plus one slash command
for interactive use from any chat surface (Telegram, webchat, terminal).

### Tools (`api.registerTool`)

| Tool | Description | Owner-only |
| --- | --- | --- |
| `antigravity_conversations_list` | List agy conversations, newest first, with optional `search` substring match against title / preview / id / workspace path. | no |
| `antigravity_conversation_read` | Read a specific conversation's structured transcript (same typed items the sidebar renders — user/agent/toolCall/toolResult). | no |
| `antigravity_reset_binding` | Force agy to start a fresh conversation next turn by renaming (backing up) its on-disk SQLite. The catch-up hook re-seeds the recent transcript so the user-visible chat continues without a break. | yes |

`antigravity_reset_binding` is guarded by `senderIsOwner` — it mutates
disk state, so untrusted agents (e.g. a sub-agent) can't invoke it.

### Slash command (`/antigravity`)

Available anywhere openclaw accepts slash commands.

```
/antigravity list [N]         — show the N most-recent agy conversations (default 10)
/antigravity status <id>      — show size + step count for a conversation
/antigravity reset <id>       — back up and drop the on-disk agy state so the next turn starts fresh
/antigravity help             — this text
```

`reset` is the interactive counterpart to `openclaw sessions compact
--max-lines N` when only agy's side of the context is inflated — it
leaves the openclaw transcript untouched and only resets the CLI backing.

### Manifest-declared plugin contract

The manifest declares the plugin owns everything it produces so openclaw's
lifecycle machinery doesn't have to guess:

- `sessionRouteStateOwners` — provider / runtime / cli-session-key / auth-profile-prefix all namespaced under `google-antigravity-cli`.
- `doctorContract.configRepair: true` — hook into `openclaw doctor --fix` for config normalization on upgrades.
- `backupResources` — declares `.gemini/antigravity-cli/{cache,logs}` as regenerable so `openclaw sessions export` doesn't bundle them.
- `contracts.tools` — the three tool ids above.
- `contracts.mediaUnderstandingProviders` — the one-shot image-description provider.
- `cliCommands` — the `/antigravity` subcommand tree.

### Media Understanding (image description)

Agy's Gemini + Claude models handle vision natively. The plugin exposes
that as a `MediaUnderstandingProvider` so any openclaw feature that
needs image understanding (inline tools in another provider's turn,
etc.) can delegate to agy without routing the whole conversation
through this plugin.

The invocation is deliberately lightweight — single-shot `agy --print`
with a per-invocation scratch data dir (no `--conversation`, no MCP
bridge), image staged to a temp workspace and referenced by path in the
prompt. Default vision model is `gemini-3.7-flash`; callers can pass a
`model` override via the standard `ImageDescriptionRequest`.

### Session Catalog Visibility (`sessionCatalog.enabled`)

Session-catalog registration is gated on
`plugins.entries.google-antigravity-cli.config.sessionCatalog.enabled`
(default: `true`) — same pattern the official codex plugin uses. Set
it to `false` to keep the provider / CLI backend / `/antigravity`
command available without publishing past agy conversations in the
sidebar.

## Platform Notes

The plugin runs on the same machine as `agy`, so paths and process limits are
resolved with platform-native APIs: `fileURLToPath` for workspace URIs (which
yields `C:\\Users\\...` and `\\\\server\\share` on Windows rather than
`/C:/Users/...`), `path.normalize` for cache keys, and `where` instead of
`which` when probing for the binary. The conversation-cache lookup also matches
case-insensitively on Windows and macOS, since agy and OpenClaw can spell the
same directory differently there. That match is not cosmetic — missing it makes
`captureSessionId` throw, which drops the session binding, restarts the agy
conversation every turn, and discards the accumulated prompt cache.

The data directory defaults to `~/.gemini/antigravity-cli`, resolved through
`$HOME` and falling back to `os.homedir()` when `HOME` is unset, as it usually
is on Windows.

### Prompt size limit

Prompts reach `agy --print` as a **command-line argument**, so the OS argv
limit is a hard ceiling:

| Platform | Limit | Notes |
| --- | --- | --- |
| Windows | ~32,767 chars for the whole command line | `CreateProcess`; the tightest |
| macOS | 262,144 bytes for args + environment | `ARG_MAX` |
| Linux | 131,072 bytes per single argument | `MAX_ARG_STRLEN`; measured |

The prompt is **not** always just the newest message. OpenClaw sends only the
new message when it has a CLI session id to resume
(`basePrompt = cliSessionIdToUse ? prompt : openClawHistoryPrompt ?? prompt`).
With no session id it reseeds, embedding the prior transcript in a
`<conversation_history>` block ahead of `<next_user_message>`.

That reseed is bounded. The context-derived budget that can reach 262,144 chars
applies only when the backend id is literally `claude-cli`, so this backend
falls back to the default `MAX_CLI_SESSION_RESEED_HISTORY_CHARS`, giving
`12288 - 89 = 12,199` chars of history. Worst case is therefore ~12.2 KB of
reseed plus the current message — comfortably inside every platform limit,
leaving roughly 20 KB of headroom for a single message on Windows, and far more
elsewhere.

So the reachable failure is one unusually large **single message** (a pasted log
or file dump) on Windows. It fails loudly, before agy starts, with
`spawn E2BIG` / `Argument list too long`.

Keeping the session binding healthy matters here too: without it every turn
takes the reseed path instead of the cheaper resume path, which both enlarges
the prompt and discards the accumulated prompt cache.

**Do not set `maxPromptArgChars`.** It is the obvious mitigation and it is
wrong twice over. First, when OpenClaw diverts a long prompt to stdin it leaves
`promptArg` undefined, and it only substitutes the `{prompt}` placeholder when
that value is defined — so agy would receive the literal string `{prompt}`.
Second, agy's stdin path is *worse* than argv: it accepts a prompt on stdin when
`--print` is omitted, but measured against agy 1.0.14 it processes 16,384 chars
and **silently discards** anything from ~20,000 up, returning
`status: SUCCESS` with an empty response and zero token usage. A loud E2BIG is
strictly preferable to a silent empty turn, so argv remains the correct
transport.

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT
