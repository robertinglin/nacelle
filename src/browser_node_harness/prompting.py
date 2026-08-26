from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Mapping, Sequence

from .config import HarnessConfig
from .discover import read_source
from .models import Task, TestResult
from .primitives import primitive_goal

_STRATEGY_GUIDANCE = {
    "minimal-generalized-fix": (
        "Find the smallest generalized runtime change that explains the whole failure cluster. "
        "Prefer implementing missing semantics over adding compatibility branches for individual tests."
    ),
    "subsystem-first": (
        "Treat the assigned failures as symptoms of one subsystem gap. Trace the relevant module, process, "
        "filesystem, stream, timer, networking, or loader boundary and repair it at that layer."
    ),
    "compatibility-differential": (
        "Use the upstream test and reference output as a behavioral specification. Compare the target's "
        "observable ordering, errors, exit behavior, and data shapes, then close the narrowest semantic gap."
    ),
    "architecture-boundary": (
        "Check whether the failure exposes a bad abstraction boundary rather than a missing special case. "
        "A focused internal refactor is allowed when it removes several compatibility gaps at once."
    ),
}

_CORE_FEATURE_GUIDANCE = {
    "globals": "Keep browser and Node globals coherent, including globalThis, process, timers, and the runtime identity exposed to modules.",
    "console": "Preserve console method ordering and argument values while keeping diagnostic output separate from test stdout and stderr.",
    "buffer-encoding": "Use one byte/encoding layer for Buffer, typed arrays, TextEncoder/TextDecoder, base64, hex, and Unicode edge cases.",
    "assert": "Keep assertion identity, deep comparison, thrown errors, and diagnostic formatting compatible with Node.",
    "structured-clone": "Use structured clone semantics for nested values, typed arrays, transferables, and supported built-ins; do not stringify as a substitute.",
    "promise-microtasks": "Preserve nextTick, Promise, queueMicrotask, immediate, timer, and rejection ordering at the browser event-loop boundary.",
    "abort-signal": "Keep abort state, reason propagation, one-shot listeners, and cancellation errors consistent across fetch and other async APIs.",
    "event-emitter": "Use shared listener registration, once/off behavior, ordering, listener counts, and error-event semantics.",
    "error-lifecycle": "Preserve uncaught exception, unhandled rejection, exit, cause, code, and stack lifecycle behavior without host-side execution.",
    "stdout": "Preserve exact stdout bytes, ordering, flushing, and capture behavior; do not silently route it to console.log.",
    "stderr": "Preserve stderr separately from stdout, including ordering and failure diagnostics.",
    "vfs": "Treat the virtual filesystem as a real compatibility layer: paths, permissions, directory state, encoding, and errors must be coherent.",
    "network": "Keep browser network policy, fetch/http semantics, response bodies, errors, and cancellation behind one Node-facing boundary.",
    "ipc": "Provide explicit message delivery, ordering, lifecycle, and cleanup semantics for Node-facing IPC channels.",
    "streams": "Build on the shared stream/backpressure primitives instead of making one test-specific output path.",
    "process": "Keep process lifecycle, argv, env, exit codes, signals, and child-process semantics explicit and testable.",
    "timers": "Preserve scheduling, cancellation, ordering, and event-loop interaction across the browser boundary.",
    "module-loader": "Fix resolution, package metadata, formats, and loader errors at the shared boundary rather than by filename special cases.",
    "vfs-io": "Build file handles, directories, metadata, file URLs, watching, rename, and cleanup on the same virtual filesystem state.",
    "http-fetch": "Keep URL, Headers, Request, Response, fetch, redirect, WebSocket boundaries, and AbortSignal behavior inside the browser transport layer.",
    "streams-backpressure": "Preserve readable, writable, transform, drain, finish, destroy, error, and async-iteration behavior under backpressure.",
    "workers-communication": "Keep workers, message ports, broadcasts, structured clone, transferables, Atomics, and cleanup browser-native.",
    "transferables": "Transfer ArrayBuffer and other supported values by ownership semantics; do not copy when the contract requires detachment.",
    "crypto": "Use browser-safe randomness, hashes, HMAC, Web Crypto keys, signatures, verification, and explicit algorithm errors.",
    "os-platform": "Expose deterministic platform and path behavior through the runtime contract instead of leaking host-specific assumptions.",
    "diagnostics": "Keep performance marks, async context, diagnostics channels, and error metadata observable without changing user code timing.",
    "compression": "Provide browser-safe compression, decompression, serialization, cloning, and text-codec parity through shared adapters.",
    "wasm": "Use browser WebAssembly validation, compilation, instantiation, exports, and memory semantics; never proxy through host Node.",
    "native-boundaries": "Declare native addons, privileged OS APIs, subprocesses, raw sockets, and other unavailable capabilities explicitly rather than faking success.",
}


def _clip(value: str, limit: int = 16_000) -> str:
    if len(value) <= limit:
        return value
    half = limit // 2
    return f"{value[:half]}\n... <{len(value) - limit} chars omitted> ...\n{value[-half:]}"


def _redact_context_paths(value: str, config: HarnessConfig) -> str:
    """Keep agent history from turning harness internals into new work targets."""

    redacted = value
    for root in (
        config.root,
        config.project.state_dir,
        config.project.target_repo,
        config.project.node_repo,
    ):
        try:
            redacted = redacted.replace(str(root.resolve()), "<harness-path>")
        except OSError:
            redacted = redacted.replace(str(root), "<harness-path>")
    return redacted


def prepare_task_context(
    *,
    config: HarnessConfig,
    worktree: Path,
    task: Task,
    failures: Mapping[str, TestResult | Mapping[str, Any] | None],
    previous_attempts: Sequence[Mapping[str, Any]],
) -> tuple[Path, str]:
    context_dir = worktree / ".bnh-context"
    context_dir.mkdir(parents=True, exist_ok=True)

    test_payload: list[dict[str, Any]] = []
    source_sections: list[str] = []
    failure_sections: list[str] = []
    copied_source_root = context_dir / "upstream"
    for test in task.tests:
        source = read_source(
            config.project.node_repo,
            test,
            limit=0,
        )
        source_sections.append(
            f"### `{test.path}`\n\n```javascript\n{_clip(source, config.discovery.max_source_chars_in_prompt)}\n```"
        )
        copied_source = copied_source_root / test.path
        copied_source.parent.mkdir(parents=True, exist_ok=True)
        copied_source.write_text(source, encoding="utf-8")
        failure = failures.get(test.path)
        if isinstance(failure, TestResult):
            status = failure.status
            stdout = failure.stdout
            stderr = failure.stderr
            fingerprint = failure.fingerprint
        elif isinstance(failure, Mapping):
            status = str(failure.get("status", "unknown"))
            stdout = str(failure.get("stdout", ""))
            stderr = str(failure.get("stderr", ""))
            fingerprint = str(failure.get("fingerprint", ""))
        else:
            status, stdout, stderr, fingerprint = "unknown", "", "", ""
        failure_sections.append(
            f"### `{test.path}`\n"
            f"Status: `{status}`  Fingerprint: `{fingerprint or 'unknown'}`\n\n"
            f"**stderr**\n```text\n{_clip(_redact_context_paths(stderr, config))}\n```\n\n"
            f"**stdout**\n```text\n{_clip(_redact_context_paths(stdout, config))}\n```"
        )
        test_payload.append(
            {
                "path": test.path,
                "suite": test.suite,
                "flags": list(test.flags),
                "modules": list(test.modules),
                "source_sha256": test.source_sha256,
                "status": status,
                "fingerprint": fingerprint,
                "source_file": str(copied_source.relative_to(worktree)),
            }
        )

    runner_script = context_dir / "run_assigned.py"
    runner_script.write_text(
        """#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path

from browser_node_harness.config import load_config
from browser_node_harness.models import TestCase
from browser_node_harness.runner import TestRunner

CONFIG = os.environ["BNH_CONFIG"]
WORKTREE = Path.cwd()
TASK_FILE = WORKTREE / ".bnh-context" / "task.json"
task = json.loads(TASK_FILE.read_text(encoding="utf-8"))
config = load_config(CONFIG, variant=task.get("variant"))
tests = []
for item in task["tests"]:
    source = (WORKTREE / item["source_file"]).read_text(encoding="utf-8")
    tests.append(TestCase(
        path=item["path"],
        suite=item["suite"],
        source_sha256=item["source_sha256"],
        flags=tuple(item.get("flags", [])),
        modules=tuple(item.get("modules", [])),
        source_override=source,
    ))
results = TestRunner(config).run_many(
    tests,
    spec=config.target,
    worktree=WORKTREE,
    phase="agent-reproduce",
    run_id="agent-reproduce-" + task["task_id"],
    iteration=0,
    concurrency=1,
)
for result in results:
    print(json.dumps({
        "test": result.test_path,
        "status": result.status,
        "exit_code": result.exit_code,
        "fingerprint": result.fingerprint,
    }))
raise SystemExit(0 if all(result.status == "pass" for result in results) else 1)
""",
        encoding="utf-8",
    )
    runner_script.chmod(0o755)

    task_file = context_dir / "task.json"
    task_file.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "task_id": task.task_id,
                "cluster_key": task.cluster_key,
                "strategy": task.strategy,
                "tests": test_payload,
                "previous_attempts": [
                    {
                        **attempt,
                        "agent_summary": _redact_context_paths(
                            str(attempt.get("agent_summary", "")), config
                        ),
                    }
                    for attempt in previous_attempts
                ],
                "variant": config.project.variant,
                "core_features": list(config.agent.core_features),
            },
            indent=2,
            default=str,
        ),
        encoding="utf-8",
    )

    history = "No prior attempts for this cluster."
    if previous_attempts:
        lines = []
        for attempt in previous_attempts:
            summary = _redact_context_paths(str(attempt.get("agent_summary", "")), config)
            lines.append(
                "- "
                + "; ".join(
                    [
                        f"strategy={attempt.get('strategy', '')}",
                        f"score={attempt.get('score', 0)}",
                        f"result={attempt.get('reason', '')}",
                        f"summary={_clip(summary, 1200)}",
                    ]
                )
            )
        history = "\n".join(lines)

    core_features = "\n".join(
        f"- **{feature}**: {_CORE_FEATURE_GUIDANCE.get(feature, 'Treat this as a shared runtime capability, not a test-specific workaround.')}"
        for feature in config.agent.core_features
    )
    primitive_goals = [
        goal
        for test in task.tests
        if (goal := primitive_goal(test.path)) is not None
    ]
    if primitive_goals:
        assignment = (
            "Your primary assignment is to implement the shared browser primitive contract(s) listed below. "
            "These capabilities are foundations for Node itself; fix the runtime boundary rather than working around the contract."
        )
        primitive_section = "\n".join(f"- {goal}" for goal in primitive_goals)
    else:
        assignment = (
            "Your primary assignment is the exact upstream file(s) listed below. Read the copied file from "
            "`.bnh-context/upstream/` and make the target runtime browser-compatible with its behavior."
        )
        primitive_section = ""

    prompt = f"""# Browser-native Node compatibility task

You are one worker in a parallel compatibility loop. Work only in this Git worktree. Implement a real browser-runtime capability that makes the assigned upstream Node.js tests pass.

{assignment} Do not blindly rewrite the contract or upstream test, and do not implement a filename-specific exception.

## Non-negotiable constraints

- Do not modify, replace, weaken, skip, or special-case the upstream tests.
- Do not return success without executing the test body. Do not hard-code test filenames, expected outputs, or harness canary markers.
- Do not add a hidden host-Node fallback, remote execution fallback, or server-side implementation. The result must remain browser-native.
- Do not edit `.bnh-context/` or the external test adapter.
- The adapter is outside this target worktree. Do not run `node adapters/...`, do not expect `adapters/playwright/daemon.mjs` to exist here, and do not diagnose a missing adapter path as a runtime compatibility failure. Use only `.bnh-context/run_assigned.py` for reproduction.
- If the assigned runner reports `infra_error`, stop and diagnose the command, worktree, and paths before changing runtime code. Do not leave a speculative patch for a harness-path failure.
- Keep tool interaction ordinary and concise: use normal shell commands and do not emit XML-like tool-call markup or attempt to repair an OpenCode tool-protocol error in source code.
- Reuse the pre-seeded shared browser runtime in `runtime.js` and `runtime/`. Do not create a parallel implementation of an existing primitive; extend the shared boundary only when the assigned contract requires a genuine gap.
- Keep unrelated behavior unchanged. Add target-side regression tests when the repository has an appropriate test structure.
- Run the assigned tests before finishing. Leave the working tree changed but do not commit.

## Strategy lane

{_STRATEGY_GUIDANCE.get(task.strategy, task.strategy)}

{"## Primitive goals\n\n" + primitive_section if primitive_section else ""}

## Reproduce

From the worktree root:

```bash
{sys.executable} .bnh-context/run_assigned.py
```

The command exits nonzero unless every assigned test passes. The harness will independently rerun the tests, hidden passing guards, negative controls, and source-mutation checks before accepting a patch.

Run this command before broad repository exploration. Treat its result as the source of truth if `task.json` contains an older status. After it runs, inspect only the copied upstream files and the target's `runtime.js`/`runtime/` paths; do not read or edit absolute harness paths such as `adapters/playwright/`.

## Failure cluster

`{task.cluster_key}`

{chr(10).join(failure_sections)}

## Exact files under test

The harness copied each file under test into `.bnh-context/upstream/`. Treat those copies as read-only source specifications. Trace their imports and call paths, then change the target runtime and its own tests where appropriate.

## Core browser capabilities to inspect or expand

{core_features}

## Upstream test sources

{chr(10).join(source_sections)}

## Prior rejected or partial approaches

{history}

## Finish condition

Implement the generalized fix, run the reproduction command, inspect the diff, and leave only the necessary source and target-side test changes in the worktree. In your final message, state the root cause, changed subsystem, and exact tests you ran.
"""
    prompt_path = context_dir / "prompt.md"
    prompt_path.write_text(prompt, encoding="utf-8")
    return prompt_path, prompt
