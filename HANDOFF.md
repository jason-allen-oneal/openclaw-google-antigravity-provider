# Handoff — google-antigravity-cli provider

Branch: `feat/image-input-and-sdk-compat` (9 commits ahead of `main`, **not pushed**)
State: 135 tests / 11 files passing, `tsc --noEmit` clean, `npm run build` clean.
Verified against **agy 1.0.14** and **openclaw 2026.9.1** on Linux.

**Nothing here has run inside a live OpenClaw gateway.** Everything was verified
by unit tests, by driving the real `agy` binary directly with the exact argv/config
the plugin generates, and by registering the built plugin against a mock plugin API.
The gateway seam itself is the open verification gap — see [What still needs
verifying](#what-still-needs-verifying).

---

## 1. Read this first: how to verify a claim about agy

`agy` **serves a reduced flag set when the account is not signed in or not
eligible.** `--help` omits real flags (`--effort`, `--input-format`,
`--json-schema`, `--mode`, `--agent`) and passing one fails with Go's
`flags provided but not defined: -effort`, which looks exactly like the flag not
existing in that build.

This produced a wrong conclusion during development — that `--effort` did not
exist and the branch's core feature was broken. It does exist.

Before concluding any agy flag or capability is missing, confirm auth works:

```bash
agy --print "say ok" --print-timeout 2m0s   # must return text, not an eligibility error
```

A short `--help` is a symptom of degraded auth, not the real interface.

---

## 2. What the plugin does

Four registrations, all from `src/index.ts`:

| Registration | File | Role |
| --- | --- | --- |
| `registerProvider` | `index.ts` | Identity, auth wizard, synthetic auth, dynamic models |
| `registerCliBackend` | `backend.ts` | How `agy` is invoked, output parsed, sessions bound |
| `registerModelCatalogProvider` | `models.ts` | Static fallback + live `agy models` catalog |
| `registerSessionCatalog` | `session-catalog.ts` | Read-only sidebar of existing agy conversations |
| `registerHook("before_prompt_build")` | `index.ts` | Workspace instructions + cross-provider catch-up |

Turn flow: OpenClaw shells out to `agy --print <prompt> --model <id> ...` once per
turn, parses `--output-format stream-json` JSONL, and binds the resulting agy
conversation id so the next turn resumes with `--conversation <id>`.

---

## 3. Quirks that will bite you

These are all measured, not inferred. Each one has a test guarding it.

### 3.1 `--effort` has three separate rules

`agy models` publishes Gemini **only** as effort-baked rows
(`gemini-3.7-flash-high/-medium/-low`). The plugin collapses them to one row per
family, which makes `--effort` mandatory — and the rules are not uniform:

| Model | `--effort` | Why |
| --- | --- | --- |
| Collapsed Gemini base id | **Required** | `--model gemini-3.7-flash requires --effort` |
| Effort-baked Gemini id | Not sent | level already in the id |
| Claude | **Never** | `--effort is not supported for model "claude-sonnet-4-6"` |
| GPT-OSS | Never | level is part of the id |

Plus: **Gemini 3.1 Pro has no `medium`** (`gemini-3.1-pro has no "medium"
effort (available: low, high)`). Efforts are clamped to what a family offers,
ties breaking downward.

Slider off/unset → `low` (an explicit product decision, not a default).

### 3.2 Prompts go via argv, and stdin is worse

| Platform | Limit |
| --- | --- |
| Windows | ~32,767 chars, whole command line |
| macOS | 262,144 bytes, args + env |
| Linux | 131,072 bytes per argument (measured) |

**Do not set `maxPromptArgChars`.** It is the obvious mitigation and it is wrong
twice over:

1. When OpenClaw diverts to stdin it leaves `promptArg` undefined and never
   substitutes `{prompt}`, so agy receives the literal string `{prompt}`.
2. agy's stdin path is *worse* than argv. It accepts a prompt on stdin when
   `--print` is omitted, but measured on 1.0.14 it handles 16,384 chars and
   **silently discards** anything from ~20,000 up — returning `status: SUCCESS`
   with an empty response and zero token usage. A loud `E2BIG` beats a silent
   empty turn.

### 3.3 The prompt is not always just the new message

```js
basePrompt = cliSessionIdToUse ? params.prompt : openClawHistoryPrompt ?? params.prompt
```

With no session id to resume, OpenClaw embeds the prior transcript in a
`<conversation_history>` block. That reseed is capped at **12,199 chars** for
this backend (`12288 - 89`); the larger context-derived budget is gated on the
literal backend id `claude-cli`, so we never get it. Not plugin-configurable.

### 3.4 Session binding is load-bearing for cost, not just continuity

If `captureSessionId` fails, every turn starts a fresh agy conversation. That
loses continuity **and** resets the prompt cache to baseline. Measured cache
behaviour across separate processes:

| Turn | Mode | input_tokens | cache_read_tokens |
| --- | --- | --- | --- |
| 1 | fresh | 6,013 | 8,093 |
| 2 | `--conversation <id>` | 8,326 | 20,228 |
| 3 | `--conversation <id>` | 11,008 | 32,423 |
| — | fresh | 6,011 | 8,093 (baseline) |

Caching is Google's and needs nothing enabled. Protecting the binding is the
whole job. This is why the cwd-matching fix (§3.5) matters.

### 3.5 agy's cwd cache is case- and separator-sensitive

`resolveCachedConversationId` reads agy's `cache/last_conversations.json`, keyed
by cwd. Windows and macOS default to case-insensitive filesystems and Windows
accepts either separator, so agy and OpenClaw can spell one directory
differently and never match — silently costing the binding. Matching tries the
exact key first, then a normalized sweep (separator, trailing slash, and case
only on case-insensitive hosts).

**Each agent must have its own workspace.** agy's cache is keyed by cwd alone,
so two agents sharing a workspace directory would contend for the same entry.

### 3.6 Images travel as file paths

agy has **no** image flag, and its stream-json input rejects non-text blocks:
`stream input content block type "image" is not supported (only "text")`.

What works: OpenClaw stages attachments and appends their absolute paths to the
prompt (the `imageArg`-unset path), and agy opens them with its own `view_file`.
`imagePathScope: "workspace"` keeps them where agy may read. Verified with both a
bare path and an `@`-prefixed one.

Vision is per-family: Gemini and Claude yes, **GPT-OSS 120B no** — it asks for
the image contents back instead of opening the file, so it stays `["text"]`.
OpenClaw gates on `input.includes("image")`, so a model row that omits `image`
gets attachments dropped.

### 3.7 agy has no compaction

Slash-command surface is `/agents /changelog /config /credits /effort /help
/hooks /model /permissions /skills /usage`. There is no `/compact`; `/compact` is
answered as ordinary chat.

The backend declares `ownsNativeCompaction` with **no** `manualCompaction`,
matching bundled `google-gemini-cli`. A previous implementation declared one that
asked the model to "summarise this conversation" — which *appends* a turn,
making the conversation longer, while reporting success to OpenClaw. Do not
reintroduce that.

### 3.8 agy reads MCP config only from HOME

Verified on 1.0.14: `~/.gemini/config/mcp_config.json` loads;
project-local `.agents/mcp_config.json` is discovered then **silently ignored**
([antigravity-cli#60](https://github.com/google-antigravity/antigravity-cli/issues/60)).
No flag or env var redirects the path per run. agy also performs **no `${VAR}`
expansion** in the config — it passed `Bearer ${PROBE_TOKEN}` through literally.

### 3.9 OpenClaw's system prompt never reaches agy

`resolveSystemPromptUsage` returns `null` unless the backend declares
`systemPromptArg`/`systemPromptFileArg`/`systemPromptFileConfigKey`, and agy has
no flag for any of them. agy also does **not** read an `AGENTS.md` from the
working directory on its own (verified).

Partly by design: with `nativeToolMode: "always-on"` agy owns its tool surface,
so OpenClaw's tool and channel instructions would describe tools agy lacks. The
part that defines agent *behaviour* is delivered instead — see §4.2.

### 3.10 The SDK type shim is required, not a workaround to remove

`openclaw/plugin-sdk/cli-backend` and `plugin-sdk/provider-model-shared` stopped
shipping `.d.ts` after 2026.7.1:

| openclaw | `plugin-sdk/cli-backend.d.ts` |
| --- | --- |
| 2026.7.1 | present |
| 2026.8.1 | **absent** (`.js` only) |
| 2026.9.1 | **absent** (`.js` only) |

So this plugin never compiled against its own declared minimum of `^2026.8.1` —
it only built because the lockfile still pinned 2026.7.1.
`src/openclaw-cli-backend-shim.d.ts` declares structural equivalents. It is safe
on 2026.8.x and 2026.9.x because neither ships competing declarations. Delete it
only if a release re-publishes those declarations. `ProviderPlugin` needs no
shim — it is still exported from `plugin-sdk/plugin-entry`.

---

## 4. Features added on this branch

### 4.1 Cross-provider catch-up (`src/session-continuity.ts`)

OpenClaw keeps CLI session bindings **per provider** and clears them only on
failure, never on a model or provider switch. `resolveCliSessionReuse` decides
reuse from auth profile, auth epoch, message-tool policy, cwd, MCP, and
system-prompt/tool hashes — **none of which is a transcript position**, and
`CliSessionBinding` has no cursor. So a chat that ran on agy, spent turns on
another provider, and came back resumed with only the new message.

Fix: every `AssistantMessage` records the `provider` that produced it, so the
missed turns are everything after this provider's most recent assistant message.
That makes the delta **stateless** — no watermark to drift — and self-correcting.

| Case | Behaviour |
| --- | --- |
| First switch-in (no prior agy turn) | silent — OpenClaw reseeds; injecting would duplicate |
| Consecutive agy turns | silent — empty delta |
| Back to agy after other-provider turns | injects the missed turns |
| A turn running on another provider | silent |

Same behaviour for `claude-cli` upstream — this is an OpenClaw property, not
something this backend broke.

### 4.2 Workspace instructions (`src/workspace-bootstrap.ts`)

Reads the same files OpenClaw does — `AGENTS.md`, `SOUL.md`, `IDENTITY.md`,
`USER.md`, `MEMORY.md` — from `ctx.workspaceDir` (per-agent) and delivers them in
the prompt. Measured effect with an `AGENTS.md` saying "answer in exactly one
sentence" and a `SOUL.md` saying "you are Ada":

- without → "I am Gemini 3.7 Flash, an AI assistant built by Google…" (several sentences)
- with → "I am Ada, and the sum of 2 and 2 is 4."

**`BOOTSTRAP.md` is deliberately excluded.** OpenClaw drives it as a dedicated
one-time run ("read BOOTSTRAP.md now and follow it before replying normally") and
the file is deleted after. Shipping it as standing instructions would invite agy
to re-run bootstrap on ordinary turns.

Sent once per agy conversation, keyed on the conversation id **and** a
fingerprint of the files. Re-sent when either changes — binding lost/replaced, or
a file edited/added/deleted. Gateway restart clears the tracker, costing one
extra delivery.

### 4.3 MCP bridge (`src/mcp-bridge.ts`)

OpenClaw runs a loopback HTTP MCP server exposing its own tools
(`mcp__openclaw__*`) and hands the child a bearer token. `claude-cli` gets it via
`--mcp-config`, `gemini-cli` via `GEMINI_CLI_SYSTEM_SETTINGS_PATH`. agy has
neither.

The backend declares `bundleMcp: true` with
**`bundleMcpMode: "gemini-system-settings"`** — the only viable mode of the
three, because it injects no CLI args (agy rejects `--mcp-config`/
`--strict-mcp-config`), delivers the path through the child env where
`prepareExecution` can read it, and resolves `${OPENCLAW_MCP_TOKEN}` to a
literal before writing (required, per §3.8).

The bridge translates to agy's schema (`url` → `serverUrl`, `excludeTools` →
`disabledTools`, drop `type`/`trust`) and merges into agy's HOME config.
Because that file is shared: entries are namespaced under `openclaw__`, each run
replaces every owned entry (no stale dead ports), cleanup re-reads before
stripping (user edits survive), `serialize: true` prevents overlap, and the file
is written `0600` via atomic rename since it briefly holds the token.

Verified end to end: the real bridge wrote the config, agy connected and
authenticated, called the tool, returned a value obtainable only from that
server, and cleanup restored the file with an unrelated user server intact.

Opt out with `exposeOpenClawTools: false`.

### 4.4 Tool permissions

agy cannot prompt in headless mode — it auto-denies. `permissionMode` config:
`skip` (default, `--dangerously-skip-permissions`), `sandbox` (`--sandbox`,
verified working), `settings` (neither flag, defers to `permissions.allow` in
agy's `settings.json`).

Default is deliberately `skip`: it is the only mode that runs unattended out of
the box. It does auto-approve every agy tool call.

---

## 5. What still needs verifying

1. **A real turn through a live gateway.** The whole seam — OpenClaw → backend →
   agy → parser → OpenClaw — is verified piecewise, never as a whole.
2. **Image input end to end.** All three links are proven independently; no
   attachment has flowed through a live turn.
3. **`before_prompt_build` firing.** Verified against a mock API only. If it does
   not fire in the gateway, the failure mode is the old behaviour, not a crash.
4. **The MCP bridge in the gateway.** The bridge itself is proven against real
   agy, but the `bundleMcp` → env → `prepareExecution` plumbing is not.
5. **Windows / macOS.** Only Linux was executable here. Platform-keyed tests
   assert the right branch on whichever host runs them — run `npm test` on a Mac
   and the case-insensitivity assertions switch automatically.
6. **`settings` permission mode** is only as good as the user's
   `permissions.allow` rules.

## 6. Draft PR openclaw/openclaw#136257

Reviewed against the raw 3.4 MB diff, not the description. **No adaptation
needed.** Zero-diff for everything used here: `registerCliBackend`,
`registerModelCatalogProvider`, `liveCatalog`/`staticCatalog`, `isModernModelRef`,
`prepareExecution`, `resolveExecutionArgs`, `parseJsonlEvent`, `captureSessionId`,
`ownsNativeCompaction`, `registerSessionCatalog`, `copyToGatewaySession`,
`before_prompt_build`, `UnifiedModelCatalogEntry`, `imageArg`/`imagePathScope`,
`nonSecretAuthMarkers`.

Apparent hits were false alarms: `resolveSyntheticAuth` gains an *optional*
`runtime?` field (for markers without a CLI backend registration — we have one);
`bundleMcp` hits are a deleted test fixture; `configPatch` changes are
codex/xai/CLI-auth specific; the one `input.includes("image")` removal is in an
e2e test.

Two behavioural notes to re-check when it lands (both degrade gracefully):

- *"Provider discovery moves exclusively to the catalog worker."* `liveCatalog`
  spawns `agy models`; a worker with a different `PATH` may not resolve `agy`.
  Failure returns null and falls back to `STATIC_MODEL_FALLBACK`.
- *"Synthetic auth facts captured at build time."* `resolveSyntheticAuth` runs
  `which agy`; if evaluated once at build time, a probe failing then could stick
  until the next catalog build.

## 7. Known-good verification commands

```bash
npm install && npm run build && npm test     # 135 tests
npx tsc -p tsconfig.json --noEmit            # includes tests

# effort matrix against real agy — all five must succeed
agy --model gemini-3.7-flash   --effort low  --print "Say OK" --print-timeout 2m0s
agy --model gemini-3.1-pro     --effort high --print "Say OK" --print-timeout 2m0s
agy --model gemini-3.8-flash-medium          --print "Say OK" --print-timeout 2m0s
agy --model claude-sonnet-4-6                --print "Say OK" --print-timeout 2m0s
agy --model gpt-oss-120b-medium              --print "Say OK" --print-timeout 2m0s

# these two MUST fail — they are the bugs that were fixed
agy --model gemini-3.7-flash --print "Say OK"                    # requires --effort
agy --model claude-sonnet-4-6 --effort high --print "Say OK"     # effort unsupported
```

Note `agy models` and a cold `agy --help` phone home and take 15–45 s.

## 8. Housekeeping

Repo working tree is clean; only `dist/` and `node_modules/` are untracked (both
gitignored). Development scratch files were removed.

**Not cleaned, because it is your data:** testing left **68 unindexed transient
conversations** in `~/.gemini/antigravity-cli/conversations/` (~35 MB total dir,
69 of 72 `.db` files created during the session). 4 files are indexed in
`conversation_summaries.db` and appear in the sidebar — keep those. To drop only
the unindexed ones:

```bash
python3 - <<'PY'
import sqlite3, os, glob
d = os.path.expanduser('~/.gemini/antigravity-cli')
c = sqlite3.connect(f'file:{d}/conversation_summaries.db?mode=ro', uri=True)
known = {r[0] for r in c.execute('SELECT conversation_id FROM conversation_summaries')}
victims = [p for p in glob.glob(d + '/conversations/*.db')
           if os.path.basename(p)[:-3] not in known]
print(len(victims), 'unindexed conversations')
# for p in victims: os.remove(p)   # uncomment to delete
PY
```

`~/.gemini/antigravity-cli/cache/last_conversations.json` also holds 4 stale
entries pointing at a deleted `/tmp/claude-.../scratchpad` path. Harmless — they
resolve to nothing — but they can be pruned from that JSON if you want it tidy.
