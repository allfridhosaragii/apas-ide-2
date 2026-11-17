/**
 * Filesystem operations, search, briefing assembly, and JSON Canvas builder for Obsidian-Mind vaults.
 * @module @deepseek-ai/dsh-obsidian-mind/vault
 */

import { appendFile, mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { basename, delimiter, dirname, join, relative, resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type {
  ObsidianMindInspectResult,
  ObsidianMindProjectSummary,
  ObsidianMindRecallHit,
  ObsidianMindRecordInput,
  ObsidianMindRecordKind,
  ObsidianMindRecordResult,
} from './types.ts'

const MAX_READ_BYTES = 262_144
const MAX_PROMPT_NOTES_PER_PROJECT = 40
const VAULT_FILE_MODE = 0o600
const VAULT_DIR_MODE = 0o700

const BRAIN_ROOT_FILES: Readonly<Record<string, string>> = {
  'Otak_Utama.md': '# 🧠 Otak Utama\n\nPusat kendali semua proyek dan riwayat sesi DeepSeek Harness.\n\n## Proyek\n\n> *Belum ada proyek tercatat.*\n',
  'Memories.md': '# Memories\n\nCatatan ingatan jangka panjang lintas proyek.\n',
  'Patterns.md': '# Patterns\n\nPola arsitektur dan konvensi kode yang berhasil.\n',
  'Key Decisions.md': '# Key Decisions\n\nKeputusan desain dan arsitektur penting.\n',
  'Gotchas.md': '# Gotchas\n\nBug, jebakan, dan catatan penting yang harus dihindari.\n',
  'logs/AI_CHAT_History.md': '# AI Chat & Prompt History\n\n> *Semua prompt dan ringkasan sesi otomatis tercatat di sini.*\n',
}

interface CanvasNode {
  id: string
  type: 'text'
  text: string
  x: number
  y: number
  width: number
  height: number
  color: string
}

interface CanvasEdge {
  id: string
  fromNode: string
  fromSide: 'right'
  toNode: string
  toSide: 'left'
}

/** Resolve primary writable vault path and optional read-only companion vaults.
 * @param configuredPrimary - Optional primary vault override from plugin config.
 * @param configuredExtras - Optional companion vault overrides from plugin config.
 * @returns Normalized absolute paths for primary and companion vaults.
 */
export function resolveVaultLocations(
  configuredPrimary?: string,
  configuredExtras?: readonly string[],
): { primaryVault: string; extraReadVaults: string[] } {
  const envPrimary = process.env.DSH_OBSIDIAN_MIND_VAULT?.trim()
  const rawPrimary = configuredPrimary?.trim() || envPrimary || dshHomePath('obsidian-mind')
  const primaryVault = resolve(rawPrimary)

  const rawExtras: string[] = []
  if (configuredExtras !== undefined) {
    for (const item of configuredExtras) {
      const trimmed = item.trim()
      if (trimmed.length > 0) rawExtras.push(trimmed)
    }
  }
  const envExtras = process.env.DSH_OBSIDIAN_MIND_EXTRA_VAULTS?.trim()
  if (envExtras) {
    for (const part of envExtras.split(delimiter)) {
      const trimmed = part.trim()
      if (trimmed.length > 0) rawExtras.push(trimmed)
    }
  }

  const seen = new Set<string>([primaryVault.toLowerCase()])
  const extraReadVaults: string[] = []
  for (const candidate of rawExtras) {
    const resolvedPath = resolve(candidate)
    const key = resolvedPath.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    extraReadVaults.push(resolvedPath)
  }
  return { primaryVault, extraReadVaults }
}

/** Normalize a workspace path or project name into display and filesystem-safe slug forms.
 * @param input - Workspace directory path or explicit project name.
 * @returns Display label and filesystem-safe slug.
 */
export function projectIdentity(input: string): { name: string; slug: string } {
  const trimmed = input.trim()
  const base = trimmed.includes('/') || trimmed.includes('\\')
    ? basename(resolve(trimmed))
    : trimmed
  const name = base.length > 0 ? base : 'Workspace'
  const slug = name.replaceAll(/[^A-Za-z0-9._-]+/g, '_').replaceAll(/^_+|_+$/g, '') || 'Workspace'
  return { name, slug }
}

function normalizeMatchKey(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]+/g, '')
}

async function readTextBounded(filePath: string, maxBytes = MAX_READ_BYTES, fromTail = false): Promise<string | undefined> {
  let info
  try {
    info = await stat(filePath)
  } catch (error) {
    // Missing or inaccessible vault files simply yield undefined to callers.
    void error
    return undefined
  }
  if (!info.isFile()) return undefined
  try {
    const raw = await readFile(filePath, 'utf8')
    if (raw.length <= maxBytes) return raw
    return fromTail
      ? `...(truncated older entries)...\n${raw.slice(-maxBytes)}`
      : `${raw.slice(0, maxBytes)}\n...(truncated)...`
  } catch (error) {
    // Unreadable files are skipped without crashing session startup.
    void error
    return undefined
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch (error) {
    // Absent target paths indicate initialization or creation is needed.
    void error
    return false
  }
}

/** Create the default built-in Obsidian-Mind directory layout if absent, preserving existing files.
 * @param vaultRoot - Primary vault root directory.
 */
export async function ensureVaultInitialized(vaultRoot: string): Promise<void> {
  const brainDir = join(vaultRoot, 'brain')
  await mkdir(join(brainDir, 'logs'), { recursive: true, mode: VAULT_DIR_MODE })
  await mkdir(join(brainDir, 'projects'), { recursive: true, mode: VAULT_DIR_MODE })

  for (const [relPath, initialContent] of Object.entries(BRAIN_ROOT_FILES)) {
    const fullPath = join(brainDir, relPath)
    if (!(await fileExists(fullPath))) {
      await writeFileAtomic(fullPath, initialContent, { mode: VAULT_FILE_MODE, dirMode: VAULT_DIR_MODE })
    }
  }

  const canvasPath = join(brainDir, 'Master_Brain.canvas')
  if (!(await fileExists(canvasPath))) {
    const emptyCanvas = buildMasterCanvasData(new Map())
    await writeFileAtomic(canvasPath, JSON.stringify(emptyCanvas, null, 2), { mode: VAULT_FILE_MODE, dirMode: VAULT_DIR_MODE })
  }
}

/** Collect project summaries from a vault's `brain/` directory. */
async function collectVaultProjects(vaultRoot: string): Promise<ObsidianMindProjectSummary[]> {
  const brainDir = join(vaultRoot, 'brain')
  const logsDir = join(brainDir, 'logs')
  const projectsDir = join(brainDir, 'projects')
  const byKey = new Map<string, ObsidianMindProjectSummary>()

  const upsert = (rawName: string, update: Partial<ObsidianMindProjectSummary>): void => {
    const id = projectIdentity(rawName)
    const key = normalizeMatchKey(id.slug)
    const existing = byKey.get(key)
    if (existing === undefined) {
      byKey.set(key, {
        name: id.name.replaceAll('_', ' '),
        slug: id.slug,
        vaultPath: vaultRoot,
        promptCount: update.promptCount ?? 0,
        hasHistoryLog: update.hasHistoryLog ?? false,
      })
      return
    }
    byKey.set(key, {
      ...existing,
      promptCount: Math.max(existing.promptCount, update.promptCount ?? 0),
      hasHistoryLog: existing.hasHistoryLog || (update.hasHistoryLog ?? false),
    })
  }

  try {
    const logEntries = await readdir(logsDir, { withFileTypes: true })
    for (const entry of logEntries) {
      if (!entry.isFile()) continue
      if (entry.name === 'AI_CHAT_History.md') continue
      if (entry.name.endsWith('_History.md')) {
        const proj = entry.name.slice(0, -'_History.md'.length)
        upsert(proj, { hasHistoryLog: true })
      }
    }
  } catch (error) {
    // Missing logs directory simply contributes no log-based projects.
    void error
  }

  try {
    const projectEntries = await readdir(projectsDir, { withFileTypes: true })
    const promptCounts = new Map<string, number>()
    for (const entry of projectEntries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const match = /^prompt_(.+)_(\d+)\.md$/.exec(entry.name)
      if (match?.[1]) {
        const key = normalizeMatchKey(match[1])
        promptCounts.set(key, (promptCounts.get(key) ?? 0) + 1)
      } else {
        const proj = entry.name.slice(0, -'.md'.length)
        upsert(proj, {})
      }
    }
    for (const [key, count] of promptCounts.entries()) {
      const existing = byKey.get(key)
      if (existing) {
        byKey.set(key, { ...existing, promptCount: Math.max(existing.promptCount, count) })
      }
    }
  } catch (error) {
    // Missing projects directory simply contributes no note-based projects.
    void error
  }

  const canvasRaw = await readTextBounded(join(brainDir, 'Master_Brain.canvas'), MAX_READ_BYTES)
  if (canvasRaw !== undefined) {
    try {
      const parsed = JSON.parse(canvasRaw) as { nodes?: Array<{ id?: unknown; text?: unknown }> }
      for (const node of parsed.nodes ?? []) {
        if (typeof node.text !== 'string') continue
        const firstLine = node.text.split(/\r?\n/, 1)[0] ?? ''
        const heading = firstLine.replace(/^#+\s*(?:📂\s*)?/, '').trim()
        if (firstLine.includes('📂') && heading.length > 0) {
          upsert(heading, {})
        }
      }
    } catch (error) {
      // Malformed user-edited canvas JSON is ignored during discovery.
      void error
    }
  }

  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Collect deduplicated project summaries across primary and companion vaults.
 * @param primaryVault - Primary writable vault root.
 * @param extraReadVaults - Read-only companion vaults.
 * @returns Sorted project summaries.
 */
export async function listAllProjects(
  primaryVault: string,
  extraReadVaults: readonly string[],
): Promise<ObsidianMindProjectSummary[]> {
  const merged = new Map<string, ObsidianMindProjectSummary>()
  for (const vault of [primaryVault, ...extraReadVaults]) {
    const items = await collectVaultProjects(vault)
    for (const item of items) {
      const key = normalizeMatchKey(item.slug)
      const prev = merged.get(key)
      if (prev === undefined) {
        merged.set(key, item)
      } else {
        merged.set(key, {
          ...prev,
          promptCount: Math.max(prev.promptCount, item.promptCount),
          hasHistoryLog: prev.hasHistoryLog || item.hasHistoryLog,
        })
      }
    }
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function isNonTemplateCoreNote(content: string | undefined, fileName: string): boolean {
  if (content === undefined) return false
  const template = BRAIN_ROOT_FILES[fileName]
  if (template !== undefined && content.trim() === template.trim()) return false
  const lines = content.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0 && !line.startsWith('#') && !line.startsWith('> *'))
  return lines.length > 0
}

async function findMatchingProjectFiles(
  vaultRoot: string,
  projectName: string,
): Promise<{ historyText?: string; historyPath?: string; projectNoteText?: string; projectNotePath?: string }> {
  const brainDir = join(vaultRoot, 'brain')
  const targetKey = normalizeMatchKey(projectName)
  let historyText: string | undefined
  let historyPath: string | undefined
  let projectNoteText: string | undefined
  let projectNotePath: string | undefined

  try {
    const logs = await readdir(join(brainDir, 'logs'), { withFileTypes: true })
    for (const entry of logs) {
      if (!entry.isFile() || !entry.name.endsWith('_History.md') || entry.name === 'AI_CHAT_History.md') continue
      const candidateName = entry.name.slice(0, -'_History.md'.length)
      if (normalizeMatchKey(candidateName) === targetKey) {
        historyPath = join('brain', 'logs', entry.name).replaceAll('\\', '/')
        historyText = await readTextBounded(join(brainDir, 'logs', entry.name), 16_384, true)
        break
      }
    }
  } catch (error) {
    // Missing logs directory means no matching history log in this vault.
    void error
  }

  try {
    const notes = await readdir(join(brainDir, 'projects'), { withFileTypes: true })
    for (const entry of notes) {
      if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.startsWith('prompt_')) continue
      const candidateName = entry.name.slice(0, -'.md'.length)
      if (normalizeMatchKey(candidateName) === targetKey) {
        projectNotePath = join('brain', 'projects', entry.name).replaceAll('\\', '/')
        projectNoteText = await readTextBounded(join(brainDir, 'projects', entry.name), 8_192, false)
        break
      }
    }
  } catch (error) {
    // Missing projects directory means no matching project note in this vault.
    void error
  }

  return {
    ...historyText === undefined ? {} : { historyText },
    ...historyPath === undefined ? {} : { historyPath },
    ...projectNoteText === undefined ? {} : { projectNoteText },
    ...projectNotePath === undefined ? {} : { projectNotePath },
  }
}

/** Assemble a bounded startup briefing for the active project from primary and companion vaults.
 * @param primaryVault - Primary writable vault root.
 * @param extraReadVaults - Read-only companion vaults.
 * @param workspaceOrProject - Workspace path or project display name.
 * @param maxChars - Maximum character budget for the rendered summary.
 * @returns Project match details and bounded markdown briefing.
 */
export async function inspectProjectInVaults(
  primaryVault: string,
  extraReadVaults: readonly string[],
  workspaceOrProject: string,
  maxChars = 12_000,
): Promise<ObsidianMindInspectResult> {
  const { name: projectName, slug: projectSlug } = projectIdentity(workspaceOrProject)
  const vaults = [primaryVault, ...extraReadVaults]
  const projects = await listAllProjects(primaryVault, extraReadVaults)
  const knownProjects = projects.map(item => item.name)
  const sections: string[] = []
  let foundInVault = false
  let hasNonTemplateNotes = false

  for (const vault of vaults) {
    const matched = await findMatchingProjectFiles(vault, projectName)
    if (matched.historyText !== undefined) {
      foundInVault = true
      sections.push(`### Project History (${vault}/${matched.historyPath})\n${matched.historyText.trim()}`)
    }
    if (matched.projectNoteText !== undefined) {
      foundInVault = true
      sections.push(`### Project Hub (${vault}/${matched.projectNotePath})\n${matched.projectNoteText.trim()}`)
    }
  }

  for (const coreFile of ['Key Decisions.md', 'Gotchas.md', 'Memories.md', 'Patterns.md'] as const) {
    for (const vault of vaults) {
      const content = await readTextBounded(join(vault, 'brain', coreFile), 4_096, true)
      if (isNonTemplateCoreNote(content, coreFile) && content !== undefined) {
        hasNonTemplateNotes = true
        sections.push(`### ${coreFile.slice(0, -3)} (${vault})\n${content.trim()}`)
      }
    }
  }

  const hasVaultContent = foundInVault || hasNonTemplateNotes || knownProjects.length > 0
  const headerLines = [
    `<obsidian-mind primary_vault="${primaryVault}" project="${projectName}" known_in_vault="${String(foundInVault)}">`,
    foundInVault
      ? `Obsidian-Mind found existing memory/history for project "${projectName}".`
      : `Project "${projectName}" does not yet have its own log in Obsidian-Mind.`,
  ]
  if (knownProjects.length > 0) {
    headerLines.push(`Known projects in Obsidian-Mind: ${knownProjects.slice(0, 25).join(', ')}`)
  }
  headerLines.push('Use `obsidian_mind_recall` for deeper search and `obsidian_mind_record` when a durable decision, pattern, or gotcha should be remembered across sessions.')

  let body = sections.join('\n\n')
  const overhead = headerLines.join('\n').length + '\n</obsidian-mind>'.length + 4
  const bodyBudget = Math.max(500, maxChars - overhead)
  if (body.length > bodyBudget) {
    body = `${body.slice(0, bodyBudget)}\n...(Obsidian-Mind briefing truncated; use obsidian_mind_recall for more)...`
  }

  const summary = body.length > 0
    ? `${headerLines.join('\n')}\n\n${body}\n</obsidian-mind>`
    : `${headerLines.join('\n')}\n</obsidian-mind>`

  return {
    projectName,
    projectSlug,
    primaryVault,
    foundInVault,
    hasVaultContent,
    summary,
    knownProjects,
  }
}

async function listBrainMarkdownFiles(dir: string, out: string[]): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    // Missing brain subdirectories produce no search targets.
    void error
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await listBrainMarkdownFiles(full, out)
    } else if (entry.isFile() && (entry.name.endsWith('.md') || entry.name.endsWith('.canvas'))) {
      out.push(full)
    }
  }
}

/** Search across `brain/` notes and canvases in all configured vaults.
 * @param vaults - Ordered vault roots to search.
 * @param query - Keywords to search for.
 * @param projectHint - Optional project name to boost matching files.
 * @param limit - Maximum number of hits to return.
 * @returns Ranked search matches.
 */
export async function recallFromVaults(
  vaults: readonly string[],
  query: string,
  projectHint?: string,
  limit: number = 10,
): Promise<ObsidianMindRecallHit[]> {
  const terms = query.toLowerCase().split(/\s+/).map(t => t.trim()).filter(t => t.length > 0)
  const hintKey = projectHint ? normalizeMatchKey(projectHint) : ''
  const hits: ObsidianMindRecallHit[] = []

  for (const vault of vaults) {
    const files: string[] = []
    await listBrainMarkdownFiles(join(vault, 'brain'), files)
    for (const file of files) {
      const content = await readTextBounded(file, MAX_READ_BYTES, true)
      if (content === undefined) continue
      const rel = relative(vault, file).replaceAll('\\', '/')
      const relLower = rel.toLowerCase()
      const lines = content.split(/\r?\n/)
      let bestLine = 1
      let bestScore = 0

      if (terms.length === 0) {
        bestScore = hintKey && normalizeMatchKey(rel).includes(hintKey) ? 10 : 1
      } else {
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i]
          if (line === undefined) continue
          const lineLower = line.toLowerCase()
          let lineScore = 0
          for (const term of terms) {
            if (lineLower.includes(term)) lineScore += 3
            else if (relLower.includes(term)) lineScore += 1
          }
          if (lineScore > bestScore) {
            bestScore = lineScore
            bestLine = i + 1
          }
        }
        if (bestScore === 0) {
          const wholeLower = content.toLowerCase()
          let docHits = 0
          for (const term of terms) {
            if (wholeLower.includes(term) || relLower.includes(term)) docHits += 1
          }
          if (docHits === 0) continue
          bestScore = docHits
        }
      }

      if (hintKey && normalizeMatchKey(rel).includes(hintKey)) {
        bestScore += 2
      }
      const start = Math.max(0, bestLine - 2)
      const end = Math.min(lines.length, bestLine + 4)
      const excerpt = lines.slice(start, end).join('\n').slice(0, 600)
      hits.push({
        vaultPath: vault,
        relativePath: rel,
        line: bestLine,
        excerpt,
        score: bestScore,
      })
    }
  }

  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, Math.max(1, Math.min(limit, 30)))
}

function buildMasterCanvasData(projectPrompts: ReadonlyMap<string, readonly string[]>): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const nodes: CanvasNode[] = [
    {
      id: 'main_brain',
      type: 'text',
      text: '# 🧠 OTAK UTAMA\n\nPusat Kendali Proyek & Memori DeepSeek Harness',
      x: -800,
      y: 0,
      width: 320,
      height: 120,
      color: '3',
    },
  ]
  const edges: CanvasEdge[] = []

  const entries = [...projectPrompts.entries()]
  if (entries.length === 0) {
    return { nodes, edges }
  }

  const promptH = 110
  const promptGap = 18
  const projH = 70
  const blockGap = 50
  const projX = -200
  const promptX = 280

  const projYMap = new Map<string, number>()
  let curY = 0
  for (const [projName, prompts] of entries) {
    const cnt = Math.max(1, prompts.length)
    const blockHeight = cnt * (promptH + promptGap) - promptGap
    projYMap.set(projName, curY + (blockHeight - projH) / 2)
    curY += blockHeight + blockGap
  }
  const totalH = curY - blockGap
  const offsetY = -Math.round(totalH / 2)

  let idx = 0
  for (const [projName, prompts] of entries) {
    const py = Math.round((projYMap.get(projName) ?? 0) + offsetY)
    const projNodeId = `proj_${idx}`
    const hasData = prompts.length > 0
    nodes.push({
      id: projNodeId,
      type: 'text',
      text: `## 📂 ${projName}`,
      x: projX,
      y: py,
      width: 300,
      height: projH,
      color: hasData ? '4' : '1',
    })
    edges.push({
      id: `edge_${idx}`,
      fromNode: 'main_brain',
      fromSide: 'right',
      toNode: projNodeId,
      toSide: 'left',
    })

    if (prompts.length === 0) {
      const nid = `prompt_${idx}_empty`
      nodes.push({
        id: nid,
        type: 'text',
        text: '### 💬 Belum ada riwayat\n\n> *(Menunggu prompt pertama pada proyek ini.)*',
        x: promptX,
        y: py,
        width: 380,
        height: promptH,
        color: '1',
      })
      edges.push({
        id: `edge_${idx}_empty`,
        fromNode: projNodeId,
        fromSide: 'right',
        toNode: nid,
        toSide: 'left',
      })
    } else {
      const blockHeight = prompts.length * (promptH + promptGap) - promptGap
      const startPY = Math.round(py + (projH - blockHeight) / 2)
      for (let i = 0; i < prompts.length; i += 1) {
        const pY = startPY + i * (promptH + promptGap)
        const nid = `prompt_${idx}_${i}`
        nodes.push({
          id: nid,
          type: 'text',
          text: `### 💬 Prompt\n\n> "${prompts[i]}"`,
          x: promptX,
          y: pY,
          width: 380,
          height: promptH,
          color: '6',
        })
        edges.push({
          id: `edge_${idx}_${i}`,
          fromNode: projNodeId,
          fromSide: 'right',
          toNode: nid,
          toSide: 'left',
        })
      }
    }
    idx += 1
  }

  return { nodes, edges }
}

async function readExistingProjectPrompts(vaultRoot: string): Promise<Map<string, string[]>> {
  const projectsDir = join(vaultRoot, 'brain', 'projects')
  const logsDir = join(vaultRoot, 'brain', 'logs')
  const result = new Map<string, string[]>()

  try {
    const logs = await readdir(logsDir, { withFileTypes: true })
    for (const entry of logs) {
      if (!entry.isFile() || !entry.name.endsWith('_History.md') || entry.name === 'AI_CHAT_History.md') continue
      const slug = entry.name.slice(0, -'_History.md'.length)
      if (!result.has(slug)) result.set(slug, [])
    }
  } catch (error) {
    // Missing logs dir yields no log projects.
    void error
  }

  try {
    const entries = await readdir(projectsDir, { withFileTypes: true })
    const numbered = new Map<string, Array<{ idx: number; text: string }>>()
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const match = /^prompt_(.+)_(\d+)\.md$/.exec(entry.name)
      if (match?.[1] && match[2]) {
        const slug = match[1]
        const raw = await readTextBounded(join(projectsDir, entry.name), 2048)
        const quoted = raw?.match(/^>\s*"?(.*?)"?\s*$/m)?.[1]?.trim() ?? ''
        if (quoted.length > 0) {
          const list = numbered.get(slug) ?? []
          list.push({ idx: Number(match[2]), text: quoted })
          numbered.set(slug, list)
        }
      } else {
        const slug = entry.name.slice(0, -'.md'.length)
        if (!result.has(slug)) result.set(slug, [])
      }
    }
    for (const [slug, items] of numbered.entries()) {
      items.sort((a, b) => a.idx - b.idx)
      result.set(slug, items.slice(-MAX_PROMPT_NOTES_PER_PROJECT).map(item => item.text))
    }
  } catch (error) {
    // Missing projects dir yields no prompt notes.
    void error
  }

  return result
}

async function rebuildNavigationAndCanvas(vaultRoot: string): Promise<void> {
  const brainDir = join(vaultRoot, 'brain')
  const map = await readExistingProjectPrompts(vaultRoot)
  const sorted = new Map([...map.entries()].sort((a, b) => a[0].localeCompare(b[0])))

  const links = [...sorted.keys()].map(slug => `- [[brain/projects/${slug}|${slug.replaceAll('_', ' ')}]]`)
  const otakContent = [
    '---',
    'tags: [otak-utama, index]',
    '---',
    '',
    '# 🧠 Otak Utama',
    '',
    'Pusat kendali semua proyek yang dikerjakan melalui DeepSeek Harness.',
    '',
    '## Proyek',
    '',
    links.length > 0 ? links.join('\n') : '> *Belum ada proyek tercatat.*',
    '',
  ].join('\n')
  await writeFileAtomic(join(brainDir, 'Otak_Utama.md'), otakContent, { mode: VAULT_FILE_MODE, dirMode: VAULT_DIR_MODE })

  const displayMap = new Map<string, readonly string[]>()
  for (const [slug, prompts] of sorted.entries()) {
    displayMap.set(slug.replaceAll('_', ' '), prompts)
  }
  const canvas = buildMasterCanvasData(displayMap)
  await writeFileAtomic(join(brainDir, 'Master_Brain.canvas'), JSON.stringify(canvas, null, 2), { mode: VAULT_FILE_MODE, dirMode: VAULT_DIR_MODE })
}

function targetFileForKind(kind: ObsidianMindRecordKind, projectSlug: string): string {
  switch (kind) {
    case 'memory':
      return 'brain/Memories.md'
    case 'pattern':
      return 'brain/Patterns.md'
    case 'decision':
      return 'brain/Key Decisions.md'
    case 'gotcha':
      return 'brain/Gotchas.md'
    case 'project-log':
    case 'prompt':
      return `brain/logs/${projectSlug}_History.md`
  }
}

/** Append a durable note, prompt, or project log into the primary Obsidian-Mind vault and refresh graphs.
 * @param vaultRoot - Primary writable vault root.
 * @param input - Structured entry to write.
 * @returns Location metadata for the updated file.
 */
export async function recordToVault(
  vaultRoot: string,
  input: ObsidianMindRecordInput,
): Promise<ObsidianMindRecordResult> {
  await ensureVaultInitialized(vaultRoot)
  const timestamp = input.timestamp ?? new Date().toISOString()
  const projectSource = input.project?.trim() || input.workspacePath?.trim() || 'General'
  const { name: projectName, slug: projectSlug } = projectIdentity(projectSource)
  const relPath = targetFileForKind(input.kind, projectSlug)
  const absPath = join(vaultRoot, relPath)
  await mkdir(dirname(absPath), { recursive: true, mode: VAULT_DIR_MODE })

  if ((input.kind === 'project-log' || input.kind === 'prompt') && !(await fileExists(absPath))) {
    const header = `# ${projectName} - AI History\n\n> *Riwayat prompt, keputusan, dan aktivitas proyek ${projectName}.*\n\n`
    await writeFileAtomic(absPath, header, { mode: VAULT_FILE_MODE, dirMode: VAULT_DIR_MODE })
  }

  const block = [
    '',
    `## [${timestamp}] ${input.title.trim()}`,
    input.kind === 'memory' || input.kind === 'pattern' || input.kind === 'decision' || input.kind === 'gotcha'
      ? `- **Proyek:** [[brain/projects/${projectSlug}|${projectName}]]`
      : undefined,
    '',
    input.content.trim(),
    '',
  ].filter((line): line is string => line !== undefined).join('\n')

  await appendFile(absPath, block, { encoding: 'utf8', mode: VAULT_FILE_MODE })

  if (input.kind === 'prompt' || input.kind === 'project-log') {
    const globalLogPath = join(vaultRoot, 'brain', 'logs', 'AI_CHAT_History.md')
    const globalLine = `\n- **[${timestamp}] [${projectName}]** ${input.title.trim()}: ${input.content.trim().replaceAll(/\s+/g, ' ').slice(0, 240)}\n`
    await appendFile(globalLogPath, globalLine, { encoding: 'utf8', mode: VAULT_FILE_MODE })
  }

  if (input.kind === 'prompt') {
    const projectsDir = join(vaultRoot, 'brain', 'projects')
    const existingEntries = await readdir(projectsDir, { withFileTypes: true })
    let nextIdx = 0
    const prefix = `prompt_${projectSlug}_`
    for (const entry of existingEntries) {
      if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.md')) continue
      const num = Number(entry.name.slice(prefix.length, -'.md'.length))
      if (Number.isInteger(num) && num >= nextIdx) nextIdx = num + 1
    }
    const promptSlug = `${prefix}${nextIdx}`
    const snippet = input.content.trim().replaceAll(/\s+/g, ' ').slice(0, 220)
    const promptContent = [
      '---',
      `tags: [prompt, ${projectSlug}]`,
      '---',
      '',
      `# 💬 Prompt ${nextIdx + 1}`,
      '',
      `**Proyek:** [[brain/projects/${projectSlug}|${projectName}]]`,
      `**Waktu:** ${timestamp}`,
      '',
      `> "${snippet.replaceAll('"', "'")}"`,
      '',
    ].join('\n')
    await writeFileAtomic(join(projectsDir, `${promptSlug}.md`), promptContent, { mode: VAULT_FILE_MODE, dirMode: VAULT_DIR_MODE })

    const promptFiles = existingEntries
      .map(entry => entry.name)
      .filter(name => name.startsWith(prefix) && name.endsWith('.md'))
      .concat(`${promptSlug}.md`)
    promptFiles.sort()
    const promptLinks = promptFiles.slice(-MAX_PROMPT_NOTES_PER_PROJECT).map((fileName) => {
      const base = fileName.slice(0, -'.md'.length)
      return `- [[brain/projects/${base}|${base}]]`
    })
    const projNote = [
      '---',
      `tags: [proyek, ${projectSlug}]`,
      '---',
      '',
      `# 📂 ${projectName}`,
      '',
      '**Status:** ✅ Aktif di DeepSeek Harness',
      `**Total Prompt:** ${promptFiles.length}`,
      '**Hub:** [[brain/Otak_Utama|🧠 Otak Utama]]',
      `**Log:** [[brain/logs/${projectSlug}_History|History]]`,
      '',
      '## Riwayat Prompt Terbaru',
      '',
      ...promptLinks,
      '',
    ].join('\n')
    await writeFileAtomic(join(projectsDir, `${projectSlug}.md`), projNote, { mode: VAULT_FILE_MODE, dirMode: VAULT_DIR_MODE })
  }

  await rebuildNavigationAndCanvas(vaultRoot)

  return {
    relativePath: relPath,
    absolutePath: absPath,
    projectSlug,
  }
}
