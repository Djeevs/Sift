# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This checkout is a Git repository (`main`, private remote `origin`). Use
`git diff` and `git log`; changes are recoverable. Private files — `.env`,
`worker/wrangler.toml`, `worker/.dev.vars`, `data/`, and non-example profiles —
are gitignored and must stay that way.

Read `docs/SESSION-HANDOFF.md` (short) for operational state: profiles,
deployment, private files, known gaps. Read `README.md` only in ranges — see
*Navigation* at the end of this file. Do not read it whole; it is ~12k tokens.

## What this is

Sift turns dozens of RSS sources into a small set of high-quality personal feeds
read in Reeder. It is a private editorial system, not a multi-tenant product:
isolated profiles exist for a few trusted readers, there is no shared user model
or growth surface, and Reeder is the only reading frontend.

The optimisation target is **"was I glad I spent attention on this?"** — never
clicks or engagement. Two consequences that shape most design decisions:

- **False negatives cost more than false positives.** Dropping something good is
  worse than surfacing something mediocre. Gating changes should be biased
  accordingly, and anything that silently discards items is a bug.
- **No single model controls the feed.** Terra scores items; a deterministic
  final stage does the ranking, diversification and portfolio construction.

## Commands

```bash
npm run pipeline        # the whole funnel; what the scheduler runs
npm run cycle           # pipeline && push && pull (edge deployment loop)
npm run ui              # control panel (127.0.0.1:8790) + feeds (:8787), one process
npm run serve           # the same, plus the scheduler; --no-schedule to disable
npm run service:install # run it in the background via launchd (--dry to preview)
npm run dev             # same, reloading on change
npm run onboard         # print/import the personal-assistant onboarding dossier
npm run calibrate       # optional feedback on real ranked recommendations
npm test                # vitest, no network or API calls
npm run typecheck       # strict tsc, no emit
```

Single test file or case:

```bash
npx vitest run tests/clustering.test.ts
npx vitest run -t "re-queues stale evaluations"
npm run test:watch
```

CLI entry points all live in `src/cli/` and are wired as npm scripts. Anything
touching the OpenAI API needs `--env-file=.env`:

```bash
node --env-file=.env node_modules/.bin/tsx src/cli/pipeline.ts
npm run pipeline -- --max-deep 10 --skip-publish
npm run pipeline -- --sources quanta,kottke
```

### Diagnostics — read these before changing scoring

| Command | Answers |
| --- | --- |
| `npm run funnel` | Stage-by-stage survival rates and cost per outcome |
| `npm run budget` | Spend, degradation stage, Terra allocation, false-negative rates (`-- --breakdown`) |
| `npm run bands` | Free-score distribution; whether the bands actually filter |
| `npm run cluster:stats` | Clustering health, sample clusters (`-- --rebuild` re-clusters) |
| `npm run cluster:eval` | Same-story precision/recall vs the labelled fixture (`-- --sweep`) |
| `npm run replay` | Replays the stored corpus at different budgets; makes no model calls |
| `npm run inspect` | Per-item trace: why it surfaced, or why it disappeared |

## Architecture

A six-stage funnel. The governing principle is **spend progressively more
computation only as an item earns the right to more attention**.

```
1 Aggregation      src/ingest      RSS/RDF/Atom → feed_items
2 Rule filtering   src/filter      cheap deterministic drops
3 Free scoring     src/rank        embeddings, clustering, free score, bands  [$0]
4 Luna             src/ai          gpt-5.6-luna triage, cheap
5 Terra            src/ai          gpt-5.6-terra deep evaluation, expensive
6 Final ranking    src/rank        deterministic portfolio construction
7 Feeds            src/server      Atom/RSS for Reeder
```

Use `allFeeds(config)` to enumerate subscribable feeds rather than reading
`config.feeds` directly at each call site — the feed server, `push`, the
static export, and `doctor` all need the same list, and history here is that a
feed added in only one of those places gets served but not pushed.

`src/pipeline/run.ts` is the spine — stages are numbered in comments there and
that is the fastest way to orient. Supporting concerns: `src/pipeline/budget.ts`
(spend), `falseNegatives.ts` (audit reporting), `journal.ts` (job records and
`setStatus`), `costs.ts`, `diagnostics.ts`.

### The item state machine

`feed_items.status` is the pipeline's control flow. Each stage selects on the
status the previous one wrote:

```
pending → rejected_rules
        → rejected_free  |  free_ranked → rejected_luna
                                       |  triaged → deep_evaluated → published
                                                  → deferred_cluster
                                                  → expired_unevaluated
```

**`triaged` means "eligible for Terra" and nothing may take that away for
resource reasons.** This is the most important invariant in the codebase. An
earlier version flipped budget-exceeded items to `rejected_luna`, which was
permanent — Luna only reads `free_ranked` and Terra only reads `triaged`, so
nothing ever reconsidered them, and one backlog run stranded 60 qualified
articles. Items that miss a run's budget keep `triaged` and are re-offered next
run until they age out by content type (`budget.requeue_max_age_hours`).
`tests/budget.test.ts` and `tests/scoring.test.ts` guard this.

### Config is the source of editorial truth

Nothing that affects editorial outcomes belongs in application code. Ten YAML
files in `config/` hold every threshold, weight, curve and cap; `src/config/`
loads and validates them with zod and records a content hash of each with every
AI judgement and ranking decision, so stored results stay interpretable across
config changes.

When adding a tunable, put it in YAML, add it to `src/config/schema.ts`, and
document *why the value is what it is* in a YAML comment. Several existing
comments record the measurement that produced the number; keep that habit.

`budget.yaml` also selects the operating mode (`calibration` vs `steady_state`,
overridable with `SIFT_MODE`), which drives audit sampling rates and monthly
spend targets.

### Cost shape

Terra is ~98% of spend. Steady-state measured cost is about **$4.50/month** at
observed volume; the configured target is $10 with a $20 hard limit, so the
budget is headroom rather than an active cut. Everything about allocation is
therefore about *which* items get a deep evaluation:

- `src/rank/terraOpportunity.ts` — deterministic pre-Terra score (Luna signals,
  free score, cluster differentiation, `feed_need`, saturation penalties). It
  allocates money and **never** reaches the final ranking or decides what
  publishes.
- `src/rank/terraAllocation.ts` — greedy selection under the budget, with a
  protected share for audit samples and graceful degradation as spend rises.

Batch beats sync+cache for Terra at the current token shape (measured: batch's
flat 50% beats caching's effective 44%, because the cacheable prefix is only
~70% of input). `terraPathCost()` prints the comparison so it stays checkable if
prices or prompt sizes change. Don't add sync/batch routing without re-measuring.

A run **submits a batch and returns**; the next run collects it. Waiting inline
froze publishing, ingestion and the scheduler behind the provider's queue.
Three things follow, and all three were bugs before they were rules:

- Items in an unfinished batch keep `triaged` and must be excluded from Terra
  selection (`pendingBatchItemIds`), or the next run pays for them twice.
- Results are stored against `batch_jobs.prompt_version`, never the currently
  configured prompt. Mislabelling them hides a superseded prompt from the
  re-scoring pass permanently.
- Batch usage is recorded at `batch_discount`, and whether something came via
  batch is passed explicitly rather than read from `stats.mode` — collecting an
  earlier run's batch leaves that mode `sync`, so its spend recorded as zero.

### Clustering

Story identity and *perspective* identity are separate questions, deliberately.
Clustering suppresses duplicated information; it must not suppress diversity of
thought. `src/cluster/signals.ts` decides both, from cheap signals only — no
model call decides clustering.

Weights were fitted by grid search with 4-fold cross-validation against
`tests/fixtures/cluster-pairs.json` (201 real article pairs, labelled by the
cheap model). **Re-run `npm run cluster:eval` after touching any clustering
weight.** Current measured performance: precision 0.78, recall 0.77, zero
UNRELATED pairs merged. Embedding similarity alone caps at F1 0.68, which is why
a single threshold does not work — the previous single-threshold design sat at
0.845 and matched 5 of 92,644 real pairs.

Perspective separation is genuinely weak from cheap signals (best balanced
accuracy 0.69), so it is tuned asymmetrically on purpose: 86% of
different-perspective pairs retained, 44% of duplicates suppressed.

### Currently disabled: `source_uniqueness_score`

Its weight is `0.00` in `free-ranking.yaml`. It is derived from clustering, and
while clustering was inert every source scored as perfectly unique — the
component contributed a near-constant 0.15 to every free score. Restore it only
when `npm run cluster:stats` reports uniqueness as calibrated.

**If you change any free-score weight, recalibrate the bands.** Zeroing
uniqueness moved the mean free score 0.427 → 0.373, which would have pushed band
D from 6 to 366 items and silently starved audit sampling. `npm run bands` shows
the distribution; verify that previously-published items still land in band A/B.

## Gotchas

- **Node 22+, ESM, `node:sqlite`.** The database module is Node's built-in
  SQLite (experimental — the `ExperimentalWarning` on startup is expected). All
  DB access is synchronous. Schema changes go in `src/db/schema.sql` plus an
  additive `ensureColumn` call in `src/db/index.ts`; there is no migration tool.
- **Beware `grep -v Experimental`** when filtering command output — it also
  eats the "Experimental History" source. Filter on `ExperimentalWarning`.
- **Tests never hit the network or the API.** `vitest.config.ts` forces
  `SIFT_DB_PATH=:memory:` and `SIFT_DRY_RUN=1`. `testDb()` in `tests/helpers.ts`
  returns `{ db, config }` against the real schema and real config.
- **Database per environment.** `production` → `data/sift.db`, `development` →
  `data/sift-dev.db`, `test` → `:memory:`; `SIFT_DB_PATH` overrides. Every
  process logs the file it opened. Scripts run without `--env-file=.env` will
  silently open the *development* database and appear to find no data.
- **`PROJECT_ROOT` reads, `resolveHome()` writes.** Config defaults, prompts,
  the schema and `profiles/example` ship with the code. Databases, readers,
  tokens and logs are state and resolve under `SIFT_HOME`, which defaults to
  `PROJECT_ROOT` — so a checkout behaves exactly as before. They must be
  separable for a packaged app, whose bundle is read-only and is replaced
  wholesale on update. Anything writing under `PROJECT_ROOT` is a bug;
  `npm run home` shows what resolves where.
- **Prompt versions are not comparable.** Terra scores from different prompt
  versions cannot be pooled; a superseded, more generous prompt will dominate the
  feed forever. `run.ts` re-scores stale evaluations using a configured share of
  the Terra budget. When editing a prompt in `prompts/`, add a new version file
  and point `final-ranking.yaml` at it rather than editing in place.
- **Cloudflare serves, Node curates.** The pipeline cannot run on Workers:
  `node:sqlite` and `node:vm` (needed by jsdom/Readability) are non-functional
  stubs there, and Container disks are ephemeral. `worker/` is a thin edge layer
  serving feed XML from KV and recording opens to D1.
- **Audit samples must never auto-publish.** They record whether they *would
  have*. That distinction is what makes the false-negative rate meaningful.

## Testing conventions

Tests are organised by concern, not by source file, and the valuable ones encode
a past failure. Where a test guards a specific bug, the comment says what broke
and what it cost — follow that pattern rather than writing a bare assertion.
Prefer asserting the *measured outcome* that was tuned for (precision, recall,
retention) over the parameters that produce it, so tuning stays free but
regression does not.

## Navigation

`src/` is ~200k tokens. Never read it broadly. Two rules make almost every task
cheap:

**Let the diagnostics do the reading.** This system is heavily instrumented.
`npm run inspect -- --id X` answers "why did this surface / disappear?" in a few
hundred tokens; reconstructing the same answer by reading the funnel costs tens
of thousands. Start from diagnostic output, then open only the stage it
implicates. The table under *Diagnostics* above says which command answers what.

**`src/pipeline/run.ts` is the index.** 340 lines, stages numbered in order,
names every module it calls. Reading it plus the one stage file you are changing
is enough context for most work.

### Where a change lives

| To change… | Read | Then verify with |
| --- | --- | --- |
| what gets collected | `src/ingest/`, `config/sources.yaml` | `npm run check-sources` |
| a cheap drop rule | `src/filter/hardFilter.ts` | `npm run funnel` |
| a free-score weight | `src/rank/freeScore.ts`, `config/free-ranking.yaml` | `npm run bands` — **always recalibrate bands** |
| clustering | `src/cluster/signals.ts`, `config/pipeline.yaml` | `npm run cluster:eval` — **required after any weight change** |
| the Luna gate | `src/ai/cheapTriage.ts` (`scoreTriage`), `config/final-ranking.yaml` | `npm run funnel`, `npm run budget` |
| who Terra sees | `src/rank/terraOpportunity.ts`, `terraAllocation.ts` | `npm run budget -- --breakdown` |
| a prompt | `prompts/` — **add a new version file**, point `final-ranking.yaml` at it | `npm run replay` |
| ranking / diversification | `src/rank/portfolio.ts`, `publishEdition.ts` | `npm run replay` |
| feed output | `src/server/renderFeed.ts`, `config/feed-config.yaml` | `npm run serve` |
| source discovery | `src/onboarding/suggestSources.ts`, `prompts/feed-source-discovery-v2.md` | `npm run sources:suggest` |
| spend or degradation | `src/pipeline/budget.ts`, `config/budget.yaml` | `npm run budget` |
| a config value | the YAML **and** `src/config/schema.ts`, with a comment recording *why* | `npm run typecheck` |
| the schema | `src/db/schema.sql` **and** an `ensureColumn` in `src/db/index.ts` | `npm test` |

### README sections

Read by range, not whole. Regenerate this index after editing README with:
`grep -n '^## ' README.md`

| Section | Range | Lines |
| --- | --- | ---: |
| How it works | `sed -n 20,82p README.md` | 63 |
| Quick start | `sed -n 83,353p README.md` | 271 |
| Commands | `sed -n 354,410p README.md` | 57 |
| Spend is a system constraint, not a metric | `sed -n 411,479p README.md` | 69 |
| Clustering, and what it is for | `sed -n 480,526p README.md` | 47 |
| Measuring what the funnel throws away | `sed -n 527,549p README.md` | 23 |
| The ten config files | `sed -n 550,774p README.md` | 225 |
| Prompts | `sed -n 775,792p README.md` | 18 |
| Explicit feedback from Reeder | `sed -n 793,828p README.md` | 36 |
| Learning | `sed -n 829,850p README.md` | 22 |
| Diagnostics | `sed -n 851,874p README.md` | 24 |
| Costs | `sed -n 875,916p README.md` | 42 |
| Which database am I using? | `sed -n 917,936p README.md` | 20 |
| Deployment | `sed -n 937,1074p README.md` | 138 |
| Design decisions worth knowing | `sed -n 1075,1138p README.md` | 64 |
| Repository layout | `sed -n 1139,1170p README.md` | 32 |
| Status | `sed -n 1171,1194p README.md` | 24 |

Operational counts in README (source count, volume, cost, cache-hit rates) have
drifted from the database. Read them from `npm run stats` / `npm run budget`,
never from the prose.
