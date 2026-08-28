from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from browser_node_harness.cli import build_parser
from browser_node_harness.db import Database
from browser_node_harness.gaps import Gap, gap_id_for
from browser_node_harness.models import TestCase, TestResult


def sample_gap(**overrides) -> Gap:
    fields = {
        "gap_id": gap_id_for("missing-api", "fs", ("chmodSync",)),
        "kind": "missing-api",
        "module": "fs",
        "symbols": ("chmodSync",),
        "affected_count": 3,
        "affected_paths": ("test/parallel/test-fs-a.js",),
        "acceptance_paths": ("test/parallel/test-fs-a.js",),
        "evidence": {"exemplar_stderr": "TypeError"},
    }
    fields.update(overrides)
    return Gap(**fields)


class GapStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.db = Database(Path(self._tmp.name) / "state.sqlite3")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_replace_and_list_gaps_round_trip(self) -> None:
        self.db.replace_gaps([sample_gap()])
        rows = self.db.list_gaps()
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["id"], sample_gap().gap_id)
        self.assertEqual(row["symbols"], ["chmodSync"])
        self.assertEqual(row["acceptance_paths"], ["test/parallel/test-fs-a.js"])
        self.assertEqual(row["evidence"], {"exemplar_stderr": "TypeError"})
        self.assertEqual(row["status"], "open")

    def test_surface_reextraction_reopens_filled_api_status(self) -> None:
        gap = sample_gap()
        self.db.replace_gaps([gap])
        self.db.set_gap_status(gap.gap_id, "filled")
        # A fresh surface diff proves that the API is still absent. Historical
        # status must not hide it from the current worklist.
        self.db.replace_gaps([sample_gap(affected_count=9)])
        rows = self.db.list_gaps()
        self.assertEqual(rows[0]["status"], "open")
        self.assertEqual(rows[0]["affected_count"], 9)

    def test_reextraction_preserves_filled_non_api_status(self) -> None:
        gap = sample_gap(kind="missing-validation")
        self.db.replace_gaps([gap])
        self.db.set_gap_status(gap.gap_id, "filled")
        self.db.replace_gaps([sample_gap(kind="missing-validation", affected_count=9)])
        rows = self.db.list_gaps()
        self.assertEqual(rows[0]["status"], "filled")

    def test_changed_symbols_open_a_new_gap_and_retire_the_old_one(self) -> None:
        gap = sample_gap()
        self.db.replace_gaps([gap])
        self.db.set_gap_status(gap.gap_id, "filled")
        grown = sample_gap(
            gap_id=gap_id_for("missing-api", "fs", ("chmodSync", "chownSync")),
            symbols=("chmodSync", "chownSync"),
        )
        self.db.replace_gaps([grown])
        by_id = {row["id"]: row["status"] for row in self.db.list_gaps()}
        # New symbol set is new open work; the filled row remains as history.
        self.assertEqual(by_id[grown.gap_id], "open")
        self.assertEqual(by_id[gap.gap_id], "filled")

    def test_stale_open_gaps_are_closed_by_reextraction(self) -> None:
        stale = sample_gap()
        self.db.replace_gaps([stale])
        replacement = sample_gap(
            gap_id=gap_id_for("missing-api", "http", ("request",)),
            kind="missing-api",
            module="http",
            symbols=("request",),
        )
        self.db.replace_gaps([replacement])
        by_id = {row["id"]: row["status"] for row in self.db.list_gaps()}
        self.assertEqual(by_id[stale.gap_id], "closed")
        self.assertEqual(by_id[replacement.gap_id], "open")

    def test_set_gap_status_rejects_unknown_status(self) -> None:
        with self.assertRaises(ValueError):
            self.db.set_gap_status("whatever", "done")

    def test_list_gaps_filters_by_status(self) -> None:
        open_gap = sample_gap()
        filled_gap = sample_gap(
            gap_id=gap_id_for("missing-api", "http", ("request",)),
            kind="missing-api",
            module="http",
            symbols=("request",),
        )
        self.db.replace_gaps([open_gap, filled_gap])
        self.db.set_gap_status(filled_gap.gap_id, "filled")
        self.assertEqual(
            [row["id"] for row in self.db.list_gaps(status="open")],
            [open_gap.gap_id],
        )

    def test_latest_target_evidence_returns_capped_recent_output(self) -> None:
        case = TestCase(
            path="test/parallel/test-fs-a.js",
            suite="parallel",
            source_sha256="a" * 64,
            modules=("fs",),
        )
        self.db.upsert_tests([case])
        self.db.start_run("run-1", "commit", variant="v22")
        for status, stderr in (
            ("fail", "TypeError: fs.chmodSync is not a function"),
            ("pass", ""),
        ):
            self.db.record_result(
                TestResult(
                    test_path=case.path,
                    status=status,
                    exit_code=1,
                    duration_ms=5,
                    stderr=stderr,
                ),
                run_id="run-1",
                iteration=0,
                phase="canonical-target",
                canonical="target",
            )
        rows = self.db.latest_target_evidence()
        # The final pass excludes the test from failure evidence entirely.
        self.assertEqual(rows, [])

        self.db.record_result(
            TestResult(
                test_path=case.path,
                status="fail",
                exit_code=1,
                duration_ms=5,
                stderr="x" * 20_000,
            ),
            run_id="run-1",
            iteration=0,
            phase="canonical-target",
            canonical="target",
        )
        rows = self.db.latest_target_evidence()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["path"], case.path)
        self.assertEqual(len(rows[0]["stderr"]), 8_000)


class GapCliParserTests(unittest.TestCase):
    def test_gaps_subcommand_parses_flags(self) -> None:
        parser = build_parser()
        args = parser.parse_args(
            ["gaps", "--list", "--json", "--emit", "/tmp/cards", "--reuse-surfaces"]
        )
        self.assertTrue(args.list)
        self.assertTrue(args.json)
        self.assertEqual(args.emit, "/tmp/cards")
        self.assertTrue(args.reuse_surfaces)
        self.assertFalse(args.verify)

    def test_prune_subcommand_parses_flags(self) -> None:
        parser = build_parser()
        args = parser.parse_args(["prune", "--keep", "5", "--dry-run"])
        self.assertEqual(args.keep, 5)
        self.assertTrue(args.dry_run)


if __name__ == "__main__":
    unittest.main()
