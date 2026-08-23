# Build my Sift reading-and-discovery profile

I’m setting up **Sift**, a personal system that discovers and ranks articles,
newsletters, essays, posts, creators, and other text-based content according to
what I would genuinely be glad to spend attention on.

Build a portable profile using only context you can actually access about me:
available conversations, saved memory, Custom Instructions or profile
information, preferences I stated, and repeated patterns you can reasonably
identify. Do not claim access to unavailable chats, browsing history, listening
history, or external accounts.

The aim is prediction, not biography:

> How likely is this specific person to be glad Sift put this specific piece in
> front of them?

Do not merely summarize my interests. Model **how I decide something is worth my
attention** and translate that model into information Sift can use for source
discovery, article ranking, filtering, portfolio diversity, and later
calibration.

## What to infer

Use the evidence to identify only distinctions that could change a recommendation:

- core, high-but-selective, conditional, low, and genuinely unwanted interests;
- the forms of coverage I prefer within each interest—reporting, analysis,
  criticism, explanation, investigation, history, practical advice, and so on;
- high-value intersections between interests;
- topic relevance separately from execution quality;
- what makes a piece rewarding or unrewarding, and why;
- whether exceptional execution can overcome weak topic fit;
- appetite for reporting versus interpretation, timely versus evergreen work,
  and archival discoveries;
- depth, length, information density, and the payoff required to justify a long
  or technically complex piece;
- entertainment value, voice, humor, storytelling, surprise, and emotional
  payoff where these are genuinely relevant;
- medium-specific differences. Interest in a podcast or video topic does not
  automatically mean I want articles about it. Transfer style preferences across
  media only when justified;
- professionally useful material separately from reading I would personally
  enjoy;
- source affinity as a prior, never a guarantee that every item is good;
- tolerance for repeated stories, saturated topics, and multiple treatments of
  the same event;
- contradictions and conditions rather than forcing a false single preference;

For source suggestions, distinguish known favorites, likely direct follows,
selective/noisy sources, discovery-only sources, and wildcards that fit through
style or execution rather than obvious topic overlap. Do not recommend something
merely because it is prestigious or popular. Do not invent a source, domain, or
example to fill a field. Sift will verify feeds and availability separately.

## Evidence discipline

Every consequential item must use one evidence basis:

- `explicit`: I directly stated it;
- `observed`: repeated available choices, reactions, or conversational patterns
  support it;
- `inferred`: a plausible interpretation that was not directly established.

Use confidence from `0` to `1`. Prefer an empty array or an explicit uncertainty
to artificial completeness. Do not infer preferences from stereotypes about my
job, identity, demographic, location, or hobbies. Do not optimize the profile to
flatter me or make me appear sophisticated.

Ask at most **three** follow-up questions, only after using all available context,
and only when the answers would materially change sources or ranking. Prefer a
tradeoff comparison over a generic topic question. It is fine to ask none. After
any questions are answered, return the final JSON.

## Privacy

This profile will be imported into another system. Include a personal detail only
when it materially improves reading recommendations. Omit secrets, credentials,
contact details, account identifiers, precise addresses or location history,
private messages, confidential workplace information, financial information,
unnecessary sensitive attributes, and private facts about other people. Use only
broad professional or geographic context when it changes ranking.

## Division of responsibility

Sift separately lets me confirm daily reading capacity, languages, paywall rules,
freshness, article length, and serendipity. If available evidence supports a
choice, include it as a non-binding value in `assistant_preference_hints`.
Otherwise use `null` or an empty array. Do not ask follow-up questions merely to
fill these operational settings.

## Final output

Return exactly one valid JSON object and no surrounding prose or Markdown fence.
Use concise, decision-relevant descriptions. Ratios in `content_mix` are
independent preferences from `0` to `1`; they do not need to sum to one.

{
  "version": 3,
  "reading_goal": "What Sift should optimize my attention for.",
  "executive_taste_summary": "A concise prediction-oriented summary, not a biography.",
  "attention_selection_model": "The central tradeoffs that determine whether I will be glad I read something.",
  "values_and_outlook": [
    {
      "description": "Only a value or outlook that changes content selection.",
      "basis": "explicit",
      "confidence": 0.0
    }
  ],
  "current_context": [
    {
      "description": "A current project or situation that temporarily changes reading value.",
      "relevance_to_reading": "How it should affect recommendations.",
      "basis": "explicit",
      "confidence": 0.0
    }
  ],
  "interests": [
    {
      "id": "lowercase_snake_case",
      "label": "Human-readable interest",
      "tier": "core",
      "priority": 0,
      "preferred_coverage": ["Specific treatments or angles that work"],
      "conditions": ["When this topic should or should not rank well"],
      "medium_fit": "text_specific",
      "basis": "explicit",
      "confidence": 0.0
    }
  ],
  "valuable_intersections": [
    {
      "description": "An evidence-backed combination of interests",
      "why_it_matters": "Why the combination is more valuable than either topic alone",
      "basis": "observed",
      "confidence": 0.0
    }
  ],
  "rewarding_qualities": [
    {
      "quality": "A content quality",
      "why": "Why it appears to increase satisfaction",
      "strength": "strong",
      "basis": "observed",
      "confidence": 0.0
    }
  ],
  "unrewarding_qualities": [
    {
      "quality": "A negative signal",
      "why": "Why it appears to reduce satisfaction",
      "strength": "strong",
      "basis": "observed",
      "confidence": 0.0
    }
  ],
  "content_mix": {
    "breaking_news": 0.0,
    "reporting": 0.0,
    "analysis": 0.0,
    "narrative": 0.0,
    "criticism": 0.0,
    "practical": 0.0,
    "entertainment": 0.0,
    "serendipity": 0.0
  },
  "timeliness_profile": {
    "news_vs_interpretation": "When immediacy matters versus waiting for explanation.",
    "loses_value_quickly": ["Types of content with rapid value decay"],
    "remains_valuable": ["Types suitable for evergreen or archival discovery"],
    "archival_appetite": "selective",
    "age_guidance": "How age should affect ranking, including exceptional old work.",
    "basis": "inferred",
    "confidence": 0.0
  },
  "depth_length_profile": {
    "summary": "Preferred depth and length without equating the two.",
    "longform_payoff_threshold": "What must justify additional reading time.",
    "technical_complexity": "How complexity and accessibility affect value.",
    "basis": "inferred",
    "confidence": 0.0
  },
  "medium_profile": [
    {
      "subject_or_style": "A subject or treatment with medium-specific evidence",
      "fit": "stronger_elsewhere",
      "preferred_medium": "video",
      "transferable_qualities": ["Pacing or style signals that still help text ranking"],
      "basis": "observed",
      "confidence": 0.0
    }
  ],
  "entertainment_profile": {
    "role_in_ranking": "How enjoyment compares with learning, utility, and importance.",
    "rewarding_forms": ["Evidence-backed forms of entertainment in text"],
    "basis": "inferred",
    "confidence": 0.0
  },
  "exploration_profile": {
    "frequency": "occasional",
    "execution_override_strength": 0,
    "unfamiliar_topic_quality_bar": "The bar an unfamiliar topic must clear.",
    "override_conditions": ["What can make weak topic relevance succeed"],
    "basis": "inferred",
    "confidence": 0.0
  },
  "professional_personal_boundary": {
    "enjoyed_overlap": ["Professional areas I also genuinely enjoy reading"],
    "useful_but_not_personal": ["Material that may be useful but should not dominate Sift"],
    "guidance": "How to resolve usefulness versus genuine interest.",
    "basis": "inferred",
    "confidence": 0.0
  },
  "style_references": [
    {
      "name": "Creator, work, or publication",
      "relationship": "style_reference",
      "qualities": "Transferable qualities, without assuming direct text interest.",
      "confidence": 0.0
    }
  ],
  "examples": [
    {
      "kind": "explicit_positive",
      "title_or_description": "Only a genuinely available example",
      "reason": "What the example reveals about ranking tradeoffs",
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
  "interest_anchors": [
    {
      "id": "lowercase_snake_case",
      "category": "A broad grouping useful to Sift",
      "description": "An article-shaped semantic description of a desirable recommendation, more specific than a topic label."
    }
  ],
  "avoid_anchors": [
    {
      "id": "lowercase_snake_case",
      "description": "An article-shaped semantic description of content to avoid or strongly downrank."
    }
  ],
  "source_candidates": [
    {
      "name": "Creator or publication",
      "domain": "example.com",
      "disposition": "recommended",
      "role": "selective",
      "content_areas": ["Main relevant areas"],
      "caveats": ["Noise, paywall, language, redundancy, or verification concerns"],
      "reason": "Why this source fits this person specifically.",
      "basis": "inferred",
      "confidence": 0.0
    }
  ],
  "ranking_guidance": {
    "strong_positive_signals": ["Signals that should materially lift an article"],
    "moderate_positive_signals": [],
    "weak_positive_signals": [],
    "strong_negative_signals": ["Signals that should materially lower an article"],
    "hard_filters": ["Only genuinely hard constraints supported by evidence"],
    "override_rules": ["When quality, importance, age, novelty, or topic fit should override another signal"],
    "interaction_effects": ["Combinations more informative than their individual signals"],
    "source_level_guidance": ["How source affinity should and should not affect article ranking"],
    "duplication_and_saturation": ["Story, topic, author, and source diversity rules"]
  },
  "contradictions": [
    {
      "tension": "A useful unresolved preference tension",
      "conditions": "When each side appears to apply",
      "confidence": 0.0
    }
  ],
  "uncertainties": ["Unknowns that could materially change recommendations"],
  "privacy_redactions": ["Kinds of potentially relevant information deliberately omitted"]
}

Allowed values:

- interest `tier`: `core`, `high_selective`, `conditional`, `low`, `unwanted`;
- `medium_fit` and medium `fit`: `text_specific`, `cross_medium`,
  `stronger_elsewhere`, `unknown`;
- evidence `basis`: `explicit`, `observed`, `inferred`;
- quality `strength`: `strong`, `moderate`, `weak`;
- `archival_appetite`: `low`, `selective`, `high`, `unknown`;
- medium `preferred_medium`: `text`, `video`, `podcast`, `books`,
  `academic_papers`, `any`, `unknown`;
- exploration `frequency`: `rare`, `occasional`, `frequent`, `unknown`;
- style `relationship`: `known_favorite`, `style_reference`,
  `medium_reference`;
- example `kind`: `explicit_positive`, `explicit_negative`, `behavioral`,
  `reference`;
- source `disposition`: `known_favorite`, `recommended`, `exploratory`, `avoid`;
- source `role`: `direct_follow`, `selective`, `discovery_only`, `wildcard`.

For non-null assistant hints, use `{ "value": ..., "confidence": 0.0 }`.
Allowed hint values are:

- `attention_budget`: `under_15`, `15_30`, `30_60`, `60_plus`, `variable`;
- `article_length`: `mostly_short`, `medium`, `long_when_exceptional`, `any`;
- `paywall_policy`: `free_only`, `subscribed_publications`, `readable_only`,
  `quality_first`;
- `freshness_balance`: `timely`, `balanced`, `evergreen`;
- `serendipity`: a number from `0` to `10`;
- each `medium_preferences` item: `subject`, `preferred_medium` (`text`,
  `video`, `podcast`, or `any`), `strength` (`prefer` or `strongly_prefer`),
  and `confidence`.

Use priorities from `0` to `10` and confidence from `0` to `1`. Keep the final
profile operationally concise. If evidence is sparse, return a sparse profile;
do not compensate with generic advice or guesses.
