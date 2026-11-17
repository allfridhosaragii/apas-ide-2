---
description: "Built-in Obsidian-Mind knowledge vault, startup project briefing, and automatic session history recorder."
kind: "package-reference"
---

# @deepseek-ai/dsh-obsidian-mind

English | [中文](README.zh.md)

## Summary

`dsh-obsidian-mind` embeds a standalone Obsidian-Mind vault directly inside DeepSeek Harness (`$DSH_HOME/obsidian-mind` by default), optionally alongside external companion Obsidian vaults. Before the first model request of a session, the agent plugin checks whether the current workspace project already has history, decisions, patterns, or gotchas in the vault and injects a bounded `<system-reminder>` briefing. A host service automatically records prompts and turn endings into `brain/logs/`, `brain/projects/`, `brain/Otak_Utama.md`, and `brain/Master_Brain.canvas`, and exposes `obsidian_mind_status`, `obsidian_mind_recall`, and `obsidian_mind_record` tools.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount `@deepseek-ai/dsh-obsidian-mind` on the Host plane and `@deepseek-ai/dsh-obsidian-mind/agent` in each Agent scope. Without overrides, the built-in vault initializes at `$DSH_HOME/obsidian-mind`. Set `vaultPath` (or `DSH_OBSIDIAN_MIND_VAULT`) to use another writable vault, or set `extraReadVaults` (or `DSH_OBSIDIAN_MIND_EXTRA_VAULTS`) to read an external Obsidian vault without modifying it.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`src/index.ts` provides `ObsidianMindService` (`ctx.obsidianMind`), serializes writes through an in-process queue using atomic file replacement, and observes `session/event` to log human prompts and turn outcomes. `src/agent.ts` attaches a prepended `agent/pre-step` listener for startup project briefings and registers `obsidian_mind_status`, `obsidian_mind_recall`, and `obsidian_mind_record`. `src/vault.ts` handles vault initialization, bounded file reads, keyword recall, and `Master_Brain.canvas` generation.

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Startup project briefing

#### What the model sees

When a root session opens with non-empty vault content, the first pre-step prepends one durable `user/message` (`source.kind = 'obsidian-mind'`, `form = 'recall'`) wrapped in `<system-reminder>` containing `<obsidian-mind ...>` project match status, known projects, recent project history, and non-empty `Key Decisions`, `Gotchas`, `Memories`, and `Patterns` excerpts.

#### Token effect

Conditional on vault content and capped at `maxBriefingChars` (default `12000`). Empty vaults inject nothing.

#### KV Cache effect

Appends one baseline message before the first human turn and preserves prefix stability across later turns and steps in the same session.

### Obsidian-Mind tools and guidance

#### What the model sees

Adds the `tool:obsidian-mind` system prompt section and schemas for `obsidian_mind_status`, `obsidian_mind_recall`, and `obsidian_mind_record`.

#### Token effect

Fixed small schema and prompt-section overhead when tools are enabled.

#### KV Cache effect

Prefix-stable across requests while tool registration remains unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Keyword recall only** — `obsidian_mind_recall` uses bounded keyword matching over `brain/` markdown and canvas files rather than semantic vector embeddings.
- **Per-host vault storage** — Cross-device sharing relies on running `dsh web` as a shared host or synchronizing the vault directory externally.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
