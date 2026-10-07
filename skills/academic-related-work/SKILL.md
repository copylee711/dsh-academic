---
name: academic-related-work
description: >-
  Write or repair the Related Work / Background section of the user's own paper: find the work a reviewer expects to see, position the paper against it, and cite it correctly. Use for 相关工作、related work、background section、研究背景、"what should I cite", missing-citation checks, novelty positioning against prior work. Use academic-literature-review for a standalone survey.
---

# Related work for one's own paper

A related-work section answers one question for the reviewer: given what exists, what is new here? Each paragraph should end with the difference between that line of work and this paper.

## 1. Start from the paper, not from the literature

Get from the user (or from their draft): the contribution in one or two sentences, the method's key ingredients, the task and datasets, the target venue and its citation style, the length allowed, and the references they already have (a `.bib`, a Zotero collection, or the draft's reference list).

List the **axes of comparison**: the 3–5 things this paper could be confused with or compared to (same problem with other methods; same method on other problems; the technique it borrows; the benchmark it uses; concurrent work).

## 2. Find what must be cited

For each axis:

- `paper_search` with the field's terms; `sort: "citations"` for the canonical papers, `sort: "date"` with a recent `year_from` for concurrent work (reviewers check the last 12 months).
- From the two or three closest papers, `paper_citations` in both directions: their references are the lineage, their citers are the competition.
- `zotero_search` in the user's library: cite what they have read before adding strangers.

For every candidate decide: **closest prior work** (must be discussed, with the difference stated), **lineage** (cite in a group), **tangential** (leave out). Read the closest ones properly (`paper_read` method and results) so the stated difference is true; a mischaracterised baseline is what reviewers punish hardest.

Check novelty honestly: if a paper already does what the draft claims, tell the user plainly, with the passage, before writing anything.

## 3. Write

- One paragraph per axis, opening with what the line of work does as a whole, then the representative papers, then the contrast: "Unlike these, we …" / "We build on X but remove the need for …".
- Group routine citations ("[3, 7, 12]"); give a sentence each only to the closest work.
- Be fair and specific: say what prior work achieved before saying what it lacks. No "to the best of our knowledge, no work has …" unless the search above supports it; if used, the search must have covered it.
- Concurrent work is named as concurrent.
- Match the venue: numeric or author–year, section placement (after the introduction or before the conclusion), and length.
- Keep the user's wording and terminology from the rest of the draft.

Give the section, then a short list: papers added and why, papers the user cited that seem off-target, and claims in the draft that the literature weakens.

## 4. Citations

- BibTeX entries come from `paper_cite` (or `zotero_export` for library items), never typed from memory. Prefer the published version over the preprint when both exist, unless the venue's custom says otherwise.
- Keep the user's existing cite keys; propose keys for new entries in the same pattern.
- Run `reference_verify` on everything added and on the user's own list if they agree; report mismatches (wrong year, wrong venue, a DOI pointing elsewhere, retractions).
- Offer to add the new papers to their Zotero collection (`zotero_add`) when writing to the library is enabled.
