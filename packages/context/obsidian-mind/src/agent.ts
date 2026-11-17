/**
 * Agent-side Obsidian-Mind integration: injects project briefings before the
 * first model step and registers `obsidian_mind_*` recall/record tools.
 *
 * @module @deepseek-ai/dsh-obsidian-mind/agent
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, HarnessError } from '@deepseek-ai/dsh-llm'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from './index.ts'
import type { ObsidianMindRecordKind } from './types.ts'
import { projectIdentity } from './vault.ts'

/** Cordis plugin name for the per-agent Obsidian-Mind contributor. */
export const name = 'obsidian-mind-agent'

/** Required host services for automatic session briefing, working-directory resolution, prompt, and tools. */
export const inject = ['agents', 'obsidianMind', 'workingDirectory', 'tools', 'systemPrompt'] as const

/** Agent-side Obsidian-Mind behavior toggles. */
export interface AgentConfig {
  /** Automatically inject a durable Obsidian-Mind briefing on the first step when vault content exists. */
  injectOnStart?: boolean
  /** Also inject an initial briefing even when the vault has no projects or notes yet. */
  injectWhenEmpty?: boolean
  /** Include subagent sessions in automatic startup briefings. */
  injectInSubagents?: boolean
}

/** Schemastery validation for {@link AgentConfig}. */
export const Config: z<AgentConfig> = z.object({
  injectOnStart: z.boolean().default(true),
  injectWhenEmpty: z.boolean().default(false),
  injectInSubagents: z.boolean().default(false),
})

const OBSIDIAN_MIND_GUIDANCE = [
  '## Obsidian-Mind Built-in Memory',
  'This harness includes a built-in Obsidian-Mind vault (`brain/Master_Brain.canvas`, `brain/logs/`, `brain/Memories.md`, `brain/Key Decisions.md`, `brain/Patterns.md`, `brain/Gotchas.md`).',
  '- Check the injected `<obsidian-mind>` project briefing at session start before making architectural assumptions.',
  '- Call `obsidian_mind_recall` when you need deeper prior prompts, decisions, or history from this or another project.',
  '- Call `obsidian_mind_record` whenever you uncover a non-obvious gotcha, make an important design decision, or establish a reusable pattern.',
].join('\n')

function hasObsidianMindBaseline(agent: Agent, claimed: readonly UserMessage[]): boolean {
  for (const message of claimed) {
    if (message.source.kind === 'obsidian-mind') return true
  }
  for (const seq of agent.session.surface.nodes.toReversed()) {
    // oxlint-disable-next-line typescript/no-deprecated -- Matches sibling agent-instructions history probe.
    const event = agent.session.eventAt(seq)
    if (event?.type === 'user/message' && event.data.source.kind === 'obsidian-mind') {
      return true
    }
  }
  return false
}

function present(title: string, kind: 'read' | 'other', rawInput?: unknown): GenericCallView {
  return { card: 'generic', title, kind, ...rawInput === undefined ? {} : { rawInput } }
}

function resolveSessionCwd(ctx: Context, session: Session): string {
  return ctx.workingDirectory.get(session)
}

function renderJson(_args: unknown, value: unknown): [{ type: 'text'; text: string }] {
  return [{ type: 'text' as const, text: JSON.stringify(value) }]
}

const PROJECT_SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true },
    slug: { type: 'string', required: true },
    vaultPath: { type: 'string', required: true },
    promptCount: { type: 'integer', required: true },
    hasHistoryLog: { type: 'boolean', required: true },
  },
} as const

const STATUS_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    primaryVault: { type: 'string', required: true },
    extraReadVaults: { type: 'array', required: true, items: { type: 'string' } },
    initialized: { type: 'boolean', required: true },
    projects: { type: 'array', required: true, items: PROJECT_SUMMARY_SCHEMA },
    currentProject: PROJECT_SUMMARY_SCHEMA,
  },
} as const

const RECALL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string', required: true },
    projectHint: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    count: { type: 'integer', required: true },
    hits: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          vaultPath: { type: 'string', required: true },
          relativePath: { type: 'string', required: true },
          line: { type: 'integer', required: true },
          excerpt: { type: 'string', required: true },
          score: { type: 'number', required: true },
        },
      },
    },
  },
} as const

const RECORD_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    relativePath: { type: 'string', required: true },
    absolutePath: { type: 'string', required: true },
    projectSlug: { type: 'string', required: true },
  },
} as const

const RECORD_KINDS: readonly ObsidianMindRecordKind[] = [
  'memory',
  'pattern',
  'decision',
  'gotcha',
  'project-log',
]

/**
 * Mount automatic Obsidian-Mind startup briefings and model-facing tools in the calling scope.
 * @param ctx - Host or preset-scoped Cordis context.
 * @param config - Agent briefing toggles.
 */
export function apply(ctx: Context, config: AgentConfig = {}): void {
  const injectOnStart = config.injectOnStart ?? true
  const injectWhenEmpty = config.injectWhenEmpty ?? false
  const injectInSubagents = config.injectInSubagents ?? false

  ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (!injectOnStart || decision.kind === 'reject' || signal.aborted || decision.messages.length === 0) {
      return decision
    }
    if (!injectInSubagents && agent.session.header.origin === 'subagent') return decision
    if (hasObsidianMindBaseline(agent, decision.messages)) return decision

    signal.throwIfAborted()
    const cwd = resolveSessionCwd(ctx, agent.session)
    const inspection = await ctx.obsidianMind.inspectProject(cwd)
    if (!inspection.hasVaultContent && !injectWhenEmpty) {
      return decision
    }

    const briefing = createUserMessage({
      content: [{ type: 'text', text: `<system-reminder>\n${inspection.summary}\n</system-reminder>` }],
      source: {
        kind: 'obsidian-mind',
        form: 'recall',
        project: inspection.projectName,
        vaultPath: inspection.primaryVault,
      },
    })
    return { ...decision, messages: [briefing, ...decision.messages] }
  }, { prepend: true })

  ctx.tools.register(defineTool({
    name: 'obsidian_mind_status',
    description: 'Inspect the built-in Obsidian-Mind vault location, companion vaults, and tracked project list.',
    parameters: {},
    output: { schema: STATUS_OUTPUT_SCHEMA, render: renderJson },
    isConcurrencySafe: () => true,
    execute: async (_args, exec) => {
      const cwd = exec.agent ? resolveSessionCwd(ctx, exec.agent.session) : undefined
      return await ctx.obsidianMind.status(cwd)
    },
    presentCall: () => present('Check Obsidian-Mind status', 'read'),
  }))

  ctx.tools.register(defineTool({
    name: 'obsidian_mind_recall',
    description: 'Search Obsidian-Mind notes, project logs, decisions, patterns, and gotchas across active vaults.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Keywords or topic to search for in Obsidian-Mind.',
      },
      project: {
        type: 'string',
        description: 'Optional project name to prioritize matching project logs and notes.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of matching excerpts to return (1-30, default 8).',
      },
    },
    output: { schema: RECALL_OUTPUT_SCHEMA, render: renderJson },
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const query = args.query.trim()
      if (query.length === 0) {
        throw new HarnessError('obsidian_mind_recall requires a non-empty query', 'OBSIDIAN_MIND_INVALID_QUERY')
      }
      const cwd = exec.agent ? resolveSessionCwd(ctx, exec.agent.session) : undefined
      const projectHint = args.project?.trim() || (cwd ? projectIdentity(cwd).name : undefined)
      const limit = args.limit === undefined ? 8 : Math.min(30, Math.max(1, Math.trunc(args.limit)))
      const hits = await ctx.obsidianMind.recall(query, projectHint, limit)
      return { query, projectHint: projectHint ?? null, count: hits.length, hits }
    },
    presentCall: args => present('Search Obsidian-Mind', 'read', args.query),
  }))

  ctx.tools.register(defineTool({
    name: 'obsidian_mind_record',
    description: 'Record a durable memory, design decision, coding pattern, gotcha, or project note into Obsidian-Mind.',
    parameters: {
      kind: {
        type: 'string',
        required: true,
        enum: [...RECORD_KINDS],
        description: 'Entry category: memory, pattern, decision, gotcha, or project-log.',
      },
      title: {
        type: 'string',
        required: true,
        description: 'Short descriptive heading for the recorded note.',
      },
      content: {
        type: 'string',
        required: true,
        description: 'Markdown details to save into the Obsidian-Mind vault.',
      },
      project: {
        type: 'string',
        description: 'Optional project name; defaults to the active workspace project.',
      },
    },
    output: { schema: RECORD_OUTPUT_SCHEMA, render: renderJson },
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      if (!RECORD_KINDS.includes(args.kind)) {
        throw new HarnessError(`Unsupported Obsidian-Mind record kind "${args.kind}"`, 'OBSIDIAN_MIND_INVALID_KIND')
      }
      if (args.title.trim().length === 0 || args.content.trim().length === 0) {
        throw new HarnessError('obsidian_mind_record requires non-empty title and content', 'OBSIDIAN_MIND_EMPTY_RECORD')
      }
      const cwd = exec.agent ? resolveSessionCwd(ctx, exec.agent.session) : undefined
      return await ctx.obsidianMind.record({
        kind: args.kind,
        title: args.title,
        content: args.content,
        ...args.project?.trim() ? { project: args.project.trim() } : {},
        ...cwd ? { workspacePath: cwd } : {},
      })
    },
    presentCall: args => present(`Record ${args.kind} in Obsidian-Mind`, 'other', args.title),
  }))

  ctx.systemPrompt.section({
    name: 'tool:obsidian-mind',
    order: 6500,
    text: OBSIDIAN_MIND_GUIDANCE,
  })
}

/** Agent-scoped Cordis plugin exporting Obsidian-Mind startup briefing and tools. */
export default { name, inject, Config, apply }
