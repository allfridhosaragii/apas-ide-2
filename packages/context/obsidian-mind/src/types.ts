/**
 * Shared vocabulary and message-source declarations for built-in Obsidian-Mind.
 * @module @deepseek-ai/dsh-obsidian-mind/types
 */

import type { ContextFormed } from '@deepseek-ai/dsh-llm'

/** Durable producer metadata attached to automatic Obsidian-Mind context injections. */
export type ObsidianMindSource = {
  kind: 'obsidian-mind'
  /** Normalized project identifier inspected for the session. */
  project: string
  /** Primary vault root used when composing the briefing. */
  vaultPath: string
} & ContextFormed

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'obsidian-mind': ObsidianMindSource
  }
}

/** Category of durable knowledge written into the Obsidian-Mind vault. */
export type ObsidianMindRecordKind =
  | 'memory'
  | 'pattern'
  | 'decision'
  | 'gotcha'
  | 'project-log'
  | 'prompt'

/** One project discovered across the configured Obsidian-Mind vault(s). */
export interface ObsidianMindProjectSummary {
  /** Human-readable project name. */
  name: string
  /** Filesystem-safe project slug used for logs and project notes. */
  slug: string
  /** Absolute path to the vault holding this project's records. */
  vaultPath: string
  /** Number of recorded prompts or log entries found for this project. */
  promptCount: number
  /** Whether a dedicated project history log exists. */
  hasHistoryLog: boolean
}

/** Snapshot returned by {@link ObsidianMindService.status}. */
export interface ObsidianMindStatus {
  /** Active primary writable vault directory. */
  primaryVault: string
  /** Optional read-only companion vaults searched alongside the primary vault. */
  extraReadVaults: string[]
  /** Whether the primary vault directory has been initialized on disk. */
  initialized: boolean
  /** All projects tracked across primary and companion vaults. */
  projects: ObsidianMindProjectSummary[]
  /** Current project matched for the requested workspace, when supplied. */
  currentProject?: ObsidianMindProjectSummary
}

/** Project briefing assembled for session startup or explicit inspection. */
export interface ObsidianMindInspectResult {
  /** Display name derived from the workspace or explicit project name. */
  projectName: string
  /** Slug used in log and project filenames. */
  projectSlug: string
  /** Primary vault path. */
  primaryVault: string
  /** Whether any matching project log, project note, or canvas node was found. */
  foundInVault: boolean
  /** Whether the vault(s) hold any meaningful user content (projects or notes). */
  hasVaultContent: boolean
  /** Rendered markdown summary bounded to the configured character budget. */
  summary: string
  /** Known projects across all active vaults. */
  knownProjects: readonly string[]
}

/** One search match returned by {@link ObsidianMindService.recall}. */
export interface ObsidianMindRecallHit {
  /** Vault directory owning the matched file. */
  vaultPath: string
  /** Relative path within the vault (e.g. `brain/logs/APAS_IDE_History.md`). */
  relativePath: string
  /** 1-based line number of the first matching line, or 1 for whole-file matches. */
  line: number
  /** Bounded excerpt around the match. */
  excerpt: string
  /** Simple relevance score (higher is more relevant). */
  score: number
}

/** Input payload for {@link ObsidianMindService.record}. */
export interface ObsidianMindRecordInput {
  /** Kind of entry to persist. */
  kind: ObsidianMindRecordKind
  /** Short title or topic heading. */
  title: string
  /** Markdown body text to append. */
  content: string
  /** Optional project name (inferred from workspace if omitted). */
  project?: string
  /** Optional workspace path used to derive the project name. */
  workspacePath?: string
  /** Optional timestamp override (defaults to current ISO timestamp). */
  timestamp?: string
}

/** Result returned after committing a record to the primary vault. */
export interface ObsidianMindRecordResult {
  /** Relative path of the updated primary note inside the vault. */
  relativePath: string
  /** Absolute path to the updated primary note. */
  absolutePath: string
  /** Project slug associated with the entry. */
  projectSlug: string
}
