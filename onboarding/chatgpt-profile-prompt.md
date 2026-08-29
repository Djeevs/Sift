# Build my Sift reader profile

I’m setting up **Sift**, a personal system that discovers, filters, and ranks
articles and other text-based content according to what I would genuinely be
glad to spend attention on.

Build a portable reader profile using only context you can actually access
about me: available conversations, saved memory, Custom Instructions or
profile information, preferences I stated, and repeated patterns you can
reasonably identify.

Do not claim access to unavailable chats, browsing history, reading history,
listening history, external accounts, or anything else you cannot actually
see.

## Your job

The goal is prediction, not biography.

Model:

> How likely is this specific person to be glad Sift put this specific
> article in front of them?

Sift will use this profile to:

- discover ongoing sources;
- rank articles;
- filter low-value content;
- control repetition and saturation;
- explore beyond established interests;
- learn from later article-level behavior.

Do not merely summarize what subjects I seem interested in. Model how I
decide something is worth my reading time.

## What to infer

Only include distinctions that could plausibly change a recommendation. Look
for:

- durable interests, strong-but-selective interests, conditional interests,
  and genuinely low-value or unwanted subjects;
- temporary projects or situations that currently change what is useful;
- preferred treatments within each interest — reporting, analysis,
  explanation, investigation, criticism, history, narrative, practical advice,
  profiles, or data;
- treatments I dislike even within topics I otherwise care about;
- high-value intersections between interests;
- topic relevance separately from execution quality;
- qualities that make a piece rewarding or unrewarding;
- whether exceptional execution can overcome weak topic relevance;
- whether strong relevance can compensate for merely adequate execution;
- preferred depth and information density;
- the payoff required to justify a long article;
- tolerance for technical complexity;
- appetite for timely reporting versus later interpretation;
- novelty and surprise;
- usefulness, entertainment, humor, voice, storytelling, emotional payoff, or
  intellectual payoff where evidence supports them;
- tolerance for multiple articles about the same event;
- saturation with repeatedly covered subjects;
- medium-specific preferences;
- professionally useful material separately from material I personally
  enjoy;
- promising directions for exploration outside established interests;
- contradictions and conditions rather than forcing a false single
  preference.

Do not include a distinction merely because the schema provides a place for
it.

## Topic interest is not enough

For each meaningful interest, distinguish where possible:

1. priority — how much the subject matters;
2. preferred coverage — what kinds of articles about it tend to work;
3. avoided coverage — what tends not to work;
4. conditions — when the topic becomes more or less valuable;
5. saturation — how quickly repeated coverage becomes tiring.

Do not infer that a high-priority interest should dominate the feed. A reader
can love a subject while wanting only occasional exceptional pieces about it.

## Execution versus relevance

An article can succeed because of its subject, because of its execution, or
because of both. Infer when possible:

- what execution qualities materially increase value;
- what negative qualities can ruin an otherwise relevant article;
- whether unfamiliar subjects can succeed through exceptional execution;
- whether important or useful content can succeed despite plain writing;
- what makes additional reading time worthwhile.

Do not convert every preference into a topic preference.

## Stable preferences versus temporary context

Separate durable taste from temporary relevance. A stable interest is likely
to remain useful for recommendation over a long period. A contextual interest
is a current project, decision, event, life situation, or temporary curiosity
that changes what is valuable right now.

Do not silently turn temporary relevance into permanent taste. For
contextual interests, estimate a horizon: `days`, `weeks`, `months`,
`indefinite`, or `unknown`. Use `indefinite` only when there is evidence that
the relevance is likely to remain.

## Saturation and duplication

Interest does not imply unlimited appetite. Infer where possible:

- how tolerant I am of several articles about the same event;
- whether I usually want one best treatment or several perspectives;
- how quickly a heavily represented topic becomes repetitive;
- what constitutes a meaningfully new angle;
- whether some subjects deserve frequent updates while others should appear
  only when the article is unusually good.

The goal is not to maximize the amount of content about my favorite subjects.
The goal is to maximize the value of each recommendation.

## Medium-specific evidence

Interest in a topic through videos, podcasts, books, games, academic papers,
or other media does not automatically mean I want articles about it. When
using cross-medium evidence, distinguish:

- interest in the underlying subject;
- preference for the medium itself;
- transferable qualities such as humor, explanation, pacing, storytelling,
  depth, criticism, curiosity, or voice.

If evidence suggests something works much better for me in another medium,
record that rather than treating it as a strong text interest.

## Professional versus personal interest

Do not infer that I want to read something simply because it relates to my
job or expertise. Where evidence allows, distinguish:

- professional subjects I genuinely enjoy reading about;
- professionally useful material I may need but would not choose for
  personal reading;
- areas where usefulness itself is enough to justify recommendation.

Sift is primarily optimizing for content I will be glad I spent attention on,
not for comprehensive professional coverage.

## Exploration

Model not just how much exploration I want, but also which directions are
promising. Useful exploration may come from:

- adjacent subjects;
- unfamiliar fields with similar intellectual qualities;
- a preferred form of storytelling applied to a new domain;
- intersections between existing interests;
- material that fits my execution preferences despite weak topic overlap.

Each exploration direction should have a plausible bridge from established
taste. Do not translate serendipity into randomness.

## Sources

Do not generate a generic list of publications I should follow. Sift has a
separate source-discovery system that combines this profile with:

- websites I explicitly provide;
- my comments about those websites;
- the existing source portfolio;
- observed article performance;
- coverage gaps;
- redundancy.

Your role is to describe the reader, not to construct the final source list.

You may name a writer, publication, newsletter, blog, or other source only
when available context provides genuine evidence about my existing
relationship to it. For example:

- I explicitly said I love it;
- I said I like only one part of it;
- several available examples show I repeatedly value its work;
- I explicitly dislike it;
- I use it as a style reference.

Keep source preferences scoped. "I like their reviews" means positive
evidence about their reviews. It does not mean I like everything from this
publication. Do not invent sources or source relationships.

## Evidence discipline

Every consequential claim must use one evidence basis:

- `explicit` — I directly stated it;
- `observed` — repeated available choices, reactions, or patterns support it;
- `inferred` — a plausible interpretation that was not directly established.

Use confidence from `0` to `1`. Confidence means confidence that the
preference inference is correct, not how strong the preference itself is.

Prefer sparse, accurate output over artificial completeness. Absence of
evidence is not dislike. Do not infer preferences from stereotypes about my
profession, education, age, gender, nationality, identity, location, hobbies,
income, personality type, or social group. A fact about me belongs in the
profile only when available evidence suggests it actually changes what I
want to read. Do not optimize the profile to flatter me or make me appear
sophisticated, well-read, curious, or interesting.

## Negative evidence

Treat explicit dislikes and repeated negative reactions as first-class
evidence. Where possible distinguish between disliking the topic, disliking
the treatment, excessive shallowness, excessive complexity, excessive
length, repetition, hype, clickbait, outrage, generic commentary, low
information density, weak storytelling, and simply lacking evidence. Do not
turn "I haven't shown interest in this" into "I dislike this."

## Follow-up questions

First use all context already available. Then ask at most three follow-up
questions, and only when resolving the uncertainty would likely change
recommendations across a meaningful category of content. Prefer questions
about tradeoffs over generic topic questions. It is fine to ask none. If
questions are needed, ask them before producing the final profile; after I
answer, produce the JSON.

## Privacy

This profile will be imported into another system. Include personal context
only when it materially improves reading recommendations. Omit secrets and
credentials, contact information, account identifiers, precise addresses or
location history, private messages, confidential workplace information,
financial information unless explicitly relevant and requested, unnecessary
sensitive attributes, and private facts about other people. Use broad
professional, geographic, or life context only when it genuinely changes
content selection.

## Operational settings

Sift separately lets me configure operational settings such as daily reading
capacity, preferred article length, languages, paywall rules, freshness, and
amount of serendipity. If available evidence strongly supports a value,
include it as a non-binding hint in `assistant_preference_hints`. Otherwise
return `null`. Do not ask questions merely to populate these settings.

## Final quality check

Before returning the JSON, internally verify:

1. Prediction over biography. Does each significant field help predict
   article value?
2. No stereotype inference. Did I avoid turning facts about the person into
   preferences without evidence?
3. Stable versus temporary. Are live projects and current situations
   separated from durable taste?
4. Topic versus execution. Did I capture why articles succeed or fail, not
   merely which topics appear?
5. Scoped negatives. Did I distinguish disliking a topic from disliking a
   treatment of that topic?
6. Saturation. Did I avoid interpreting strong interest as unlimited
   appetite?
7. Medium transfer. Did I avoid assuming enthusiasm in another medium
   automatically transfers to text?
8. Source discipline. Does every named source reflect an actual evidenced
   relationship rather than a recommendation I invented?
9. Scoped source affinity. If the evidence is "I like their reviews," did I
   preserve that scope rather than generalizing it to the whole publication?
10. Useful exploration. Does every exploration frontier have a plausible
    bridge from established taste?
11. Evidence calibration. Are high-confidence and strong-negative claims
    genuinely supported?
12. Sparse when uncertain. Did I leave unsupported fields empty rather than
    filling them with plausible-sounding guesses?
13. Operational value. Could a downstream source-discovery or article-ranking
    model use every major statement to make a better decision?

Keep the final profile operationally concise. If evidence is sparse, return a
sparse profile. Do not compensate with generic interests, flattering
interpretations, prestigious sources, or guesses.

## Output

If no follow-up question is necessary, return the profile immediately. When
returning the profile: return exactly one valid JSON object; output no
surrounding prose; output no Markdown fence; keep descriptions concise and
decision-relevant; use empty arrays or `null` when evidence is missing; do
not create generic filler.

{
  "version": 5,
  "reading_goal": "What Sift should optimize my reading attention for.",
  "executive_taste_summary": "A concise prediction-oriented summary of what tends to earn my reading time.",
  "attention_selection_model": "The central tradeoffs that predict whether I will be glad I read something.",
  "contextual_interests": [
    {
      "id": "lowercase_snake_case",
      "description": "A temporary project, situation, decision, event or curiosity.",
      "effect_on_recommendations": "How it should temporarily change article selection.",
      "strength": "high",
      "time_horizon": "weeks",
      "refresh_required": true,
      "basis": "explicit",
      "confidence": 0.0
    }
  ],
  "stable_interests": [
    {
      "id": "lowercase_snake_case",
      "label": "Human-readable interest",
      "tier": "core",
      "priority": 0,
      "preferred_coverage": ["Specific treatments or angles that work"],
      "avoid_coverage": ["Treatments of this topic that tend not to work"],
      "conditions": ["When this interest becomes more or less valuable"],
      "saturation": {
        "repeat_tolerance": "low",
        "new_angle_required": true,
        "guidance": "What makes another article on this subject worthwhile."
      },
      "medium_fit": "text_specific",
      "basis": "explicit",
      "confidence": 0.0
    }
  ],
  "valuable_intersections": [
    {
      "description": "A combination of interests or qualities that appears unusually valuable.",
      "why_it_matters": "Why the combination predicts stronger articles than either component alone.",
      "basis": "observed",
      "confidence": 0.0
    }
  ],
  "taste_signals": [
    {
      "signal": "A property of an article or its execution.",
      "effect": "strong_positive",
      "why": "Why it appears to change satisfaction.",
      "conditions": ["When this signal applies, if not generally"],
      "basis": "observed",
      "confidence": 0.0
    }
  ],
  "semantic_anchors": [
    {
      "id": "lowercase_snake_case",
      "interest_id": "related_stable_interest_id_or_null",
      "description": "An article-shaped description of a desirable recommendation, more specific than a topic label.",
      "priority": 0,
      "basis": "explicit",
      "confidence": 0.0
    }
  ],
  "avoid_anchors": [
    {
      "id": "lowercase_snake_case",
      "description": "An article-shaped description of content that should usually be filtered or strongly downranked.",
      "strength": "strong",
      "basis": "observed",
      "confidence": 0.0
    }
  ],
  "depth_length_profile": {
    "summary": "How depth, length and information density affect value.",
    "longform_payoff_threshold": "What additional value must justify a long article.",
    "technical_complexity": "How technical difficulty affects recommendation value.",
    "basis": "inferred",
    "confidence": 0.0
  },
  "timeliness_profile": {
    "summary": "When fresh coverage is valuable versus when waiting for deeper treatment is better.",
    "loses_value_quickly": [],
    "remains_valuable": [],
    "basis": "inferred",
    "confidence": 0.0
  },
  "exploration_profile": {
    "frequency": "occasional",
    "execution_override_strength": 0,
    "unfamiliar_topic_quality_bar": "How good an unfamiliar article must be.",
    "override_conditions": ["What can make weak topic relevance succeed"],
    "basis": "inferred",
    "confidence": 0.0
  },
  "exploration_frontiers": [
    {
      "description": "A specific promising direction outside established interests.",
      "bridge": "Which established preference makes this plausible.",
      "basis": "inferred",
      "confidence": 0.0
    }
  ],
  "medium_profile": [
    {
      "subject_or_style": "A topic or treatment with medium-specific evidence.",
      "fit": "stronger_elsewhere",
      "preferred_medium": "video",
      "transferable_qualities": ["Qualities that may still inform text ranking"],
      "basis": "observed",
      "confidence": 0.0
    }
  ],
  "professional_personal_boundary": {
    "enjoyed_overlap": ["Professional areas I genuinely enjoy reading about"],
    "useful_but_not_personal": ["Material that may be useful but should not dominate my feed"],
    "guidance": "How Sift should resolve professional usefulness versus genuine reading interest.",
    "basis": "inferred",
    "confidence": 0.0
  },
  "known_source_evidence": [
    {
      "name": "A publication, writer or source I genuinely have an evidenced relationship with.",
      "relationship": "known_favorite",
      "scope": "What specifically I value or dislike about this source.",
      "reason": "What the available evidence establishes.",
      "basis": "explicit",
      "confidence": 0.0
    }
  ],
  "examples": [
    {
      "kind": "explicit_positive",
      "title_or_description": "Only an example genuinely available in context.",
      "reason": "What this example reveals about article-selection tradeoffs.",
      "confidence": 0.0
    }
  ],
  "assistant_preference_hints": {
    "attention_budget": null,
    "article_length": null,
    "paywall_policy": null,
    "languages": null,
    "freshness_balance": null,
    "max_evergreen_age_days": null,
    "serendipity": null,
    "writing_voices": null,
    "disliked_styles": null,
    "medium_preferences": []
  },
  "contradictions": [
    {
      "tension": "A useful unresolved or context-dependent preference.",
      "conditions": "When each side appears to apply.",
      "confidence": 0.0
    }
  ],
  "uncertainties": ["Unknowns that could materially change recommendations"],
  "privacy_redactions": ["Kinds of potentially relevant information deliberately omitted"]
}

Allowed values:

- interest `tier`: `core`, `high_selective`, `conditional`, `low`,
  `unwanted`;
- `priority`: integer from `0` to `10`;
- saturation `repeat_tolerance`: `high`, `moderate`, `low`, `very_low`,
  `unknown`;
- taste-signal `effect`: `strong_positive`, `moderate_positive`,
  `weak_positive`, `weak_negative`, `moderate_negative`, `strong_negative`,
  `hard_filter` (use `hard_filter` extremely conservatively);
- evidence `basis`: `explicit`, `observed`, `inferred`;
- contextual-interest `strength`: `low`, `moderate`, `high`;
- contextual-interest `time_horizon`: `days`, `weeks`, `months`,
  `indefinite`, `unknown`;
- `medium_fit` and medium-profile `fit`: `text_specific`, `cross_medium`,
  `stronger_elsewhere`, `unknown`;
- `preferred_medium`: `text`, `video`, `podcast`, `books`,
  `academic_papers`, `any`, `unknown`;
- exploration `frequency`: `rare`, `occasional`, `frequent`, `unknown`;
- `execution_override_strength`: integer from `0` to `10`;
- avoid-anchor `strength`: `strong`, `moderate`, `weak`;
- known-source `relationship`: `known_favorite`, `positive_evidence`,
  `known_dislike`, `style_reference`, `noisy_but_useful` (include a named
  source only with genuine evidence);
- example `kind`: `explicit_positive`, `explicit_negative`, `behavioral`,
  `reference`.

For non-null assistant hints, use `{ "value": ..., "confidence": 0.0 }`.
Allowed hint values are:

- `attention_budget`: `under_15`, `15_30`, `30_60`, `60_plus`, `variable`;
- `article_length`: `mostly_short`, `medium`, `long_when_exceptional`, `any`;
- `paywall_policy`: `free_only`, `subscribed_publications`, `readable_only`,
  `quality_first`;
- `freshness_balance`: `timely`, `balanced`, `evergreen`;
- `serendipity`: a number from `0` to `10`;
- `languages`: array of language names or codes when supported by evidence;
- each `medium_preferences` item: `subject`, `preferred_medium` (`text`,
  `video`, `podcast`, or `any`), `strength` (`prefer` or `strongly_prefer`),
  and `confidence`.

Use priorities from `0` to `10` and confidence from `0` to `1`. Keep the
final profile operationally concise. If evidence is sparse, return a sparse
profile; do not compensate with generic advice or guesses.
