from __future__ import annotations

import unittest

from browser_node_harness.models import TestCase
from browser_node_harness.scheduler import schedule_tasks


class SchedulerTests(unittest.TestCase):
    def test_tasks_partition_failure_files_without_overlap(self) -> None:
        tests = tuple(
            TestCase(
                path=f"test/parallel/test-{index}.js",
                suite="parallel",
                source_sha256=f"sha-{index}",
            )
            for index in range(5)
        )

        tasks = schedule_tasks(
            tests,
            state_for=lambda _path: {"failure_fingerprint": "same"},
            batch_size=2,
            max_attempts=3,
            iteration=1,
            stalled_iterations=0,
        )

        assigned = [test.path for task in tasks for test in task.tests]
        self.assertEqual(len(tasks), 3)
        self.assertEqual(len(assigned), len(set(assigned)))
        self.assertEqual(set(assigned), {test.path for test in tests})

    def test_tasks_rotate_strategies_across_disjoint_batches(self) -> None:
        tests = tuple(
            TestCase(path=f"test-{index}.js", suite="parallel", source_sha256=f"sha-{index}")
            for index in range(3)
        )

        tasks = schedule_tasks(
            tests,
            state_for=lambda _path: {"failure_fingerprint": "same"},
            batch_size=1,
            max_attempts=3,
            iteration=2,
            stalled_iterations=0,
        )

        self.assertEqual([task.replica for task in tasks], [0, 0, 0])
        self.assertEqual(len({task.strategy for task in tasks}), 3)

    def test_related_module_failures_share_a_task_even_with_different_fingerprints(self) -> None:
        tests = tuple(
            TestCase(
                path=f"test/parallel/test-buffer-{name}.js",
                suite="parallel",
                modules=("assert", "buffer", "test"),
                source_sha256=name,
            )
            for name in ("one", "two", "three")
        )

        tasks = schedule_tasks(
            tests,
            state_for=lambda path: {
                "failure_fingerprint": "fingerprint-" + path.rsplit("-", 1)[-1].split(".", 1)[0]
            },
            batch_size=2,
            max_attempts=2,
            iteration=1,
            stalled_iterations=0,
        )

        self.assertEqual([len(task.tests) for task in tasks], [2, 1])


if __name__ == "__main__":
    unittest.main()
