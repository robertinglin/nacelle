# Compatibility loop internals

## Canonical state

`tests.target_status` is changed only by canonical target phases: baseline scans, merge validation committed to the integration branch, failure refreshes, and full regressions. Candidate worktree results are stored for audit and scoring but do not overwrite canonical state.

When the oracle is enabled, only tests whose latest host result is `pass` are actionable. This prevents agents from spending cycles on an upstream test that is already broken, skipped, or incompatible with the selected host environment.

## Failure scheduling

The scheduler groups tests by:

- upstream suite;
- statically observed built-in modules;
- normalized target failure fingerprint.

It prioritizes larger clusters while preferring tests with fewer prior attempts. Related tests are batched so an agent is pushed toward a subsystem implementation instead of one filename-specific fix.

Replicas use rotating strategy lanes:

- minimal generalized fix;
- subsystem-first repair;
- reference/target behavioral differential;
- architecture-boundary repair.

Target scans stop after the configured failure budget is reached (12 files by default). The scheduler queues a configurable backlog of attempts (12 by default) while only the configured worker count runs concurrently. Unknown tests are not scheduled as failures. A full scan is still used for explicit confirmation, periodic regression, and when no known failures remain.

After iterations with no accepted patch, the strategy offset rotates rather than repeating the same prompt lane.

## Parallel proposal, serial integration

Agents run concurrently from one integration commit. Their candidate patches are validated independently in detached worktrees. Valid proposals are then sorted by score and considered serially.

Before a patch is committed, it is three-way applied to the current integration head and its gains are rerun. A proposal that conflicts, loses its gains, regresses hidden guards, or becomes redundant is rejected. A later iteration starts from the new head and can rediscover a compatible version of the same fix.

## Scoring

A candidate's score rewards assigned tests changed from unresolved to pass and gives a small guard-test credit. It penalizes patch size, changed-file count, and very long agent execution. Score chooses merge order; it never bypasses a validation gate.

## Full convergence

After accepted patches, all currently unresolved tests are refreshed. A configurable periodic full regression catches changes outside the hidden guard sample. When no failures remain, the loop performs another full eligible scan and randomized adapter controls before recording `green`.
