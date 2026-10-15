# Runtime contracts

- Public repository contents and logs must contain no application source, plaintext analytics, tokens, private diagnostics, or plaintext delivery checkpoints.
- A dedicated read-only SSH key fetches private `main`; repository-scoped `GITHUB_TOKEN` only writes encrypted runner state.
- All manual and scheduled modes use the same concurrency group.
- State must exist and decrypt before any operation. AES-GCM authentication failures, unsupported schemas, future delivery dates, or optimistic concurrency failures stop execution.
- Confirm durable in-flight state before Telegram; never replay uncertain delivery automatically.
- No Actions cache or artifact uploads. Bounded private command diagnostics are stored encrypted with the state.
- Validate against completed Microsoft reports without sending Telegram or publishing reviews. Do not create new Microsoft reports merely to test migration.

## Activation status

- The public runner was activated on October 9, 2026. Legacy private scheduled workflows are disabled; `REPORTS_ENABLED=true` gates the public schedules.

## Dashboard asynchronous recovery

- Normal daily and retry runs use current API queries by default, including after the Singapore date changes and when resuming a legacy async checkpoint. Explicit source recovery and verified repair retain async collection. October 15's recurrence was caused by the old default resetting yesterday's successful query method to async on a new day; date-rollover and ordinary-retry delivery regression checks now cover this selection.
- Manual `repair` requires an explicit same-day source run. It verifies that all five original reports have no execution records before replacing their request identity. The previous identity is retained in encrypted `analyticsHistory`; delivery checkpoints are never reset. Any existing execution refuses replacement.
- Manual `diagnose` performs bounded control requests through private source and stores responses only in encrypted diagnostics. It does not send dashboards or publish reviews.

- The morning request runs at 05:00 Asia/Singapore. Retry checks at 06:15 through 23:15 reuse only the saved current-day request so provider creation quotas and queues do not permanently suppress today's delivery. No current request means no new Microsoft work. The final pending check fails visibly.
- `state.analytics` retains request identity encrypted before Microsoft work starts. All five datasets must be ready before preparing dashboards. Only missing reports in an owned request may be created when resuming partial creation.
- Explicit source recovery must match a run from the current Singapore calendar date and an existing attempt; the orchestration token needs `actions: read` for this metadata check. The token is removed from every private subprocess environment.
- Delivery still requires durable in-flight checkpoints. Confirmed and uncertain sends are skipped on retry. Deploy the private source with `scripts/check-store-dashboard-analytics.js` before this wrapper.
