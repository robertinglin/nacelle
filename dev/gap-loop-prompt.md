# Gap coverage loop — standing instructions

You are running the bnh gap-coverage loop: turn open gap cards into runtime
capability, three cards at a time, using INTERNAL `gpt-5.6-luna` agents at
HIGH reasoning as the builders.
You are the orchestrator: you validate, commit, merge, and re-verify. Repeat
rounds until all credible cards are closed, every remaining unsolved card has
been explicitly deferred with evidence, or the user interrupts.

Fixed paths (always absolute — relative paths have caused two incidents):

- Harness repo: `/home/bee/Projects/browser-node-harness`
- Node target repo (owns worktrees): `/home/bee/Projects/browser-node-harness/.bnh-state/target`
- Integration worktree (branch `bnh/integration-v22`): `/home/bee/Projects/browser-node-harness/.bnh-state/v22/worktrees/integration-v22`
- Worklist: `/home/bee/Projects/browser-node-harness/.bnh-state/v22/gap-worklist` (WORKLIST.md + gap-<id>/ card dirs)
- Real DB: `/home/bee/Projects/browser-node-harness/.bnh-state/v22/state.sqlite3` (never open `Database()` on a guessed filename — it creates a stray empty db)
- Codex binary fallback: `/home/bee/.local/share/mise/installs/codex/latest/bin/codex`

All `python3 -m browser_node_harness` commands run from the harness repo root
with `PYTHONPATH=/home/bee/Projects/browser-node-harness/src`.

## Builder first 60 seconds

After receiving a card, do these actions immediately before broad exploration:

**You need to fix the FAILING tests. that's the requirement.** A before/after
no-regression result, a partial improvement, or a plausible runtime patch is
not completion. Keep working until the full listed suite passes, or preserve
the attempted runtime-only work as explicitly unapproved deferred WIP with
the exact remaining failures documented.

1. Read the coordinator tail in that card's `agent-prompt.md` for the absolute
   worktree and exact acceptance paths.
2. Run the exact command shown there from
   `/home/bee/Projects/browser-node-harness`; never spend time searching for a
   `bnh` executable and never substitute a guessed test command.
3. If Chromium reports an operation-permitted `INFRA_ERROR`, rerun the same
   command with escalated browser permissions. Only the completed rerun is
   evidence.
4. Use the resulting per-test `PASS`/`FAIL`/`TIMEOUT` output to choose the
   smallest browser-native runtime fix. A card is approvable only when every
   listed acceptance test is `PASS`. There are no partial-pass, timeout, or
   named-test exceptions to this approval gate; “no regression,” partial PASS,
   or an unstarted test is not approval.

Before editing, confirm that the assigned worktree is isolated. If
`runtime.js` or `runtime/` is a symlink into the shared adapter, materialize
that path in the assigned worktree first; never edit the shared adapter through
a symlink.

Do not begin with PATH/launcher archaeology, harness edits, test edits, or
`gaps --verify`/`gaps --emit`. Those commands are coordinator work.

## Environment bootstrap (required on every machine)

The shared browser runtime has one branch-owned source of truth in the harness
repository:

- Runtime entry: `/home/bee/Projects/browser-node-harness/adapters/playwright/runtime.js`
- Runtime modules: `/home/bee/Projects/browser-node-harness/adapters/playwright/runtime/`
- Link command: `/home/bee/Projects/browser-node-harness/link-runtime.py`

From the harness repository root, line up the active v22 integration before
running setup, creating agents, or launching validation:

```bash
cd /home/bee/Projects/browser-node-harness
./link-runtime.py --config harness.toml --variant v22
```

The command is safe to rerun. It creates relative links from the integration
worktree to the adapter runtime:

```bash
test "$(readlink -f .bnh-state/v22/worktrees/integration-v22/runtime.js)" = \
  "/home/bee/Projects/browser-node-harness/adapters/playwright/runtime.js"
test "$(readlink -f .bnh-state/v22/worktrees/integration-v22/runtime)" = \
  "/home/bee/Projects/browser-node-harness/adapters/playwright/runtime"
```

Do not copy a second runtime into the integration worktree and do not replace
different target content silently. The link command refuses conflicts and
backs up matching regular copies under `.bnh-state/` before converting them.
The bridge and harness page remain target integration files; only
`runtime.js`, `runtime/`, and `server.js` are shared links. The canonical
server is `/home/bee/Projects/browser-node-harness/adapters/playwright/server.js`;
it serves `harness.html` and modules from the current target worktree and
supplies the required COOP/COEP headers. Do not write a replacement server in
the Node checkout when this link is missing; rerun `./link-runtime.py` and
resolve any reported conflict without deleting the existing copy.

When runtime code is edited through the integration path, the bytes change in
the adapter paths above and must be committed from the harness repository:

```bash
git -C /home/bee/Projects/browser-node-harness add \
  adapters/playwright/runtime.js adapters/playwright/runtime \
  adapters/playwright/server.js
git -C /home/bee/Projects/browser-node-harness commit \
  -m "Update shared browser runtime"
```

Do not stage the integration worktree's symlink replacement as a target-runtime
implementation commit. Detached agent worktrees remain isolated validation
worktrees; do not link multiple concurrent agent worktrees to the same shared
adapter files.

## Acceptance-test launch recipe

Do not spend time looking for a `bnh` executable on `PATH`; it is not required
and may not be installed in the agent shell. Every builder should use this
already-known command shape immediately, with absolute paths:

```bash
cd /home/bee/Projects/browser-node-harness
./link-runtime.py --config harness.toml --variant v22
PYTHONPATH=/home/bee/Projects/browser-node-harness/src python3 -m \
  browser_node_harness --config harness.toml test \
  --worktree <absolute-agent-worktree> <card acceptance paths...>
```

The orchestrator uses the same command with
`--worktree /home/bee/Projects/browser-node-harness/.bnh-state/v22/worktrees/integration-v22`
for the independent baseline and post-merge verification. Agents must copy
the exact acceptance paths from the card prompt; do not substitute a smaller
sample. If Chromium is rejected by the sandbox with an operation-permitted
`INFRA_ERROR`, immediately rerun the identical command through the escalated
execution path and classify the result only after that rerun. A missing `bnh`
launcher, a sandbox rejection, or an unstarted browser is not a test result
and is never evidence that the card passes or fails. Record the harness log
path and the per-test PASS/FAIL/TIMEOUT counts from the completed run.

## Agent launch and long-running execution policy

Builders MUST be spawned through the local internal multi-agent workflow first,
with model `gpt-5.6-luna` and HIGH reasoning. Use the
local multi-agent spawn/wait/close workflow to create, monitor, and collect the
three builders before attempting to drive an agent through a shell command.
`codex exec` is a fallback for cases where the local agent workflow is
unavailable or insufficient; it is not the first launch path and must not be
used merely because a local agent has not reported back yet.

If an `exec` fallback is necessary, the command MUST be run in escalated mode
(`require_escalated`) with a justification. A sandboxed `exec` is not an
acceptable substitute: agent bootstrap, browser access, and long-lived child
processes may require the escalated environment.

Agents and validation jobs are allowed to run for more than 30 minutes. Never
terminate, retry, or declare an agent stuck solely because 30 minutes have
elapsed. Launch long-running fallback jobs in a persistent/background session
whose process survives the command's foreground timeout, retain its session or
process identifier, and reconnect by polling it until completion. Use bounded
poll intervals in the orchestrator so the unattended gap loop remains
responsive while the job continues running.

## Parallel-agent invariant

Keep three INTERNAL Luna HIGH builders active whenever at least three safe,
non-overlapping cards are available. Long-running implementation or acceptance
jobs are expected and are never a reason to reduce the active-builder count.
At the start of every round, dispatch all three selected cards in parallel. If
one builder finishes, fails, is deferred, or is merged while other builders
continue, immediately select and launch a replacement safe card; do not wait
for the slowest builder before refilling the slot. Apply the write-surface and
family-conflict rules in Step 1 when choosing replacements, and do not dispatch
deferred cards unless their implementation path, prerequisite, or validation
condition has materially changed. If fewer than three safe cards exist, launch
all available cards and record why a slot is unused. This concurrency rule
never relaxes the full-suite approval gate: a builder is not approved until
every listed acceptance test passes. Any timeout, including a known
pre-existing loader timeout, keeps the card unapproved and requires repair or
explicit deferral with evidence.

## One round

1. **Pick 3 cards.** Read the `## Work accounting` family table in
   `WORKLIST.md` first, then the `## Evidence/build cards` table. The evidence
   card count is not the independent-work count: several bounded cards may
   belong to one runtime write-surface family, and the family table reports
   the assignment unit and its combined obligations. Take top-ranked cards
   from different, unclaimed runtime write surfaces — different runtime files
   per round whenever possible. Before dispatch, inspect each card's symbols
   and confirm its likely files under `adapters/playwright/runtime/`. Never
   assign two agents cards that edit the same runtime file, shared export
   table, or tightly coupled API family in parallel. If the next ranked card
   overlaps, skip it for this round and select the next safe family; if
   overlap is unavoidable, batch the cards into one agent or serialize them
   after the first merge. Never assign two agents the same card or the same
   family at once. Note `test/es-module/
   test-esm-named-exports.mjs` is a known pre-existing loader-hook timeout:
   record it as evidence, but it remains a blocker for approval and requires
   repair or explicit deferral.

2. **Create worktrees** from the current `bnh/integration-v22` HEAD
   (get it with `git -C <integration worktree> rev-parse HEAD`):

   ```bash
   git -C /home/bee/Projects/browser-node-harness/.bnh-state/target worktree add \
     /home/bee/Projects/browser-node-harness/.bnh-state/v22/worktrees/luna-gap-<id> \
     -b luna-gap-<id> <HEAD>
   ```

   The path argument MUST be absolute: with `git -C`, relative paths resolve
   against the repo directory, not your cwd, and the worktree lands nested
   inside the repo.

3. **Write the agent prompt.** Copy the card's `prompt.md` to `agent-prompt.md`
   in the card dir, then append the environment tail — use an existing
   `gap-*/agent-prompt.md` from a previous round as the template. The tail
   must contain: the worktree path and branch, the card dir path, the exact
   acceptance command (using the launch recipe above, never a bare `bnh`), the
   constraints (no test modification, no
   hard-coded expectations, browser-native only, extend `runtime.js`/`runtime/`
   rather than adding a parallel layer), an explicit hard approval gate that
   every listed acceptance test must report `PASS` with no timeout exception,
   and "leave changes uncommitted".

   Acceptance command shape:

   ```bash
   cd /home/bee/Projects/browser-node-harness && \
   PYTHONPATH=/home/bee/Projects/browser-node-harness/src python3 -m \
   browser_node_harness --config harness.toml test \
     --worktree <worktree> <card acceptance_paths...>
   ```

4. **Launch all three in parallel** using the local agent workflow first. Keep
   each agent attached to its own worktree and retain its agent identifier so
   it can be waited on and closed cleanly. Only if that workflow is unavailable
   or insufficient, use an `exec` fallback (in escalated mode as required
   above) and keep the process in a persistent session because it may exceed
   30 minutes:

   The surrounding tool invocation must set `sandbox_permissions:
   require_escalated` and provide a user-facing justification; the CLI flag
   below does not replace that escalation.

   ```bash
   /home/bee/.local/share/mise/installs/codex/latest/bin/codex exec \
     --dangerously-bypass-approvals-and-sandbox \
     -C <worktree> "$(cat <card dir>/agent-prompt.md)"
   ```

5. **As each agent finishes:**
   - Read its final report (root cause, subsystem, tests run).
   - Agents must not run `gaps --verify` or `gaps --emit`: those commands
     mutate the shared DB/worklist and are reserved for the orchestrator after
     all merges in the round. Agents may run focused acceptance commands.
   - Independently rerun the card's exact acceptance command yourself. This is
     a hard approval gate: every listed test must report `PASS` before the
     card can be approved, committed, or merged. A before/after result of
     "no regression" is not sufficient. Any `FAIL`, `TIMEOUT`, infrastructure
     error, or incomplete suite — including the known pre-existing loader
     timeout — means the card is not approved and must be repaired/retried or
     deferred after its second failed validation.
   - Review scope: `git -C <worktree> diff --stat` — only `runtime.js` and
     `runtime/**` are acceptable. Anything touching `test/` or harness code:
     reject and relaunch that card once.
   - Commit: `git -C <worktree> add -A && git -C <worktree> commit -m
     "<module>: implement <symbol summary>"`.
   - If a card fails validation twice, mark it `deferred` for this loop,
     record the card ID, attempted change, exact validation results, and the
     reason it remains unresolved in the deferred ledger, then continue with
     the other cards. Before deferring, apply the preservation rule below so
     valuable runtime-only work is not lost. The gap stays open in the
     DB/worklist; deferred is an orchestration status, not a successful
     implementation.

6. **Merge serially** into `bnh/integration-v22` (in the integration worktree):
   `git merge --no-edit luna-gap-<id>`, one at a time, resolving conflicts as
   you go. The selection rule above should prevent concurrent edits to the
   same runtime file; do not create avoidable merge conflicts merely to keep
   three agents busy. When two branches touched the same file (fs and
   fs/promises both edit `runtime/vfs.js` — expect this only when no
   disjoint card is available):
   - Union both sides' additions, then check for duplicate definitions:
     `grep -oE "^  (function|const) [A-Za-z_$]+" <file> | sort | uniq -d`
     (ignore pre-existing pairs like directories/files/symlinks — they are in
     separate scopes). Two agents implementing the same family WILL
     double-define functions; JS silently keeps the last one. Pick the more
     Node-faithful implementation, delete the other, and check shared helpers
     agree on units and signatures (a real case: one `updateTimes` took
     seconds, the other milliseconds).
   - `node --check` every touched runtime file before committing the merge.

7. **Post-merge verification.** Rerun every merged card's acceptance tests
   against the integration worktree. All must hold. If a merge broke a
   previously passing card, fix the integration (usually a missed dedupe)
   before proceeding.

8. **Close the round.** Then start the next one:

   ```bash
   cd /home/bee/Projects/browser-node-harness && \
   PYTHONPATH=src python3 -m browser_node_harness --config harness.toml gaps --verify && \
   PYTHONPATH=src python3 -m browser_node_harness --config harness.toml gaps --emit .bnh-state/v22/gap-worklist
   ```

   `--verify` marks filled cards in the DB (real fills only — it re-probes
   the target surface); `--emit` refreshes the worklist from a fresh surface
   diff (expect ~1–2 min of probing). Previously implemented symbols simply
   disappear from the worklist; their old gap rows retire as `closed`, which
   is success, not loss.

9. **Cleanup per round:** remove merged agent worktrees
   (`git -C .bnh-state/target worktree remove <absolute path>`; branches can
   stay). The harness auto-checkpoints uncommitted worktree changes into
   "bnh: checkpoint" commits — harmless.

## Deferred-card policy

- A card is `deferred` only after two concrete implementation/validation
  attempts have failed, or when the card has a documented infrastructure or
  browser-native feasibility blocker. Record the evidence in
  `.bnh-state/v22/gap-worklist/DEFERRED.md` (or the card directory when a
  more detailed record is useful).
- Deferred cards remain open in the real DB and in the generated worklist.
  Skip them for the current pass and keep working on other unclaimed,
  non-deferred families. Revisit a deferred card only when a new implementation
  path, prerequisite merge, or validation condition materially changes.
- Deferred cards do not count as closures and do not satisfy completion. Never
  stop merely because a round has zero accepted closures or because multiple
  cards have been deferred.

## Valuable partial-work preservation

- The full listed suite passing remains the only approval and closure gate.
  A partial pass, a no-regression result, or a test that cannot run is never
  silently promoted to `PASS`.
- If a builder produces credible browser-native runtime improvements but a
  specific acceptance test is proven genuinely unavailable or non-runnable in
  this browser environment, do not discard the candidate. First prove the
  condition with the exact command, the escalated rerun, and an independent
  integration comparison; do not confuse a sandbox launcher error with a
  browser-native limitation.
- Preserve the reviewed runtime-only changes in a named WIP commit on the
  agent branch (for example, `WIP: preserve <card> runtime improvements —
  unapproved`) before removing its worktree. Record the commit, changed files,
  runnable-test results, non-runnable test, and limitation in
  `DEFERRED.md`. Keep the card open/deferred and never claim that WIP commit
  closed it.
- When the preserved changes are safe and useful to carry forward, the
  orchestrator may integrate only the reviewed runtime files as an explicitly
  unapproved WIP preservation merge, rerun every runnable acceptance test and
  relevant regression suite, and retain the open gap with the known failing or
  unavailable test documented. Never let an unapproved WIP overwrite newer
  runtime fixes or silently change the approval gate.

## Stop / escalate

- Do not stop solely because the top open card's affected count is below ~50.
  That is a card-ranking signal, not a work-completion signal. Keep starting
  new rounds while any safe, unquarantined family has credible implementation
  work, even if earlier rounds had zero accepted closures. Stop only when every
  remaining open family is deferred/blocked with recorded evidence, unsafe to
  merge, or has no credible browser-native implementation path. Report
  evidence-card count, distinct obligation count, and runtime-family count
  separately.
- Escalate to the user (stop working) if: a merge cannot be resolved
  confidently, an acceptance regression appears that a dedupe fix doesn't
  cure, or the gaps commands error.
- Never modify upstream tests, never special-case test filenames or expected
  outputs, and never weaken the harness to make runs green.

## Anchor (state as of 2026-08-26)

`bnh/integration-v22` at `c72be5e3`: 269 open gaps, 4 filled, 55 closed.
Top open areas: fs stream-constructor families (~467 affected each), fs/promises
glob fidelity (anchor test `test/parallel/test-fs-glob.mjs` — 69 subtests fail;
Node's rule: `**` does not traverse symlinks unless the pattern starts with
`./` or the next literal segment names the link, see `lib/internal/fs/glob.js`
around line 480), then http internals (~388 affected each).
