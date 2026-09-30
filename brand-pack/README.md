# SuperCompress Brand Pack

Official logos, colors, typography, and dither/shader primitives for marketing, launch assets, and product UI.

## Contents

```
brand-pack/
├── logos/           # Marks, lockups, wordmarks, favicons, badge
├── tokens/          # colors.css + colors.json
├── dither/          # dither-kit-lite.js, logo-dots demo, Bayer matrices, CSS
├── fonts/           # Font sourcing notes
├── patterns/        # Misc brand patterns (Product Hunt tag, etc.)
└── export/          # Drop rendered PNG/SVG exports here
```

## Quick reference

| Asset | Light | Dark |
|-------|-------|------|
| Horizontal lockup | `logos/lockup-horizontal-light.svg` | `logos/lockup-horizontal-dark.svg` |
| Wordmark only | `logos/wordmark-light.svg` | `logos/wordmark-dark.svg` |
| Mark (chevrons) | `logos/logo-mark-square-light.svg` | `logos/logo-mark-square-dark.svg` |
| Raster mark | `logos/logo-mark.png` (1096²) · also 512/128/64/32 | same mark on dark bg |

**Paper:** `#fbfbf8` · **Ink:** `#171717` · **Brand:** `#0566ff` · **Dark bg:** `#0a0a0a`

## Logos

- **Mark** — blue chevron stack (`logo-mark*.png`). Do not stretch; keep square aspect.
- **Wordmark** — Platypi: `Super` upright + `Compress` italic blue.
- **Lockup** — mark + 12px gap + wordmark (matches site header).
- **Badge** — `badge-compressed-by.svg` for embeds (“COMPRESSED BY SuperCompress”).
- **Favicons** — `favicon.svg`, `favicon-chevron.svg` (64² embedded mark).

## Dither / shaders

Port of [Tripwire dither-kit](https://www.tripwire.sh/dither-kit) tuned for SuperCompress blue.

| File | Purpose |
|------|---------|
| `dither/dither-kit-lite.js` | Charts, washes, meters, sparklines (`window.DitherKitLite`) |
| `dither/dither-kit.css` | Host + tooltip styles |
| `dither/bayer-matrices.json` | 4×4 chart Bayer + 8×8 logo-dots Bayer |
| `dither/logo-dots.html` | Interactive dithered lockup (open in browser) |

### Usage

```html
<link rel="stylesheet" href="brand-pack/tokens/colors.css" />
<link rel="stylesheet" href="brand-pack/dither/dither-kit.css" />
<script src="brand-pack/dither/dither-kit-lite.js"></script>
<div class="dk-chart" id="chart" style="height:260px"></div>
<script>
  DitherKitLite.renderAreaChart(document.getElementById("chart"), {
    data: [12, 18, 9, 22, 31],
    color: "brand",
    bloom: "aura",
  });
</script>
```

## Typography

See `fonts/README.md`. Prefer self-hosted files under `web/assets/fonts/` in production.

## Canonical product paths

These mirror what ships on [supercompress.dev](https://www.supercompress.dev):

- Mark PNG: `/assets/img/logo-chevrons.png`
- Site CSS tokens: `web/assets/css/landing-motion.css`, `web/assets/css/supercompress.css`
- Dither JS: `web/assets/js/dither-kit-lite.js`
