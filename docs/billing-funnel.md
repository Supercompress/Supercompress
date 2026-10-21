# Billing conversion measurement

The founder usage API (`GET /api/founder-usage`, founder authentication required)
includes `funnel.unique_accounts` for the current UTC month:

- `quota_blocked`: an authenticated compression request actually returned a paywall.
- `billing_opened`: the signed-in dashboard opened its billing panel.
- `checkout_created`: Stripe successfully created a credit Checkout session.
- `payment_succeeded`: a verified Stripe success webhook confirmed a positive credit payment.

`blocked_cohort` intersects each stage with accounts blocked during that month.
These are distinct-account monthly observations, **not ordered event sequences**,
session counts, or proof that a billing view caused a purchase. Payment markers
use the signed Stripe event's UTC month, not the reconciliation/retry month.
Reconciliation alone never invents a current-month purchase. Stripe remains authoritative for
payment amounts, successful charges, refunds and checkout abandonment.

Markers use disabled, email-less Firebase Auth records (`sc_fnl_` + a deterministic
hash of owner UID, UTC month and stage). This follows the existing Auth-backed
fallback pattern and works while Firestore is disabled. Markers hold only UID,
month and stage in their own claims; they never change account billing claims.
They are deduplicated across instances/retries and excluded from human usage
counts. A maximum of four markers per active account per month is created;
records persist until explicitly deleted. Monitor Auth record growth and migrate
to an event store before scaling this approach to high-volume event analytics.

Tracking failures/timeouts are logged and do not fail compression or checkout.
Counts can therefore under-report during persistence outages. No historical
paywalls, views or purchases are backfilled. Deployment of the API **and existing
dashboard assets** is required to start all four stages. Do not deploy the new
website or control plane as part of this change.
