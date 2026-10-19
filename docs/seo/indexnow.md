# IndexNow

- Key: `1ade97a6bb5c418e8250421d93f175fc`
- Key file: `web/1ade97a6bb5c418e8250421d93f175fc.txt`, served at https://www.supercompress.dev/1ade97a6bb5c418e8250421d93f175fc.txt (already live).
- Ping only after `npm run deploy:prod` has finished and the changed pages return 200 on www.

```bash
bash scripts/indexnow-ping.sh https://www.supercompress.dev/faq https://www.supercompress.dev/context-rot
bash scripts/indexnow-ping.sh --sitemap   # every www URL in web/sitemap.xml
```

HTTP 200 or 202 means accepted. 403 means the key file is not reachable; 422 means a URL is not on the host. IndexNow notifies Bing and other participating engines. Google does not use it; submit the sitemap in Search Console instead.
