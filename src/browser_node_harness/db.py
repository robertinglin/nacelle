from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from collections.abc import Iterable, Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterator

from .models import CandidateAttempt, TestCase, TestResult


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _target_snapshot(
    *,
    result_id: int,
    run_id: str | None,
    iteration: int,
    phase: str,
    attempt_id: str | None,
    test_path: str,
    workspace_commit: str,
    result: TestResult,
    created_at: str,
) -> str:
    """Serialize the canonical result metadata retained for dashboard history."""
    return json.dumps(
        {
            "id": result_id,
            "run_id": run_id,
            "iteration": iteration,
            "phase": phase,
            "attempt_id": attempt_id,
            "test_path": test_path,
            "workspace_commit": workspace_commit,
            "status": result.status,
            "exit_code": result.exit_code,
            "duration_ms": result.duration_ms,
            "fingerprint": result.fingerprint,
            "log_dir": str(result.log_dir or ""),
            "created_at": created_at,
        },
        sort_keys=True,
    )


class Database:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.path, timeout=30)
        try:
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys = ON")
            conn.execute("PRAGMA journal_mode = WAL")
            conn.execute("PRAGMA busy_timeout = 30000")
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _initialize(self) -> None:
        with self.connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS tests (
                    path TEXT PRIMARY KEY,
                    suite TEXT NOT NULL,
                    source_sha256 TEXT NOT NULL,
                    flags_json TEXT NOT NULL,
                    modules_json TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    oracle_status TEXT NOT NULL DEFAULT 'unknown',
                    target_status TEXT NOT NULL DEFAULT 'unknown',
                    target_snapshot_json TEXT,
                    prior_target_status TEXT,
                    prior_target_snapshot_json TEXT,
                    target_regression_count INTEGER NOT NULL DEFAULT 0,
                    failure_fingerprint TEXT NOT NULL DEFAULT '',
                    last_duration_ms INTEGER NOT NULL DEFAULT 0,
                    attempt_count INTEGER NOT NULL DEFAULT 0,
                    consecutive_failures INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS runs (
                    id TEXT PRIMARY KEY,
                    started_at TEXT NOT NULL,
                    finished_at TEXT,
                    base_commit TEXT NOT NULL,
                    status TEXT NOT NULL,
                    iteration INTEGER NOT NULL DEFAULT 0,
                    notes TEXT NOT NULL DEFAULT '',
                    variant TEXT NOT NULL DEFAULT 'default'
                );

                CREATE TABLE IF NOT EXISTS results (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id TEXT,
                    iteration INTEGER NOT NULL,
                    phase TEXT NOT NULL,
                    attempt_id TEXT,
                    test_path TEXT NOT NULL,
                    workspace_commit TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL,
                    exit_code INTEGER,
                    duration_ms INTEGER NOT NULL,
                    fingerprint TEXT NOT NULL DEFAULT '',
                    stdout TEXT NOT NULL DEFAULT '',
                    stderr TEXT NOT NULL DEFAULT '',
                    log_dir TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(run_id) REFERENCES runs(id)
                );

                CREATE INDEX IF NOT EXISTS results_test_idx ON results(test_path, id DESC);
                CREATE INDEX IF NOT EXISTS results_attempt_idx ON results(attempt_id);

                CREATE TABLE IF NOT EXISTS attempts (
                    id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL,
                    iteration INTEGER NOT NULL,
                    task_id TEXT NOT NULL,
                    replica INTEGER NOT NULL,
                    strategy TEXT NOT NULL,
                    base_commit TEXT NOT NULL,
                    worktree TEXT NOT NULL,
                    assigned_tests_json TEXT NOT NULL,
                    agent_exit_code INTEGER,
                    agent_timed_out INTEGER NOT NULL,
                    agent_duration_ms INTEGER NOT NULL,
                    agent_summary TEXT NOT NULL DEFAULT '',
                    provider TEXT NOT NULL DEFAULT '',
                    model TEXT NOT NULL DEFAULT '',
                    stdout_path TEXT NOT NULL DEFAULT '',
                    stderr_path TEXT NOT NULL DEFAULT '',
                    output_path TEXT NOT NULL DEFAULT '',
                    patch_path TEXT NOT NULL DEFAULT '',
                    patch_sha256 TEXT NOT NULL DEFAULT '',
                    patch_bytes INTEGER NOT NULL DEFAULT 0,
                    changed_files_json TEXT NOT NULL DEFAULT '[]',
                    score REAL NOT NULL DEFAULT 0,
                    accepted INTEGER NOT NULL DEFAULT 0,
                    reason TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(run_id) REFERENCES runs(id)
                );

                CREATE INDEX IF NOT EXISTS attempts_run_idx ON attempts(run_id, iteration);

                CREATE TABLE IF NOT EXISTS events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id TEXT,
                    iteration INTEGER NOT NULL DEFAULT 0,
                    kind TEXT NOT NULL,
                    status TEXT NOT NULL,
                    attempt_id TEXT,
                    message TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS events_created_idx ON events(created_at DESC, id DESC);
                CREATE INDEX IF NOT EXISTS events_attempt_idx ON events(attempt_id, id DESC);

                CREATE TABLE IF NOT EXISTS agent_sessions (
                    attempt_id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL,
                    iteration INTEGER NOT NULL,
                    task_id TEXT NOT NULL,
                    strategy TEXT NOT NULL,
                    assigned_tests_json TEXT NOT NULL,
                    provider TEXT NOT NULL DEFAULT '',
                    model TEXT NOT NULL DEFAULT '',
                    pid INTEGER,
                    status TEXT NOT NULL,
                    restart_count INTEGER NOT NULL DEFAULT 0,
                    worktree TEXT NOT NULL,
                    stdout_path TEXT NOT NULL,
                    stderr_path TEXT NOT NULL,
                    output_path TEXT NOT NULL DEFAULT '',
                    started_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    finished_at TEXT,
                    action TEXT NOT NULL DEFAULT ''
                );

                CREATE INDEX IF NOT EXISTS agent_sessions_run_idx
                    ON agent_sessions(run_id, status, updated_at DESC);

                CREATE TABLE IF NOT EXISTS merges (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id TEXT NOT NULL,
                    iteration INTEGER NOT NULL,
                    attempt_id TEXT NOT NULL,
                    commit_sha TEXT NOT NULL,
                    patch_sha256 TEXT NOT NULL,
                    tests_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(run_id) REFERENCES runs(id),
                    FOREIGN KEY(attempt_id) REFERENCES attempts(id)
                );

                CREATE TABLE IF NOT EXISTS gaps (
                    id TEXT PRIMARY KEY,
                    kind TEXT NOT NULL,
                    module TEXT NOT NULL,
                    symbols_json TEXT NOT NULL DEFAULT '[]',
                    affected_count INTEGER NOT NULL DEFAULT 0,
                    affected_paths_json TEXT NOT NULL DEFAULT '[]',
                    acceptance_json TEXT NOT NULL DEFAULT '[]',
                    evidence_json TEXT NOT NULL DEFAULT '{}',
                    status TEXT NOT NULL DEFAULT 'open',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS gaps_status_idx ON gaps(status, affected_count DESC);
                """
            )
            run_columns = {
                str(row["name"])
                for row in conn.execute("PRAGMA table_info(runs)").fetchall()
            }
            if "variant" not in run_columns:
                conn.execute("ALTER TABLE runs ADD COLUMN variant TEXT NOT NULL DEFAULT 'default'")
            attempt_columns = {
                str(row["name"])
                for row in conn.execute("PRAGMA table_info(attempts)").fetchall()
            }
            for column, definition in (
                ("provider", "TEXT NOT NULL DEFAULT ''"),
                ("model", "TEXT NOT NULL DEFAULT ''"),
                ("stdout_path", "TEXT NOT NULL DEFAULT ''"),
                ("stderr_path", "TEXT NOT NULL DEFAULT ''"),
                ("output_path", "TEXT NOT NULL DEFAULT ''"),
            ):
                if column not in attempt_columns:
                    conn.execute(f"ALTER TABLE attempts ADD COLUMN {column} {definition}")
            session_columns = {
                str(row["name"])
                for row in conn.execute("PRAGMA table_info(agent_sessions)").fetchall()
            }
            if "output_path" not in session_columns:
                conn.execute("ALTER TABLE agent_sessions ADD COLUMN output_path TEXT NOT NULL DEFAULT ''")
            test_columns = {
                str(row["name"])
                for row in conn.execute("PRAGMA table_info(tests)").fetchall()
            }
            target_history_migrated = False
            for column, definition in (
                ("target_snapshot_json", "TEXT"),
                ("prior_target_status", "TEXT"),
                ("prior_target_snapshot_json", "TEXT"),
                ("target_regression_count", "INTEGER NOT NULL DEFAULT 0"),
            ):
                if column not in test_columns:
                    conn.execute(f"ALTER TABLE tests ADD COLUMN {column} {definition}")
                    target_history_migrated = True
            if target_history_migrated:
                self._backfill_target_history(conn)

    @staticmethod
    def _backfill_target_history(conn: sqlite3.Connection) -> None:
        tests = conn.execute("SELECT path FROM tests").fetchall()
        for test in tests:
            path = str(test["path"])
            results = conn.execute(
                "SELECT * FROM results WHERE test_path=? AND phase LIKE 'canonical-target%' ORDER BY id",
                (path,),
            ).fetchall()
            if not results:
                continue
            latest = results[-1]
            prior = results[-2] if len(results) > 1 else None
            regression_count = sum(
                1
                for previous, current in zip(results, results[1:])
                if str(previous["status"]) == "pass" and str(current["status"]) != "pass"
            )
            latest_snapshot = json.dumps(
                {
                    key: latest[key]
                    for key in latest.keys()
                    if key not in {"stdout", "stderr"}
                },
                sort_keys=True,
            )
            prior_snapshot = (
                json.dumps(
                    {
                        key: prior[key]
                        for key in prior.keys()
                        if key not in {"stdout", "stderr"}
                    },
                    sort_keys=True,
                )
                if prior is not None
                else None
            )
            conn.execute(
                """
                UPDATE tests
                SET target_snapshot_json=?,
                    prior_target_status=?,
                    prior_target_snapshot_json=?,
                    target_regression_count=?
                WHERE path=?
                """,
                (
                    latest_snapshot,
                    None if prior is None else str(prior["status"]),
                    prior_snapshot,
                    regression_count,
                    path,
                ),
            )

    def set_meta(self, key: str, value: str) -> None:
        with self.connect() as conn:
            conn.execute(
                "INSERT INTO meta(key, value) VALUES(?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, value),
            )

    def get_meta(self, key: str) -> str | None:
        with self.connect() as conn:
            row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return None if row is None else str(row["value"])

    def upsert_tests(self, tests: Iterable[TestCase]) -> int:
        rows = [
            (
                test.path,
                test.suite,
                test.source_sha256,
                json.dumps(test.flags),
                json.dumps(test.modules),
                test.size_bytes,
                utc_now(),
            )
            for test in tests
        ]
        if not rows:
            return 0
        with self.connect() as conn:
            conn.executemany(
                """
                INSERT INTO tests(
                    path, suite, source_sha256, flags_json, modules_json,
                    size_bytes, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(path) DO UPDATE SET
                    suite=excluded.suite,
                    source_sha256=excluded.source_sha256,
                    flags_json=excluded.flags_json,
                    modules_json=excluded.modules_json,
                    size_bytes=excluded.size_bytes,
                    enabled=1,
                    oracle_status=CASE
                        WHEN tests.source_sha256 != excluded.source_sha256 THEN 'unknown'
                        ELSE tests.oracle_status
                    END,
                    target_status=CASE
                        WHEN tests.source_sha256 != excluded.source_sha256 THEN 'unknown'
                        ELSE tests.target_status
                    END,
                    failure_fingerprint=CASE
                        WHEN tests.source_sha256 != excluded.source_sha256 THEN ''
                        ELSE tests.failure_fingerprint
                    END,
                    target_snapshot_json=CASE
                        WHEN tests.source_sha256 != excluded.source_sha256 THEN NULL
                        ELSE tests.target_snapshot_json
                    END,
                    prior_target_status=CASE
                        WHEN tests.source_sha256 != excluded.source_sha256 THEN NULL
                        ELSE tests.prior_target_status
                    END,
                    prior_target_snapshot_json=CASE
                        WHEN tests.source_sha256 != excluded.source_sha256 THEN NULL
                        ELSE tests.prior_target_snapshot_json
                    END,
                    target_regression_count=CASE
                        WHEN tests.source_sha256 != excluded.source_sha256 THEN 0
                        ELSE tests.target_regression_count
                    END,
                    attempt_count=CASE
                        WHEN tests.source_sha256 != excluded.source_sha256 THEN 0
                        ELSE tests.attempt_count
                    END,
                    consecutive_failures=CASE
                        WHEN tests.source_sha256 != excluded.source_sha256 THEN 0
                        ELSE tests.consecutive_failures
                    END,
                    updated_at=excluded.updated_at
                """,
                rows,
            )
        return len(rows)

    def disable_missing_tests(self, present_paths: Sequence[str]) -> None:
        with self.connect() as conn:
            if not present_paths:
                conn.execute("UPDATE tests SET enabled=0")
                return
            conn.execute("CREATE TEMP TABLE present_tests(path TEXT PRIMARY KEY)")
            conn.executemany("INSERT INTO present_tests(path) VALUES(?)", ((p,) for p in present_paths))
            conn.execute(
                "UPDATE tests SET enabled=0 WHERE path NOT IN (SELECT path FROM present_tests)"
            )

    def mark_oracle_pass(self, test_paths: Sequence[str]) -> None:
        if not test_paths:
            return
        with self.connect() as conn:
            conn.executemany(
                "UPDATE tests SET oracle_status='pass', updated_at=? WHERE path=?",
                ((utc_now(), path) for path in test_paths),
            )

    def set_oracle_statuses(self, statuses: Mapping[str, str]) -> None:
        if not statuses:
            return
        allowed = {"pass", "fail", "skip", "timeout", "infra_error", "unknown"}
        rows = [
            (status, utc_now(), path)
            for path, status in statuses.items()
            if status in allowed
        ]
        if not rows:
            return
        with self.connect() as conn:
            conn.executemany(
                "UPDATE tests SET oracle_status=?, updated_at=? WHERE path=?",
                rows,
            )

    @staticmethod
    def _row_to_test(row: sqlite3.Row) -> TestCase:
        return TestCase(
            path=str(row["path"]),
            suite=str(row["suite"]),
            source_sha256=str(row["source_sha256"]),
            flags=tuple(json.loads(row["flags_json"])),
            modules=tuple(json.loads(row["modules_json"])),
            size_bytes=int(row["size_bytes"]),
        )

    def get_test(self, path: str) -> TestCase | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM tests WHERE path=? AND enabled=1", (path,)).fetchone()
        return None if row is None else self._row_to_test(row)

    def list_tests(
        self,
        *,
        target_statuses: Sequence[str] | None = None,
        oracle_eligible: bool = False,
        limit: int = 0,
    ) -> list[TestCase]:
        clauses = ["enabled=1"]
        args: list[Any] = []
        if target_statuses:
            placeholders = ",".join("?" for _ in target_statuses)
            clauses.append(f"target_status IN ({placeholders})")
            args.extend(target_statuses)
        if oracle_eligible:
            clauses.append("oracle_status='pass'")
        sql = "SELECT * FROM tests WHERE " + " AND ".join(clauses)
        sql += " ORDER BY suite, path"
        if limit > 0:
            sql += " LIMIT ?"
            args.append(limit)
        with self.connect() as conn:
            rows = conn.execute(sql, args).fetchall()
        return [self._row_to_test(row) for row in rows]

    def list_actionable_tests(self, *, oracle_enabled: bool, max_attempts: int = 0) -> list[TestCase]:
        clauses = [
            "enabled=1",
            "target_status IN ('fail', 'skip', 'timeout', 'infra_error')",
        ]
        if oracle_enabled:
            clauses.append("oracle_status='pass'")
        if max_attempts > 0:
            clauses.append("attempt_count < ?")
        sql = "SELECT * FROM tests WHERE " + " AND ".join(clauses)
        sql += " ORDER BY attempt_count ASC, consecutive_failures DESC, suite, path"
        args: list[Any] = [max_attempts] if max_attempts > 0 else []
        with self.connect() as conn:
            rows = conn.execute(sql, args).fetchall()
        return [self._row_to_test(row) for row in rows]

    def test_state(self, path: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM tests WHERE path=?", (path,)).fetchone()
        return None if row is None else dict(row)

    def record_result(
        self,
        result: TestResult,
        *,
        run_id: str | None,
        iteration: int,
        phase: str,
        attempt_id: str | None = None,
        workspace_commit: str = "",
        canonical: str | None = None,
    ) -> None:
        with self.connect() as conn:
            previous_target_status: str | None = None
            previous_target_snapshot: str | None = None
            previous_regression_count = 0
            if canonical == "target":
                test_row = conn.execute(
                    "SELECT target_status, target_snapshot_json, target_regression_count FROM tests WHERE path=?",
                    (result.test_path,),
                ).fetchone()
                if test_row is not None:
                    previous_target_snapshot = test_row["target_snapshot_json"]
                    if previous_target_snapshot is not None:
                        previous_target_status = str(test_row["target_status"])
                    previous_regression_count = int(test_row["target_regression_count"])
            created_at = utc_now()
            result_cursor = conn.execute(
                """
                INSERT INTO results(
                    run_id, iteration, phase, attempt_id, test_path,
                    workspace_commit, status, exit_code, duration_ms,
                    fingerprint, stdout, stderr, log_dir, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    iteration,
                    phase,
                    attempt_id,
                    result.test_path,
                    workspace_commit,
                    result.status,
                    result.exit_code,
                    result.duration_ms,
                    result.fingerprint,
                    result.stdout,
                    result.stderr,
                    str(result.log_dir or ""),
                    created_at,
                ),
            )
            if canonical in {"target", "oracle"}:
                column = "target_status" if canonical == "target" else "oracle_status"
                extra = ""
                params: list[Any] = [result.status]
                if canonical == "target":
                    regression_count = previous_regression_count + int(
                        previous_target_status == "pass" and result.status != "pass"
                    )
                    snapshot = _target_snapshot(
                        result_id=int(result_cursor.lastrowid),
                        run_id=run_id,
                        iteration=iteration,
                        phase=phase,
                        attempt_id=attempt_id,
                        test_path=result.test_path,
                        workspace_commit=workspace_commit,
                        result=result,
                        created_at=created_at,
                    )
                    extra = ", failure_fingerprint=?, last_duration_ms=?, consecutive_failures=CASE WHEN ?='pass' THEN 0 ELSE consecutive_failures + 1 END, target_snapshot_json=?, prior_target_status=?, prior_target_snapshot_json=?, target_regression_count=?"
                    params.extend(
                        [
                            result.fingerprint,
                            result.duration_ms,
                            result.status,
                            snapshot,
                            previous_target_status,
                            previous_target_snapshot,
                            regression_count,
                        ]
                    )
                params.extend([utc_now(), result.test_path])
                conn.execute(
                    f"UPDATE tests SET {column}=?{extra}, updated_at=? WHERE path=?",
                    params,
                )

    def increment_attempts(self, test_paths: Sequence[str]) -> None:
        if not test_paths:
            return
        with self.connect() as conn:
            conn.executemany(
                "UPDATE tests SET attempt_count=attempt_count+1, updated_at=? WHERE path=?",
                ((utc_now(), path) for path in test_paths),
            )

    def start_run(self, run_id: str, base_commit: str, *, variant: str = "default") -> None:
        with self.connect() as conn:
            conn.execute(
                "INSERT INTO runs(id, started_at, base_commit, status, variant) VALUES(?, ?, ?, 'running', ?)",
                (run_id, utc_now(), base_commit, variant),
            )

    def update_run(self, run_id: str, *, iteration: int | None = None, status: str | None = None, notes: str | None = None) -> None:
        assignments: list[str] = []
        values: list[Any] = []
        if iteration is not None:
            assignments.append("iteration=?")
            values.append(iteration)
        if status is not None:
            assignments.append("status=?")
            values.append(status)
            if status != "running":
                assignments.append("finished_at=?")
                values.append(utc_now())
        if notes is not None:
            assignments.append("notes=?")
            values.append(notes)
        if not assignments:
            return
        values.append(run_id)
        with self.connect() as conn:
            conn.execute(f"UPDATE runs SET {', '.join(assignments)} WHERE id=?", values)

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
        return None if row is None else dict(row)

    def latest_run(self, *, variant: str | None = None) -> dict[str, Any] | None:
        where = "WHERE variant=?" if variant is not None else ""
        args: tuple[Any, ...] = (variant,) if variant is not None else ()
        with self.connect() as conn:
            row = conn.execute(
                f"SELECT * FROM runs {where} ORDER BY started_at DESC, rowid DESC LIMIT 1",
                args,
            ).fetchone()
        return None if row is None else dict(row)

    def resume_run(self, run_id: str, *, iteration: int, notes: str = "") -> None:
        with self.connect() as conn:
            conn.execute(
                """
                UPDATE runs
                SET status='running', iteration=?, finished_at=NULL, notes=?
                WHERE id=?
                """,
                (iteration, notes, run_id),
            )

    def record_event(
        self,
        message: str,
        *,
        run_id: str | None = None,
        iteration: int = 0,
        kind: str = "log",
        status: str = "info",
        attempt_id: str | None = None,
    ) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO events(run_id, iteration, kind, status, attempt_id, message, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (run_id, iteration, kind, status, attempt_id, message, utc_now()),
            )

    def recent_events(self, *, run_id: str | None = None, limit: int = 80) -> list[dict[str, Any]]:
        where = "WHERE run_id=?" if run_id else ""
        args: list[Any] = [run_id] if run_id else []
        args.append(limit)
        with self.connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM events {where} ORDER BY id DESC LIMIT ?",
                args,
            ).fetchall()
        return [dict(row) for row in rows]

    def active_agents(self, *, run_id: str | None = None) -> list[dict[str, Any]]:
        where = "AND run_id=?" if run_id else ""
        args: list[Any] = [run_id] if run_id else []
        with self.connect() as conn:
            rows = conn.execute(
                f"""
                SELECT * FROM agent_sessions
                WHERE status IN ('starting', 'running', 'stopping') {where}
                ORDER BY started_at DESC
                """,
                args,
            ).fetchall()
            if rows:
                return [dict(row) for row in rows]
            event_where = "AND started.run_id=?" if run_id else ""
            event_args: list[Any] = [run_id] if run_id else []
            event_rows = conn.execute(
                f"""
                SELECT started.*
                FROM events AS started
                WHERE started.kind='agent' AND started.status='started'
                  AND started.attempt_id IS NOT NULL {event_where}
                  AND NOT EXISTS (
                      SELECT 1 FROM events AS newer
                      WHERE newer.kind='agent'
                        AND newer.attempt_id=started.attempt_id
                        AND newer.id > started.id
                  )
                ORDER BY started.id DESC
                """,
                event_args,
            ).fetchall()
        return [dict(row) for row in event_rows]

    def active_runners(self, *, run_id: str | None = None) -> list[dict[str, Any]]:
        where = "AND started.run_id=?" if run_id else ""
        args: list[Any] = [run_id] if run_id else []
        with self.connect() as conn:
            rows = conn.execute(
                f"""
                SELECT started.*
                FROM events AS started
                WHERE started.kind='runner' AND started.status='started'
                  AND started.attempt_id IS NOT NULL {where}
                  AND NOT EXISTS (
                      SELECT 1 FROM events AS newer
                      WHERE newer.kind='runner'
                        AND newer.attempt_id=started.attempt_id
                        AND newer.id > started.id
                        AND newer.status IN ('finished', 'failed')
                  )
                ORDER BY started.id DESC
                """,
                args,
            ).fetchall()
        return [dict(row) for row in rows]

    def start_agent_session(
        self,
        *,
        run_id: str,
        iteration: int,
        attempt_id: str,
        task_id: str,
        strategy: str,
        assigned_tests: Sequence[str],
        provider: str,
        model: str,
        worktree: Path,
        stdout_path: Path,
        stderr_path: Path,
        output_path: Path,
    ) -> None:
        now = utc_now()
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO agent_sessions(
                    attempt_id, run_id, iteration, task_id, strategy,
                    assigned_tests_json, provider, model, status, worktree,
                    stdout_path, stderr_path, output_path, started_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?, ?)
                ON CONFLICT(attempt_id) DO UPDATE SET
                    provider=excluded.provider,
                    model=excluded.model,
                    status='starting',
                    updated_at=excluded.updated_at,
                    action=''
                """,
                (
                    attempt_id,
                    run_id,
                    iteration,
                    task_id,
                    strategy,
                    json.dumps(list(assigned_tests)),
                    provider,
                    model,
                    str(worktree),
                    str(stdout_path),
                    str(stderr_path),
                    str(output_path),
                    now,
                    now,
                ),
            )

    def update_agent_session(self, attempt_id: str, **fields: Any) -> None:
        allowed = {
            "provider",
            "model",
            "pid",
            "status",
            "restart_count",
            "updated_at",
            "finished_at",
        }
        updates = {key: value for key, value in fields.items() if key in allowed}
        if not updates:
            return
        updates.setdefault("updated_at", utc_now())
        assignments = ", ".join(f"{key}=?" for key in updates)
        values = [updates[key] for key in updates]
        values.append(attempt_id)
        with self.connect() as conn:
            conn.execute(f"UPDATE agent_sessions SET {assignments} WHERE attempt_id=?", values)

    def request_agent_action(self, attempt_id: str, action: str) -> bool:
        if action not in {"stop", "restart"}:
            raise ValueError(f"unsupported agent action: {action}")
        with self.connect() as conn:
            result = conn.execute(
                """
                UPDATE agent_sessions
                SET action=?, status=CASE WHEN ?='stop' THEN 'stopping' ELSE status END,
                    updated_at=?
                WHERE attempt_id=? AND status IN ('starting', 'running', 'stopping')
                """,
                (action, action, utc_now(), attempt_id),
            )
        return result.rowcount == 1

    def agent_action(self, attempt_id: str) -> str:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT action FROM agent_sessions WHERE attempt_id=?", (attempt_id,)
            ).fetchone()
        return "" if row is None else str(row["action"] or "")

    def clear_agent_action(self, attempt_id: str) -> None:
        with self.connect() as conn:
            conn.execute(
                "UPDATE agent_sessions SET action='', updated_at=? WHERE attempt_id=?",
                (utc_now(), attempt_id),
            )

    def recent_agent_sessions(self, *, run_id: str | None = None, limit: int = 30) -> list[dict[str, Any]]:
        where = "WHERE run_id=?" if run_id else ""
        args: list[Any] = [run_id] if run_id else []
        args.append(limit)
        with self.connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM agent_sessions {where} ORDER BY started_at DESC LIMIT ?",
                args,
            ).fetchall()
        return [dict(row) for row in rows]

    def recent_attempts(self, *, run_id: str | None = None, limit: int = 30) -> list[dict[str, Any]]:
        where = "WHERE run_id=?" if run_id else ""
        args: list[Any] = [run_id] if run_id else []
        args.append(limit)
        with self.connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM attempts {where} ORDER BY created_at DESC LIMIT ?",
                args,
            ).fetchall()
        return [dict(row) for row in rows]

    def recent_merges(self, *, run_id: str | None = None, limit: int = 20) -> list[dict[str, Any]]:
        where = "WHERE run_id=?" if run_id else ""
        args: list[Any] = [run_id] if run_id else []
        args.append(limit)
        with self.connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM merges {where} ORDER BY created_at DESC LIMIT ?",
                args,
            ).fetchall()
        return [dict(row) for row in rows]

    def record_attempt(self, run_id: str, iteration: int, attempt: CandidateAttempt) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO attempts(
                    id, run_id, iteration, task_id, replica, strategy,
                    base_commit, worktree, assigned_tests_json,
                    agent_exit_code, agent_timed_out, agent_duration_ms,
                    agent_summary, provider, model, stdout_path, stderr_path,
                    output_path,
                    patch_path, patch_sha256, patch_bytes,
                    changed_files_json, score, accepted, reason, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    attempt.attempt_id,
                    run_id,
                    iteration,
                    attempt.task.task_id,
                    attempt.task.replica,
                    attempt.task.strategy,
                    attempt.base_commit,
                    str(attempt.worktree),
                    json.dumps([test.path for test in attempt.task.tests]),
                    attempt.agent.exit_code,
                    int(attempt.agent.timed_out),
                    attempt.agent.duration_ms,
                    attempt.agent.summary,
                    attempt.agent.provider,
                    attempt.agent.model,
                    str(attempt.agent.stdout_path or ""),
                    str(attempt.agent.stderr_path or ""),
                    str(attempt.agent.output_path or ""),
                    str(attempt.patch.path),
                    attempt.patch.sha256,
                    attempt.patch.size_bytes,
                    json.dumps(attempt.patch.changed_files),
                    attempt.score,
                    int(attempt.accepted),
                    attempt.reason,
                    utc_now(),
                ),
            )

    def mark_attempt(self, attempt_id: str, *, accepted: bool, reason: str, score: float | None = None) -> None:
        with self.connect() as conn:
            if score is None:
                conn.execute(
                    "UPDATE attempts SET accepted=?, reason=? WHERE id=?",
                    (int(accepted), reason, attempt_id),
                )
            else:
                conn.execute(
                    "UPDATE attempts SET accepted=?, reason=?, score=? WHERE id=?",
                    (int(accepted), reason, score, attempt_id),
                )

    def record_merge(
        self,
        *,
        run_id: str,
        iteration: int,
        attempt_id: str,
        commit_sha: str,
        patch_sha256: str,
        tests: Sequence[str],
    ) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO merges(
                    run_id, iteration, attempt_id, commit_sha,
                    patch_sha256, tests_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (run_id, iteration, attempt_id, commit_sha, patch_sha256, json.dumps(tests), utc_now()),
            )

    def summary(self) -> dict[str, int]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT target_status, COUNT(*) AS count FROM tests WHERE enabled=1 GROUP BY target_status"
            ).fetchall()
            regression_count = conn.execute(
                """
                SELECT COUNT(*) AS count
                FROM tests
                WHERE enabled=1 AND prior_target_status='pass' AND target_status != 'pass'
                """
            ).fetchone()["count"]
        result = {"total": 0, "pass": 0, "fail": 0, "skip": 0, "timeout": 0, "infra_error": 0, "unknown": 0}
        for row in rows:
            status = str(row["target_status"])
            count = int(row["count"])
            result[status] = count
            result["total"] += count
        result["regression_count"] = int(regression_count)
        return result

    def dashboard_target_results(self) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT path, suite, target_status, target_snapshot_json,
                       prior_target_status, prior_target_snapshot_json,
                       target_regression_count, updated_at
                FROM tests
                WHERE enabled=1
                ORDER BY path
                """
            ).fetchall()
        return [dict(row) for row in rows]

    def top_failure_clusters(self, limit: int = 10) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT suite, failure_fingerprint, COUNT(*) AS count,
                       MIN(path) AS example, MIN(attempt_count) AS min_attempts
                FROM tests
                WHERE enabled=1 AND target_status != 'pass'
                GROUP BY suite, failure_fingerprint
                ORDER BY count DESC, suite
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [dict(row) for row in rows]

    def passing_paths(self) -> list[str]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT path FROM tests WHERE enabled=1 AND target_status='pass' ORDER BY path"
            ).fetchall()
        return [str(row["path"]) for row in rows]

    def latest_result(
        self,
        test_path: str,
        *,
        canonical_phase_prefix: str | None = None,
        run_id: str | None = None,
    ) -> dict[str, Any] | None:
        sql = "SELECT * FROM results WHERE test_path=?"
        args: list[Any] = [test_path]
        if run_id is not None:
            sql += " AND run_id=?"
            args.append(run_id)
        if canonical_phase_prefix is not None:
            sql += " AND phase LIKE ?"
            args.append(canonical_phase_prefix + "%")
        sql += " ORDER BY id DESC LIMIT 1"
        with self.connect() as conn:
            row = conn.execute(sql, args).fetchone()
        return None if row is None else dict(row)

    def previous_attempts(self, test_paths: Sequence[str], limit: int = 8) -> list[dict[str, Any]]:
        if not test_paths:
            return []
        placeholders = ",".join("?" for _ in test_paths)
        sql = f"""
            SELECT id, strategy, agent_summary, reason, score, changed_files_json, created_at
            FROM attempts
            WHERE EXISTS (
                SELECT 1 FROM json_each(attempts.assigned_tests_json)
                WHERE json_each.value IN ({placeholders})
            )
            ORDER BY created_at DESC
            LIMIT ?
        """
        try:
            with self.connect() as conn:
                rows = conn.execute(sql, [*test_paths, limit]).fetchall()
        except sqlite3.OperationalError:
            return []
        return [dict(row) for row in rows]

    def latest_target_evidence(self) -> list[dict[str, Any]]:
        """Latest canonical-target output for every enabled non-passing test.

        stderr/stdout are capped in SQL: the full text lives in results, and
        gap classification only needs the leading error frames.
        """

        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT t.path, t.suite, t.modules_json, t.target_status,
                       t.failure_fingerprint, t.size_bytes,
                       substr(r.stderr, 1, 8000) AS stderr,
                       substr(r.stdout, 1, 4000) AS stdout
                FROM tests t
                JOIN (
                    SELECT test_path, MAX(id) AS id
                    FROM results
                    WHERE phase LIKE 'canonical-target%'
                    GROUP BY test_path
                ) latest ON latest.test_path = t.path
                JOIN results r ON r.id = latest.id
                WHERE t.enabled = 1 AND t.target_status != 'pass'
                ORDER BY t.path
                """
            ).fetchall()
        return [dict(row) for row in rows]

    def replace_gaps(self, gaps: Iterable[Any]) -> int:
        now = utc_now()
        rows = [
            (
                gap.gap_id,
                gap.kind,
                gap.module,
                json.dumps(list(gap.symbols)),
                gap.affected_count,
                json.dumps(list(gap.affected_paths)),
                json.dumps(list(gap.acceptance_paths)),
                json.dumps(gap.evidence, default=str),
                now,
                now,
            )
            for gap in gaps
        ]
        if not rows:
            return 0
        with self.connect() as conn:
            conn.executemany(
                """
                INSERT INTO gaps(
                    id, kind, module, symbols_json, affected_count,
                    affected_paths_json, acceptance_json, evidence_json,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    kind=excluded.kind,
                    module=excluded.module,
                    symbols_json=excluded.symbols_json,
                    affected_count=excluded.affected_count,
                    affected_paths_json=excluded.affected_paths_json,
                    acceptance_json=excluded.acceptance_json,
                    evidence_json=excluded.evidence_json,
                    status=CASE
                        -- A fresh surface diff is authoritative for API
                        -- presence. If an API gap reappears after a prior
                        -- fill/close, reopen it so the worklist cannot hide
                        -- a regression behind historical status.
                        WHEN excluded.kind = 'missing-api' THEN 'open'
                        WHEN gaps.symbols_json = excluded.symbols_json THEN gaps.status
                        ELSE 'open'
                    END,
                    updated_at=excluded.updated_at
                """,
                rows,
            )
            # Re-extraction is the whole truth about open work: gaps that no
            # longer exist are retired, filled ones remain as history.
            placeholders = ",".join("?" for _ in rows)
            conn.execute(
                f"UPDATE gaps SET status='closed', updated_at=? "
                f"WHERE status='open' AND id NOT IN ({placeholders})",
                (now, *[row[0] for row in rows]),
            )
        return len(rows)

    def list_gaps(self, *, status: str | None = None, limit: int = 0) -> list[dict[str, Any]]:
        sql = "SELECT * FROM gaps"
        args: list[Any] = []
        if status is not None:
            sql += " WHERE status=?"
            args.append(status)
        sql += " ORDER BY affected_count DESC, kind, module"
        if limit > 0:
            sql += " LIMIT ?"
            args.append(limit)
        with self.connect() as conn:
            rows = conn.execute(sql, args).fetchall()
        parsed: list[dict[str, Any]] = []
        for row in rows:
            item = dict(row)
            item["symbols"] = json.loads(item.pop("symbols_json") or "[]")
            item["affected_paths"] = json.loads(item.pop("affected_paths_json") or "[]")
            item["acceptance_paths"] = json.loads(item.pop("acceptance_json") or "[]")
            item["evidence"] = json.loads(item.pop("evidence_json") or "{}")
            parsed.append(item)
        return parsed

    def set_gap_status(self, gap_id: str, status: str) -> bool:
        if status not in {"open", "filled", "closed"}:
            raise ValueError(f"unsupported gap status: {status}")
        with self.connect() as conn:
            result = conn.execute(
                "UPDATE gaps SET status=?, updated_at=? WHERE id=?",
                (status, utc_now(), gap_id),
            )
        return result.rowcount == 1
