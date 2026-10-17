# Next commands for the actual BeautyHall experiment

These commands retain the exact target and existing cohort. Credentials/authorized hosts are currently absent; configure your real values in a private environment first. Never paste secrets into reports or commit them. `.env` is not auto-loaded.

Inspect actual results without new remote requests:

```bash
export LAB_TARGET_URL='https://beautyhallbd.com/product/ceramide-face-mask-30ml/'
npm run cli -- execution-report --label beautyhall-end-to-end-20261017
npm run cli -- actions --experiment 0045d0de-7bc0-4bda-986c-8fea5769f186
```

A — after deploying the configured fixed-destination gateway on your authorized HTTPS origin (see README/.env.example), start its local backend on that host:

```bash
npm run cli -- gateway-serve --port 8787
```

On the lab, with the same gateway proof secret and origin configured:

```bash
npm run cli -- gateway-run "$LAB_TARGET_URL" --allowed-domain beautyhallbd.com --variant temporary --label gateway-live
npm run cli -- gateway-run "$LAB_TARGET_URL" --allowed-domain beautyhallbd.com --variant permanent --label gateway-live
```

B — after configuring your authorized WordPress site/user/application password, review the exact proposed post:

```bash
npm run cli -- cms-publish "$LAB_TARGET_URL" --allowed-domain beautyhallbd.com --variant link --preview
```

Copy its confirmation_sha256 only after approving the displayed content/site. The following shell input is your explicit publication confirmation; it is not automatic approval:

```bash
read -r -p 'Approved confirmation_sha256 from the preview: ' LAB_PUBLICATION_CONFIRMATION
npm run cli -- cms-publish "$LAB_TARGET_URL" --allowed-domain beautyhallbd.com --variant link --confirm-publication "$LAB_PUBLICATION_CONFIRMATION" --label cms-live
```

For RSS, Atom or sitemap, preview/confirm the desired variant independently (substitute rss, atom or sitemap for link). The already published identical post is reused; extra posts are not created per variant.

C — the actual diagnostic already returned 429. Do not immediately retry. After configuring an enabled API key for your own project and checking quota:

```bash
npm run cli -- pagespeed "$LAB_TARGET_URL" --allowed-domain beautyhallbd.com --label pagespeed-configured
```

D — after configuring your authorized Blogger blog ID/public origin and user OAuth token:

```bash
npm run cli -- blogger-publish "$LAB_TARGET_URL" --allowed-domain beautyhallbd.com --preview
read -r -p 'Approved Blogger confirmation_sha256 from the preview: ' LAB_BLOGGER_CONFIRMATION
npm run cli -- blogger-publish "$LAB_TARGET_URL" --allowed-domain beautyhallbd.com --confirm-publication "$LAB_BLOGGER_CONFIRMATION" --label blogger-live
```

Read-only indexing observation, after configuring your own verified Search Console property/authorized identity:

```bash
npm run cli -- url-inspection "$LAB_TARGET_URL" --allowed-domain beautyhallbd.com --experiment 59c80a9d-423b-4b92-95b7-ba76682c9d57
```

For real server logs, set LAB_TRUSTED_LOG_FILE to the actual trusted JSONL export path before importing:

```bash
npm run cli -- crawl-monitor "$LAB_TARGET_URL" --allowed-domain beautyhallbd.com --logs "$LAB_TRUSTED_LOG_FILE" --experiment 59c80a9d-423b-4b92-95b7-ba76682c9d57
```

Do not run google-indexing-api against this ordinary product URL. No tool response, public reference or redirect alone establishes Googlebot crawling or indexing.
