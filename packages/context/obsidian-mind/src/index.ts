/**
 * Built-in Obsidian-Mind service: manages the standalone `$DSH_HOME/obsidian-mind`
 * knowledge vault (plus optional companion vaults) and records session prompts
 * and turn outcomes automatically.
 *
 * @module @deepseek-ai/dsh-obsidian-mind
 */

import { statSync } from 'node:fs'
import { Context, Service, type Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-working-directory'
import './types.ts'
import type {
  ObsidianMindInspectResult,
  ObsidianMindRecallHit,
  ObsidianMindRecordInput,
  ObsidianMindRecordResult,
  ObsidianMindStatus,
} from './types.ts'
import {
  ensureVaultInitialized,
  inspectProjectInVaults,
  listAllProjects,
  projectIdentity,
  recallFromVaults,
  recordToVault,
  resolveVaultLocations,
} from './vault.ts'

export * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Built-in Obsidian-Mind vault service and session memory recorder. */
    obsidianMind: ObsidianMindService
  }
}

/** Configuration for the built-in Obsidian-Mind host service. */
export interface Config {
  /** Primary writable Obsidian vault directory; defaults to `$DSH_HOME/obsidian-mind`. */
  vaultPath?: string
  /** Optional read-only companion Obsidian vault directories searched alongside the primary vault. */
  extraReadVaults?: string[]
  /** Create the default built-in vault layout on startup when absent. Defaults to true. */
  autoInitialize?: boolean
  /** Automatically record human prompts and turn outcomes into the primary vault. Defaults to true. */
  autoRecord?: boolean
  /** Maximum characters included in automatic startup session briefings. Defaults to 12000. */
  maxBriefingChars?: number
}

interface RuntimeConfig {
  vaultPath: Volatile<string | undefined>
  extraReadVaults: Volatile<string[] | undefined>
  autoInitialize: Volatile<boolean>
  autoRecord: Volatile<boolean>
  maxBriefingChars: Volatile<number>
}

/** Schemastery validation for {@link Config}. */
export const Config = z.object({
  vaultPath: z.string().volatile(),
  extraReadVaults: z.array(z.string()).volatile(),
  autoInitialize: z.boolean().default(true).volatile(),
  autoRecord: z.boolean().default(true).volatile(),
  maxBriefingChars: z.number().step(1).min(500).max(100_000).default(12_000).volatile(),
})

function isHumanPromptSource(kind: string): boolean {
  return kind === 'user' || kind === 'user-rpc'
}

function extractPromptText(content: readonly { readonly type: string; readonly text?: string }[]): string {
  return content
    .filter((block): block is { readonly type: 'text'; readonly text: string } =>
      block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

/**
 * Host service owning the built-in Obsidian-Mind vault, project briefings,
 * keyword recall, structured writes, and automatic session event logging.
 */
export class ObsidianMindService extends Service {
  static readonly Config = Config

  private writeQueue: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(ctx: Context, private readonly config: RuntimeConfig) {
    super(ctx, 'obsidianMind')
  }

  /** Initialize the primary vault when configured and attach live session recording. */
  protected async [Service.init](): Promise<void> {
    const { primaryVault } = this.locations()
    if (this.shouldAutoInitialize()) {
      await ensureVaultInitialized(primaryVault)
    }

    this.ctx.on('session/event', (session, event) => {
      this.handleSessionEvent(session, event)
    })

    this.ctx.effect(() => () => {
      this.disposed = true
      return this.writeQueue.catch((error: unknown) => {
        this.ctx.logger.warn('obsidian-mind write drain failed during shutdown: %s', String(error))
      })
    }, 'obsidian-mind.drain')
  }

  private shouldAutoInitialize(): boolean {
    return this.config.autoInitialize.get()
  }

  private shouldAutoRecord(): boolean {
    return this.config.autoRecord.get()
  }

  private maxBriefingChars(): number {
    return this.config.maxBriefingChars.get()
  }

  /** Resolve current primary and companion vault paths from config and environment.
   * @returns Primary writable vault root and companion read-only vaults.
   */
  locations(): { primaryVault: string; extraReadVaults: string[] } {
    return resolveVaultLocations(
      this.config.vaultPath.get(),
      this.config.extraReadVaults.get(),
    )
  }

  /** Enqueue one serialized mutation against the primary vault. */
  private enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(task)
    this.writeQueue = run.then(() => undefined, () => undefined)
    return run
  }

  private sessionWorkspace(session: Session): string | undefined {
    const workingDir = this.ctx.get('workingDirectory')
    return workingDir?.get(session) ?? session.header.cwd
  }

  private handleSessionEvent(session: Session, event: SessionEvent): void {
    if (this.disposed || !this.shouldAutoRecord()) return
    if (session.header.origin === 'subagent') return

    if (event.type === 'user/message') {
      if (!isHumanPromptSource(event.data.source.kind)) return
      const promptText = extractPromptText(event.data.content).trim()
      if (promptText.length === 0) return
      const workspacePath = this.sessionWorkspace(session)
      const { primaryVault } = this.locations()
      void this.enqueueWrite(() =>
        recordToVault(primaryVault, {
          kind: 'prompt',
          title: `Prompt (Session ${session.id.slice(0, 8)})`,
          content: promptText,
          ...workspacePath === undefined ? {} : { workspacePath },
        }),
      ).catch((error: unknown) => {
        this.ctx.logger.warn('obsidian-mind failed to record user prompt: %s', String(error))
      })
      return
    }

    if (event.type === 'turn/end' && event.data.reason.kind !== 'completed') {
      const workspacePath = this.sessionWorkspace(session)
      const { primaryVault } = this.locations()
      void this.enqueueWrite(() =>
        recordToVault(primaryVault, {
          kind: 'project-log',
          title: `Turn ${event.data.turn} ended (${event.data.reason.kind})`,
          content: `Session \`${session.id}\` turn ${event.data.turn} settled with reason \`${event.data.reason.kind}\`.`,
          ...workspacePath === undefined ? {} : { workspacePath },
        }),
      ).catch((error: unknown) => {
        this.ctx.logger.warn('obsidian-mind failed to record turn end: %s', String(error))
      })
    }
  }

  /** Wait until all pending automatic vault writes finish.
   * @returns Settlement of the serialized write queue.
   */
  async flush(): Promise<void> {
    await this.writeQueue
  }

  /** Inspect active vault paths, initialized state, and tracked projects.
   * @param workspaceOrProject - Optional workspace path or project name to match.
   * @returns Status snapshot across primary and companion vaults.
   */
  async status(workspaceOrProject?: string): Promise<ObsidianMindStatus> {
    const { primaryVault, extraReadVaults } = this.locations()
    let initialized = false
    try {
      initialized = statSync(primaryVault).isDirectory()
    } catch (error) {
      // Uninitialized vault paths report initialized: false rather than throwing.
      void error
    }
    const projects = await listAllProjects(primaryVault, extraReadVaults)
    let currentProject: ObsidianMindStatus['currentProject']
    if (workspaceOrProject !== undefined && workspaceOrProject.trim().length > 0) {
      const targetSlug = projectIdentity(workspaceOrProject).slug.toLowerCase()
      currentProject = projects.find(item => item.slug.toLowerCase() === targetSlug)
    }
    return {
      primaryVault,
      extraReadVaults,
      initialized,
      projects,
      ...currentProject === undefined ? {} : { currentProject },
    }
  }

  /** Build a bounded project memory briefing for the active workspace.
   * @param workspaceOrProject - Workspace directory or project name.
   * @param maxChars - Optional character ceiling override.
   * @returns Project briefing and vault match flags.
   */
  async inspectProject(workspaceOrProject: string, maxChars?: number): Promise<ObsidianMindInspectResult> {
    await this.writeQueue
    const { primaryVault, extraReadVaults } = this.locations()
    return inspectProjectInVaults(
      primaryVault,
      extraReadVaults,
      workspaceOrProject,
      maxChars ?? this.maxBriefingChars(),
    )
  }

  /** Search notes, logs, memories, decisions, and gotchas across all configured vaults.
   * @param query - Search keywords.
   * @param projectHint - Optional project name used to prioritize matching files.
   * @param limit - Maximum number of hits to return.
   * @returns Ranked matching snippets.
   */
  async recall(query: string, projectHint?: string, limit: number = 10): Promise<ObsidianMindRecallHit[]> {
    await this.writeQueue
    const { primaryVault, extraReadVaults } = this.locations()
    return recallFromVaults([primaryVault, ...extraReadVaults], query, projectHint, limit)
  }

  /** Persist a durable memory, decision, pattern, gotcha, or log entry into the primary vault.
   * @param input - Structured entry payload.
   * @returns Saved file paths inside the primary vault.
   */
  async record(input: ObsidianMindRecordInput): Promise<ObsidianMindRecordResult> {
    const { primaryVault } = this.locations()
    return this.enqueueWrite(() => recordToVault(primaryVault, input))
  }
}

export default ObsidianMindService
