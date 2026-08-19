# Security Policy

## Supported versions

Please report vulnerabilities against the latest published PyPI release and the `main` branch of this repository.

## Reporting a vulnerability

Do **not** open a public issue for security reports.

**Preferred:** [GitHub Private vulnerability reporting](https://github.com/Supercompress/Supercompress/security/advisories/new) on this repository (Settings → Code security and analysis → Private vulnerability reporting). Use this for full reproduction steps, PoCs, and proposed fixes.

**Also accepted:** email [arjunkshah21@gmail.com](mailto:arjunkshah21@gmail.com) for initial contact only. If the report includes exploit details, we will ask you to move the full write-up to GitHub private reporting or another encrypted channel.

Include:

- Description of the issue
- Steps to reproduce
- Impact assessment (auth bypass, key leakage, data exposure, DoS, etc.)
- Any proof-of-concept limited to a private report

We will acknowledge receipt within a few business days and work on a fix before any public disclosure.

## API keys

- Treat `sc_live_…` keys as secrets.
- Rotate keys from the [dashboard](https://supercompress.dev/dashboard) if exposed.
- Never commit keys, `.env` files, or Firebase/Stripe credentials to git.
