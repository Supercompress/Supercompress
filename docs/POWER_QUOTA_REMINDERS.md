# Power-user quota reminders

## Automatic conversion sequence

The dedicated Fly Machine `sc-conversion-daily` (`83d493b71721d8`) in
`supercompress-api`, region `sjc`, runs `scripts/run-conversion-emails.js` daily.
It has no HTTP services and uses restart policy `no`; the existing API Machine
is not replaced or redeployed. Fly's daily schedule is approximate, not a
guaranteed wall-clock delivery time.

Eligible unpaid power users receive an initial quota/upgrade reminder, a
follow-up no earlier than three days later, and a final follow-up no earlier
than seven days after the initial reminder. Follow-ups are at least three days
apart; missed runs never produce a catch-up burst. After the final follow-up,
the broader conversion sequence ends permanently. The existing monthly
near-quota notification flow is unchanged and is separate from this sequence.

Existing current-month quota reminders seed the sequence without sending
another initial email. The seed date starts the follow-up clock conservatively.
Each run checks live Auth eligibility and successful Stripe payment history;
payment-history read failures prevent sending. Paid/comped accounts, opted-out
accounts, and hard-blocked recipients are suppressed. An unsubscribe for an
existing account is acknowledged only after its Auth suppression flag is saved;
failed writes return a retryable error rather than a false success. Historical store-only
opt-outs are preserved through a reconciled SHA256 suppression manifest; new
opt-outs are checked through live Auth claims. Never replace that manifest with
an empty list without reconciling the durable unsubscribe source.

SQLite on the dedicated encrypted Fly volume `sc_conversion_state`
(`vol_vgn0keenwnqj9lj4`, mounted at `/data`) records sequence stage and delivery
status keyed by SHA256 of the Auth UID. Scheduled volume snapshots retain
seven days of backups. Legacy
`sc_conv` Auth claims are read as a fallback without requiring their removal.
Campaign state does not consume the 1KB Auth claim budget or trim billing
history. The worker transactionally reserves a pending state before sending and marks it sent only
after provider acceptance. A failed or ambiguous send remains pending for
manual reconciliation, not an automatic retry. Runs stop on delivery or claim
write failure, preserve billing claims, and send at most 40 messages by default.
Signed unsubscribe links and one-click unsubscribe headers accompany every
message. Provider acceptance still does not prove inbox delivery.

### Deployment and operations

The worker uses a bundled file injected into the pinned production API image
`registry.fly.io/supercompress-api:deployment-01M5QTC007KTWTTFHDAQACKQWM`.
It inherits app secrets; its non-secret environment enables the campaign,
disables legacy Gist access, provides the reconciled suppression manifest, and
sets `SC_CONVERSION_STATE_DB=/data/conversion.sqlite`. The mount directory must
be writable by the image's `node` user. The worker needs Node 24's built-in
SQLite support; no Firestore API or database is required.
Do not deploy the entire working tree to update this worker.

Build and dry-run any replacement bundle before activating it:

```sh
esbuild scripts/run-conversion-emails.js --bundle --platform=node --target=node24 --packages=external --outfile=/tmp/sc-conversion-worker.cjs
fly machine update 83d493b71721d8 -a supercompress-api --file-local /app/sc-conversion-worker.cjs=/tmp/sc-conversion-worker.cjs --command 'node /app/sc-conversion-worker.cjs' --restart no --yes
fly machine start 83d493b71721d8 -a supercompress-api
fly logs -a supercompress-api -m 83d493b71721d8 --no-tail
```

Inspect the aggregate `conversion-emails` result before enabling live sends:

```sh
fly machine update 83d493b71721d8 -a supercompress-api --command 'node /app/sc-conversion-worker.cjs --send' --restart no --yes
fly machine start 83d493b71721d8 -a supercompress-api
fly machine list -a supercompress-api --json
```

Verify the worker retains `schedule: daily`, no services, restart policy `no`,
and the intended command. Delivery requires both `--send` and
`SC_CONVERSION_EMAILS_ENABLED=1`; the command defaults to dry-run otherwise.
Investigate nonzero `failed` or `pending_review` counts before any manual rerun.
Do not clear pending state without reconciling provider receipts. Preserve the
volume and SQLite database across deployments; deleting or restoring stale
state can restart sequences for accounts without a legacy Auth state marker.
Never run another campaign Machine with an independent state database. A
volume snapshot restore requires reconciling provider receipts before sends.

To suspend delivery while retaining daily dry-run checks, update the command
without `--send`. To permanently remove the schedule, destroy only this worker:

```sh
fly machine destroy 83d493b71721d8 -a supercompress-api --force
```

Stopping the Machine alone does not disable its daily schedule. Never destroy
the API Machine as part of campaign maintenance. Keep the campaign volume for
deduplication history even when removing the worker.

## Explicit one-off campaign

`api/_lib/power-quota-mail.js` supports an explicitly invoked, bounded campaign.
It is not connected to the regular quota drain. Runs default to dry-run mode;
delivery requires `dryRun: false`. Never invoke simultaneous campaign workers.

Eligible accounts have a recorded power-user milestone or at least one million
retained monthly input tokens. Disabled, synthetic, unsubscribed, comped,
legacy-paid, and positive-credit accounts are excluded. Both live Auth opt-outs
and the reconciled historical suppression manifest are checked before delivery.
A missing or invalid manifest blocks the run; a process-local empty store is
not proof that nobody unsubscribed.

Messages report current-month usage and the remaining 1M free allowance;
retired onboarding bonuses do not increase it. Historical power users without current-month usage are
shown zero usage. Do not tell a user they exhausted quota unless their usage
actually reaches their allowance. Near-limit notifications historically start
at 98%, so a quota-mail stamp alone is not evidence of a blocked request.

Successful reminders receive the existing `sc_quota_mail = YYYY-MM` stamp and use
the quota lane's provider idempotency key. This also prevents duplicate reminders
from older deployed quota workers without requiring a deployment. Both lanes
additionally respect `sc_power_quota_mail` for compatibility. These are
notification markers, not `quota_blocked` events or
evidence of payment. Provider acceptance is not proof of inbox delivery.

The worker rechecks live account claims before each send, includes signed
unsubscribe links, uses a stable provider idempotency key, and stops on the first
delivery or claim-stamp failure. After a partially failed run, reconcile provider
receipts and Auth markers before retrying; provider idempotency is not permanent.

Offline verification:

```sh
node --test api/_lib/conversion-mail.test.js api/_lib/power-quota-mail.test.js api/_lib/quota-mail.test.js
node api/_lib/power-user.test.js
```
