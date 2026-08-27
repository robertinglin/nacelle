# Gap coverage loop — standing instructions

You are running the bnh gap-coverage loop: turn open gap cards into runtime
capability, three cards at a time, using codex "luna" agents as the builders.
You are the orchestrator: you validate, commit, merge, and re-verify. Repeat
rounds until the stop condition or the user interrupts.

Fixed paths (always absolute — relative paths have caused two incidents):

- Harness repo: `/home/bee/Projects/browser-node-harness`
- Node target repo (owns worktrees): `/home/bee/Projects/browser-node-harness/.bnh-state/target`
- Integration worktree (branch `bnh/integration-v22`): `/home/bee/Projects/browser-node-harness/.bnh-state/v22/worktrees/integration-v22`
- Worklist: `/home/bee/Projects/browser-node-harness/.bnh-state/v22/gap-worklist` (WORKLIST.md + gap-<id>/ card dirs)
- Real DB: `/home/bee/Projects/browser-node-harness/.bnh-state/v22/state.sqlite3` (never open `Database()` on a guessed filename — it creates a stray empty db)
- Codex binary fallback: `/home/bee/.local/share/mise/installs/codex/latest/bin/codex`

All `python3 -m browser_node_harness` commands run from the harness repo root
with `PYTHONPATH=/home/bee/Projects/browser-node-harness/src`.

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

## Agent launch and long-running execution policy

Codex builders MUST be spawned through the local agent workflow first. Use the
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

## One round

1. **Pick 3 cards.** Read `WORKLIST.md` (or `bnh gaps --list`). Take the top
   ranked non-overlapping cards — different modules per round whenever
   possible. Never assign two agents the same card. Note `test/es-module/
   test-esm-named-exports.mjs` is a known pre-existing loader-hook timeout:
   when it appears in a card's acceptance list, a "9 of 10 pass" result is
   acceptable — treat that test as a note, not a blocker.

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
   acceptance command (below), the constraints (no test modification, no
   hard-coded expectations, browser-native only, extend `runtime.js`/`runtime/`
   not a parallel layer), and "leave changes uncommitted".

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
   - Independently rerun the card's acceptance command yourself. Require all
     pass, or all-but-one where the one is pre-existing (confirm pre-existing
     by running it against the integration worktree before merging).
   - Review scope: `git -C <worktree> diff --stat` — only `runtime.js` and
     `runtime/**` are acceptable. Anything touching `test/` or harness code:
     reject and relaunch that card once.
   - Commit: `git -C <worktree> add -A && git -C <worktree> commit -m
     "<module>: implement <symbol summary>"`.
   - If a card fails validation twice, abandon it for this round (the gap
     stays open) and continue with the others.

6. **Merge serially** into `bnh/integration-v22` (in the integration worktree):
   `git merge --no-edit luna-gap-<id>`, one at a time, resolving conflicts as
   you go. When two branches touched the same file (fs and fs/promises both
   edit `runtime/vfs.js` — expect this):
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

## Stop / escalate

- Stop starting new rounds when the top open card's affected count is below
  ~50 (diminishing returns) and report the summary.
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
