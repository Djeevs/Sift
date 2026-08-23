---
id: story-comparison-v1
stage: cluster
description: Decides whether two items about the same event add different value.
---

Two items appear to cover the same underlying story. The reader does not want
the same event reported five times — but they do want genuinely different
perspectives on it.

Item A:
Source: {{A_SOURCE}}
Title: {{A_TITLE}}
Gist: {{A_GIST}}
Summary: {{A_SUMMARY}}

Item B:
Source: {{B_SOURCE}}
Title: {{B_TITLE}}
Gist: {{B_GIST}}
Summary: {{B_SUMMARY}}

Decide:

1. Are these about the same underlying event, announcement, paper or claim?
2. If so, does the second add materially different information or perspective —
   original reporting, technical explanation, dissent, analysis, first-hand
   experience — or is it a recap of the same facts?

Keep both when the difference is real. A technical explainer and a sceptical
critique of the same launch are both worth reading. Two summaries of the same
press release are not.

Return only JSON:

```json
{
  "same_story": true,
  "relationship": "different_perspective",
  "keep_both": true,
  "reason": "B is a technical teardown; A is the announcement recap."
}
```

`relationship` must be one of: `duplicate_reporting`, `different_perspective`,
`follow_up`, `unrelated`.
