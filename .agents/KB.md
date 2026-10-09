# Runtime contracts

- Public repository contents and logs must contain no application source, plaintext analytics, tokens, private diagnostics, or plaintext delivery checkpoints.
- A dedicated read-only SSH key fetches private `main`; repository-scoped `GITHUB_TOKEN` only writes encrypted runner state.
- All manual and scheduled modes use the same concurrency group.
- State must exist and decrypt before any operation. AES-GCM authentication failures, unsupported schemas, future delivery dates, or optimistic concurrency failures stop execution.
- Confirm durable in-flight state before Telegram; never replay uncertain delivery automatically.
- No Actions cache or artifact uploads. Bounded private command diagnostics are stored encrypted with the state.
- Validate against completed Microsoft reports without sending Telegram or publishing reviews. Do not create new Microsoft reports merely to test migration.

## Activation status

- Public cloud wrapper tests passed on October 9, 2026. Scheduled production execution remains gated until the private bootstrap and no-delivery validation complete.
- Do not enable scheduled execution with missing application secrets or encrypted state. Keep the original delivery owner active until cutover is verified.
