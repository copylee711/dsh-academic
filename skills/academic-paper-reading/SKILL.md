---
name: academic-paper-reading
description: >-
  Read one research paper closely and produce structured reading notes: what it asks, what it does, what it shows, how far the evidence goes, and how it connects to other work. Use for 论文精读、读论文、论文笔记、论文解读、帮我看这篇论文、paper summary, journal club preparation. Can save the notes to Zotero.
---

# Reading a paper closely

The aim is notes that let someone decide whether to trust and use the paper without rereading it, and that keep apart what the authors show, what they claim, and what the reader concludes.

## 1. Get the text

- The paper is in the user's Zotero: `zotero_search` → `zotero_get` (metadata and the user's own highlights) → `zotero_read`.
- An arXiv id, DOI, PMID or PMCID: `paper_get` for the metadata, then `paper_read`.
- A local PDF or a pasted text: read that.

If only the abstract is available (paywalled, not in Zotero), say so at the top of the notes and stop at what the abstract supports. Do not reconstruct the method or results from general knowledge.

## 2. Read in three passes

1. **Map** (`outline: true`, abstract, introduction's last paragraph, conclusion, figure captions): what kind of paper is it (new method, empirical study, theory, resource, survey), what is the single main claim?
2. **Evidence** (method and results sections, one at a time via `section`): what exactly was done, on what data, compared with what, measured how? For each headline number find the table or figure it comes from.
3. **Limits** (limitations, discussion, appendix; `query` for "limitation", "assumption", "ablation", "failure"): what did the authors not test, where does it fail, what would change the conclusion?

For a long paper, read by section instead of loading everything; use `query` to find where a specific claim is supported.

## 3. Write the notes

Use this layout; drop a heading that does not apply rather than padding it.

```
# <Title> (<first author> et al., <year>, <venue>)
<link or id> · read from: <full text | abstract only>

## In one sentence
What the paper shows, with its main number.

## Problem
What was unknown or not working before, and why it matters. The gap as the authors frame it.

## Approach
What they do, in the order someone would need to reproduce it. Key design choices and what each is for.
Data, baselines, metrics.

## Results
- Result 1, with the number, the comparison, and where it is in the paper (Table/Fig./section).
- …

## How far the evidence goes
What the experiments support directly; what is extrapolated. Missing controls or ablations, small samples,
favourable baselines, single dataset or seed, statistics not reported. The authors' own stated limitations.

## Relation to other work
What it builds on and what it supersedes or contradicts (name the papers). Who has built on it since
(paper_citations, direction "citations") when that matters.

## Worth taking away
Ideas, techniques or data reusable in the user's own work. Open questions it raises.

## Terms
Notation and terms a reader needs, each in a line.
```

Rules:

- Page or section references come from the text read (`[page N]` markers, section headings). None is invented.
- Formulas are copied as written (LaTeX stays LaTeX); a paraphrased formula is marked as a paraphrase.
- "The authors claim" and "the data show" are different sentences. Keep them different.
- Write in the user's language; keep technical terms in the original with a gloss the first time.
- If the user highlighted passages in Zotero, organise "Worth taking away" around them.

## 4. Afterwards

- Offer to save the notes as a Zotero note under the item (`zotero_note` with `parent`), when writing to the library is enabled.
- For a journal club or a talk, add 3–5 discussion questions that probe the weakest link in the argument.
- For several papers on one topic, switch to the academic-literature-review skill and compare them instead of stacking summaries.
