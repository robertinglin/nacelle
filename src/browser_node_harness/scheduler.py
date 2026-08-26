from __future__ import annotations

import hashlib
from collections import defaultdict, deque
from collections.abc import Callable, Sequence

from .models import Task, TestCase

_STRATEGIES = (
    "minimal-generalized-fix",
    "subsystem-first",
    "compatibility-differential",
    "architecture-boundary",
)

_GENERIC_MODULES = frozenset({"assert", "internal", "test", "util"})


def _failure_domain(test: TestCase, fingerprint: str) -> str:
    """Group tests by the runtime subsystem an agent can fix together."""

    specific_module = next(
        (module for module in test.modules if module not in _GENERIC_MODULES),
        None,
    )
    if specific_module:
        return f"{test.suite}:{specific_module}"
    # Without a specific imported subsystem, the normalized failure is the
    # only evidence that two tests need the same repair. Keep those failures
    # together rather than inventing a filename-based subsystem.
    return f"{test.suite}:failure:{fingerprint or 'unknown'}"


def schedule_tasks(
    tests: Sequence[TestCase],
    *,
    state_for: Callable[[str], dict | None],
    batch_size: int,
    max_attempts: int,
    iteration: int,
    stalled_iterations: int,
) -> list[Task]:
    groups: dict[str, list[TestCase]] = defaultdict(list)
    for test in tests:
        state = state_for(test.path) or {}
        fingerprint = str(state.get("failure_fingerprint") or "unknown")
        # Fingerprints remain useful in the database, but grouping by their
        # hash made every distinct assertion message a one-test task.
        groups[_failure_domain(test, fingerprint)].append(test)

    queues: deque[tuple[str, deque[TestCase]]] = deque()
    for key, members in sorted(groups.items(), key=lambda item: (-len(item[1]), item[0])):
        members.sort(key=lambda test: (int((state_for(test.path) or {}).get("attempt_count", 0)), test.path))
        queues.append((key, deque(members)))

    tasks: list[Task] = []
    strategy_offset = min(stalled_iterations, len(_STRATEGIES) - 1)
    while queues and len(tasks) < max_attempts:
        key, queue = queues.popleft()
        batch: list[TestCase] = []
        while queue and len(batch) < batch_size:
            batch.append(queue.popleft())
        if queue:
            queues.append((key, queue))
        if not batch:
            continue

        if len(tasks) >= max_attempts:
            break
        batch_identity = "\n".join(test.path for test in batch)
        strategy = _STRATEGIES[(strategy_offset + len(tasks) + iteration) % len(_STRATEGIES)]
        digest = hashlib.sha256(
            f"{iteration}:{key}:{batch_identity}:{len(tasks)}:{strategy}".encode()
        ).hexdigest()[:12]
        tasks.append(
            Task(
                task_id=f"i{iteration:04d}-{digest}",
                tests=tuple(batch),
                cluster_key=key,
                strategy=strategy,
                replica=0,
            )
        )
    return tasks
