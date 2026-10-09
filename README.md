# Private report cloud runner

This public repository contains only a cloud execution wrapper. The application source remains in a separate private repository and is cloned with a dedicated read-only SSH deploy key.

Standard public GitHub-hosted Linux runners do not consume the private-repository Actions minutes allowance. No Actions caches or uploaded artifacts are used here. Durable checkpoints and bounded diagnostic logs are AES-256-GCM encrypted, padded, and stored as `state.enc` on the `state` branch. The encryption key is a repository secret. Losing that key loses access to checkpoints; do not reset state or rotate the key without decrypting and re-encrypting the existing file.

Only generic stage results are public. Private subprocess output is captured and included in encrypted diagnostics. The private working directory is removed after execution. Invalid or unavailable state stops execution. Every external delivery requires a confirmed durable in-flight checkpoint. An uncertain delivery is retained for manual investigation and is never automatically replayed.

Installation, source checkout, and tests receive no provider credentials. Each business stage receives only its relevant credentials. Repository policy only allows the exact pinned checkout/setup-node commits. Main requires owner review, with owner admin bypass retained; force pushes and branch deletion are disabled. Repository Secrets are not available to public readers or fork workflows. A compromised trusted maintainer, runner, action, or dependency can still compromise credentials: public visibility does not provide a guarantee against those threats.

The `Cloud reports` workflow supports `validate` (existing analytics required, renders four PNGs without sending), `validate-reviews` (checks and exports saved reviews without publishing), `daily`, `reviews`, and `collect`. All modes share one concurrency group and only run from `main`. Scheduled execution is gated by the repository variable `REPORTS_ENABLED=true`.

The source repository and host keys are repository variables. Authentication and application configuration are repository secrets. Never copy private source, plaintext checkpoints, analytics, or credentials into this repository, its issue tracker, logs, caches, or artifacts. Only trusted owners should be allowed to edit workflows. There are no pull-request or push execution triggers.

Public repositories may have schedules disabled after 60 days without activity. Normal encrypted checkpoint commits provide activity, but workflow status must still be checked after extended inactivity. Scheduling delays on GitHub remain possible.

Run the wrapper's security and state tests with `npm test`.
