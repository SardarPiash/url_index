# Experimental URL Indexer Lab

Minimal local Node.js/TypeScript CLI. **Discovery, evidence monitoring, application HTTP diagnostic and optional Google API experiments:** PostgreSQL persistence, URL/CSV baseline import, terminal reports, and CSV exports.

## Ubuntu setup

Requires Node.js 24+, npm, Docker Engine and the Docker Compose plugin.

```bash
cd /home/gh/piash/word/url-indexer
npm ci
docker compose up -d --wait
npm run db:migrate
npm run build
TEST_DATABASE=1 npm test
```

The default database is `indexer_lab` on `127.0.0.1:54329`. Docker exposes it only on loopback. The Compose password is for local development. For another database, set `DATABASE_URL` in your shell. `.env.example` documents the default; `.env` is not automatically loaded.

## Run a baseline

```bash
npm run cli -- baseline https://example.com/lab/a https://example.com/lab/b --label control-group
npm run cli -- baseline --csv examples/urls.csv --label csv-control
npm run cli -- report
mkdir -p reports
npm run cli -- report --csv reports/run-observations.csv --summary-csv reports/run-summary.csv
```

To isolate an experiment, add `--experiment UUID` to `report`, using the ID printed by `baseline`. Export paths must be new files; existing files are never overwritten. CSV input must have exactly one `url` header; other columns are ignored. Quoted fields, BOM, and CRLF are supported. Arguments and CSV URLs can be combined. URLs are normalized, fragments removed and duplicates removed within an experiment. Invalid input rejects the whole import; inserts use a transaction.

The sample uses example.com purely as local records. Baseline sends no request to any target. Unit tests use synthetic HTTP transport results. The separate http-fetch command makes explicitly authorized requests. For real experiments use equivalent groups of pages on properties you control or are authorized to test. `--label` can record the group. Each run records its own start time; imports across separate runs are separate observations.

## What the results mean

An imported row has state `SUBMITTED` (submitted to this local lab), while its index status and final result are `UNKNOWN`. This is not a Google submission. Baseline performs no active discovery intervention and makes no target network requests. Baseline has no target fetching. The separate diagnostic below implements bounded HTTP fetching; future experiment adapters still need their own authorization and safety checks.

The schema reserves all requested states: `SUBMITTED`, `DISCOVERY_ATTEMPTED`, `API_ACCEPTED`, `CRAWL_VERIFIED`, `INDEX_CONFIRMED`, `NOT_INDEXED`, `UNKNOWN`, `ERROR`. It also stores request status, errors, API metadata, verified crawl timestamps, indexing evidence and confirmation times. Fields without evidence remain null. The crawl-monitor and url-inspection workflows below collect separate crawl/index evidence.

Reports aggregate URL observations by method. Rates use all observations as the denominator (0–1). Repeated URLs in separate runs count separately. Timing medians use only observed timestamps, in seconds from experiment start; absent timings are null, not zero. Observation exports include experiment IDs, starts, labels, statuses, evidence fields, timings and limitations; summary exports include counts, rates, medians, errors and unknown outcomes. No observations means no data rows. Reports expose completion, manual-required and unsupported counts; errors include failed action responses. HTTP diagnostics are stored separately and never contribute to crawl/index metrics. CSV text is escaped and spreadsheet formula prefixes are neutralized.

A successful HTTP response, an API acceptance or Googlebot-like User-Agent is never proof of indexing. No reliable evidence means `UNKNOWN`; zero confirmed observations does not mean `NOT_INDEXED`. There is no supported speed comparison yet.

## Credentials and later milestones

`credentials.json` is never auto-discovered or required for local setup and is excluded by `.gitignore`. Keep it and `.env` private. Avoid credentials or sensitive tokens in submitted URLs; reports intentionally contain target URLs. Errors do not dump database connection strings or credentials.

Discovery preparation/source-verification adapters, optional URL Inspection and server-log crawl monitoring are implemented below. Remote publication of sitemap/link/redirect/feed changes and Request Indexing in Search Console remain manual. Baseline/report/HTTP diagnostic do not load Google credentials. Future log analysis must verify Googlebot identity using Google's documented verification process before recording a crawl.

## Validation

```bash
npm run build
npm test                         # unit tests; database test skipped
TEST_DATABASE=1 npm test         # includes real PostgreSQL integration test
npm audit
```

The database test creates a uniquely identified fixture, checks persistence and evidence-based medians, then deletes its own records. Its synthetic evidence is never retained in the report. See `VALIDATION.md` for the actual first-run results.

```bash
docker compose stop             # retain data
# When needed, restart with docker compose up -d --wait
```

Data lives in a Docker named volume. Removing the volume deletes experiments.

## CLI troubleshooting and application HTTP diagnostic

A bare URL is not a command. `tsx src/cli.ts https://example.com/page` fails before database access because the parser expects `baseline`, `report`, `migrate`, `http-fetch`, or `google-indexing-api` as its first positional argument. It now prints a specific correction. Use:

```bash
npm run cli -- baseline https://beautyhallbd.com/product/ceramide-face-mask-30ml/
npm run cli -- report
```

Errors show trusted validation messages and recognized system/PostgreSQL error codes, with actionable guidance for missing schema and failed authentication. Raw database messages, arbitrary server error text, passwords, connection URLs and stacks are withheld. Unknown failures retain a validated machine code when available.

For a domain you control or are authorized to test, explicitly opt into an application HTTP fetch:

```bash
npm run db:migrate
npm run cli -- http-fetch https://beautyhallbd.com/product/ceramide-face-mask-30ml/ --allowed-domain beautyhallbd.com
```

`--allowed-domain` is your assertion of authorization, not automatic proof of domain ownership. The exact hostname is required. Redirects to another hostname are recorded and blocked; run another explicitly authorized diagnostic if needed. Only standard HTTP(S) ports are allowed. Each hop resolves DNS, rejects non-public addresses (including IPv4-mapped IPv6), and pins the validated public IP while preserving TLS hostname verification. The user agent identifies this application's diagnostic, never Googlebot.

The command performs one GET per hop and closes the response after headers; no response body is downloaded. Response times are elapsed milliseconds to headers, including DNS/TLS; total time includes redirect delays. Limits: 5 redirects, 500 ms between hops, 5-second socket inactivity timeout and 15-second total deadline, no retries. A blocked redirect leaves `final_url` at the last actually requested URL. HTTP status is the last received status; when no headers arrive it is null. HTTP 4xx/5xx remain visible as statuses; transport/policy errors populate `error` and exit nonzero. A completed HTTP exchange exits zero regardless of HTTP status.

Results persist in `http_diagnostics` with their own ID, timestamp and `APPLICATION_HTTP_FETCH` kind. They never modify `observations`, verified crawl timestamps, index status, or baseline reports. Inspect recorded diagnostics locally:

```bash
docker compose exec -T postgres psql -U indexer -d indexer_lab -c 'SELECT id, observed_at, kind, target_url, result FROM http_diagnostics ORDER BY observed_at;'
```

This makes an active request; use separate pages/groups when measuring passive baseline discovery to avoid contaminating experimental controls.

## Optional Google Indexing API experiment

Only `JobPosting` pages or genuine livestream pages with `BroadcastEvent` nested in `VideoObject` are supported. Ordinary product, article and generic video pages are unsupported. The existing BeautyHall product URL is not an eligible Google adapter test target. See Google's [eligibility and API documentation](https://developers.google.com/search/apis/indexing-api/v3/using-api) and [authorization prerequisites](https://developers.google.com/search/apis/indexing-api/v3/prereqs).

1. Enable the Indexing API in your own Google Cloud project and create a service account.
2. Verify your property in Search Console and add that service account as a delegated site owner. Google enforces access; local configuration cannot grant it.
3. Review the actual page and its structured data against Google's eligible page requirements. Add only those exact URLs to the allowlist below. This adapter does not inspect page markup or independently verify ownership; its local checks enforce your declarations, property scope and eligible types. A declared type does not turn an unsupported page into an eligible page.
4. Store your downloaded service-account JSON outside the repository, owned by your Ubuntu user with mode 600. The loader rejects symlinks, group/world access, non-service-account JSON, and invalid/non-RSA keys. Credential-supplied endpoints, delegated subjects and quota-project overrides are ignored. No fallback to `credentials.json`, ambient ADC or account rotation occurs.

Example shell configuration (replace the placeholders with your authorized, genuinely eligible page):

```bash
chmod 600 /absolute/private/path/service-account.json
export GOOGLE_APPLICATION_CREDENTIALS=/absolute/private/path/service-account.json
export GOOGLE_INDEXING_PROPERTY='sc-domain:your-domain.com'
export GOOGLE_INDEXING_AUTHORIZED=true
export GOOGLE_INDEXING_ELIGIBLE_PAGES='[{"url":"https://your-domain.com/jobs/42","pageType":"JobPosting"}]'
npm run db:migrate
npm run cli -- google-indexing-api https://your-domain.com/jobs/42 --label job-notification-test
npm run cli -- report
```

Use `pageType: "VideoObject/BroadcastEvent"` only for the documented nested livestream type. Domain properties include the named domain and subdomains, with a hostname boundary check. Alternatively set a URL-prefix property such as `https://your-domain.com/jobs/` (trailing slash required); only URLs under that exact origin/path prefix pass. Eligible-page configuration is a JSON array of 1–1000 unique entries, all within the property. The command submits exactly one allowlisted URL per invocation; CSV and batch submission are not supported. No target URL is fetched by this adapter, so arbitrary submitted URLs cannot cause server-side target fetching. API/auth endpoints are fixed Google HTTPS endpoints and redirects are disabled.

Authentication uses Google's `google-auth-library` service-account OAuth flow with only the `https://www.googleapis.com/auth/indexing` scope. It sends a JSON `URL_UPDATED` POST to `https://indexing.googleapis.com/v3/urlNotifications:publish`. Authentication has a 10-second request timeout; the whole operation uses a 20-second abort deadline. Publish response reading is bounded to 64 KiB. No automatic retries or quota evasion are implemented. Respect your project's Google quota; rerunning the command creates a new experiment and sends a new notification.

The database transaction records experiment/URL intent before external calls. A completed attempt saves HTTP status, publish start/completion timestamps, optional API acceptance time, a safe error, and allowlisted response metadata. Authentication failures leave publish time/status null because no publish occurred. Missing/invalid configuration fails before network access and before creating an experiment. If the process stops or saving the result fails after sending, the persisted intent remains `SUBMITTED`/`UNKNOWN`; delivery may be uncertain. Do not blindly resubmit such attempts.

A Google HTTP 200 sets lifecycle state and independent `api_status` to `API_ACCEPTED` only. `api_accepted_at` records local receipt time; Google's optional `notifyTime` is stored separately in `api_metadata`. Neither timestamp is a crawl/index timestamp. Non-200/auth/transport failures set state/api_status to `ERROR`, preserving index status and final outcome as `UNKNOWN`. Successful HTTP 200 with missing/malformed metadata still records acceptance; untrusted raw response text is discarded.

Three independent dimensions are retained:

| Dimension | Database evidence |
| --- | --- |
| API notification acceptance | `api_status`, `api_accepted_at`, `request_status`, safe `api_metadata` |
| Verified Googlebot crawl | `first_verified_crawl_at`, exported as independent `crawl_status` UNKNOWN/CRAWL_VERIFIED (never written by this adapter) |
| Confirmed indexing | `index_status`, `index_confirmed_at`, `index_evidence_source` (never written by this adapter) |

The report adds `api_accepted` counts and CSV exports include independent API status/timestamps. Existing baseline records are preserved by an additive, transactional, repeatable migration. All absent indexing evidence stays `UNKNOWN`. An API acceptance cannot force or confirm immediate crawling/indexing. Raw response messages, access tokens, private keys, authorization headers and credential paths are never included in adapter logs or stored metadata. Submitted target URLs are intentionally recorded; do not put secrets in them.

When no eligible page/credentials are configured, run offline mocked tests (including optional real PostgreSQL persistence):

```bash
npm run build
npm test
TEST_DATABASE=1 npm test
```

Tests use synthetic token/API responses and temporary generated test keys. No live Google request is made by these tests; database fixtures are removed afterward. There is no fake-success CLI mode that inserts mocked Google acceptance into normal experiment data.

## Discovery and evidence workflows

All new workflow commands require `--allowed-domain HOST` as your explicit authorization assertion. They do not prove ownership or provide CMS access. Existing records remain intact. Additive migrations add execution status, action history and separate evidence events. `actions --experiment UUID` displays action timestamps, response statuses/errors and evidence; `--csv NEW_FILE` exports action history.

| Command | Executable behavior | What needs manual configuration |
| --- | --- | --- |
| `baseline` | Records target; zero network requests | Nothing |
| `sitemap` | Generates XML or verifies target membership in a published sitemap/index | Publish on your website; supply actual sitemap URL |
| `internal-link` | Generates HTML link or verifies an actual followable anchor in source HTML | Publish link on your own indexable page; supply source URL |
| `redirect` | Generates fixed redirect recipe or verifies direct 301/302/303/307/308 Location to target | Configure a separate source URL on your server |
| `feed` | Generates RSS or verifies target entry in published RSS/Atom | Publish target entry in your own feed |
| `public-tool` | Records operator-reported tool use/response; never auto-calls a public tool | Run tool manually and record time/reference |
| `google-indexing-api` | Authenticated eligible-page URL_UPDATED notification | Eligible page, secure credentials, verified property/owner access |
| `url-inspection` | Read-only Search Console stored index-status inspection | Verified property, Search Console API enabled and authorized identity |
| `request-indexing` | Records manual Search Console Request Indexing action | Use Search Console UI where available; no automation endpoint is invented |
| `crawl-monitor` | Imports normalized trusted JSONL logs and verifies common Googlebot via reverse/forward DNS | Access to your website's actual origin/CDN logs |

Source verification makes our application's read-only GET requests. It observes an existing exposure, not the time Google discovered it and not a remote publication action. A successful match sets `DISCOVERY_ATTEMPTED` but leaves crawl/index UNKNOWN. Local artifact generation leaves state SUBMITTED and execution MANUAL_REQUIRED. Unmatched, missing and out-of-bounds sources remain manual-required, with response statuses recorded. Responses over 1 MiB, non-public destinations, unapproved hostnames and nonstandard ports are blocked. Sitemap indexes are bounded to six checked sources, same authorized hostname, with 500 ms between requests and 10-second deadlines. XML entities/DOCTYPE are rejected; HTML is parsed structurally, including base URL and nofollow rules. Verification does not evaluate robots.txt/indexability and is not proof Google will follow the link. Source redirects are recorded without following them; configure the final source URL explicitly. The redirect adapter only verifies a direct source-to-target redirect.

Example preparation (local files only; never overwrites existing files):

```bash
npm run cli -- sitemap https://beautyhallbd.com/product/ceramide-face-mask-30ml/ --allowed-domain beautyhallbd.com --output reports/prepared
npm run cli -- internal-link https://beautyhallbd.com/product/ceramide-face-mask-30ml/ --allowed-domain beautyhallbd.com --output reports/prepared
npm run cli -- redirect https://beautyhallbd.com/product/ceramide-face-mask-30ml/ --allowed-domain beautyhallbd.com --output reports/prepared
npm run cli -- feed https://beautyhallbd.com/product/ceramide-face-mask-30ml/ --allowed-domain beautyhallbd.com --output reports/prepared
```

Publish the generated artifact using your normal authorized website deployment process. For redirects, configure a fixed separate source path to return the recipe's status/Location; never redirect the target itself. Artifacts alone do not cause Google discovery. After publication, verify it under the original experiment ID:

```bash
npm run cli -- sitemap https://beautyhallbd.com/product/ceramide-face-mask-30ml/ --allowed-domain beautyhallbd.com --experiment UUID --source https://beautyhallbd.com/your-published-sitemap.xml
npm run cli -- actions --experiment UUID
npm run cli -- report --label beautyhall-discovery-observation
```

The deprecated Google sitemap ping endpoint is not used. Publication and optionally authorized Search Console sitemap submission remain separate operator actions; the adapter does not claim either occurred. See [Google's sitemap guidance](https://developers.google.com/search/blog/2023/06/sitemaps-lastmod-ping).

### Manual public tools and Request Indexing

```bash
npm run cli -- public-tool https://beautyhallbd.com/product/ceramide-face-mask-30ml/ --allowed-domain beautyhallbd.com --tool rich-results-test
# After actually using the tool, attach a truthful timestamp and optional result reference:
npm run cli -- public-tool https://beautyhallbd.com/product/ceramide-face-mask-30ml/ --allowed-domain beautyhallbd.com --tool rich-results-test --experiment UUID --performed-at 2026-10-17T09:00:00Z --reference https://search.google.com/test/rich-results/result --http-status 200
```

Replace example timestamps with the actual past action time; future times are rejected. Supported labels are rich-results-test, search-console-live-test and other-authorized-tool. References are recorded without query/fragment and are never fetched. Manual tool usage/HTTP responses are explicitly unverified operator reports and never establish Googlebot crawl or indexing.

For Request Indexing, configure `SEARCH_CONSOLE_AUTHORIZED=true` and `SEARCH_CONSOLE_PROPERTY` for your verified property, open URL Inspection in Search Console and use Request Indexing where supported. Record actual usage with:

```bash
npm run cli -- request-indexing https://beautyhallbd.com/product/ceramide-face-mask-30ml/ --allowed-domain beautyhallbd.com --performed-at ACTUAL_ISO_TIMESTAMP
```

Without property authorization/configuration the record remains MANUAL_REQUIRED even if an action timestamp is supplied. The [URL Inspection API](https://developers.google.com/webmaster-tools/v1/urlInspection.index/inspect) is read-only indexed-version inspection, not Request Indexing or a live URL test. See [Google's manual recrawl workflow](https://developers.google.com/search/docs/crawling-indexing/ask-google-to-recrawl).

### Separate indexing evidence from URL Inspection

Enable Search Console API and grant your service account access to your verified Search Console property. Reuse the secure mode-600 credential-file configuration above, but use the separate read-only property configuration:

```bash
export SEARCH_CONSOLE_AUTHORIZED=true
export SEARCH_CONSOLE_PROPERTY='sc-domain:beautyhallbd.com'
export GOOGLE_APPLICATION_CREDENTIALS='/absolute/private/path/service-account.json'
npm run cli -- url-inspection https://beautyhallbd.com/product/ceramide-face-mask-30ml/ --allowed-domain beautyhallbd.com
# Or attach evidence to an existing exact experiment/target pair:
npm run cli -- url-inspection https://beautyhallbd.com/product/ceramide-face-mask-30ml/ --allowed-domain beautyhallbd.com --experiment UUID
```

The adapter uses `webmasters.readonly`, fixed Google endpoint, bounded requests, no retries, and filtered response metadata. Only index-status PASS plus INDEXING_ALLOWED plus an exact matching Google canonical confirms this target. FAIL/NEUTRAL without that canonical records NOT_INDEXED as current stored index evidence; ambiguous/missing data stays UNKNOWN and does not overwrite previous confirmed evidence. API HTTP 200 alone never confirms indexing. Separate timestamped INDEX evidence events are retained. Confirmation time is when this lab first observed reliable evidence, not Google's unknown actual indexing time. Google's lastCrawlTime is stored as Google-reported history, never promoted into server-log-verified Googlebot evidence. API failure is recorded and cannot invalidate prior indexing evidence. Attaching inspection to an experiment does not change its independent Indexing API acceptance fields.

### Own-server Googlebot monitoring

Export your own trusted origin/CDN access logs to JSONL with one object per request:

```json
{"timestamp":"2026-10-17T08:00:00Z","remote_ip":"66.249.66.1","url":"https://beautyhallbd.com/product/ceramide-face-mask-30ml/","method":"GET","status":200,"user_agent":"Googlebot/2.1"}
```

This is a format example, **not real crawl evidence**. Supply full absolute URLs and a real timezone-aware request timestamp. `remote_ip` must be the actual remote address from a trusted log pipeline. Never copy an attacker-controlled X-Forwarded-For header into it. When behind a CDN, establish trusted client-IP handling before exporting. The lab cannot independently authenticate the provenance of a local log file.

```bash
npm run cli -- crawl-monitor https://beautyhallbd.com/product/ceramide-face-mask-30ml/ --allowed-domain beautyhallbd.com --logs /path/to/trusted-requests.jsonl --experiment UUID
```

Inputs are bounded to 4 MiB/1000 rows, all rows validated before import, DNS lookups bounded/cached, at most 20 uncached identity checks with a 60-second import budget. Common Googlebot UA is only a candidate: reverse DNS must match Google's documented common-crawler hostname pattern and forward DNS must return the original IP. AdsBot, broad google.com/googleusercontent.com proxies, Google InspectionTool and spoofed User-Agents do not qualify. DNS failure yields unverified evidence. See [Google's verification process and crawler categories](https://developers.google.com/crawling/docs/crawlers-fetchers/verify-google-requests).

Only exact-target GET requests at/after experiment start update first verified crawl time. Older verified visits remain historical evidence and cannot produce negative timings. Repeated identical rows are deduplicated. A verified request with any HTTP status is a crawl observation, not indexing proof. Attach evidence to a specific experiment; the lab never automatically credits all experiments sharing the same URL. A standalone monitoring run requires subsequent logs; historical logs should be attached to the appropriate older experiment.

### Limits of comparison

Report/CSV include execution status, completed/manual/unsupported counts, API acceptance, verified crawls, confirmed index counts/rates, evidence sources and elapsed crawl/index timings. Rates use all recorded URL observations in the selected group, including pending/manual/unsupported rows; always read execution counts alongside rates. Filter a cohort with `report --label NAME`. Unknown timing medians are null. No confirmed results means UNKNOWN, not evidence that a method failed.

The same existing BeautyHall URL has overlapping historic exposures and repeated experiments, so it cannot be an isolated control/treatment comparison. Observation start time is not necessarily publication time. Use fresh equivalent URL groups, a truthful recorded publication/action time, and sufficient independent observations before comparing speed. No method effectiveness claim is currently supported.

## Practical execution adapters A–D

The new adapters extend the existing project. `experiments.variant` separates temporary/permanent gateway and link/RSS/Atom/sitemap publishing variants. Existing lifecycle/index fields retain their meanings. New observation fields store `discovery_url`, `real_request_sent`, `published_verified`, safe `output_metadata`, and a separate execution `run_state`. Reports derive legacy request evidence from already-recorded HTTP actions without rewriting old observations.

Execution states are NOT_RUN, BLOCKED_CONFIGURATION, REQUEST_SENT, DISCOVERY_SIGNAL_OBSERVED, CRAWLED, INDEXED and UNKNOWN. CRAWLED requires verified crawler evidence; INDEXED requires confirmed index evidence. DISCOVERY_SIGNAL_OBSERVED means our application observed a valid redirect/exposed public reference, **not that Google discovered it**. A request can fail with HTTP 429/404 and still truthfully have state REQUEST_SENT. Baseline intentionally has no intervention/request and keeps its outcome UNKNOWN. API acceptance remains a separate field. Evidence can later override the displayed execution state while the original exposure/acceptance remains independently recorded.

### Run the safe configured suite and view actual results

```bash
export LAB_TARGET_URL='https://beautyhallbd.com/product/ceramide-face-mask-30ml/'
npm run db:migrate
npm run cli -- experiment-suite "$LAB_TARGET_URL" --allowed-domain beautyhallbd.com --label my-new-cohort
npm run cli -- execution-report --label my-new-cohort
npm run cli -- report --label my-new-cohort
```

The suite uses actual production transports, no mock-success mode, one PageSpeed call, baseline and public source checks. Missing integrations produce persisted BLOCKED_CONFIGURATION records. The suite never automatically confirms a public publication. Product eligibility assessment never calls the Indexing API. Rich Results Test remains an operator workflow because no supported automated interface is configured. Source overrides in `.env.example` are optional; a guessed default endpoint's failure does not prove no sitemap/feed exists elsewhere. Suite errors are isolated per experiment. Repeat runs create new observations and may be rate-limited.

Current actual results are retained in `reports/end-to-end-executions.md`, with full per-action/evidence CSVs and comparison exports. Review them without new requests:

```bash
npm run cli -- execution-report --label beautyhall-end-to-end-20261017
npm run cli -- report --label beautyhall-end-to-end-20261017
npm run cli -- actions --experiment 0045d0de-7bc0-4bda-986c-8fea5769f186
```

### A. Configured HTTPS redirect gateway

Set `GATEWAY_AUTHORIZED=true`, `GATEWAY_PUBLIC_ORIGIN` (a separate owned/authorized HTTPS origin), the exact `GATEWAY_TARGET_URL`, and a private random `GATEWAY_PROOF_SECRET` of at least 32 characters on both lab and gateway host. Optional `GATEWAY_PATH_PREFIX` defaults to `/url-lab`. No credentials or domains are silently discovered or invented.

```bash
npm run cli -- gateway-serve --port 8787
```

This starts a real fixed-destination HTTP server bound to 127.0.0.1. Deploy it on your authorized host behind an already configured HTTPS reverse proxy. Forward `/url-lab/` and `/.well-known/url-indexer-lab` to the backend while preserving the path. Local serving alone is not public execution evidence. The server is not an open redirect: query-supplied targets are rejected, and its only destination is the configured fixed product URL.

After public deployment, run independently:

```bash
npm run cli -- gateway-run "$LAB_TARGET_URL" --allowed-domain beautyhallbd.com --variant temporary --label gateway-tests
npm run cli -- gateway-run "$LAB_TARGET_URL" --allowed-domain beautyhallbd.com --variant permanent --label gateway-tests
```

Temporary means HTTP 302; permanent means HTTP 301. Gateway paths contain the experiment UUID. Preflight verifies explicit authorization, separate HTTPS origin, fixed destination and a fresh HMAC endpoint-control proof. It does not infer legal ownership solely from DNS or an accessible page. The HTTP chain checks every destination, HTTPS, loops, expected initial status and final success, limited to five redirects between the configured gateway and target origins. Every hop/status/resolved Location/time/body SHA-256 is recorded. No gateway URL is automatically submitted to Google. The local server test uses real loopback HTTP responses but is explicitly a local-only test, not a public gateway experiment.

### B. Real authorized WordPress publication

Configure `CMS_URL` with a trailing slash, `CMS_AUTHORIZED=true`, `CMS_USERNAME` and `CMS_APPLICATION_PASSWORD` in your secure environment. Use an application password and a user with `publish_posts` capability. Transport pins validated public DNS addresses, verifies TLS, never follows authenticated redirects and never logs credentials or raw API bodies. See the official [WordPress application-password authentication](https://developer.wordpress.org/rest-api/using-the-rest-api/authentication/) and [post creation API](https://developer.wordpress.org/rest-api/reference/posts/).

Review the exact relevant, transparent post/site/variant first:

```bash
npm run cli -- cms-publish "$LAB_TARGET_URL" --allowed-domain beautyhallbd.com --variant link --preview
```

The preview prints `confirmation_sha256` and the complete post HTML. After review, with authorization/credentials configured, pass that exact hash:

```bash
npm run cli -- cms-publish "$LAB_TARGET_URL" --allowed-domain beautyhallbd.com --variant link --confirm-publication HASH_FROM_PREVIEW --label publishing-tests
```

`HASH_FROM_PREVIEW` must be replaced by the actual 64-character hash, not used literally. Confirmation is bound to provider, site, target, variant and content. Wrong/missing confirmation makes no public POST. No CMS credentials means BLOCKED_CONFIGURATION, never “applied”. Preview is a separate explicitly local NOT_RUN operation and never publishes.

Supported variants are `link`, `rss`, `atom` and `sitemap`; preview/confirm each desired variant. One real `POST /wp-json/wp/v2/posts` publishes a transparent reference. Subsequent variants reuse the same publication receipt instead of generating more posts. RSS/Atom verification checks the native feed for the target link in the published entry/content. Sitemap verification checks the CMS-owned post's URL in its own native sitemap, then the post's target link—cross-domain sitemap URLs are not fabricated. Generated XML is retained and labeled local-only; the adapter does not pretend that local XML was uploaded. Native resource URLs can be set explicitly with CMS_FEED_URL, CMS_ATOM_URL and CMS_SITEMAP_URL when defaults differ.

Public verification is an unauthenticated HTTP request, structural followable-anchor check, meta/X-Robots checks and Googlebot robots.txt evaluation. HTTP 200 or an API's publish status alone is insufficient. An unavailable/unverified feed/sitemap does not count as a verified variant. An API-side PUBLISHED receipt is not proof of public visibility; `published_verified` is set only by public verification. Missing/blocked robot evidence stays unverified.

A unique provider/site/target receipt is reserved before POST. Uncertain/pending attempts are never automatically repeated; reconcile their actions/resource before retrying. This avoids duplicate posts after an interrupted HTTP response. Existing identical published references are reused. There are no account pools, mass publication loops, account rotation or automatic retries.

### C. Documented PageSpeed diagnostic API

```bash
npm run cli -- pagespeed "$LAB_TARGET_URL" --allowed-domain beautyhallbd.com --label rendering-diagnostics
```

This sends one real request to the documented PageSpeed Insights REST v5 interface. Optional PAGESPEED_API_KEY must belong to your own project. [Google documents anonymous use and Lighthouse diagnostic data](https://developers.google.com/speed/docs/insights/v5/get-started). Successful Lighthouse output can indicate a **diagnostic rendering**, not a Search Googlebot crawl, Search discovery signal, indexing request or indexed URL. Output is always labeled DIAGNOSTIC_ONLY. Rich Results Test UI is not scraped or driven through an undocumented endpoint.

Only selected diagnostic fields/safe error codes are retained; raw response messages, headers and API keys are not logged. A PostgreSQL-enforced 60-second minimum interval serializes local calls; there are no automatic retries. HTTP 429 is recorded as a genuine rejected request, with rendering UNKNOWN. Do not retry to evade quota; configure your own enabled project/key and respect its quota. One transport deadline is 55 seconds, with a bounded 1 MiB response. No response/cache/API acceptance is promoted into crawler/index evidence.

### D. Optional supported Blogger API

Configure `BLOGGER_AUTHORIZED=true`, numeric BLOGGER_BLOG_ID, BLOGGER_PUBLIC_ORIGIN and a user OAuth BLOGGER_ACCESS_TOKEN granted the `https://www.googleapis.com/auth/blogger` scope for your owned/authorized blog. The adapter does not use Indexing API service-account credentials for Blogger or impersonate a user. Enable Blogger API in your own project and obtain authorization through Google's supported OAuth flow. See [Blogger authorization](https://developers.google.com/blogger/docs/3.0/using) and [posts.insert](https://developers.google.com/blogger/docs/3.0/reference/posts/insert).

```bash
npm run cli -- blogger-publish "$LAB_TARGET_URL" --allowed-domain beautyhallbd.com --preview
npm run cli -- blogger-publish "$LAB_TARGET_URL" --allowed-domain beautyhallbd.com --confirm-publication HASH_FROM_PREVIEW --label blogger-test
```

The same explicit content/site-bound confirmation and duplicate protection apply. The real supported API creates one relevant transparent public post when authorized; public HTTP/anchor/robots verification runs afterward. Missing credentials block execution. Blog metadata alone does not prove write permission; Google's authenticated insert enforces it. A Google-owned hostname does not automatically enqueue an external URL for Search indexing. No live Blogger post was created during the current verification because no publishing account was configured.

### Reporting and evidence separation

```bash
npm run cli -- execution-report --label COHORT --csv reports/NEW-executions.csv --markdown reports/NEW-executions.md
npm run cli -- report --label COHORT --csv reports/NEW-observations.csv --summary-csv reports/NEW-comparison.csv
```

Use new output filenames; exports never overwrite prior artifacts. Full observation CSV includes action history and evidence history, real-request flag, discovery URL, execution variant/state, safe output, publication verification and independent crawl/index fields. Rates still use all recorded observations in the cohort, so blocked/not-run rows must be read alongside request and completion counts. Timings remain null without evidence. An exposed reference is an application-observed discovery opportunity, not a confirmed Google discovery event.

Local-only simulations (gateway server tests), mocked API/DNS transports (tests only), live public requests (recorded HTTP actions), previews and manual Search Console actions are separately labeled. There is no production fake-success option. Google Indexing API product restrictions and all earlier workflows remain enabled. Same-target overlapping experiments cannot establish a controlled speed advantage.
