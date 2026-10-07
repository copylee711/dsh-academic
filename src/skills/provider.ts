/**
 * The skills shipped in the package's `skills/` folder, offered to the host's
 * skill registry (`ctx.skills`, @deepseek-ai/dsh-skill). A skill is a folder
 * with a SKILL.md; its other files are read by the model on demand, by path,
 * from the folder named as its resource base.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

/** Rank of skills bundled with a plugin; user and project skills of the same name rank lower and win. */
const BUNDLED_SKILL_RANK = 600
export const PROVIDER_NAME = 'copylee-academic'

/** Folders that other skills read from but that are not skills to invoke. */
const SUPPORT_FOLDERS = new Set(['academic-shared'])

export interface BundledSkill {
  name: string
  description: string
  directory: string
  path: string
}

// The slice of @deepseek-ai/dsh-skill this provider touches.
interface Candidate {
  name: string
  description: string
  invocation: { modelInvocable: boolean; userInvocable: boolean }
  provider: string
  source: 'bundled'
  resourceBase: { kind: 'directory'; path: string }
  path: string
  rank: number
  locator: unknown
}
export interface SkillProvider {
  name: string
  list(options: { signal?: AbortSignal | undefined }): Promise<readonly Candidate[]>
  get(candidate: Candidate, options: { signal?: AbortSignal | undefined }): Promise<(Omit<Candidate, 'rank' | 'locator'> & { content: string }) | undefined>
}

/** `skills/` next to the built bundle, or up from the source tree when run unbundled. */
export function skillsRoot(): string | undefined {
  return ['../skills/', '../../skills/', '../../../skills/'].map(relative => fileURLToPath(new URL(relative, import.meta.url))).find(path => existsSync(join(path, 'THIRD_PARTY_NOTICES.md')))
}

export function parseSkill(raw: string): { name?: string; description?: string; content: string } {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (frontmatter?.[1] === undefined) return { content: raw }
  let meta: unknown
  try { meta = parse(frontmatter[1]) } catch { meta = undefined }
  const field = (key: string): string | undefined => {
    const value = typeof meta === 'object' && meta !== null ? (meta as Record<string, unknown>)[key] : undefined
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
  }
  const name = field('name')
  const description = field('description')
  return { ...(name === undefined ? {} : { name }), ...(description === undefined ? {} : { description }), content: raw.slice(frontmatter[0].length).trim() }
}

/** Every folder under `root` holding a SKILL.md whose name matches the folder. */
export function discoverSkills(root: string | undefined): BundledSkill[] {
  if (root === undefined) return []
  const skills: BundledSkill[] = []
  for (const entry of readdirSync(root).sort()) {
    const directory = join(root, entry)
    const path = join(directory, 'SKILL.md')
    if (SUPPORT_FOLDERS.has(entry) || !statSync(directory).isDirectory() || !existsSync(path)) continue
    const { name, description } = parseSkill(readFileSync(path, 'utf8'))
    if (name !== entry || description === undefined) continue
    skills.push({ name, description: description.replace(/\s+/g, ' '), directory, path })
  }
  return skills
}

export interface SkillOptions {
  /** Whether a skill is offered right now (settings can switch each off). */
  enabled(name: string): boolean
  /** Text added after a skill's body: what the host has that the skill's text cannot know. */
  appendix(name: string): string
}

export function createSkillProvider(skills: readonly BundledSkill[], options: SkillOptions): SkillProvider {
  const candidates: Candidate[] = skills.map(skill => ({
    name: skill.name,
    description: skill.description,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: PROVIDER_NAME,
    source: 'bundled',
    resourceBase: { kind: 'directory', path: skill.directory },
    path: skill.path,
    rank: BUNDLED_SKILL_RANK,
    locator: skill.path,
  }))
  return {
    name: PROVIDER_NAME,
    list: () => Promise.resolve(candidates.filter(candidate => options.enabled(candidate.name))),
    async get(candidate, lookup) {
      if (!options.enabled(candidate.name)) return undefined
      const { rank: _rank, locator, ...summary } = candidate
      const raw = await readFile(String(locator), { encoding: 'utf8', ...(lookup.signal === undefined ? {} : { signal: lookup.signal }) })
      return { ...summary, content: `${parseSkill(raw).content}${options.appendix(candidate.name)}` }
    },
  }
}

/**
 * What a loaded skill is told about this installation: which tools stand in
 * for the search, citation and Zotero steps its text describes, and which of
 * the skills it refers to exist here.
 */
export function skillAppendix(skills: readonly BundledSkill[], state: { papers: boolean; zotero: boolean; zoteroWrite: boolean }, enabled: (name: string) => boolean): string {
  const lines = ['', '', '## In this app']
  if (state.papers) {
    lines.push('Literature search, citation data and reference checks are done with the paper_ tools: paper_search (arXiv, OpenAlex, Crossref, Semantic Scholar, PubMed, Europe PMC, DBLP), paper_get, paper_citations, paper_read (open-access full text), paper_cite (BibTeX / RIS / formatted references from the DOI registries) and reference_verify (does each reference exist and match). Use them wherever this skill calls for a database query, a Crossref lookup, a web search for a paper, or a script that does one of these.')
  } else {
    lines.push('The paper search tools are switched off (Settings > 学术). Where this skill needs a literature search or a reference check, say that it is unavailable instead of answering from memory.')
  }
  if (state.zotero) {
    lines.push(`The user's Zotero library is reached with the zotero_ tools (zotero_search, zotero_get, zotero_read, zotero_export${state.zoteroWrite ? ', and zotero_add / zotero_note / zotero_organize to change it' : '; the library is read-only here'}). They replace any Zotero connector or MCP server this skill mentions.`)
  }
  lines.push('Other databases, bridges or MCP servers this skill names (CNKI, Wanfang, IEEE Xplore, Scopus …) are available only if the user has set them up separately; if a step depends on one that is missing, say so and continue with what is available.')
  const names = skills.filter(skill => enabled(skill.name)).map(skill => skill.name)
  lines.push(`Skills installed with this one: ${names.join(', ')}. A skill this text refers to that is not in the list (for example a figure, slides or downloader skill) is not installed; do that part directly or tell the user.`)
  lines.push('Files this skill refers to by relative path are under its resource directory; a path starting with ../academic-shared/ is the folder next to it.')
  return lines.join('\n')
}
