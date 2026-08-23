# Sift

> Continuing development from the August 2026 implementation session? Start
> with [`docs/SESSION-HANDOFF.md`](docs/SESSION-HANDOFF.md), then read
> `CLAUDE.md` for engineering invariants.

A private, AI-assisted editorial desk for the internet. It sits between public
RSS/podcast feeds, bounded Hacker News discovery, Product Hunt and Reeder, and
turns a few hundred items a day into a handful worth your attention.

Reeder stays the reading interface. Sift builds no reader UI.

It optimises for one question — **"was I glad I spent attention on this?"** — not
for clicks. Opening an article is treated as a weak signal; "Excellent" and "Not
for me" are the strong ones; and no amount of engagement can teach it that
ragebait is desirable.

---

## How it works

Seven stages. Each spends more per item than the last, and each only sees what
earned the right to be there.

```text
1  AGGREGATION          FREE       "what was published?"
        │                          public sources, normalised and persisted, no judgement
        ▼
2  RULE FILTERING       FREE       "what is obviously not worth considering?"
        │                          deterministic, high-precision, conservative
        ▼
3  FREE RANKING         FREE       "what deserves computational attention?"
        │                          12 stored components → free_score → bands A/B/C/D
        ▼
4  LUNA  (gpt-5.6-luna) CHEAP      "what plausibly deserves human attention?"
        │                          advises; deterministic code decides
        ▼
5  TERRA (gpt-5.6-terra) EXPENSIVE "what genuinely deserves human attention?"
        │                          full article text, 19 independent dimensions
        ▼
6  FINAL RANKING        FREE       "what combination makes the best edition?"
        │                          portfolio construction, not a ranked slice
        ▼
7  GENERATED FEEDS  →  Reeder  →  opens + tags  →  slow, bounded learning
```

The principle: **spend progressively more computation only as an item earns the
right to receive more attention.** And the constraint that shapes everything else:

> Source weighting and heuristics control how much opportunity content gets to
> *request*. They must not override high-quality article-level judgment.

So a source's prior extends modest opportunity at stage 3, less at the stage-4
gate, and almost nothing at stage 6 — by which point Terra has read the article.
No single model controls the final feed: Terra identifies excellent candidates,
and deterministic portfolio construction decides which combination reaches you.

Every stage writes down what it decided and why, so both questions are answerable
from the database alone:

```text
$ npm run inspect -- --item <id>

WHY DID THIS REACH ME
  AI agents can't yet do open-ended AI research
  stage 2 rules: keep (v3)
  stage 3 free:  0.564 band B  quality=0.84 cat=1.00 sem=0.13 kw=0.33 fresh=0.65
  stage 4 Luna:  UNCERTAIN → passed (serendipity candidate)
  stage 5 Terra: expected_attention_value 0.74
  stage 6:       ai_product final=0.687 published
                 essential  final=0.594 < min_score 0.72
                 serendipity gate: anchor_distance 0.50 < min_distance 0.52

WHY DID THIS DISAPPEAR
  X's Algorithm Feeds Off Ragebait and Impacts Democrats More
  stage 3 free:  0.418 band C — category prior 0.35, volume penalty 0.75
  stage 4 Luna:  never called
```

## Quick start

### If you have never used a terminal

You need three things, in this order. It takes about fifteen minutes.

1. **Install Node.js.** Go to <https://nodejs.org>, download the version marked
   **LTS**, open the installer, and accept the defaults. Sift needs version 22
   or newer; the LTS download is always newer than that.
2. **Open Sift.** In Finder, open the Sift folder, then the `mac` folder, and
   double-click **Sift.command**.

   The first time, macOS will refuse to open it — it says the file is from an
   unidentified developer. This is expected for any app not bought from the App
   Store. To get past it: **right-click** (or Control-click) `Sift.command`,
   choose **Open**, then choose **Open** again in the dialog. You only have to
   do this once.

   The first run downloads what Sift needs and takes a minute or two. Leave the
   black Terminal window open — closing it stops Sift.
3. **Set up a reader in the browser** that opens. The screens walk you through
   it. You will need a free ChatGPT account for the first step, and an OpenAI
   API key for the third — Sift's dashboard explains how to get one.

Sift runs entirely on your Mac. Nothing you read is sent anywhere except the
article text Sift shows the AI service you choose.

### Mac: Sift Home

If you already have Node.js and a terminal open:

```bash
npm run ui
```

It opens <http://127.0.0.1:8790> and provides:

- guided personal-ChatGPT dossier import;
- the skippable reading-preferences wizard and approval preview;
- optional calibration on real ranked articles after the first recommendation run;
- private AI-provider setup: API keys are stored only in the profile `.env`, never rendered back into the dashboard or job logs;
- guided local, static-hosting, and Cloudflare publishing paths;
- profile/database status and exact RSS subscription links;
- safe buttons for database setup, a free dry test, recommendation updates, and
  source-feed discovery;
- live output for long-running actions.

Alternatively, double-click `mac/Sift.command` in Finder. On its first run it
installs the pinned dependencies from the public npm registry, then opens Sift
Home. The UI binds only to `127.0.0.1`, uses a per-process form token, and does
not expose Cloudflare publishing, feedback mutation, or destructive database
commands. Those remain explicit terminal operations.

Set `SIFT_UI_PORT` or pass `npm run ui -- --port 8791` when port 8790 is already
in use.

### Terminal onboarding

For a new reader, onboarding has three explicit stages: transfer what their
personal ChatGPT already knows, confirm Sift's practical reading settings, then
approve the compiled profile before anything is created.

```bash
npm ci --registry=https://registry.npmjs.org/
cp .env.example .env                    # choose the AI provider; keep secrets local
npm run onboard                         # prints the personal-ChatGPT dossier prompt
# Save ChatGPT's final JSON response, then:
npm run onboard -- --profile alice --from ~/Downloads/sift-profile.json
```

The explicit public registry keeps installation portable when a work computer
sets `NPM_CONFIG_REGISTRY` to a private company mirror. If installation fails,
do not continue to onboarding: commands such as `tsx` will be unavailable until
`npm ci` completes successfully.

The ChatGPT prompt asks at most three high-information taste/source questions.
Its dossier v3 models attention selection rather than producing a generic
interest summary: interest tiers, topic-versus-execution tradeoffs, source roles,
medium boundaries, freshness, depth, duplication, and evidence confidence all
compile into ranking inputs. It does not ask the generic operational questions
Sift owns. The CLI then confirms attention budget, length, paywalls, languages,
freshness, serendipity, preferred voices, and subject-specific medium choices.
Use `--skip-preferences` for conservative Sift defaults or `--preferences-file
FILE` for a reviewed JSON configuration.

Before writing a profile, token, or database path, Sift prints a readable preview
of the compiled interests, preferences, source candidates, confidence, and
uncertainties. Type `approve` to continue. For automation, first run `--preview`,
then rerun with `--approve` only after reviewing the same inputs:

```bash
npm run onboard -- --profile alice --from ./dossier.json --preview
npm run onboard -- --profile alice --from ./dossier.json --approve
```

The approved profile becomes a private `profiles/alice` overlay and receives a
unique feed token. Calibration deliberately happens later: run the first real
recommendation update, read some results, then use Sift Home or
`npm run calibrate -- --profile alice` to rate the actual articles. Unread items
do not affect the profile.
ChatGPT memory is an evidence source, not complete ground truth; Sift keeps
confidence/provenance in the original dossier and compiles only bounded ranking
inputs. See the [official OpenAI memory guidance](https://learn.chatgpt.com/docs/customization/memories).

ChatGPT returns source names, domains, reasons, dispositions, and roles—not RSS
URLs. Sift records these in `source-candidates.json`. A direct follow can receive
a small bounded source prior when it matches an already validated `sources.yaml`
entry; selective sources receive a smaller prior, while discovery-only and
wildcard sources receive none. Unmatched candidates remain inactive until their
real feed is discovered and checked. After approval, run:

```bash
npm run sources:discover -- --profile alice
```

Discovery uses Sift's public-network/redirect safety checks, inspects advertised
RSS/Atom links and common feed locations, and confirms that candidate feeds
contain parseable entries. It writes `source-discovery.json`; it never silently
edits `sources.yaml`.

Then configure the provider in the checkout-wide `.env` and initialize the
profile:

```bash
npm run db:setup -- --profile alice
npm run doctor -- --profile alice  # verifies setup and prints exact Reeder URLs
```

Try the whole pipeline with **no API key and no cost** first — `SIFT_DRY_RUN=1`
runs every stage with deterministic stub scores, so you can see the plumbing work:

```bash
SIFT_DRY_RUN=1 npm run pipeline
```

Then for real, starting small:

```bash
npm run pipeline -- --sources quanta,simon_willison,interconnected,citation_needed
npm run serve
```

Open <http://localhost:8787/admin?t=YOUR_TOKEN>, check what happened, then add
the rest:

```bash
npm run pipeline          # all sources
```

Subscribe in Reeder to whichever of these you want:

```text
http://localhost:8787/feed/essential.xml?t=YOUR_TOKEN
http://localhost:8787/feed/ai-product.xml?t=YOUR_TOKEN
http://localhost:8787/feed/ideas-science.xml?t=YOUR_TOKEN
http://localhost:8787/feed/games.xml?t=YOUR_TOKEN
http://localhost:8787/feed/culture.xml?t=YOUR_TOKEN
http://localhost:8787/feed/serendipity.xml?t=YOUR_TOKEN
```

Add `.rss` instead of `.xml` for RSS 2.0, or `.json` for JSON Feed 1.1.

### Account-free local AI

Sift can use Ollama without an API key or hosting account. Install Ollama, pull
chat and embedding models, then set the provider and role models in `.env`:

```bash
ollama pull qwen3:8b
ollama pull nomic-embed-text

SIFT_AI_PROVIDER=ollama
SIFT_TRIAGE_MODEL=qwen3:8b
SIFT_DEEP_MODEL=qwen3:8b
SIFT_EMBEDDING_MODEL=nomic-embed-text
```

Run `npm run doctor`; it detects the Ollama endpoint and reports which configured
models are installed. This is a genuine zero-account path, but it is a
compatibility mode, not the reference-quality preset: the current Sift prompts
and thresholds were calibrated with the cloud models in `config/models.yaml`.
Use the audit and replay commands before trusting a different model configuration.

### Provider and hybrid modes

`SIFT_AI_PROVIDER` accepts `openai`, `ollama`, `openrouter`, `groq`, `gemini`,
`anthropic`, or `custom`. The chat client is resolved separately for triage,
deep ranking and embeddings, so a local/cloud hybrid does not require code
changes:

```bash
SIFT_TRIAGE_PROVIDER=ollama
SIFT_TRIAGE_MODEL=qwen3:8b
SIFT_DEEP_PROVIDER=openai
SIFT_DEEP_MODEL=gpt-5.6-terra
SIFT_EMBEDDING_PROVIDER=ollama
SIFT_EMBEDDING_MODEL=nomic-embed-text
```

For a custom OpenAI-compatible endpoint, set `SIFT_<ROLE>_BASE_URL` and
`SIFT_<ROLE>_API_KEY`. Provider-specific batch APIs are deliberately not assumed;
Sift uses batch only with the OpenAI preset and otherwise falls back to normal
requests. Ollama usage is always recorded at $0; for other hosted models, update
the `cost_per_1m_*` fields in `config/models.yaml` so the spend guard remains
truthful.

### Static feeds: compute and hosting are independent

An always-running Sift server is optional. After a pipeline run, materialise
Atom, RSS and JSON Feed files with direct publisher links:

```bash
npm run export -- --public-url https://YOUR-STATIC-HOST --output public
```

This writes `public/feed/*.xml`, `.rss` and `.json` atomically, plus an
`index.txt` containing the exact subscription URLs. The directory can be served
locally or published by GitHub Pages, a web server, NAS, or any static host.
Static feeds are public at their host URL and cannot record opens; explicit
Reeder feedback polling remains available as a separate optional path.

### Separate personal profiles

Generated profiles are private overlays on the neutral defaults in `config/`.
Each gets a separate database, feed token, calibration evidence, and review
state:

```bash
npm run pipeline -- --profile alice
npm run serve -- --profile alice
```

Profile directories and databases are gitignored. The distributable checkout
contains only `profiles/example`; `npm run share-check` verifies the expected
privacy boundaries and performs a basic secret scan. `npm run share-package`
creates a reviewed npm tarball that excludes `.env`, databases, generated feeds,
private profiles, and the live `worker/wrangler.toml`. Use this tarball rather
than zipping the working directory. A generated profile leaves
Cloudflare identifiers blank deliberately: create/configure a separate KV
namespace before publishing that person's feeds. Never point two profiles at
the same unscoped KV keys.

Seven days after onboarding, run the evidence-backed review:

```bash
npm run review -- --profile alice
```

It reports volume, explicit feedback, repetition, and source/category dominance;
asks whether Sift feels narrow, noisy, repetitive, or incomplete; and shows an
exact profile proposal. Nothing changes unless the reader types `apply` (or uses
`--apply`). Use `--force` to run the review before day seven.

This is process-level isolation for a few trusted users, not a multi-tenant
service: the schema still has no `profile_id`, and credentials, scheduling,
feedback and publication remain deployment concerns per profile.

---

## Commands

| Command | What it does |
| --- | --- |
| `npm run db:setup` | Create the database, mirror `sources.yaml` into it |
| `npm run db:reset` | Delete and recreate the database |
| `npm run doctor` | Check provider/model setup and print exact Reeder URLs |
| `npm run onboard` | Print the ChatGPT handoff prompt or create an isolated profile from its JSON dossier |
| `npm run calibrate` | Rate real ranked recommendations after a pipeline run |
| `npm run review` | Run the first-week evidence report and approval-gated profile update |
| `npm run ui` | Open the localhost-only Sift Home interface for Mac onboarding and routine use |
| `npm run share-check` | Verify distributable files, ignores, and common secret patterns |
| `npm run share-package` | Create a tarball that excludes all private/runtime material |
| `npm run sources:discover` | Safely discover and validate feeds for an approved profile's source candidates; report only |
| `npm run check-sources` | Verify every feed URL still resolves and parses |
| `npm run classics` | Refresh archival discovery, verify access, selectively rank, and publish at most one Classic |
| `npm run ingest` | Fetch feeds + hard filter. Free: no model calls |
| `npm run process` | Embed → triage → cluster → extract → deep score → route |
| `npm run publish` | Route already-scored items and resolve alternate formats |
| `npm run export` | Atomically write static Atom/RSS/JSON feeds for any static host |
| `npm run pipeline` | Everything, in order. This is what cron runs |
| `npm run serve` | Serve the generated feeds and the admin view |
| `npm run dev` | Same, with reload on change |
| `npm run feedback` | Poll the Reeder feedback feeds |
| `npm run learn` | Apply one slow learning round (`-- --dry` to preview) |
| `npm run audit` | False-negative audit (`-- --run 20` to sample more) |
| `npm run push` | Render feeds and upload them to Cloudflare KV (`-- --dry` to preview; `-- --feed classics` to scope the upload) |
| `npm run pull` | Copy open events recorded at the edge into the local database |
| `npm run cycle` | `pipeline && push && pull` — what a scheduled job runs |
| `npm run funnel` | The seven-stage funnel, survival rates, cost per outcome, false-negative audit |
| `npm run bands` | Free-score distribution and whether the bands are actually filtering |
| `npm run budget` | Month-to-date spend, degradation stage, Terra allocation, false-negative rates (`-- --breakdown` for what kinds of item get dropped) |
| `npm run replay` | Replay the stored corpus at different monthly budgets. No model calls |
| `npm run cluster:stats` | Clustering health and sample clusters (`-- --rebuild` to re-cluster after tuning) |
| `npm run cluster:eval` | Same-story precision/recall against the labelled pair set (`-- --sweep` for the curve) |
| `npm run cluster:pairs` | Regenerate the labelled pair fixture (makes cheap model calls) |
| `npm run stats` | Per-source rates, spend, cheap-stage audit |
| `npm run inspect` | Browse items from the terminal |
| `npm test` | 385 tests, no network or API calls |
| `npm run typecheck` | Strict TypeScript check |

Useful flags:

```bash
npm run pipeline -- --sources quanta,kottke     # a subset of sources
npm run pipeline -- --max-deep 10               # cap the expensive stage
npm run pipeline -- --skip-publish              # score but do not publish
npm run inspect -- --status rejected_cheap      # what the cheap stage dropped
npm run inspect -- --feed essential             # what is in a feed, and why
npm run inspect -- --item <item-id>             # everything about one item
npm run stats -- --days 30
```

---

## Spend is a system constraint, not a metric

Terra is ~98% of the bill, so "budget" means, almost entirely, how many deep
evaluations get bought and which ones. `config/budget.yaml` holds both, plus the
two operating modes.

```yaml
mode: calibration        # or steady_state; SIFT_MODE overrides

modes:
  calibration:           # temporary: buys audit coverage to measure the funnel
    monthly_target_usd: 15
    free_reject_audit_rate: 0.20
    luna_reject_audit_rate: 0.15
  steady_state:          # the intended resting state
    monthly_target_usd: 10
    free_reject_audit_rate: 0.05
    luna_reject_audit_rate: 0.05
```

**Measured, not assumed.** At the observed arrival rate (~54 raw items/day, 25%
reaching Terra) and the measured $0.0099 per Terra call, giving *every* eligible
item a deep evaluation costs about **$4.50/month**. The $10 target is therefore
roughly 2× headroom rather than a cut that bites today. `npm run replay` shows
where it does start to bite:

| monthly budget | published retained | good retained |
| -------------: | -----------------: | ------------: |
| $1  | 45%  | 29%  |
| $2  | 68%  | 55%  |
| $3  | 86%  | 81%  |
| $4  | 100% | 93%  |
| $5+ | 100% | 100% |

### Degradation, not failure

As spend rises the bar for a Terra call rises with it — `min_opportunity` in the
degradation ladder. At the hard limit, only Essential candidates, Serendipity and
audit samples still buy a call.

Nothing is ever rejected for want of budget. Items that miss the cut keep their
`triaged` status and are reconsidered next run, until they age out by content type
(`requeue_max_age_hours`: news 72h, essays 1440h). This is deliberate: an earlier
version *did* flip such items to rejected and stranded 60 qualified articles
permanently, because nothing downstream ever read that state again.

### The Terra opportunity score

A deterministic pre-Terra score answering "how much upside is there in paying for
a deep look at this?" — Luna's interest and novelty, the free score, source
prior, cluster differentiation, `feed_need`, Serendipity potential, minus source
and topic saturation. It allocates money; it never reaches the final ranking and
never decides what publishes.

`feed_need` is what makes spend follow scarcity: a borderline Games item is worth
evaluating when Games is empty, and an excellent AI item is worth less when the
edition already has five.

### Batch or sync+cache?

Both discounts are real and they do not compose — the batch API does not apply
prompt caching. Measured at the observed token shape, **batch wins**: its flat 50%
beats caching's effective 44%, because the cacheable prefix is only ~70% of input
and cached tokens still cost a tenth. So batch is kept and no routing layer was
built for a saving that does not exist. The comparison is printed by
`npm run budget` so it stays checkable if prices or prompt sizes change.

---

## Clustering, and what it is for

Clustering exists to suppress duplicated information without suppressing
diversity of thought. Those are different problems and it treats them separately.

**Story identity** is decided by weighted cheap signals — no model call. Fitted by
grid search with 4-fold cross-validation against
`tests/fixtures/cluster-pairs.json`, 201 real article pairs labelled into
`SAME_STORY_DUPLICATE` / `SAME_STORY_DIFFERENT_PERSPECTIVE` /
`RELATED_TOPIC_DIFFERENT_STORY` / `UNRELATED`.

Embedding similarity alone caps out at F1 0.68 on that set, because same-story
and related-topic pairs overlap heavily (medians 0.727 vs 0.662). No single
threshold separates them, which is why the previous single-threshold design sat at
0.845 and matched 5 of 92,644 real pairs — clustering was inert. The current
configuration scores **precision 0.78, recall 0.77, and merges zero UNRELATED
pairs**.

Entity, title and gist signals are deliberately *not* in the primary score:
adding them measurably reduced F1 from 0.806 to 0.742. They are the fallback path
for items with no embedding.

**Perspective identity** is a second, separate question: given that two items are
one story, does the second still add something? Cheap signals separate this
poorly (best balanced accuracy 0.69), so it is tuned asymmetrically on purpose —
losing a genuinely different take costs more than letting a duplicate through. At
the shipped settings it retains **86% of different-perspective pairs while still
suppressing 44% of duplicates**.

Every signal behind a cluster decision is stored, so `/admin/cluster-samples`
answers "why were these considered one story?"

### source_uniqueness is currently switched off

It is derived from how often a source's items cluster with other sources'. While
clustering was inert every source looked perfectly unique, and the component
contributed a near-constant 0.15 to every free score — 15% of the weight
measuring nothing. It is now `0.00`, with the freed weight moved to
`semantic_interest`, which is measured and reads the actual words.

`npm run cluster:stats` reports whether it is calibrated yet. Three conditions
must hold: enough multi-item clusters, a high enough multi-item rate, and few
enough sources still sitting on the 0.5 prior with no evidence at all. Restore the
weight to ~0.15 only when it says yes.

---

## Measuring what the funnel throws away

False negatives cost more than false positives here, which makes "what good
things are we discarding?" the most important number in the system. It was also
unmeasurable: eight free-stage and two Luna-stage audit samples had accumulated,
and nothing read them.

Calibration mode samples rejects at 20% (free→Luna) and 15% (Luna→Terra), and
audit traffic gets a protected share of the Terra budget (`calibration_share`) so
spend pressure cannot quietly switch off the only measurement of the funnel's
mistakes. Audit items never publish automatically; the system records whether they
*would have*.

`npm run budget -- --breakdown` groups misses by source, category, band, content
type, article length, source prior, semantic interest and Serendipity status —
because "we drop 12% of good items" is far less actionable than "we drop long
essays from low-prior sources".

The report refuses to state a rate below ~30 resolved observations per boundary,
which is honest rather than helpful, and is why calibration mode exists.

---

## The nine config files

Nothing that affects editorial outcomes lives in application code. Every
threshold, weight, curve and cap is a file you can edit, and the content hash of
each is recorded with every AI judgement and every ranking decision, so results
stay comparable across changes.

| File | Stage | What it controls |
| --- | --- | --- |
| `sources.yaml` | all | who we read, and how much opportunity each source gets |
| `taste-profile.yaml` | 3,4,5 | who you are; the anchors the semantic scoring uses |
| `free-ranking.yaml` | 2,3 | rule filters, free-score weights, bands, freshness curves |
| `models.yaml` | 4,5 | Luna and Terra, reasoning effort, semantic provider |
| `final-ranking.yaml` | 4,5,6 | gating thresholds, diminishing returns, attention |
| `feed-config.yaml` | 6,7 | the six feeds, each with its own goal |
| `pipeline.yaml` | — | mechanics: fetching, extraction, clustering, learning |
| `budget.yaml` | 5 | monthly spend limits, operating mode, audit rates, Terra allocation |
| `classics.yaml` | archive | historical discovery pools, archival quality bar, diversity and one-per-day publishing |

### The source model

A source is not one weight:

```yaml
- id: quanta
  quality_prior: 0.92      # how likely an item here deserves a closer look
  volume_budget: 1.0       # how much attention it may *request*
  exploration_floor: 0.08  # keeps a quiet source from vanishing permanently
  category_priors:
    ideas_science: 1.00    # excellent on science
    default: 0.35          # unproven elsewhere
  feed_weights:
    essential: 0.85
    ideas_science: 1.00
    serendipity: 0.30
```

`quality_prior` is what you set. Learned statistics live separately in
`source_statistics` and never overwrite it — the two are combined at scoring time.

Mixed-access publications fail closed. They are publishable only when their
source config enables both `require_explicit_free_article` and
`require_readable_article`. Sift fetches the canonical page without signing in,
requires schema.org `isAccessibleForFree: true`, and then requires a full body
from Readability. A paid declaration, missing declaration, teaser, RSS fallback,
or short extraction becomes `rejected_access`; none reaches Terra or a feed.

### Sift Classics

Classics is a parallel archival lane rather than another daily-feed score. It
discovers historical candidates from year-bounded Hacker News search and the
public Longreads editorial archive, with an explicit seed hook for awards,
author recommendations and targeted research. Popularity is only a discovery
prior. Candidates are deduplicated against every previously published/opened
Sift URL, fetched without authentication, required to yield a full English
Readability body, and rejected on explicit paid/subscriber metadata or text.

Only a small, source/era-diversified subset reaches `gpt-5.6-terra` under the
versioned Classics prompt. Its deterministic score strongly weights analysis,
storytelling, voice, entertainment, obsessive expertise, rabbit-hole potential
and enduring value; topic fit and historical popularity are deliberately small.
The model separately predicts whether the reader will start an article and whether the
read will produce a 9/10-or-better payoff, so worthy homework and clickable
disappointments cannot hide behind one blended score. At most one
item is published per day to `/feed/classics.xml` (also `.rss` and `.json`). The
feed timestamp is Sift's recommendation time; the original date is displayed in
the item and retained separately in JSON Feed metadata.

### Stage 3: the free score

Eleven components, each stored per item rather than folded into one number:

```json
{ "source_quality_prior": 0.84, "category_prior": 1.00,
  "keyword_interest_score": 0.33, "semantic_interest_score": 0.13,
  "freshness_score": 0.65, "editorial_type_score": 0.55,
  "source_uniqueness_score": 0.50, "source_volume_penalty": 0.00,
  "redundancy_penalty": 0.00, "clickbait_penalty": 0.00,
  "negative_interest_penalty": 0.00, "free_score": 0.564, "band": "B" }
```

Weights are normalised by their own total, so the positive part lands in 0..1 and
band thresholds keep their meaning after a retune. Bands decide who costs money:
**A** always goes to Luna, **B** goes while the run's budget lasts, **C** is
rejected but audit-sampled, **D** is rejected.

**Recalibrate the bands whenever you change the weights** — the weights change the
shape of the distribution:

```bash
npm run bands
```

Calibrated 2026-08-19 against a real 553-item run with live embeddings:
A 12.5%, B 32.4%, C 27.1%, D 28.0% — 44.8% reach Luna.

Recalibration affects future items only. Bands already stored keep the config hash
they were decided under, so past decisions stay interpretable rather than being
retroactively rewritten.

### Freshness depends on content type

One global decay curve would be wrong. A games-history piece is not stale at three
weeks; a hardware rumour is stale in a day:

```yaml
news:      { half_life_days: 1.0,   expires_after_days: 5 }
analysis:  { half_life_days: 21.0,  expires_after_days: null }
essay:     { half_life_days: 90.0,  expires_after_days: null }
history:   { half_life_days: 365.0, expires_after_days: null }
```

Only types with an `expires_after_days` can be dropped as stale, so an essay is
never discarded for being three weeks old.

### Diminishing returns, not caps

The old build capped sources ("never more than 3 from Quanta"), which threw away
an excellent fourth item for nothing. Now each further item from the same source
competes at a discount:

```yaml
source_diminishing:
  decay: [1.00, 0.90, 0.75, 0.55, 0.40, 0.28]
  tail: 0.20
  hard_cap_per_feed_per_day: 6      # final safety valve only
```

The same shape applies to repeated topics, and much more steeply to repeated
stories — where the penalty is scaled by Terra's `duplicate_information`, so a
recap is suppressed while a genuinely different take survives.

### Attention budgets

One article is not one article. Feeds are sized in minutes as well as items:

```yaml
essential:     { daily_cap: 8,  attention: { minutes_per_day: 45 } }
ideas_science: { daily_cap: 10, attention: { minutes_per_day: 60 } }
```

A 35-minute essay costs what four short posts cost. Reading time comes from the
extracted word count where available, then Terra's estimate, then the enclosure
duration, then a default.

## Prompts

`prompts/*.md` — versioned Markdown with front matter, never inline strings.
`{{PLACEHOLDER}}` tokens are filled from the taste profile and feed config.

- `cheap-triage-v3.md` — recall-first triage. Explicitly instructed that false
  positives are cheap and false negatives are permanent.
- `deep-ranking-v4.md` — article-level editorial judgement across topic fit,
  independent craft/quality traits and headline sufficiency, plus the concrete
  `why_it_surfaced` line.
- `story-comparison-v1.md` — duplicate reporting vs genuinely different take.

To iterate: copy to `-v2.md`, edit, and point `ranking-config.yaml` at it
(`triage.prompt` / `deep.prompt`). Old evaluations keep their version, so you can
compare before and after.

---

## Explicit feedback from Reeder

Opens are recorded automatically through the tracked `/open/<id>` redirect (item
id, feed, URL, timestamp — nothing about the device, and one open per item per
day). That is a **weak** signal.

For strong signals, Reeder needs to hand items back. Create a tag or shared feed
per signal and point Sift at its URL:

```bash
# in .env
SIFT_FEEDBACK_EXCELLENT_URL=https://.../reeder-shared-excellent.xml
SIFT_FEEDBACK_NOT_FOR_ME_URL=https://.../reeder-shared-not-for-me.xml
```

```bash
npm run feedback
```

Matching works three ways in order: our own tracked link (the item id is in the
URL), the canonical article URL, then a strong title match. A weak title match is
refused — mislabelling the wrong article as "not for me" is worse than losing the
signal. Unmatched entries are kept and listed so you can see what did not stick.

If Reeder's sharing options do not suit you, record feedback directly:

```bash
npm run feedback -- --item <item-id> --signal excellent
npm run feedback -- --item <item-id> --signal not_for_me --note "too long"
```

The integration is deliberately isolated in `src/feedback/reeder.ts`, since
Reeder's capabilities may change.

---

## Learning

`npm run learn` applies one slow round. It adjusts source priors, category
priors and interest-anchor weights by at most `learning_rate` (0.04) per round,
never past the configured bounds, and only once a key has `min_events_before_update`
(8) events behind it. Every round writes a snapshot to `taste_profile_versions`.

Three rules are enforced in code, not prompt text:

1. **An open is weak.** Explicit feedback outweighs it ~7×.
2. **Clicking ragebait teaches nothing.** Opens on items scoring above
   `ignore_opens_when_ragebait_above` are discarded, not learned from.
3. **Editorial penalties have floors.** `protected_penalties` can never be
   learned into positives.

Plus a 20% exploration budget (`learning.exploration_fraction`) so behavioural
personalisation cannot collapse the system onto what it already knows you like.

Preview before applying: `npm run learn -- --dry`.

---

## Diagnostics

`npm run stats` and `/admin` answer, from stored data:

- how many items were ingested, hard-filtered, triaged, deep-scored, published
- which sources produce recommendations, and which never do
- which categories dominate
- how many multi-item story clusters exist
- what you opened, and what you marked excellent or not-for-me
- **the false-negative rate at both boundaries**, from random samples of rejects:
  how often Luna finds good items among free-ranker rejects, and how often Terra
  finds excellent items among Luna's rejects. Audit items never enter a feed
  automatically — the point is measurement, not rescue. `npm run funnel` shows both,
  and names the exact knob to loosen if a rate is high.
- current estimated API spend (today / 30 days / all time, by stage and model)

`/admin/item/<id>` shows one item end to end: cheap scores, deep scores, every
routing decision with its reason, cluster siblings, alternate formats, extracted
text and the raw model output.

---

## Costs

The funnel is the cost control: hard rules → embeddings → cheap model → deep
model only for what survives.

Measured, not estimated. The 45 configured sources publish **52 items/day** on
average (from real publication dates), and per-item costs at the configured
models with caching engaged are $0.000128 (triage) and $0.004439 (deep):

| Triage pass rate | Deep evals/day | Cost/month |
| --- | --- | --- |
| 20% | 10 | ~$1.60 |
| 35% | 18 | ~$2.65 |
| 50% | 26 | ~$3.70 |
| 75% | 39 | ~$5.45 |

Plus a one-off ~$0.61 to work through the 14-day backlog on first run. Note that
run frequency does *not* multiply this: every item is evaluated exactly once,
which is what the idempotency guarantees buy.

- `SIFT_MAX_SPEND_PER_RUN` is a hard ceiling. Hitting it ends the run cleanly;
  work already done is committed and the next run continues.
- `deep.mode: auto` uses the provider's batch API when the queue reaches
  `batch_min_items` (usually ~50% cheaper). Latency does not matter here.
  Submitted batches are tracked in the database, so a crash mid-batch loses
  nothing — the next run collects the results. If the endpoint has no batch API,
  it falls back to sync calls automatically.
- **Prompt caching is the biggest lever.** The system prompt (your taste
  profile) is byte-identical on every call and sits at the front of each
  request, so the provider serves it from cache. Measured on a real run:
  **92% of triage input tokens and 93% of deep input tokens** came from cache.
  `npm run stats` shows the hit rate per stage — if it reads 0% at any volume,
  something has broken it. The usual cause is a shorter taste profile dropping
  the prompt below the provider's minimum cacheable length; set
  `cost_per_1m_cached_input` in `models:` so the saving shows up in the estimate.
- Embeddings are content-hashed: re-running never re-embeds unchanged text.
- Extraction is cached for `cache_ttl_days`.
- Model ids, reasoning effort and prices live in `config/ranking-config.yaml`
  under `models:`. Nothing in the business logic depends on a specific model.

---

## Which database am I using?

One file per environment, decided in one place:

| `SIFT_ENV` | Database |
| --- | --- |
| `production` | `data/sift.db` |
| `development` (default) | `data/sift-dev.db` |
| `test` | `:memory:` |

`SIFT_DB_PATH` still overrides everything — that is how the replay and migration
tools point at a copy. Every process logs the file it opened on startup, and warns
if another populated `.db` is sitting beside it.

This exists because `data/sift.db` and `data/dev.db` once diverged for an entire
session, with the pipeline writing one while the admin server read the other. The
UI showed a stale funnel and nothing said so.

---

## Deployment

Sift deploys as two pieces, for a reason worth knowing before you start.

**The curation pipeline cannot run on Cloudflare Workers.** Two hard blockers,
both verified against the current docs:

- `node:sqlite` is a *non-functional stub* in the Workers runtime, and so is
  `node:vm` — which jsdom needs. So neither the database nor Readability works.
- Cloudflare Containers would run the Node image, but *"all disk storage is
  ephemeral… the next time it is started, it will have a fresh disk as defined by
  its container image."* SQLite has nowhere to live. (Snapshots are "coming
  soon".)

A full Workers port would mean migrating the whole synchronous data layer to D1
and replacing Readability with something weaker — worse output, much more code.

So the split is: **Cloudflare serves, Node curates.**

```text
   the machine with a disk                      Cloudflare (wrangler)
 ┌──────────────────────────┐              ┌──────────────────────────────┐
 │ npm run pipeline         │              │  Worker                      │
 │   ingest → AI → route    │  npm run     │   /feed/*.xml   ← KV         │
 │   Readability, SQLite    │  push  ──────▶   /open/<id>    → 302 + D1   │
 │                          │              │   /events       → D1         │
 │ npm run pull  ◀──────────┼──────────────┼─  open events                │
 └──────────────────────────┘              └──────────────────────────────┘
```

The feeds live at the edge, so Reeder on your phone always resolves — even when
the machine running the pipeline is asleep. Feeds simply stop *updating* until it
wakes.

### 1. Deploy the Worker

```bash
cd worker
npx wrangler kv namespace create SIFT_FEEDS
npx wrangler d1 create sift-events
```

Paste the two returned ids into `worker/wrangler.toml`, then:

```bash
npx wrangler d1 execute sift-events --remote --file=./schema.sql
npx wrangler types
npx wrangler secret put SIFT_ACCESS_TOKEN     # the same token as your .env
npx wrangler deploy
```

### 2. Point the pipeline at it

In `.env`:

```bash
SIFT_PUBLIC_URL=https://sift.<your-subdomain>.workers.dev
CLOUDFLARE_ACCOUNT_ID=...
SIFT_KV_NAMESPACE_ID=...        # the id from `kv namespace create`
```

`CLOUDFLARE_API_TOKEN` is **optional**. Deploying the Worker already required a
wrangler login, so when no token is set `npm run push` uploads through the
wrangler CLI with those same credentials — one less long-lived secret to create in
a dashboard and keep out of git. Set the token only if you want pushes to work
without wrangler present.

`SIFT_PUBLIC_URL` matters: it is what the tracked links in every feed entry point
at. Set it before pushing, or the links will point at localhost.

### 3. Push, and subscribe

```bash
npm run push -- --dry     # render locally, upload nothing, check the sizes
npm run push              # upload to KV
npm run push -- --feed classics  # upload only Classics + its item redirects
```

Feeds are then live at `https://sift.<subdomain>.workers.dev/feed/<slug>.xml?t=TOKEN`.

### 4. Keep it running

One command does a full cycle — refresh, publish to the edge, collect opens:

```bash
npm run cycle             # pipeline && push && pull
```

On a Mac, run it on a schedule with `launchd` (survives reboots, unlike `cron`
on modern macOS). Save as
`~/Library/LaunchAgents/com.sift.cycle.plist`, adjusting the paths:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.sift.cycle</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string><string>-lc</string>
    <string>cd /Users/you/Claude/Sift &amp;&amp; npm run cycle</string>
  </array>
  <key>StartInterval</key><integer>5400</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/tmp/sift.log</string>
  <key>StandardErrorPath</key><string>/tmp/sift.err</string>
</dict></plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.sift.cycle.plist
```

Check `https://.../health` any time: `stalenessMinutes` tells you how long since
the last successful push. If it climbs past a few hours, the pipeline is not
running.

### Running the pipeline always-on instead

If you would rather the feeds never go stale, run the pipeline on any Docker host
with a volume and skip `push`/`pull` entirely — the Node service serves its own
feeds. `Dockerfile` and `fly.toml` are included for that:

```bash
fly launch --no-deploy
fly volumes create sift_data --size 1
fly secrets set OPENAI_API_KEY=sk-... SIFT_ACCESS_TOKEN=... SIFT_PUBLIC_URL=https://your-app.fly.dev
fly deploy
```

You can still put Cloudflare in front of that for DNS and TLS on your own
domain, or expose a machine you own with a Cloudflare Tunnel:

```bash
cloudflared tunnel --url http://localhost:8787
```

## Design decisions worth knowing

**Node + SQLite, one process.** One user, no concurrency to speak of, latency
irrelevant. `node:sqlite` is built in, so there is no native dependency to
rebuild and no database server to run. Requires Node 22+.

**Brute-force vector search.** Embeddings are float32 blobs in SQLite, compared
in JS. At tens of thousands of vectors this takes single-digit milliseconds —
cheaper in complexity than running a vector database for one reader.

**The model advises; code decides.** Both AI stages return scores only. Gating,
thresholds, diversity and edition assembly are pure functions over those scores
(`src/rank/`), so the editorial policy is inspectable, testable and adjustable
without touching a prompt.

**Source weight fades at every stage.** A prior is worth 0.25 of the free score at
stage 3, 0.20 against Luna's 0.45 at the stage-4 gate, and 0.08 at stage 6. It
buys an article a closer look; it does not buy it a place in a feed.

**Stage 6 is portfolio construction, not a ranked slice.** Each pick re-scores
every remaining candidate against what the edition already holds, so a
candidate's value depends on what has been chosen. That is what stops five
excellent articles about the same announcement from all getting through.

**Learned statistics are smoothed and kept separate.** `source_statistics` holds
the empirical view (value, uniqueness, overlap); `sources.yaml` holds what you
set. Neither overwrites the other. Two excellent posts out of two cannot make a
source perfect: the bound is asymptotic, so reaching the maximum needs unbounded
evidence.

**Semantic scoring is pluggable, and paid by default.** Stage 3 is meant to be
free, and a local sentence-transformer would make the embedding bill exactly zero
— which is $0.29/month, a rounding error next to Terra, against ~100MB of ONNX
runtime in a deployment whose whole point is one small Node process. So the paid
provider stays behind `SemanticProvider`, `local` is a documented extension point,
and `hash` is a real free fallback that keeps the pipeline running with no API key.
Which provider scored an item is recorded per item, so a run without real
embeddings is never mistaken for one that had them.

**Recall over precision at the cheap stage.** UNCERTAIN gets a discounted
threshold, so do trusted sources and items needing the full text. Serendipity
candidates bypass the score entirely. A malformed model response becomes
UNCERTAIN, never DROP. And 7% of rejects are deep-evaluated anyway, so the
false-negative rate is measured rather than assumed.

**Clustering does not mean showing one article.** Up to
`max_published_per_cluster` (2) members survive, but only when the deep model
scores the second one as genuinely non-duplicative. A technical explainer and a
sceptical critique both get through; a second recap does not.

**Politeness is not optional.** robots.txt is respected, per-host delays are
enforced, conditional GETs avoid redundant transfers, and paywalls, logins and
access restrictions are never circumvented — when a page cannot be fetched, the
RSS content is used instead. Broken feeds get exponential backoff, but are never
abandoned permanently.

**Privacy.** No third-party analytics, no advertising SDKs, no device
fingerprinting. `open_events` stores exactly five columns. The redirect sends
`Referrer-Policy: no-referrer` so your reading does not leak to publishers, and
the access token is deliberately *not* included in article links for the same
reason.

---

## Repository layout

```text
config/          sources.yaml, taste-profile.yaml, ranking-config.yaml
prompts/         versioned prompt files
src/
  config/        loading + zod validation of the three config files
  db/            schema.sql and the thin SQLite wrapper
  ingest/        feed fetching, RSS/Atom/RDF parsing, normalisation
  filter/        deterministic hard filters
  embed/         embedding storage, cosine, anchor matching
  ai/            client, prompts, JSON repair, cheap triage, deep eval, batch
  cluster/       story clustering and deduplication
  extract/       Readability extraction and robots.txt
  alternate/     podcast / audio / video matching
  rank/          stage 3 free scoring, source statistics, attention,
                 stage 6 portfolio construction
  route/         per-feed score formulas (pure); stage 6 entry point
  feedback/      tracked opens and Reeder feedback
  learn/         bounded, transparent adaptation
  server/        Atom+RSS generation, tracked redirects, admin
  pipeline/      orchestration, journal, diagnostics
  cli/           one entry point per command
  cloudflare/    KV upload and edge-event fetch
worker/          Cloudflare Worker: serves feeds from KV, logs opens to D1
tests/           offline tests, fixtures and mocks only
```

---

## Status

Phases 1–4 of the original plan are implemented: end-to-end pipeline, all
sources, multiple feeds, extraction, clustering, alternate formats, tracked
opens, explicit feedback, adaptive weights, false-negative auditing, serendipity
scoring and cost reporting.

Not built, on purpose: custom reader, collaborative filtering, trained
recommender, mobile app, browser extension, dashboards, real-time processing,
multi-user accounts.

Verified during development: all 45 feed URLs parse; a full run ingested 550
items and published 25 across 4 feeds; article extraction succeeded on 145 of 157
real pages (the rest fell back to RSS content, as designed).

### Worth tuning after a week of real use

- Feed volumes against the daily caps — `npm run stats` shows what each feed
  produced. `essential` is aimed at 3–8/day and `serendipity` at 1–3/day.
- `npm run audit -- --run 20`, then look at the false-negative rate. If good
  items are being dropped early, lower `triage.threshold`.
- Whether `clustering.similarity_threshold` (0.845) is grouping too eagerly or
  too little; `/admin/clusters` shows what it actually grouped.
- Source priors for anything that is either always or never surfacing.
