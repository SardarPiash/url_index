# Project: Experimental URL Indexer Lab — Minimal MVP

Act as a senior Node.js/TypeScript engineer and web crawling researcher. Build a small, local-first experimental tool to test different URL discovery and indexing-related approaches and measure their actual results.

## Environment
- OS: Ubuntu Linux
- Docker: Installed
- Runtime: Node.js + TypeScript
- Database: PostgreSQL using Docker Compose
- Keep the implementation minimal.
- Do not build a full SaaS, elaborate dashboard, authentication system, or unnecessary abstractions.
- Do not add Redis, BullMQ, Next.js, or NestJS unless needed later.

## Goal
I want to compare how different approaches affect URL discovery, Googlebot crawling, and confirmed Google indexing. I want evidence and measured timings, not assumptions.

## Experiment methods

Implement a modular experiment runner with these methods:

1. Baseline: Record what happens without an active discovery intervention.
2. Sitemap: Test sitemap-based discovery on domains I control.
3. Internal links: Test discovery through links on my test website.
4. Redirects: Test redirect behavior using my own test pages.
5. RSS/feed and external links: Test discovery on authorized test properties.
6. Public testing tools: Record usage and observe subsequent crawling without assuming the tools trigger indexing.
7. Google Indexing API: Test documented API authentication, eligibility, responses, and subsequent observable outcomes on eligible pages and authorized properties.

Treat any ownership-free or arbitrary-URL Indexing API behavior as an unverified hypothesis. Do not implement ownership bypass, quota evasion through project/service-account rotation, spam-link automation, or abuse of public services.

## Data collection

Accept URLs from command-line arguments or CSV.

For each URL, save:
- Experiment ID and method
- Target URL
- Experiment start time
- Request/response status and error
- API response metadata, where applicable
- First verified Googlebot crawl timestamp, if observed
- Index status and evidence source, if available
- Time to first crawl and time to confirmed indexing
- Final result and limitations

Use separate states:
- SUBMITTED
- DISCOVERY_ATTEMPTED
- API_ACCEPTED
- CRAWL_VERIFIED
- INDEX_CONFIRMED
- NOT_INDEXED
- UNKNOWN
- ERROR

Never interpret HTTP 200, an API acceptance response, or a crawler-like User-Agent as proof of indexing. Verify Googlebot identity using Google's documented verification process when analyzing logs from my own test server.

## Google integration

Make Google integration optional.

- Do not require Search Console credentials for local setup or non-Google experiments.
- Explain how to connect my own verified Search Console property later.
- Use the URL Inspection API only for properties I am authorized to inspect.
- Restrict Indexing API tests to Google's documented eligible page types and authorization requirements.
- Never promise that an API request will force immediate crawling or indexing.
- If no reliable indexing evidence is available, return UNKNOWN.

## Comparison report

Provide a simple terminal report and CSV export containing:
- Number of URLs tested per method
- Verified crawl count and rate
- Confirmed indexed count and rate
- Median time to first verified crawl
- Median time to confirmed indexing
- Errors and unknown outcomes

Use equivalent test groups and record when experiments start. Do not claim one method is faster without sufficient observations.

## Safety and reliability

- Prevent SSRF when fetching submitted URLs, including access to localhost, private IP ranges, and cloud metadata endpoints.
- Use request timeouts, bounded retries, and rate limits.
- Keep credentials out of source code and logs.
- Only run active tests on domains I control or am authorized to test.

## Implementation plan

Milestone 1:
- Create the project and Docker Compose configuration.
- Start PostgreSQL.
- Implement URL import and persistence.
- Add one baseline experiment and a working report.
- Run tests and show actual command output.

Milestone 2:
- Add sitemap, internal-link, redirect, and feed adapters.

Milestone 3:
- Add optional Google API integrations and verified crawl monitoring.

Milestone 4:
- Improve comparisons, reporting, and cleanup.

Begin with Milestone 1 only. Inspect the workspace before changing files, avoid overwriting existing files, and provide exact Ubuntu commands. Do not claim a feature works until it has been tested successfully.
