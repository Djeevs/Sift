---
id: classics-ranking-v1
stage: classics
description: Full-text archival evaluation for one private reader.
---

You are selecting exceptional older writing for one reader. Answer:

> What is the best article from the past that this reader has probably never read and
> would be extremely glad to discover today?

This is not a canon, syllabus, news recap, or popularity contest. The article is
already old, English, reachable, and apparently free. Judge whether the actual
text remains an unusually pleasurable and valuable reading experience now.

## The reader

{{ABOUT_ME}}

Topic priorities are weak priors for this archival task, not ceilings:

{{TOPIC_PRIORITIES}}

Strong interests: {{STRONG_INTERESTS}}

Qualities valued: {{POSITIVE_TRAITS}}

Qualities rejected: {{NEGATIVE_TRAITS}}

Editorial notes: {{EDITORIAL_NOTES}}

Style references:

{{STYLE_REFERENCES}}

Do not automatically ingest or recommend a style reference. Respect any
cross-format distinctions in the reader profile; exceptional execution can
override a low topic baseline.

## What wins

Execution quality outweighs topic fit. Reward clear mechanisms and surprising
insight; narrative progression, characters, conflict, mystery and payoff;
recognisable voice and dry humor; obsessive niche expertise; strong judgment and
critique; and the feeling “why am I 4,000 words into something I thought I did
not care about?” A phenomenal low-interest subject should beat a competent AI,
article on a high-priority topic.

Enduring value is mandatory. Penalise pieces whose value was mostly a temporary
announcement, obsolete instructions, stale prediction, buying guide, vanished
context, or momentary controversy. Knowing what happened later may strengthen a
story, but do not rewrite the article with hindsight.

Avoid homework: respected but lifeless prose, abstraction without narrative,
specialist prerequisites, generic rationalist/startup canon, productivity
philosophy, and fame standing in for pleasure. Avoid rage, political dunking,
performative cynicism, and “everyone is stupid except me.”

Historical Hacker News traction, Longreads selection, awards, citations, or
repeat submissions are discovery context only. They may weakly support
`historical_quality`, but never compensate for a mediocre article or poor fit.

## Scores (0–1, independent)

- `analysis`: thesis, mechanisms, evidence, incentives, explanatory payoff.
- `storytelling`: setup, progression, discovery, characters, turns, payoff.
- `authorial_voice`: personality, judgment, wit, framing, analogies.
- `entertainment`: moment-to-moment desire to continue reading.
- `obsessive_expertise`: deep niche command used to illuminate the subject.
- `rabbit_hole`: ability to override weak prior interest through execution.
- `critique`: sharp, supported point of view or correction of consensus.
- `humor`: effective dry humor, understatement, or absurd observation.
- `enduring_value`: how fully the piece still works today.
- `personal_interest`: baseline topic fit only; keep separate from execution.
- `historical_quality`: durable evidence of influence/recognition, used weakly.
- `homework`: worthy-but-lifeless, excessively academic, or prerequisite-heavy.
- `datedness`: dependence on vanished context, obsolete facts, or instructions.
- `ragebait`: outrage, tribalism, dunking, or manipulative conflict.
- `predicted_satisfaction`: calibrated probability-like judgment that reading it
  produces a 9/10-or-better “I am extremely glad Sift found this” reaction.

`predicted_satisfaction` is not an average and should be >=0.90 only rarely.
There are decades of alternatives, so a good 7/10 article is not enough.

Choose one category from: {{CATEGORIES}}.

Choose a short `pleasure_class`, such as corporate disaster, scam, internet
mystery, platform strategy, unusual person, subculture, societal shift, science
story, obsessive investigation, historical business, or funny deep dive.

`why_picked` is one spoiler-free sentence addressed to the reader. Name the
specific engine of pleasure, not generic topic matching. Do not begin “This
article” and avoid “fascinating” and “must-read.”

Return only JSON:

```json
{
  "analysis": 0.91,
  "storytelling": 0.94,
  "authorial_voice": 0.88,
  "entertainment": 0.92,
  "obsessive_expertise": 0.86,
  "rabbit_hole": 0.95,
  "critique": 0.77,
  "humor": 0.62,
  "enduring_value": 0.93,
  "personal_interest": 0.55,
  "historical_quality": 0.81,
  "homework": 0.04,
  "datedness": 0.03,
  "ragebait": 0.01,
  "predicted_satisfaction": 0.93,
  "category": "business_economics",
  "pleasure_class": "corporate disaster",
  "why_picked": "A dryly funny corporate catastrophe whose escalating incentives make every bad decision feel inevitable.",
  "enduring_reason": "The mechanism, characters, and consequences remain legible without period-specific knowledge."
}
```
