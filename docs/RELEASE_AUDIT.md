# SuperCompress repository and coding-agent release audit

Date: 2026-07-24 (historical audit — not a live doc index)

## Scope

- Public branding and stale product references.
- Coding-agent package metadata, install path, CLI entrypoints, MCP registration, and proxy lifecycle.
- Static Node syntax checks, package tarball contents, and a local smoke test.
- No compression algorithm, API contract, or proxy request behavior was intentionally changed.

## Findings and actions

| Severity | Finding | Action |
| --- | --- | --- |
| High | Public pages advertised the retired `@supercompress/proxy` package. | Replaced with the supported `supercompress-proxy` install path. |
| Medium | The site still exposed inherited `Datafruit` asset names and comments. | Renamed the assets to `supercompress.css` and `supercompress.js`; updated all references. |
| Medium | Proxy package lock metadata had the wrong package name. | Regenerated the lockfile from `packages/proxy/package.json`. |
| Medium | The scoped runtime package made the install path unnecessarily complex. | Published `supercompress-proxy@0.4.0` as the recommended package; retained `supercompress-cli` as a compatibility wrapper. |
| Low | Health output reported the old `0.1.0` runtime version. | Aligned it to the release version. |
| Low | Service comments referenced the retired `.supercompress-proxy` directory. | Updated documentation to `.supercompress`. |
| High | A local ignored Vercel environment file contained an OIDC credential. | Removed the local file; revoke/rotate that Vercel credential if it was ever shared outside this machine. |
| High | `fast-uri` was present at a vulnerable transitive version. | Applied the non-breaking `npm audit fix`; current audit has no high or critical findings. |

## Verification matrix

- `node --check` on all proxy and CLI JavaScript files.
- `npm test` in `packages/proxy`.
- `npm pack --dry-run` confirms only the intended runtime files ship.
- Clean consumer install from the generated proxy tarball.
- Clean consumer install from `supercompress-proxy@0.4.0` on npm.
- `npm run deploy:prod -- --check` passes without deploying.
- `npm audit --omit=dev` recorded separately; remaining advisories are in upstream MCP/Firebase dependency trees and require an explicit dependency-major upgrade.

## Release notes

The plugin is distributed as two packages:

1. `supercompress-proxy` — runtime, proxy, MCP server, and CLI; this is the recommended install.
2. `supercompress-cli` — legacy convenience wrapper retained for compatibility.

Both packages must be published together for a complete release.
