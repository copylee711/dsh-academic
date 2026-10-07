// Regenerate the skills adapted from Yuan1z0825/nature-skills (Apache-2.0).
// Usage: node scripts/import-nature-skills.mjs <path to a clone of nature-skills>
//
// Only the skills that are plain Markdown are taken. They are renamed
// (nature-x -> academic-x) so they do not collide with a copy of nature-skills
// the user installed themselves; nothing else in their text is changed.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const upstream = process.argv[2]
if (!upstream || !existsSync(join(upstream, 'skills', 'nature-shared'))) {
  console.error('Give the path of a clone of https://github.com/Yuan1z0825/nature-skills')
  process.exit(1)
}

const NAMES = {
  'nature-polishing': 'academic-polishing',
  'nature-writing': 'academic-writing',
  'nature-reviewer': 'academic-reviewer',
  'nature-response': 'academic-response',
  'nature-statistics': 'academic-statistics',
  'nature-data': 'academic-data-statement',
  'nature-ref-verifier': 'academic-ref-verifier',
  'nature-shared': 'academic-shared',
}
// Human documentation, other agents' manifests and the upstream test suites are not part of a skill.
const SKIP = new Set(['README.md', 'README_EN.md', 'agents', 'tests', 'evals'])
const TEXT = new Set(['.md', '.yaml', '.yml', '.tex', '.py'])
const RENAME = new RegExp(`\\b(${Object.keys(NAMES).join('|')})(?![a-z0-9-])`, 'g')

const target = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')
const commit = execFileSync('git', ['-C', upstream, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const date = execFileSync('git', ['-C', upstream, 'log', '-1', '--format=%cs'], { encoding: 'utf8' }).trim()

function rewrite(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) { rewrite(path); continue }
    if (!TEXT.has(extname(entry))) continue
    const before = readFileSync(path, 'utf8')
    const after = before.replace(RENAME, name => NAMES[name])
    if (after !== before) writeFileSync(path, after)
  }
}

let files = 0
const count = dir => { for (const entry of readdirSync(dir)) { const path = join(dir, entry); if (statSync(path).isDirectory()) count(path); else files++ } }

for (const [from, to] of Object.entries(NAMES)) {
  const destination = join(target, to)
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })
  cpSync(join(upstream, 'skills', from), destination, { recursive: true, filter: source => !SKIP.has(source.split(/[\\/]/).at(-1)) })
  rewrite(destination)
  // Apache-2.0 4(b): say that the files were changed, and how.
  const skill = join(destination, 'SKILL.md')
  const body = readFileSync(skill, 'utf8')
  const end = body.indexOf('\n---', 3)
  const note = `<!-- Adapted from ${from} in Yuan1z0825/nature-skills (Apache-2.0). Changed: skill names (nature-* -> academic-*). See ../THIRD_PARTY_NOTICES.md. -->`
  writeFileSync(skill, `${body.slice(0, end + 4)}\n\n${note}\n${body.slice(end + 4).replace(/^\n+/, '\n')}`)
  count(destination)
}

cpSync(join(upstream, 'LICENSE'), join(target, 'LICENSE-nature-skills'))
writeFileSync(join(target, 'THIRD_PARTY_NOTICES.md'), `# Third-party notices

The following skill folders are adapted from **nature-skills** by Yuan1z0825
(https://github.com/Yuan1z0825/nature-skills), licensed under the Apache
License, Version 2.0. The licence text is in \`LICENSE-nature-skills\`.

Upstream commit: \`${commit}\` (${date}).

| Folder here | Upstream folder |
|---|---|
${Object.entries(NAMES).map(([from, to]) => `| \`${to}\` | \`skills/${from}\` |`).join('\n')}

Changes made to the upstream files:

- The folders and the skill names inside every file were renamed from
  \`nature-*\` to \`academic-*\` (as in the table), so that they do not collide
  with a copy of nature-skills installed separately.
- A one-line comment naming the origin was added to each \`SKILL.md\`.
- \`README.md\`, \`README_EN.md\`, \`agents/\`, \`tests/\` and \`evals/\` of each
  folder were left out.

No other text was changed. The remaining skill folders in this directory were
written for this plugin and are under the plugin's own licence (MIT).

Regenerate with \`node scripts/import-nature-skills.mjs <clone of nature-skills>\`.
`)
console.log(`Imported ${String(Object.keys(NAMES).length)} folders, ${String(files)} files, from ${commit.slice(0, 12)} (${date}).`)
