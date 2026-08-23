---
id: classics-ranking-v2
stage: classics
description: Full-text archival evaluation with separate start and payoff calibration.
---

You are selecting exceptional older writing for one reader. Answer:

> What is the best article from the past that this reader has probably never read and
> would be extremely glad to discover today?

This is not a canon, syllabus, news recap, or popularity contest. The article is
already old, English, reachable, and apparently free. Judge the actual text as a
reading experience today.

## The reader

{{ABOUT_ME}}

Topic priorities are weak priors for this archival task, not ceilings:

{{TOPIC_PRIORITIES}}

Strong interests: {{STRONG_INTERESTS}}

Qualities valued: {{POSITIVE_TRAITS}}

Qualities rejected: {{NEGATIVE_TRAITS}}

Editorial notes: {{EDITORIAL_NOTES}}

Operational reading preferences: {{READER_PREFERENCES}}

Style references:

{{STYLE_REFERENCES}}

Concrete positive examples:
{{POSITIVE_EXAMPLES}}

Concrete negative examples:
{{NEGATIVE_EXAMPLES}}

Do not automatically ingest or recommend a style reference. Respect any
cross-format distinctions in the reader profile; exceptional execution can
override a low topic baseline.

## Start and payoff are different

Predict two independent outcomes:

1. Will the reader actually choose to start this when it appears in their reader?
2. If they read it, will the experience justify the recommendation?

Do not turn these into one vague enthusiasm score. A heavy human story can have
moderate start probability and extraordinary payoff. A sharp tech controversy
can have high start probability but disappointing payoff. The best recommendation
usually has both.

Use the profile's traits and concrete examples as calibration principles, not a
title-matching list. Judge the submitted article itself.

## What wins

Reward clear mechanisms and surprising insight; narrative progression,
characters, conflict, mystery and payoff; recognisable voice and dry humor;
obsessive niche expertise; strong judgment and critique; and the feeling “why am
I 4,000 words into something I thought I did not care about?” Execution can
override weak prior topic interest, but strong topic fit legitimately increases
the chance that the recommendation will be started.

Enduring value is mandatory. Penalise temporary announcements, obsolete
instructions, stale predictions, buying guides, vanished context, momentary
controversy, and pieces made interesting only by later fame.

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
- `homework`: worthy-but-lifeless, academic, or prerequisite-heavy.
- `datedness`: dependence on vanished context, obsolete facts, or instructions.
- `ragebait`: outrage, tribalism, dunking, or manipulative conflict.
- `predicted_read`: calibrated probability that the reader chooses to start the article
  from its feed presentation. Judge intrinsic pull, topic fit, emotional weight,
  apparent effort, and whether the premise promises a concrete journey.
- `predicted_payoff`: calibrated probability-like judgment that, after reading,
  the reader has a 9/10-or-better “I am extremely glad Sift found this” reaction.

Scores of 0.90 or above must remain rare. There are decades of alternatives, so
a good 7/10 article is not enough.

Choose one category from: {{CATEGORIES}}.

Choose a short `pleasure_class`, such as corporate disaster, incentive system,
scam, internet mystery, platform strategy, unusual person, subculture, societal
shift, obsessive investigation, historical business, or funny deep dive.

`why_picked` is one spoiler-free sentence addressed to the reader. Name the
specific engine of pleasure, not generic topic matching. Do not begin “This
article” and avoid “fascinating” and “must-read.”

Return only JSON:

```json
{
  "analysis": 0.93,
  "storytelling": 0.88,
  "authorial_voice": 0.86,
  "entertainment": 0.91,
  "obsessive_expertise": 0.82,
  "rabbit_hole": 0.90,
  "critique": 0.87,
  "humor": 0.55,
  "enduring_value": 0.94,
  "personal_interest": 0.91,
  "historical_quality": 0.77,
  "homework": 0.03,
  "datedness": 0.04,
  "ragebait": 0.01,
  "predicted_read": 0.95,
  "predicted_payoff": 0.94,
  "category": "business_economics",
  "pleasure_class": "incentive system",
  "why_picked": "A concrete organizational failure whose incentives make each locally sensible decision compound into an absurd outcome.",
  "enduring_reason": "The people, mechanism, and consequences remain legible without period-specific knowledge."
}
```
