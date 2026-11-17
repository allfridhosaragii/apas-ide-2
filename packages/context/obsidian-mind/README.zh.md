---
description: "内置 Obsidian-Mind 知识库、会话启动项目简报与自动历史记录器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-obsidian-mind

[English](README.md) | 中文

## 摘要

`dsh-obsidian-mind` 在 DeepSeek Harness 内置独立的 Obsidian-Mind 知识库（默认位于 `$DSH_HOME/obsidian-mind`），并可选连接外部只读伴随库。在会话首次模型请求前，插件会自动检查当前工作区项目是否已有历史记录、决策、模式或注意事项，并注入有界的 `<system-reminder>` 简报。宿主机服务还会自动将提示词与轮次结果记录到 `brain/logs/`、`brain/projects/`、`brain/Otak_Utama.md` 与 `brain/Master_Brain.canvas`，并提供 `obsidian_mind_status`、`obsidian_mind_recall` 与 `obsidian_mind_record` 工具。

## 目录

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在宿主机层面挂载 `@deepseek-ai/dsh-obsidian-mind`，在 Agent 作用域挂载 `@deepseek-ai/dsh-obsidian-mind/agent`。未覆盖配置时，内置知识库自动初始化于 `$DSH_HOME/obsidian-mind`。可通过 `vaultPath`（或 `DSH_OBSIDIAN_MIND_VAULT`）指定其他可写知识库，或通过 `extraReadVaults`（或 `DSH_OBSIDIAN_MIND_EXTRA_VAULTS`）以只读方式联合检索外部 Obsidian 库。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

`src/index.ts` 提供 `ObsidianMindService`（`ctx.obsidianMind`），通过进程内串行写入队列与原子替换确保并发安全，并监听 `session/event` 自动记录人类提示词与轮次结束状态。`src/agent.ts` 注册前置 `agent/pre-step` 监听器及 `obsidian_mind_status`、`obsidian_mind_recall`、`obsidian_mind_record` 工具。`src/vault.ts` 负责初始化、有界读取、关键词检索及生成 `Master_Brain.canvas`。

</details>

-----

<a id="model-experience"></a>
## 模型体验

### 启动项目简报

#### 模型看到的内容

当知识库包含有效内容时，根会话首次步骤前会前置一条持久 `user/message`（`source.kind = 'obsidian-mind'`、`form = 'recall'`），包含 `<obsidian-mind ...>` 项目匹配状态、已知项目列表、近期项目历史及非空的 `Key Decisions`、`Gotchas`、`Memories` 与 `Patterns` 摘要。

#### Token 影响

仅在知识库有内容时注入，且受 `maxBriefingChars`（默认 `12000`）限制；空库不增加额外 token。

#### KV Cache 影响

仅在首轮之前追加一次基线消息，同一会话后续轮次与步骤保持前缀稳定。

### Obsidian-Mind 工具与提示词引导

#### 模型看到的内容

注入 `tool:obsidian-mind` 系统提示词段以及 `obsidian_mind_status`、`obsidian_mind_recall` 和 `obsidian_mind_record` 工具模式。

#### Token 影响

启用工具时带来固定且较小的模式与引导文本开销。

#### KV Cache 影响

只要工具集合不变，各次请求的前缀保持稳定。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

- **仅支持关键词检索** — `obsidian_mind_recall` 对 `brain/` 下的 Markdown 与 Canvas 文件做有界关键词匹配，不包含向量语义索引。
- **单宿主机存储** — 跨设备共享需通过统一宿主机运行 `dsh web`，或由外部工具同步知识库目录。

<a id="dev-note"></a>
### 开发说明

<details>
<summary>维护者上下文 — 点击展开</summary>

无。

</details>
