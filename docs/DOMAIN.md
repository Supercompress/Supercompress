# Domains

## Canonical product host

- **Primary:** `https://www.supercompress.dev`
- **Apex:** `https://supercompress.dev` (308 → `www` on Vercel)

Use `www.supercompress.dev` in API clients and docs when redirects are not followed.

## Entity / SEO graph (AEO + GEO)

| Domain | Role | SEO use |
|--------|------|---------|
| `www.supercompress.dev` | Product + money pages + `/llms.txt` + `/ai-search.json` | Canonical citations |
| `docs.supercompress.dev` | Install / API / agents | How-to trust |
| `api.supercompress.dev` | Compress API only | **No catch-all redirects** |
| `www.arjunshah.xyz` | Founder Person entity | E-E-A-T / sameAs / author |
| `loopy.yachts` | Sister product (uses SC) | Natural referral + “powered by” |
| `tryjasmine.dev` | Personal / studio | Soft brand; do not doorway-spam |
| `dihsign.com` | Design experiments | Soft brand only |
| `suryatara.website` | Hub / tools index | Curated links → SC + Loopy + portfolio (**live**) |
| `tryjasmine.dev` | Jasmine brand | 301 → `arjunshah.xyz/projects/jasmine` |
| `ideatr.dev` | Expired 2026-08-31 | **Renew** then 301 → `arjunshah.xyz` or Loopy |

Bidirectional entity links: Organization (`supercompress.dev`) ↔ Person (`arjunshah.xyz`) ↔ related product (`loopy.yachts`).

AEO/GEO hub: https://www.supercompress.dev/aeo-geo

## `supercompress.com`

**Not under Vercel control.** WHOIS shows Fabulous / Sea Wasp parking (`NS*.FABULOUS.COM`) with `x-robots-tag: noindex`. It is **not** the product and should not be linked from ads or press.

**If / when acquired:** point DNS at the same Vercel project as `.dev` and 301 `https://supercompress.com/*` → `https://www.supercompress.dev/$1`.

## Anti-patterns

- Do **not** build thin PBN clones of SuperCompress on unrelated domains.
- Do **not** add api-host catch-all redirects.
- Prefer unique useful content + clear sameAs over doorway pages.
