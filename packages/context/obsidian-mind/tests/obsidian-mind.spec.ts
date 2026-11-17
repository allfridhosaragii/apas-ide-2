import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, type ContentBlock, type ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { type Session, type SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolsService, { type ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import WorkingDirectoryService from '@deepseek-ai/dsh-working-directory'
import ObsidianMindService from '@deepseek-ai/dsh-obsidian-mind'
import * as obsidianMindAgent from '@deepseek-ai/dsh-obsidian-mind/agent'

const tempDirs: string[] = []
const originalDshHome = process.env['DSH_HOME']
const originalVaultEnv = process.env['DSH_OBSIDIAN_MIND_VAULT']
const originalExtraEnv = process.env['DSH_OBSIDIAN_MIND_EXTRA_VAULTS']

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  if (originalDshHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = originalDshHome
  if (originalVaultEnv === undefined) delete process.env['DSH_OBSIDIAN_MIND_VAULT']
  else process.env['DSH_OBSIDIAN_MIND_VAULT'] = originalVaultEnv
  if (originalExtraEnv === undefined) delete process.env['DSH_OBSIDIAN_MIND_EXTRA_VAULTS']
  else process.env['DSH_OBSIDIAN_MIND_EXTRA_VAULTS'] = originalExtraEnv
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

function fakeAgent(session: Session): Agent {
  return {
    id: session.id,
    options: {},
    session,
    model: unsupportedModel(),
    inbox: unsupportedInbox(),
    status: 'running',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel: () => {},
    whenIdle: async () => {},
    runMaintenance: <T>(task: (signal: AbortSignal) => Promise<T>) => task(new AbortController().signal),
  }
}

async function mountFullHarness(options: {
  vaultPath?: string
  extraReadVaults?: string[]
  autoRecord?: boolean
} = {}) {
  const ctx = new Context()
  await ctx.plugin(FsLocal)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(WorkingDirectoryService)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ToolsService)
  await ctx.plugin(ObsidianMindService, {
    ...options.vaultPath === undefined ? {} : { vaultPath: options.vaultPath },
    ...options.extraReadVaults === undefined ? {} : { extraReadVaults: options.extraReadVaults },
    ...options.autoRecord === undefined ? {} : { autoRecord: options.autoRecord },
  })
  await ctx.plugin(obsidianMindAgent)
  return ctx
}

describe('dsh-obsidian-mind', () => {
  it('initializes its own standalone vault under $DSH_HOME/obsidian-mind by default', async () => {
    const dshHome = makeTempDir('dsh-home-')
    process.env['DSH_HOME'] = dshHome

    const ctx = await mountFullHarness()
    try {
      const expectedVault = join(dshHome, 'obsidian-mind')
      const status = await ctx.obsidianMind.status()
      expect(status.primaryVault).toBe(expectedVault)
      expect(status.initialized).toBe(true)
      expect(existsSync(join(expectedVault, 'brain', 'Master_Brain.canvas'))).toBe(true)
      expect(existsSync(join(expectedVault, 'brain', 'Otak_Utama.md'))).toBe(true)
      expect(existsSync(join(expectedVault, 'brain', 'Memories.md'))).toBe(true)
      expect(existsSync(join(expectedVault, 'brain', 'Key Decisions.md'))).toBe(true)
      expect(existsSync(join(expectedVault, 'brain', 'Gotchas.md'))).toBe(true)
      expect(existsSync(join(expectedVault, 'brain', 'Patterns.md'))).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('records prompts and decisions, rebuilds Master_Brain.canvas, and searches across primary + extra vaults', async () => {
    const primary = makeTempDir('om-primary-')
    const external = makeTempDir('om-external-')
    mkdirSync(join(external, 'brain', 'logs'), { recursive: true })
    writeFileSync(
      join(external, 'brain', 'logs', 'Alpha_Bot_History.md'),
      '# Alpha Bot\n\n- Decision: Always validate lot step before placing order.\n',
      'utf8',
    )

    const ctx = await mountFullHarness({
      vaultPath: primary,
      extraReadVaults: [external],
      autoRecord: false,
    })
    try {
      await ctx.obsidianMind.record({
        kind: 'prompt',
        project: 'APAS IDE',
        title: 'Prompt 1',
        content: 'Build standalone Obsidian Mind inside DeepSeek Harness',
      })
      await ctx.obsidianMind.record({
        kind: 'decision',
        project: 'APAS IDE',
        title: 'Default standalone vault',
        content: 'Store default brain in $DSH_HOME/obsidian-mind with optional external read vaults.',
      })

      const canvas = JSON.parse(
        readFileSync(join(primary, 'brain', 'Master_Brain.canvas'), 'utf8'),
      ) as { nodes: Array<{ text: string }>; edges: Array<{ id: string }> }
      expect(canvas.nodes.some(node => node.text.includes('APAS IDE'))).toBe(true)
      expect(canvas.nodes.some(node => node.text.includes('Build standalone Obsidian Mind'))).toBe(true)
      expect(canvas.edges.length).toBeGreaterThanOrEqual(2)

      const inspection = await ctx.obsidianMind.inspectProject('/work/Alpha_Bot')
      expect(inspection.foundInVault).toBe(true)
      expect(inspection.summary).toContain('validate lot step')

      const hits = await ctx.obsidianMind.recall('lot step', 'Alpha_Bot')
      expect(hits.length).toBeGreaterThan(0)
      expect(hits[0]?.vaultPath).toBe(external)

      // External read-only vault must remain untouched by writes to primary.
      expect(existsSync(join(external, 'brain', 'Master_Brain.canvas'))).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('automatically logs human session prompts and injects project briefing once on pre-step', async () => {
    const primary = makeTempDir('om-auto-')
    const workspace = makeTempDir('project-mt5-')
    const ctx = await mountFullHarness({ vaultPath: primary })
    try {
      // Seed prior decision so the vault has content on session start.
      await ctx.obsidianMind.record({
        kind: 'gotcha',
        workspacePath: workspace,
        title: 'Windows rename lock',
        content: 'Always use atomic write retries on Windows.',
      })

      const sid = brandString<SessionId>('sess-1')
      const session = ctx.sessions.create(sid, { meta: { cwd: workspace } })
      const agent = fakeAgent(session)
      const events = agentEvents(ctx, agent)
      const signal = new AbortController().signal

      const humanMsg = createUserMessage({
        content: [{ type: 'text', text: 'Check why Windows sandbox failed' }],
        source: { kind: 'user' },
      })

      // Step 1 pre-step should prepend the Obsidian-Mind briefing.
      const decision1 = await events.waterfall(
        'agent/pre-step',
        { messages: [humanMsg], turn: 1, step: 1, signal, modelSelection: { provider: 'deepseek-official', model: 'deepseek-flash' } },
        async () => ({ kind: 'enter' as const, messages: [humanMsg] }),
      )
      expect(decision1.kind).toBe('enter')
      if (decision1.kind !== 'enter') throw new Error('expected enter')
      expect(decision1.messages).toHaveLength(2)
      expect(decision1.messages[0]?.source.kind).toBe('obsidian-mind')
      const injectedText = (decision1.messages[0]?.content[0] as Extract<ContentBlock, { type: 'text' }>).text
      expect(injectedText).toContain('Windows rename lock')

      // Commit those messages to the session log; auto-record logs only humanMsg (not briefing).
      for (const msg of decision1.messages) {
        session.append('user/message', msg, { surfaceOp: 'append' })
      }
      await ctx.obsidianMind.flush()

      // Second step in the same session should NOT inject a duplicate baseline.
      const followUp = createUserMessage({
        content: [{ type: 'text', text: 'Continue fixing it' }],
        source: { kind: 'user' },
      })
      const decision2 = await events.waterfall(
        'agent/pre-step',
        { messages: [followUp], turn: 2, step: 1, signal, modelSelection: { provider: 'deepseek-official', model: 'deepseek-flash' } },
        async () => ({ kind: 'enter' as const, messages: [followUp] }),
      )
      expect(decision2.kind).toBe('enter')
      if (decision2.kind !== 'enter') throw new Error('expected enter')
      expect(decision2.messages).toHaveLength(1)

      const statusAfter = await ctx.obsidianMind.status(workspace)
      expect(statusAfter.currentProject?.promptCount).toBe(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('stays silent on pre-step when the vault is completely empty and exposes model tools', async () => {
    const primary = makeTempDir('om-empty-')
    const workspace = makeTempDir('fresh-proj-')
    const ctx = await mountFullHarness({ vaultPath: primary })
    try {
      const sid = brandString<SessionId>('sess-empty')
      const session = ctx.sessions.create(sid, { meta: { cwd: workspace } })
      const agent = fakeAgent(session)
      const events = agentEvents(ctx, agent)
      const signal = new AbortController().signal

      const humanMsg = createUserMessage({
        content: [{ type: 'text', text: 'Hello' }],
        source: { kind: 'user' },
      })
      const decision = await events.waterfall(
        'agent/pre-step',
        { messages: [humanMsg], turn: 1, step: 1, signal, modelSelection: { provider: 'deepseek-official', model: 'deepseek-flash' } },
        async () => ({ kind: 'enter' as const, messages: [humanMsg] }),
      )
      expect(decision.kind).toBe('enter')
      if (decision.kind !== 'enter') throw new Error('expected enter')
      expect(decision.messages).toHaveLength(1)

      const recordTool = ctx.tools.get('obsidian_mind_record')
      const recallTool = ctx.tools.get('obsidian_mind_recall')
      const statusTool = ctx.tools.get('obsidian_mind_status')
      expect(recordTool).toBeDefined()
      expect(recallTool).toBeDefined()
      expect(statusTool).toBeDefined()

      const toolExec = {
        callId: brandString<ToolCallId>('call-1'),
        rootCallId: brandString<ToolCallId>('call-1'),
        name: 'obsidian_mind_record',
        agent,
        signal,
        token: Symbol('tok-1') as ToolExecutionToken,
        arguments: {},
        deferContext: () => {},
        concludeTurn: () => {},
      }
      await recordTool!.execute(
        { kind: 'pattern', title: 'Tool write', content: 'Prefer atomic rename on Windows.' },
        toolExec,
      )
      const recalled = await recallTool!.execute({ query: 'atomic rename' }, toolExec) as { count: number }
      expect(recalled.count).toBeGreaterThan(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
