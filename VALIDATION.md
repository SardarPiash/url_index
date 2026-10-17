# Actual Milestone 1 validation

Executed locally on 2026-10-17 with Node v24.21.0 and Docker Compose v5.5.0.

`npm run build` exited 0.

`TEST_DATABASE=1 npm test` output:

```text
✔ imports quoted CSV and deduplicates normalized URLs
✔ rejects empty, malformed and credential-bearing imports atomically
✔ median has no fabricated zero when no evidence exists
✔ CSV escapes quotes, newlines and spreadsheet formulas
✔ PostgreSQL persistence and evidence-based report
ℹ tests 5
ℹ pass 5
ℹ fail 0
ℹ skipped 0
```

`npm run db:migrate` output:

```text
Database schema ready.
```

`npm run cli -- baseline --csv examples/urls.csv --label milestone-1-smoke` output:

```json
{
  "experiment_id": "2cbab09d-cb9a-4798-9e6d-ec5fe63dbd2e",
  "method": "baseline",
  "started_at": "2026-10-17T07:49:39.386Z",
  "urls": 2,
  "state": "SUBMITTED",
  "final_result": "UNKNOWN",
  "limitations": "Baseline performs no network requests. Crawl and index status remain UNKNOWN until reliable evidence is collected. No comparison or speed claim is supported."
}
```

`npm run cli -- report --csv reports/observations.csv --summary-csv reports/summary.csv` exited 0 and reported:

```text
method: baseline
urls_tested: 2
verified_crawls: 0
crawl_rate: 0
confirmed_indexed: 0
index_rate: 0
median_seconds_to_crawl: null
median_seconds_to_index: null
errors: 0
unknown: 2
Observation CSV saved: reports/observations.csv
Summary CSV saved: reports/summary.csv
```

These are local baseline records, not observed Google crawling or indexing results. The two smoke records remain in the local database. Generated reports are ignored by Git.

## Baseline debugging and HTTP diagnostic verification (2026-10-17)

Reproduced the original bare-URL command: exit 1 with the old generic error. Root cause: the URL occupied the command position and triggered `Unknown command` before creating a database pool. The new regression test verifies the actionable `Missing command ... baseline URL` message even with an unreachable database.

PostgreSQL was healthy. Direct SQL confirmed `indexer_lab` connectivity and the `experiments`, `observations`, and new `http_diagnostics` tables. `npm run db:migrate` returned `Database schema ready.`

The documented baseline command for the BeautyHall URL succeeded:

```text
experiment_id: 9df786ef-5a22-4732-a5a6-f300ef0d8237
state: SUBMITTED
final_result: UNKNOWN
```

Direct SQL confirmed the target URL persisted, with index_status UNKNOWN and null verified crawl/index timestamps. The original two records are still present. Report now contains 3 baseline records, 0 verified crawls, 0 confirmed indexed, 3 unknowns and null timing medians.

First HTTP diagnostic attempt exposed a Node DNS lookup callback issue with automatic address-family selection. The pinned lookup now disables automatic family selection. The failed diagnostic remains in the database for transparency. The corrected live run returned:

```text
id: 7ed442d4-c395-4ee1-8fbc-ef7c0f221872
kind: APPLICATION_HTTP_FETCH
http_status: 200
final_url: https://beautyhallbd.com/product/ceramide-face-mask-30ml/
redirects: []
response_ms: 1631
error: null
```

This is this application's HTTP response-header observation, not Googlebot or indexing evidence.

Final-code verification: `npm run build` exited 0; `TEST_DATABASE=1 npm test` passed 10/10 with 0 failures and 0 skipped; `npm audit` found 0 vulnerabilities. The DNS transport now explicitly sets the validated address family, which also passes TypeScript's request option checks.

A final live run with that exact code succeeded (exit 0): diagnostic `629342c8-7234-41d2-ae53-a46e581f5e00`, HTTP 200, unchanged final URL, no redirects, 485 ms, error null. The baseline report still showed 3 UNKNOWN records and no verified crawl/index evidence after the previous diagnostic runs.

## Google Indexing API adapter verification (2026-10-17)

Implemented in the existing CLI/database; no project rebuild. Added `src/google-indexing.ts` (configuration, secure service-account loading, Google auth and publisher), `src/google-experiment.ts` (persistence runner), and `test/google-indexing.test.ts`. Updated CLI/help, transactional schema migration, report/CSV API fields, package manifests/lockfile, `.gitignore`, `.env.example`, README and this validation log.

Actual final commands:

```text
npm run build
> tsc --noEmit
(exit 0)

TEST_DATABASE=1 npm test
ℹ tests 20
ℹ pass 20
ℹ fail 0
ℹ skipped 0
(exit 0)

npm run db:migrate
Database schema ready.
(exit 0)

npm audit
found 0 vulnerabilities
(exit 0)
```

Coverage includes Google HTTP 200 acceptance, non-200 API failures (400/401/403/429/500), authentication/transport failures, missing credentials, invalid configuration, unsupported page types, property boundary checks, exact URL allowlisting, secure key-file checks and secret redaction. Google auth initialization is mocked to verify scope, timeout, redirect and retry settings without contacting Google. API response metadata is strictly filtered, and malformed success metadata cannot produce crawl/index evidence.

The real PostgreSQL integration test uses mocked Google transport and checks successful acceptance, HTTP 403 and authentication failure. It verifies HTTP status, independent `api_status`/`crawl_status`/`index_status`, persisted lifecycle state, UNKNOWN final index outcome and null verified crawl/index timestamps. Temporary experiment fixtures are deleted afterward. Existing baseline count remains unchanged.

Direct SQL verified the method constraint permits exactly baseline and google-indexing-api and the following columns exist:

```text
api_accepted_at
api_status
request_completed_at
request_started_at
```

`npm run cli -- report` still succeeds:

```text
method: baseline
urls_tested: 3
api_accepted: 0
verified_crawls: 0
confirmed_indexed: 0
errors: 0
unknown: 3
median_seconds_to_crawl: null
median_seconds_to_index: null
```

There are 2 retained baseline experiments containing these 3 URL observations. No mocked Google experiments remain in the normal report.

Environment presence checks (values/secrets never printed):

```text
GOOGLE_APPLICATION_CREDENTIALS: not configured
GOOGLE_INDEXING_PROPERTY: not configured
GOOGLE_INDEXING_ELIGIBLE_PAGES: not configured
GOOGLE_INDEXING_AUTHORIZED: not configured
```

An actual CLI preflight command, `npm run cli -- google-indexing-api https://jobs.example.com/openings/42`, exited 1 with:

```text
Command failed: Set GOOGLE_INDEXING_AUTHORIZED=true only after verifying property ownership and granting the service account owner access.
```

**No live Google OAuth or Indexing API request was made.** Existing `credentials.json` was not loaded or inspected. A live authorized, eligible page submission remains unverified until configured explicitly. Google's official prerequisites and eligibility documentation are linked in README.

## Discovery and evidence milestone (2026-10-17)

Existing code, original PostgreSQL observations and tests were preserved. Added `discovery.ts`, `inspection.ts`, `crawl-monitor.ts`, `experiment-store.ts`, `workflow-cli.ts` and workflow tests; extended migration, report/CSV and existing CLI/Google runner with action logging. The bounded public HTTP transport is shared with discovery verification.

Final actual verification:

```text
npm run build: exit 0 (tsc --noEmit)
TEST_DATABASE=1 npm test: 29 tests, 29 passed, 0 failed, 0 skipped
npm audit: found 0 vulnerabilities
npm run db:migrate: Database schema ready.
```

New tests cover XML/HTML escaping and structural membership, sitemap indexes, RSS/Atom, nofollow/base tags, XML entity rejection, strict indexing interpretation, spoofed Googlebot/user-triggered fetcher rejection, reverse/forward DNS matching, log validation/deduplication/historical timestamps, operator-reported public tool usage and configuration limitations. Integration tests use real PostgreSQL with injected HTTP/API/DNS fixtures; synthetic evidence/experiments are deleted afterward. Existing eligible-page Indexing API tests still pass separately with mocked Google responses and no live request.

Live BeautyHall actions were safe read-only application requests, not website publications or Googlebot crawls. A new no-network baseline and method/configuration records were created with label `beautyhall-discovery-observation`:

| Method | Actual result | Experiment ID |
| --- | --- | --- |
| Baseline | Zero network requests; SUBMITTED/UNKNOWN | f2099847-6e67-4d53-88d9-6cd95dadacd6 |
| Sitemap | `/sitemap_index.xml` HTTP 404; no target membership verified | 5e66e223-0079-4a9a-88f2-446b2a0c3378 |
| Internal link | Homepage HTTP 200; no matching followable target anchor verified | e145f0e4-8f0e-424d-90bb-63b63dc8a07b |
| Redirect | Local redirect recipe generated; no remote source configured/published | 56ac1ab3-57f2-4466-86bf-411c02f76e57 |
| RSS/feed | `/feed/` HTTP 200; target item not found | bcecddec-9955-4972-83f7-1ad9c3369b8d |
| Public tool | MANUAL_REQUIRED; no public tool was invoked | 4458d75e-96f1-482f-9965-ab969041e91a |
| Indexing API | UNSUPPORTED for Product; no Google submission | 99258f83-6734-4a7f-b1e5-2093c820cc8e |
| URL Inspection | MANUAL_REQUIRED; verified property/access not configured | 6ed50df9-32a5-4a94-96ac-ebae88b5a35d |
| Request Indexing | MANUAL_REQUIRED; manual authorized Search Console UI action not performed | b7e4531b-922b-4cd7-9817-edeaa80fbbbb |
| Crawl monitoring | MANUAL_REQUIRED; no trusted server-log file supplied | 28757977-06f6-469d-8c45-b15de5e05c4e |

An additional read-only `/robots.txt` lookup returned HTTP 200 with no same-host Sitemap declarations. This check is logged under the sitemap experiment. This does not prove no sitemap exists elsewhere. Homepage/feed checks do not prove the target is absent from other pages/feeds.

No remote website changes were performed. The only generated BeautyHall deployment artifact is the local redirect recipe under `reports/beautyhall-artifacts/`. Other publishable artifacts can be generated through the documented `--output` commands. Publishing sitemap/link/redirect/feed requires your website deployment access and a deliberate publication step, then `--source` verification.

Actual comparison command:

```bash
npm run cli -- report --label beautyhall-discovery-observation --csv reports/beautyhall-discovery-observations.csv --summary-csv reports/beautyhall-discovery-summary.csv
```

It exited 0 and exported both CSVs. The selected cohort has 10 method/workflow records: baseline completed, 8 manual-required, 1 unsupported. Each has 0 API acceptance, 0 verified crawl, 0 confirmed indexed; final/index outcomes UNKNOWN; crawl/index time medians null. Sitemap has one recorded HTTP failure (404). Request Indexing is an additional UI workflow beside read-only Inspection, hence 10 records for the requested adapter/workflow set.

Direct SQL confirmed all 3 original observations from the prior two baseline experiments remain. All new crawl/index timestamps are null. No live Google OAuth, Indexing API, URL Inspection or public testing-tool request was made; no credentials were auto-loaded. A live eligible, authorized Indexing API test remains unverified because no eligible test page/property/credentials are configured.

These same-URL overlapping observations cannot establish relative discovery/crawl/indexing speed or causality. The baseline target already has historic exposures and earlier application fetches, so this is not an isolated control group.

## Practical end-to-end adapters A–D (2026-10-17)

Inspected existing README, validation history, CLI, schema and live PostgreSQL records before extending them. The pre-existing 13 observations remain present under milestone-1-smoke, baseline-workflow-verification and beautyhall-discovery-observation; no prior experiments/actions were deleted or rewritten.

Added production modules:

- `gateway.ts`: real fixed-destination gateway server; temporary 302/permanent 301 variants; configured HTTPS origin, fresh HMAC endpoint-control proof, public destination/loop/variant/chain checks.
- `publishing.ts`: supported WordPress REST publication and Blogger posts.insert using explicit credentials; exact site/content/variant confirmation; one-publication receipt per provider/site/target; uncertain-attempt deduplication; unauthenticated public link/robots/feed/sitemap verification.
- `pagespeed.ts`: one documented PageSpeed v5 diagnostic call, selected response fields, safe metadata, persistent 60-second local limit and no automatic retries.
- `live-store.ts` and `live-cli.ts`: real-request/action recording, persisted blockers, safe per-experiment execution, independent CLI commands and actual execution reports.

Migration additions preserve earlier fields: variant, discovery URL, real-request flag, public verification, independent run_state/output metadata, publication receipts and API rate limits. Report/CSV now include action/evidence history and independent exposure/crawl/index fields. Existing Google Indexing API restrictions remain enabled. WordPress/Blogger API tokens, application passwords and gateway proof secrets are never printed or stored in actions.

### Actual verification commands/results

```text
npm run build
> tsc --noEmit
exit 0

TEST_DATABASE=1 npm test
ℹ tests 34
ℹ pass 34
ℹ fail 0
ℹ skipped 0
exit 0

npm run db:migrate
Database schema ready.
exit 0

npm audit
found 0 vulnerabilities
exit 0
```

Tests include genuine **local-only** gateway HTTP 302/301/control-proof responses, rejected query-supplied destinations, missing configuration, site/content-bound confirmation, RSS/Atom generation, proper owned-resource sitemap membership, mocked real-PostgreSQL gateway chain/loop/control failures, publication/reuse/uncertain-duplicate prevention, private/robots-blocked reference rejection, mocked PageSpeed HTTP 200/429/rate limiting and secret redaction. Mocked API transports never contacted Google/WordPress/Blogger and fixture publications/evidence were deleted. Test-only limiter keys are separate from the live PageSpeed key and removed afterward.

### Actual live execution

Executed production CLI with no mocked transport:

```bash
npm run cli -- experiment-suite https://beautyhallbd.com/product/ceramide-face-mask-30ml/ --allowed-domain beautyhallbd.com --label beautyhall-end-to-end-20261017
```

The suite created 18 independently timestamped records. First PageSpeed attempt `01643b41-3f58-4e5b-a17c-4390ad090680` failed target DNS/HTTPS/public-destination preflight, so no Google request was sent. A later direct target DNS validation succeeded; the initial blocked record was retained. One subsequent standalone diagnostic was executed:

```bash
npm run cli -- pagespeed https://beautyhallbd.com/product/ceramide-face-mask-30ml/ --allowed-domain beautyhallbd.com --label beautyhall-end-to-end-20261017
```

Actual experiment `0045d0de-7bc0-4bda-986c-8fea5769f186` sent a real Google PageSpeed API request and received **HTTP 429** after approximately 300 ms. It is labeled DIAGNOSTIC_ONLY, REQUEST_SENT, rendering unverified, no Google Search discovery signal. No retry, account/project rotation or quota workaround followed the 429. The first preflight failure was not counted as an API call.

BeautyHall's `/sitemap.xml` returned **301** to the same-host `/wp-sitemap.xml`. A deliberate read-only follow-up under the same sitemap experiment returned **404**. Homepage and `/feed/` returned **200**, with no structurally verified target anchor/feed entry. These are application HTTP observations, not Googlebot visits.

| Method/variant | Actual live result | Next configuration/action |
| --- | --- | --- |
| Baseline | Executed without intervention/network; outcome UNKNOWN | Collect later verified evidence |
| Gateway temporary | BLOCKED_CONFIGURATION; no request | Owned HTTPS endpoint, fixed target, authorization and matching private proof secret |
| Gateway permanent | BLOCKED_CONFIGURATION; no request | Same deployment; separate permanent variant |
| CMS link/RSS/Atom/sitemap | Four BLOCKED_CONFIGURATION records; no API calls/posts | Authorized WordPress URL/user/application password; preview and exact confirmation |
| PageSpeed | One earlier preflight blocker; one actual HTTP 429 request | Configure own project key/quota; no automatic retry |
| Blogger | BLOCKED_CONFIGURATION; no post/API call | Owned blog ID/origin, user OAuth token, explicit content/site confirmation |
| Sitemap | 301 then 404; no target membership verified | Configure a real published sitemap containing the target |
| Internal link | Homepage 200; target link absent in checked HTML | Supply/publish an authorized source with the actual target anchor |
| Feed | Feed 200; target link absent in checked entries/content | Supply/publish the actual authorized feed entry |
| Legacy redirect | BLOCKED_CONFIGURATION; source not configured | Set DISCOVERY_REDIRECT_URL or configure gateway |
| Rich Results Test | BLOCKED_CONFIGURATION; no supported automated interface configured/called | Manual truthful observation only; supported PageSpeed API is separate |
| Indexing API product | NOT_RUN / UNSUPPORTED; no notification | Separate genuinely eligible authorized test page only |
| URL Inspection | BLOCKED_CONFIGURATION; no Google inspection | Verified property, authorized identity and secure credentials |
| Request Indexing | BLOCKED_CONFIGURATION; no UI action claimed | Verified-property Search Console UI action where supported |
| Crawl monitoring | BLOCKED_CONFIGURATION; no log import | Trusted origin/CDN JSONL logs |

There are **19 records** in this live cohort: 13 BLOCKED_CONFIGURATION, 4 REQUEST_SENT, 1 NOT_RUN (ineligible API), 1 baseline UNKNOWN. Four experiment records contain actual outbound HTTP observations, comprising five HTTP responses (sitemap 301+404, homepage 200, feed 200, PageSpeed 429). No public CMS/Blogger/gateway deployment was created; publication_receipts contains zero production rows after test cleanup.

All 19 index statuses/final indexing outcomes remain UNKNOWN. Verified Googlebot crawl count 0; confirmed indexed count 0; observed application-level discovery signals 0; crawl/index timing medians null. No Google indexing notification or request-indexing action was performed. No credential file was auto-loaded. The legacy credentials.json remains unused.

### Generated actual reports

Both commands exited 0:

```bash
npm run cli -- execution-report --label beautyhall-end-to-end-20261017 --csv reports/end-to-end-executions.csv --markdown reports/end-to-end-executions.md
npm run cli -- report --label beautyhall-end-to-end-20261017 --csv reports/end-to-end-observations.csv --summary-csv reports/end-to-end-comparison.csv
```

`reports/end-to-end-executions.md` includes experiment IDs/start times, states, actual request/status, evidence/blockers and next configuration steps. Observation CSV includes full safe action/evidence history. Existing terminal report/CSV workflows still work. Local simulations and mocked test successes are not included as genuine live discovery outcomes.

A/B/D live public execution remains externally blocked because no authorized gateway endpoint, WordPress publishing credentials or Blogger account credentials/confirmation are configured. It would be false to describe these methods as applied. No conclusion about discovery speed, Googlebot following redirects or indexing effectiveness is supported by these results.
