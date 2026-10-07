import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSkillProvider, discoverSkills, parseSkill, PROVIDER_NAME, skillAppendix, skillsRoot } from '../src/skills/provider.js'

const root = skillsRoot()!
const skills = discoverSkills(root)
const names = skills.map(skill => skill.name)
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { files: string[] }

const everyFile = (dir: string): string[] => readdirSync(dir).flatMap(entry => { const path = join(dir, entry); return statSync(path).isDirectory() ? everyFile(path) : [path] })

describe('the bundled skills', () => {
  it('are found next to the package and ship with it', () => {
    expect(root).toBeDefined()
    expect(pkg.files).toContain('skills/**')
    expect(names).toEqual(['academic-data-statement', 'academic-literature-review', 'academic-paper-reading', 'academic-polishing', 'academic-proposal', 'academic-ref-verifier', 'academic-related-work', 'academic-response', 'academic-reviewer', 'academic-statistics', 'academic-writing'])
  })
  it('each have a name matching the folder and a description that routes', () => {
    for (const skill of skills) {
      expect(skill.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      expect(skill.description.length).toBeGreaterThan(60)
      expect(skill.description.length).toBeLessThan(1024)
      expect(parseSkill(readFileSync(skill.path, 'utf8')).content.length).toBeGreaterThan(500)
    }
  })
  it('leave the shared support folder out of the catalogue but on disk', () => {
    expect(names).not.toContain('academic-shared')
    expect(existsSync(join(root, 'academic-shared', 'core'))).toBe(true)
  })
  it('refer only to files that are there', () => {
    // Paths the routers load: `always_load` and axis values in manifest.yaml, relative to the skill folder.
    for (const skill of skills) {
      const manifest = join(skill.directory, 'manifest.yaml')
      if (!existsSync(manifest)) continue
      const paths = [...readFileSync(manifest, 'utf8').matchAll(/(?:^\s*-\s+|:\s+)((?:\.\.\/|static\/|references\/)[\w./-]+\.md)\s*$/gm)].map(match => match[1]!)
      expect(paths.length).toBeGreaterThan(0)
      for (const path of paths) expect(existsSync(join(skill.directory, path)), `${skill.name}: ${path}`).toBe(true)
    }
  })
  it('carry the upstream licence and say what was changed', () => {
    const notices = readFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8')
    expect(readFileSync(join(root, 'LICENSE-nature-skills'), 'utf8')).toContain('Apache License')
    expect(notices).toMatch(/Upstream commit: `[0-9a-f]{40}`/)
    for (const adapted of ['academic-polishing', 'academic-writing', 'academic-reviewer', 'academic-response', 'academic-statistics', 'academic-data-statement', 'academic-ref-verifier', 'academic-shared']) {
      expect(notices).toContain(`\`${adapted}\``)
      expect(readFileSync(join(root, adapted, 'SKILL.md'), 'utf8')).toContain('Adapted from nature-')
    }
    // Renamed everywhere: no file still points at a folder that is not shipped.
    for (const file of everyFile(root).filter(path => /\.(md|yaml)$/.test(path) && !path.endsWith('THIRD_PARTY_NOTICES.md'))) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/\.\.\/nature-shared\//)
    }
  })
})

describe('the skill provider', () => {
  const state = { papers: true, zotero: true, zoteroWrite: false }

  it('lists what is switched on and loads a body with the app\'s tools appended', async () => {
    const off = new Set(['academic-proposal'])
    const enabled = (name: string): boolean => !off.has(name)
    const provider = createSkillProvider(skills, { enabled, appendix: () => skillAppendix(skills, state, enabled) })
    const listed = await provider.list({})
    expect(provider.name).toBe(PROVIDER_NAME)
    expect(listed.map(candidate => candidate.name)).not.toContain('academic-proposal')
    expect(listed).toHaveLength(skills.length - 1)
    const review = listed.find(candidate => candidate.name === 'academic-literature-review')!
    expect(review).toMatchObject({ source: 'bundled', rank: 600, provider: PROVIDER_NAME, invocation: { modelInvocable: true, userInvocable: true }, resourceBase: { kind: 'directory' } })
    const loaded = (await provider.get(review, {}))!
    expect(loaded.content).toMatch(/^# Literature review/)
    expect(loaded.content).not.toContain('description:')
    expect(loaded.content).toContain('## In this app')
    expect(loaded.content).toContain('reference_verify')
    expect(loaded.content).toContain('the library is read-only here')
    expect(loaded.content).not.toMatch(/Skills installed with this one:[^\n]*academic-proposal/)
    expect('rank' in loaded || 'locator' in loaded).toBe(false)
    // Switched off after it was listed: no longer loadable.
    off.add('academic-literature-review')
    expect(await provider.get(review, {})).toBeUndefined()
  })
  it('tells a skill what is missing instead of letting it improvise', () => {
    const text = skillAppendix(skills, { papers: false, zotero: false, zoteroWrite: false }, () => true)
    expect(text).toContain('paper search tools are switched off')
    expect(text).not.toContain('zotero_search')
    expect(skillAppendix(skills, { ...state, zoteroWrite: true }, () => true)).toContain('zotero_add / zotero_note / zotero_organize')
  })
  it('reads frontmatter in the forms skill authors use', () => {
    expect(parseSkill('---\nname: a-b\ndescription: >-\n  One line\n  folded: with a colon.\n---\n\n# Body\n')).toEqual({ name: 'a-b', description: 'One line folded: with a colon.', content: '# Body' })
    expect(parseSkill('---\nname: a-b\ndescription: "Quoted: yes"\nmetadata:\n  author: x\n---\nBody')).toMatchObject({ name: 'a-b', description: 'Quoted: yes' })
    expect(parseSkill('No frontmatter')).toEqual({ content: 'No frontmatter' })
    expect(discoverSkills(undefined)).toEqual([])
  })
})
