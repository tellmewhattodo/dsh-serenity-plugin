# Serenity ACC — an "AI workspace" for DeepSeek Harness

> **In one line**: this plugin turns an ordinary directory into an AI **workspace**. Inside it, the
> agent gets **memory, discipline, tools and boundaries** — swap the model, reboot the machine, come
> back tomorrow, and it picks up where it stopped.

> 🔵 **This file is a short English orientation, not a second manual.**
> The authoritative README — tool inventory, mechanical constraints, entry points, FAQ — is the
> Chinese one: **[README.md](README.md)**. Keeping two full translations is a second source of truth
> that silently drifts (this file had already fallen several releases behind), so it deliberately
> stays short.

## What it is / is not

| | |
|---|---|
| **Is** | a **DSH plugin** (npm `@shgroup/dsh-serenity-hooks`): adds tools, interceptor seams and assembly text to the host |
| **Is** | one *implementation* of a **standard** — the standard lives in [serenity-acc-specs](https://github.com/tellmewhattodo/serenity-acc-specs); this repo is its DSH adaptation layer |
| **Is not** | an agent framework. It defines no agent loop, picks no model, does no prompt orchestration — that is the host's job |
| **Is not** | a replacement or fork of DSH. **The plugin never modifies the host** |
| **Is not** | a model router / gateway |
| **Is not** | private to one workspace. Another standard-conforming implementation drives the same workspace unchanged |

Supported host bands = `peerDependencies` in the package `package.json`. Current version = `CHANGELOG.md`.
Runtime state = the `dashboard health` tool. None of these are written into prose.

## Quick start (2 minutes)

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

A workspace is **a directory plus one marker file**:

```
my-workspace/
├── .serenity            ← marker: this directory is a workspace (without it the plugin does nothing)
├── .opencode/skills/    ← domain skills: one body of knowledge per domain, may carry small tools
├── AGENT_SESSIONS/      ← the vault: one directory per cognitive trajectory; SESSION.md is its body
└── _tmp/                ← images and files pasted into the conversation land here
```

**Safe mode**: flip the SAFE slider in the capsule and `bash` is **removed** from the agent's tool
list — it cannot see it and cannot call it. The switch belongs to the human side only.

## Where to go next

| You want | Go to |
|---|---|
| the **tool inventory** (14 tools, 3 of them conditional) and the **mechanical constraints** the agent cannot bypass | [README.md](README.md) (authoritative) |
| the **standard**: six invariants, tool contract surface, induction, interceptor semantics, acceptance checklist | [serenity-acc-specs](https://github.com/tellmewhattodo/serenity-acc-specs) |
| **what changed and why**, plus the current version | [CHANGELOG.md](CHANGELOG.md) |
| why it is called a "cognitive container" / "cognitive trajectory" | [docs/cognitive-container-theory.md](docs/cognitive-container-theory.md) |
| the maintainer criteria library | the `dsh-serenity-plugin-development` skill |

## Development

```bash
pnpm typecheck   # types (node + web client)
pnpm test        # full test suite (vitest)
pnpm build       # bundle (lib/index.js + client.js)
```

- One-stop dev script: `scripts/dsp-develop.ts` (typecheck / test / build / commit / push / version /
  bump / deploy / lockfile / host-upgrade / restart-web / publish / pack-check / github-push).
- 🔴 After touching dependencies in `package.json`, run `lockfile` and commit the lockfile.
- Host type baseline = devDependencies (`paths` in both tsconfigs point inside the repo).
- The package README is **generated** from the repo-root README (`dsp-develop readme-sync`).

## License

MIT (see [LICENSE](LICENSE))
