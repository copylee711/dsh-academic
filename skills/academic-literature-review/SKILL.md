---
name: academic-literature-review
description: >-
  Survey the literature on a topic and write a sourced review: plan the search, query the scholarly indexes, screen and cluster the papers, read the key ones, and synthesise with verified citations. Use for 文献综述、文献调研、研究现状、领域综述、related literature survey, "what has been done on X", state of the art. Use academic-related-work for the Related Work section of one's own paper.
---

# Literature review

A review is an argument about a body of work, not a list of summaries. The steps below get from a topic to a text in which every claim about the literature can be traced to a paper that was actually looked at.

## 1. Fix the question before searching

Ask the user only what cannot be inferred, in one message:

- The topic as a question ("How is X done / what limits Y"), and what is out of scope.
- Time window (default: the last 5 years plus the classics everyone cites).
- Depth: quick map (8–12 papers), standard review (20–40), or systematic (state inclusion criteria and report counts).
- Output: language, length, citation style, and whether a BibTeX file is wanted.

If the user has a Zotero library, check it first (`zotero_search` with mode=everything): what they already hold shows what they consider relevant.

## 2. Search in rounds

Write 3–6 queries that differ in vocabulary, not just word order: the field's own terms, synonyms, the method name, the problem name, a key author. Run `paper_search` for each.

- Start broad with the default sources; then target: `sources: ["arxiv"]` with `categories` for recent CS / physics / math; `["pubmed", "europepmc"]` for biomedicine; `sort: "citations"` to find the landmarks; `sort: "date"` with `year_from` for the newest work.
- Snowball from the 3–5 most central papers: `paper_citations` with `direction: "references"` (where the idea came from) and `"citations"` (who built on it). This finds what keyword search misses.
- Stop when a new round returns mostly papers already seen.

Keep a running table: id, title, year, venue, citations, why it is in or out. For a systematic review, record how many records each query returned and how many survived each screen.

## 3. Screen

Screen on title and abstract (`paper_get` when the snippet is not enough). Drop what is off-topic, superseded, or retracted (`paper_get` says so). Do not keep a paper only because it is highly cited, nor drop one only because it is new.

## 4. Read what carries the argument

For the 5–15 papers the review will lean on, read more than the abstract:

- `paper_read` with `outline: true`, then the sections that matter (method, results, limitations), or `query` for a specific point.
- For a paper in the user's library, `zotero_read`; their highlights (`zotero_get`) show what they found important.
- A paywalled paper cannot be read. Say so in the notes and describe it only as far as its abstract allows.

Per paper, note: the question, the method, the main result with its number, the stated limitation, and how it relates to the others.

## 5. Synthesise

Organise by idea, not by paper. Typical structures: by approach (families of methods), by sub-problem, chronologically when the field has clear turns, or by the debate (positions and evidence). For each cluster say what the papers agree on, where they differ and why, and what remains open.

Write:

1. **Scope**: the question, the window, how the search was done (two sentences; for a systematic review a full paragraph with counts).
2. **Body**: one section per cluster. Compare; a table helps when several papers report the same quantity.
3. **Gaps and open problems**: what is contradictory, untested, or missing, each tied to the evidence.
4. **References**.

Rules for the text:

- Every statement about a paper carries its citation, and says only what was read. "Reports" for results, "argues" for interpretation, "claims" where support is thin.
- Distinguish what the abstract says from what the full text shows when only the abstract was read.
- Numbers are copied, never rounded into a different claim. Preprints are named as preprints.
- No citation from memory. A paper not returned by a tool in this session is not in the review until it has been found.

## 6. Verify and deliver

- Build the reference list with `paper_cite` (or `zotero_export` for library items) in the requested style; BibTeX from the same tools when asked.
- Run `reference_verify` on the final list. Fix what it flags; remove what cannot be found.
- State the limits: indexes searched, date of search, papers that could not be read in full.
- Offer to save the kept papers to Zotero (`zotero_add`, into a collection named for the topic) when writing to the library is enabled.
