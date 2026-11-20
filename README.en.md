# Serenity ACC — a "cognitive container" for DeepSeek Harness

> **In one line**: this plugin turns an ordinary directory into an AI **cognitive container**. Inside
> it, the agent gets **memory, discipline, tools and boundaries** — swap the model, reboot the machine,
> come back tomorrow, and it picks up where it stopped.

## 1 What it is / is not

| | |
|---|---|
| **Is** | a **DSH plugin** (npm `@shgroup/dsh-serenity-hooks`): adds tools, interceptor seams and assembly text to the host |
| **Is** | one *implementation* of a **standard** — the standard lives in [serenity-acc-specs](https://github.com/tellmewhattodo/serenity-acc-specs); this repo is its DSH adaptation layer |
| **Is not** | an agent framework. It defines no agent loop, picks no model, does no prompt orchestration — that is the host's job |
| **Is not** | a replacement or fork of DSH. **The plugin never modifies the host** |
| **Is not** | a model router / gateway |
| **Is not** | private to one container. Another standard-conforming implementation drives the same container unchanged |

Supported host bands = `peerDependencies` in the package `package.json`. Current version = `CHANGELOG.md`.
Runtime state = the `dashboard health` tool. None of these are written into prose.

### Three concepts (everything below rests on these)

| Concept | What it is | Where it lives |
|---|---|---|
| **CCC** (Concrete Cognitive Container) | a directory plus a `.serenity` marker. **Without the marker the plugin does nothing** | that directory |
| **Cognitive trajectory** | a piece of **long-running engineering**, not a one-off chat. It has no lifecycle: it never completes, closes, or expires | `AGENT_SESSIONS/<date>--<code>--<name>/SESSION.md` |
| **Session** | the trajectory's **rebuildable carrier**. The model changes, context fills, processes restart — replace the carrier, the trajectory stays put | the host's session log |

> The distinction that governs the whole plugin: **identity belongs to the trajectory, not to any
> session.**

## 2 Quick start (2 minutes)

Needs Node ≥ 20 (or bun) and a supported DSH release line.

```bash
# 1 install (joins the DSH web profile automatically)
dsh plugin --profile web add @shgroup/dsh-serenity-hooks

# 2 restart dsh web (plugin and web UI take effect together)
dsh web

# 3 verify: open a session inside a directory that has a .serenity marker
#   · the session starts with the container identity and the skill catalog
#   · a status capsule appears next to the session title (green dot + SAFE slider)
#   · run `dashboard health` — the three self-checks should all pass
```

Uninstall: `dsh plugin --profile web remove @shgroup/dsh-serenity-hooks`

From source (when you change the code):

```bash
git clone https://github.com/tellmewhattodo/dsh-serenity-plugin.git
cd dsh-serenity-plugin
dsh plugin --profile web add link:$(pwd)/hooks/dsh-serenity-hooks
```

⚠️ Do **not** use `dsh plugin add github:…` — that URL points at the repository root, not at the
plugin package, so nothing loads.

A container is **a directory plus one marker file**:

```
my-container/
├── .serenity            ← marker: this directory is a container (without it the plugin does nothing)
├── .opencode/skills/    ← domain skills: one body of knowledge per domain, may carry small tools
├── AGENT_SESSIONS/      ← the vault: one directory per cognitive trajectory; SESSION.md is its body
└── _tmp/                ← images and files pasted into the conversation land here
```

**Safe mode**: flip the SAFE slider in the capsule and `bash` is **removed** from the agent's tool
list — it cannot see it and cannot call it. The switch belongs to the human side only.

## 3 What you get

### 3.1 Thirteen tools, two of them conditional

> This inventory lives **here only** (the user's view: what you can do). Contract semantics — what
> each action must do — are in §4 of the standard and are not duplicated here.
> Additions/removals follow `REGISTERED_TOOLS` in `src/kernel/invariant.ts`; `tests/compliance.test.ts`
> cross-checks that constant against the assembly text.

| Tool | What it does |
|---|---|
| `container_fs` | file operations inside the container: list / tree / find / copy / move / create / reveal. One step outside the container is refused |
| `cognitive_trajectory` | **one cognitive trajectory**: its body (SESSION.md) plus a timeline. create / show / use / rebuild, plus **wake at a future instant** (`send-later`) and **deliver right now** (`send-now`) |
| `dashboard` | always-on instruments: `health` (three self-checks) / `time` / `diag` (runtime diagnosis) |
| `container_git` | git: status / commit / push / log / pull / diff. **Never force-pushes** |
| `msm` | single entry for small tools: `msm("name", ["args"])`; a partial name returns candidates; `inspect=true` shows usage |
| `praxis` | on-demand method injection: `eap` (say it explicitly) / `neat` (align before acting) / `cce` (continuity) / `ontology` (make domain structure explicit) |
| `ontology` | ontology engineering **engine**: reads `.ttl`, runs structural validation and semantic review, writes templates. `praxis ontology` explains, this one runs |
| `serenity-skill-creator` | creator for enhanced skills: `guide` / `create` / `check` / `review` / `index` / `status` |
| `localstore` | credentials and local preferences: `localstore.json` at the container root, not committed by default |
| `container_admin` | the maintenance bay: `config` (manual index / trajectory constraint / current values) + `msm` (registry management) |
| `browser_slot` | **browser slot manager** (up to 20 independent Chromes): `acquire` / `list` / `release` plus 19 page actions (`ax` / `click` / `fill` / `wait` / `upload` / `dialog` …). Slots carry ownership and state; if you forget to release one, **the watchman nudges the session holding it** |
| `im-bridge` ● | send messages to contacts (WeChat / Feishu): text, files, contacts, channel status |
| `diagram` ● | tag source → diagram, rasterized **in-process** and pasted into the conversation (no browser, no files) |

● = **conditional**. When the condition is unmet the tool is **not registered at all** (the agent
cannot even see it, and it costs no context): `im-bridge` needs an enabled IM channel; `diagram` is
experimental and **off by default** (toggle in the settings panel's "Tools" group).

> 🔴 **`reconstruct` was removed on 2026-11-20** (v1.137.12): its capability is **entirely** carried by
> `cognitive_trajectory`'s `rebuild` — once cumulative usage crosses the threshold, `rebuild` is
> **mechanically rerouted** into a carrier replacement (new session + archive the old one). Both paths
> already ended in the same code; keeping a second action name only bought the model one extra moment of
> hesitation. **The replacement capability is untouched — there is simply no second entrance.**
> If you used to call it directly: call `rebuild` instead (identical parameters: `summary` required,
> `note` optional); past the threshold the behaviour is equivalent.

> **Runtime diagnosis**: `dashboard diag` (always visible, no declaration needed) — live sessions /
> wake scheduler clock / CRO-enabled trajectories / wake registry (future vs overdue).

> **Renames are hard cuts with no compatibility alias**: `cc_fs` → `container_fs`, `logbook` /
> `trajectory` → **`cognitive_trajectory`**, `eap` / `neat` / `cce` → `praxis`, `acc-diag` →
> **`dashboard diag`**. Read old names through this table.

> 🔴 **Retired actions and keys** (meeting them means your upstream doc is stale, not that you
> misconfigured something): `container_fs`'s `append` (cut in v1.101.0) / `dashboard`'s `wait` (cut) /
> the `exclusiveTools` mechanism (cut) / `weixin.autoReplyWithLastMessage` and
> `weixin.fallbackOnNoSend` (cut in D238).

### 3.2 Mechanical constraints (the agent cannot talk its way past these)

> This is the plugin's main selling point: none of the following relies on prompting — it relies on
> mechanism. Every item is observable from your side.

| Constraint | What you will see |
|---|---|
| **Container wall** | usable inside, refused outside — the path is not even resolved |
| **Safe mode** | `bash` disappears from the tool list (re-synced every step); a forced call is still refused by the backstop |
| **Governance files and blacklist** | `.serenity` and other governance files are write-protected for the agent; other paths can be blacklisted |
| **Credential guard** | `localstore.json` is refused to **every** tool (including read / grep / glob) ⇒ secret values cannot structurally leave |
| **Outbound output guard** | on outward-facing sessions, an answer containing a sensitive term is **sent back for a rewrite**, naming the term and the direction to change |
| **Progress reminder** | after long work the agent is told to write progress back into the work log and must answer with an ack code — the reminder is mechanism, not self-discipline |
| **Log size governance** | when `SESSION.md` exceeds the threshold the agent is prompted to rewrite it (keep the skeleton / move detail out / merge what can merge). Threshold `sessionKeeper.sessionMdMaxKB`, 0 = off |
| **Automatic log rotation** | on context rebuild, the fine-grained log `LOG/LOG.md` is **frozen whole** into `LOG-<timestamp>.md` and a new generation begins. Name collisions auto-avoid, **it never overwrites**, and the frozen file's byte count is read back for verification |

> **Why the last one is worth its own row**: it used to be a *rule* ("remember to rotate"). The
> failure mode of a rule is that the agent forgets, **nothing signals it, and the log grows without
> bound**. Moving it onto the rebuild path makes forgetting irrelevant.

## 4 Outward-facing endpoints (optional)

| Endpoint | Default | Purpose |
|---|---|---|
| DSH main UI | 3080 | local use. **The plugin does not touch this port** and does not start this listener |
| Web login entry | 3081 (**off by default**) | reach the full UI from a phone or the internet: password or a 6-digit TOTP, per-account failure lockout, reverse-proxied to 3080 after login |
| WeChat proactive send | 3082 (`127.0.0.1` only) | scripts **outside** the container use it to send WeChat messages; the agent inside does not — it uses `im-bridge` directly |
| WeChat bridge | no port (outbound long poll) | family members talk to the agent directly in WeChat: QR binding, accepts text / voice / image / file |

- **Sessions hang off trajectories**: the same trajectory keeps the same session, history survives a
  restart (identity sits outside this layer).
- **Routing = WeChat id → trajectory code** (exact match first, `*` as fallback).
- Everything listens on `127.0.0.1` by default; exposing it to the internet is your call (tunnel,
  reverse proxy, port mapping — the plugin commits to none of them).
- **Programmatic or remote access goes through the host's own official ACP server**
  (`dsh --profile acp`, plain stdio): this plugin provides no ACP surface; authentication lives in the
  access layer.

## 5 FAQ

**Nothing happens after install?**
Check that you are inside a directory with `.serenity` — outside a container the plugin does nothing
at all. Then run `dashboard health` for the three self-checks.

**Why did `bash` disappear?**
Safe mode is on. That is by design, not a fault: turn the SAFE slider off and it returns.

**3081 login is locked out?**
5 consecutive failures lock it for 15 minutes, then exponential backoff. Wait it out, or check the
account's TOTP binding.

**Context is nearly full — what now?**
Have the agent write progress back into `SESSION.md`, then do an in-place rebuild
(`cognitive_trajectory rebuild`) — **the carrier is replaced, the trajectory is untouched**, and you
never open a new session by hand.

**How do I connect from a phone or another editor?**
Use the host's official ACP: start `dsh --profile acp` and connect any ACP client. Authentication and
exposure are decided by your tunnel / reverse proxy / Access layer; the plugin issues no keys.

**I use opencode models inside DSH — must I hand-write request headers?**
No. The plugin only fills the **missing** headers in the `x-opencode-session` family and **never
touches a value you wrote**; if `OPENCODE_API_KEY` is in the environment and no opencode route
exists, it creates one. Turn it off with `opencodeProvider.autoConfigure`.

**How does the agent's reply get sent in WeChat?**
The **agent sends it itself** (`im-bridge`) — that is now the **only** path. The bridge does two
things: turn an inbound message into a turn, and **nudge the agent when it should have sent
something but did not** (at most twice). It never speaks for the agent, and there is no fallback
switch (both old switches are retired; see §3.1).

**Are proactive messages recorded?**
Yes, through the same recording channel as replies, with `source` distinguishing them.

**How do I configure trajectory declarations, scheduled wakes, and CRO?**
Not here — each lives where it belongs: the **declaration surface** (what `trajectory.json` accepts
and what the defaults are) is §3.0.1 of the standard; the **tool's own manual** is
`container_admin config docs trajectory-self` (describing yourself) and
`config docs trajectory-constraint` (restricting yourself); the **CRO authoring guide** is
`cognitive_trajectory cro-guide`.

## 6 Further reading

| You want | Go to |
|---|---|
| the **standard**: six invariants, tool contract surface, assembly content, interceptor semantics, acceptance checklist | [serenity-acc-specs](https://github.com/tellmewhattodo/serenity-acc-specs) |
| **what changed and why**, plus the current version | [CHANGELOG.md](CHANGELOG.md) |
| why it is called a "cognitive container" / "cognitive trajectory" | [docs/cognitive-container-theory.md](docs/cognitive-container-theory.md) |
| the full criteria for the trajectory declaration surface | [docs/trajectory-declaration-file.md](docs/trajectory-declaration-file.md) |
| code map | [docs/codebase-overview-v1.22.md](docs/codebase-overview-v1.22.md) |
| the maintainer's criteria library (this repo's maintenance discipline) | the `dsh-serenity-plugin-development` skill |

### For plugin developers

```bash
pnpm typecheck   # types (node + web client)
pnpm test        # full test suite (vitest)
pnpm build       # bundle (lib/index.js + client.js)
```

- One-stop dev script: `scripts/dsp-develop.ts` (typecheck / test / build / commit / push / version /
  bump / deploy / lockfile / host-upgrade / restart-web / publish / pack-check / github-push); see `--help`.
- 🔴 After touching dependencies in `package.json`, run `lockfile` and commit the lockfile — skipping
  it once left CI red at "the tests never ran".
- Host type baseline = devDependencies: `paths` in both tsconfigs point inside the repo's
  `node_modules/@deepseek-ai/*`, supplied by pinned devDeps ⇒ **a new `paths` entry needs a matching
  devDependency**; the gate is `tests/compliance.test.ts`.
- The package README is **generated**: repo-root `README.md` → `hooks/dsh-serenity-hooks/README.md`
  (`dsp-develop readme-sync`, relative links rewritten to absolute). **Do not edit the packaged copy.**

## License

MIT (see [LICENSE](LICENSE))
