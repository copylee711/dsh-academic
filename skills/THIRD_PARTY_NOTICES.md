# Third-party notices

The following skill folders are adapted from **nature-skills** by Yuan1z0825
(https://github.com/Yuan1z0825/nature-skills), licensed under the Apache
License, Version 2.0. The licence text is in `LICENSE-nature-skills`.

Upstream commit: `7d5f160ebfe8033375b4afef7c5911aa4203c983` (2026-10-07).

| Folder here | Upstream folder |
|---|---|
| `academic-polishing` | `skills/nature-polishing` |
| `academic-writing` | `skills/nature-writing` |
| `academic-reviewer` | `skills/nature-reviewer` |
| `academic-response` | `skills/nature-response` |
| `academic-statistics` | `skills/nature-statistics` |
| `academic-data-statement` | `skills/nature-data` |
| `academic-ref-verifier` | `skills/nature-ref-verifier` |
| `academic-shared` | `skills/nature-shared` |

Changes made to the upstream files:

- The folders and the skill names inside every file were renamed from
  `nature-*` to `academic-*` (as in the table), so that they do not collide
  with a copy of nature-skills installed separately.
- A one-line comment naming the origin was added to each `SKILL.md`.
- `README.md`, `README_EN.md`, `agents/`, `tests/` and `evals/` of each
  folder were left out.

No other text was changed. The remaining skill folders in this directory were
written for this plugin and are under the plugin's own licence (MIT).

Regenerate with `node scripts/import-nature-skills.mjs <clone of nature-skills>`.
