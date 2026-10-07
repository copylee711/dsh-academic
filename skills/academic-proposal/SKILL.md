---
name: academic-proposal
description: >-
  Draft or review a research proposal: a thesis proposal (开题报告), a research plan, or the scientific part of a grant application, with a literature basis that is actually searched and cited. Use for 开题报告、研究计划、课题申报、基金申请书、研究方案、选题论证、research proposal, thesis proposal, grant proposal aims.
---

# Research proposal

A proposal persuades a committee of four things: the question matters, it is not yet answered, this plan can answer it, and this person can carry the plan out in the time given. Every section serves one of the four.

## 1. Establish the brief

Ask once, for what is not already given:

- Kind and audience: degree thesis proposal (which level, which discipline), funding application (which programme), or internal plan. The institution's or funder's template, if any — follow its headings and limits exactly.
- The topic as far as the user has it, their supervisor's or group's direction, and prior results or data they hold.
- Resources and time: duration, equipment, data access, collaborators.
- Language and length.

If the user has only a broad area, do the scoping in section 2 first and offer two or three candidate questions with their trade-offs (novelty, feasibility, data) before drafting.

## 2. Ground it in the literature

Do a real search before writing the background; a proposal that misses the obvious prior work fails on that alone.

- `paper_search` on the topic (`sort: "citations"` for the foundations, `sort: "date"` for the last two years), then `paper_citations` from the central papers. For Chinese-language scholarship that the indexes cover poorly, say so and ask the user for the key sources they know.
- `zotero_search` in the user's library when they have one.
- Read the closest 5–10 papers (`paper_read`, or their abstracts when not open) well enough to state what each did and did not do.
- From this, write the **gap** as a specific sentence: what is unknown, contradictory or unsolved, and the evidence that it is.

For a longer review use the academic-literature-review skill and bring its result here.

## 3. Draft

Typical structure; rename and reorder to the template in force.

1. **Title**: the object, the question, and where useful the method; no slogans.
2. **Background and significance** (选题背景与意义): the problem in its field, why it matters now, for whom. Concrete, with sources.
3. **State of research** (国内外研究现状): organised by line of work, not by author; ends in the gap. Fair to prior work.
4. **Objectives and research questions** (研究目标与内容): one overall aim, 2–4 specific questions or hypotheses, each answerable and each mapped to a work package.
5. **Methods and technical route** (研究方法与技术路线): for each question, the data or materials, the procedure, the analysis, and what result would count as an answer. A route diagram described in text (or as a figure if the user wants one). Name controls, sample sizes or datasets, and evaluation criteria.
6. **Feasibility** (可行性分析): preliminary results, access to data and equipment, the applicant's and group's record.
7. **Innovation** (创新点): two or three points, each stated against a named prior work, none larger than the plan can deliver.
8. **Schedule and milestones** (进度安排): by term or quarter, with a checkable deliverable for each period.
9. **Expected results** (预期成果): papers, thesis chapters, software, data, in realistic numbers.
10. **Risks and alternatives**: what could fail and the fallback for each.
11. **References**.

Writing rules:

- Claims of novelty are tied to the search actually done, and scoped ("among methods that …").
- The plan must fit the time: if a work package depends on a result that may not come, say what is done instead.
- Plain, exact language; define terms on first use; no inflated significance.
- Numbers (sample sizes, budgets, durations) come from the user or are marked as placeholders for them to fill; none is invented.
- Follow the template's limits on length and its heading wording.

## 4. Check before handing over

- References built with `paper_cite` / `zotero_export` in the required style (GB/T 7714 for most Chinese institutions: style `china-national-standard-gb-t-7714-2015-numeric`), then `reference_verify` on the whole list.
- Each research question has a method; each method has data; each period of the schedule has a deliverable.
- Read it as a committee member: what is the first objection? Answer it in the text or list it for the user under "open points".
- Give the user a short list of what still needs their input (placeholders, choices between alternatives, items only they can supply).

When reviewing a proposal the user wrote, do not rewrite it wholesale: report by section what is missing or weak against the four questions at the top, propose specific edits, and check their references the same way.
