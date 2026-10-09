# Runtime contracts

- Public repository contents and logs must contain no application source, plaintext analytics, tokens, private diagnostics, or plaintext delivery checkpoints.
- A dedicated read-only SSH key fetches private `main`; repository-scoped `GITHUB_TOKEN` only writes encrypted runner state.
- All manual and scheduled modes use the same concurrency group.
- State must exist and decrypt before any operation. AES-GCM authentication failures, unsupported schemas, future delivery dates, or optimistic concurrency failures stop execution.
- Confirm durable in-flight state before Telegram; never replay uncertain delivery automatically.
- No Actions cache or artifact uploads. Bounded private command diagnostics are stored encrypted with the state.
- Validate against completed Microsoft reports without sending Telegram or publishing reviews. Do not create new Microsoft reports merely to test migration.

## Activation status

- Production schedules are enabled after the October 9, 2026 migration. Legacy private daily/review workflows are disabled and their schedules removed.
- Secured wrapper checks passed 14 tests. Cloud validation passed 38 private application tests and rendered four dashboard images without sending. Saved reviews were exported without publishing. A daily test skipped all four same-day sent dashboards.
- Only the owner has repository write access. Main requires owner review; owner admin bypass is retained. Force pushes and deletion are disabled. Actions policy permits only the two exact pinned checkout/setup-node revisions; secret scanning and push protection are enabled.
- Each child stage receives only its required provider credentials. Installation, clone, and tests receive none. No workflow executes PR/fork code.
- Public history and completed run logs were checked for known keys, token/private-key patterns, and exposed private diagnostics; no matches were found. This does not guarantee protection against a compromised owner account, runner, trusted action, or application dependency.
