# SuperCompress fonts

| Role | Family | Weights | Source |
|------|--------|---------|--------|
| Wordmark / headlines | **Platypi** | 300–700, italic | [Google Fonts](https://fonts.google.com/specimen/Platypi) or `web/assets/fonts/platypi-latin*.woff2` on deploy |
| UI / body | **Geist** | 400–700 | [Vercel Geist](https://vercel.com/font) or `web/assets/fonts/Geist-*.woff2` |
| Code / HUD | **IBM Plex Mono** | 400–500 | Used in `dither/logo-dots.html` HUD only |

## Wordmark rule

- **Super** — upright, ink color (`#171717` light / `#f5f5f5` dark)
- **Compress** — italic, brand blue (`#0566ff` light / `#93c5fd` dark)

## CSS

```css
@import url("../tokens/colors.css");
/* or copy @font-face blocks from web/assets/css/fonts.css */
```
