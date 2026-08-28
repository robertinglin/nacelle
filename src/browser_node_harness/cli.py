from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from collections import Counter
from dataclasses import replace
from pathlib import Path

from . import __version__
from .addon_build import build_addon_manifest
from .addon_build import native_failing_tests as addon_native_failing_tests
from .config import ConfigError, load_config
from .db import Database
from .dashboard import create_dashboard_server
from .discover import test_case_from_path
from .gap_cards import emit_gap_cards, emit_worklist_index
from .gaps import FailureEvidence, MISSING_API, form_gaps
from .gitops import GitError
from .node_source import prepare_node_source, prepare_target_repository
from .orchestrator import Harness, make_run_id
from .primitives import primitive_tests
from .reference_adapter import run_reference_request
from .surface import (
    SurfaceProbeError,
    diff_surfaces,
    list_builtin_modules,
    run_surface_probe,
    surfaces_from_json,
    surfaces_to_json,
)
from .validation import validate_adapter_controls


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="bnh",
        description="Parallel coding-agent loop for browser-native Node.js compatibility",
    )
    parser.add_argument(
        "--config",
        default=os.environ.get("BNH_CONFIG", "harness.toml"),
        help="TOML configuration path (default: harness.toml or BNH_CONFIG)",
    )
    parser.add_argument(
        "--variant",
        default=os.environ.get("BNH_VARIANT"),
        help="configured runtime/source variant (also accepted after start or loop)",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    init = sub.add_parser("init", help="create the integration worktree and discover tests")
    init.add_argument("--no-setup", action="store_true", help="do not run workspace.setup")

    sub.add_parser("discover", help="refresh the upstream test manifest")

    scan = sub.add_parser("scan", help="run the reference and browser target adapters")
    scan.add_argument("tests", nargs="*", help="specific test paths; default is all discovered tests")
    scan.add_argument("--refresh", action="store_true", help="rerun tests with existing results")
    scan.add_argument("--no-oracle", action="store_true", help="do not run the reference adapter")
    scan.add_argument(
        "--browser-only",
        action="store_true",
        help="run only tests classified as browser_js",
    )
    scan.add_argument(
        "--target-concurrency",
        type=int,
        default=None,
        help="override the number of concurrent target Playwright workers",
    )
    scan.add_argument(
        "--timeout-seconds",
        type=float,
        default=None,
        help="override the target per-test timeout",
    )
    scan.add_argument(
        "--failure-limit",
        type=int,
        default=None,
        help="stop after this many actionable failures; 0 scans all selected tests",
    )
    scan_mode = scan.add_mutually_exclusive_group()
    scan_mode.add_argument(
        "--include-oracle-ineligible",
        action="store_true",
        help="also run tests whose oracle failed, skipped, or timed out in a separate browser exploration phase",
    )
    scan_mode.add_argument(
        "--retry-infra",
        action="store_true",
        help="rerun only tests currently marked as target infrastructure failures",
    )
    scan_mode.add_argument(
        "--retry-unknown",
        action="store_true",
        help="rerun only tests currently missing a canonical browser result",
    )

    loop = sub.add_parser("loop", help="run agents until the selected suite is green")
    loop.add_argument("--refresh", action="store_true", help="rerun the full baseline first")
    loop.add_argument(
        "--max-iterations",
        type=int,
        default=None,
        help="override loop.max_iterations; 0 means unlimited",
    )
    loop.add_argument("--variant", dest="variant", default=argparse.SUPPRESS, help=argparse.SUPPRESS)

    start = sub.add_parser("start", help="start the loop and a local live status dashboard")
    start.add_argument("--host", default="127.0.0.1", help="dashboard bind host (default: 127.0.0.1)")
    start.add_argument("--port", type=int, default=8787, help="dashboard port (default: 8787; 0 picks a free port)")
    start.add_argument("--refresh", action="store_true", help="rerun the full baseline first")
    start.add_argument(
        "--max-iterations",
        type=int,
        default=None,
        help="override loop.max_iterations; 0 means unlimited",
    )
    start.add_argument("--variant", dest="variant", default=argparse.SUPPRESS, help=argparse.SUPPRESS)

    dashboard = sub.add_parser("dashboard", help="serve the local status dashboard without starting a loop")
    dashboard.add_argument("--host", default="127.0.0.1", help="dashboard bind host (default: 127.0.0.1)")
    dashboard.add_argument("--port", type=int, default=8787, help="dashboard port (default: 8787; 0 picks a free port)")

    status = sub.add_parser("status", help="show current compatibility state")
    status.add_argument("--json", action="store_true", help="emit machine-readable JSON")

    test = sub.add_parser("test", help="run target tests in a specific candidate worktree")
    test.add_argument(
        "--worktree",
        default=None,
        help="candidate target worktree (default: configured variant integration worktree)",
    )
    test.add_argument("tests", nargs="+", help="upstream test paths")
    test.add_argument("--json", action="store_true", help="emit JSON lines")

    report = sub.add_parser("report", help="write a JSON status report")
    report.add_argument("--output", default="bnh-report.json")

    gaps = sub.add_parser("gaps", help="extract capability gaps and emit build cards")
    gaps.add_argument("--list", action="store_true", help="list stored gaps and exit")
    gaps.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    gaps.add_argument(
        "--emit",
        metavar="DIR",
        default=None,
        help="write one task-card directory per gap plus WORKLIST.md into DIR",
    )
    gaps.add_argument(
        "--reuse-surfaces",
        action="store_true",
        help="reuse stored probe surfaces instead of re-probing both adapters",
    )
    gaps.add_argument(
        "--verify",
        action="store_true",
        help="re-probe the target surface and mark filled missing-api gaps",
    )

    prune = sub.add_parser("prune", help="delete per-test logs of all but the most recent runs")
    prune.add_argument(
        "--keep",
        type=int,
        default=20,
        help="number of most recent run log directories to keep (default 20)",
    )
    prune.add_argument("--dry-run", action="store_true", help="report what would be deleted")

    addon_build = sub.add_parser(
        "addon-build",
        help="compile failing native addons to wasm32 and write the bundle manifest",
    )
    addon_build.add_argument(
        "tests",
        nargs="*",
        help="specific native test paths; default is all failing native-scope tests",
    )
    addon_build.add_argument(
        "--bootstrap",
        action="store_true",
        help="install the Emscripten SDK under the state dir first when missing",
    )

    adapter = sub.add_parser("adapter", help="built-in adapter entry points")
    adapter_sub = adapter.add_subparsers(dest="adapter_command", required=True)
    reference = adapter_sub.add_parser("reference-node", help="execute one request with host Node.js")
    reference.add_argument("request", nargs="?", help="request JSON path; defaults to BNH_REQUEST_FILE")

    return parser


def _load_harness(config_path: str, variant: str | None = None) -> Harness:
    return Harness(load_config(config_path, variant=variant))


def _select_tests(harness: Harness, paths: list[str]):
    if not paths:
        return harness.db.list_tests()
    primitive_by_path = {
        test.path: test
        for test in primitive_tests(harness.config.primitives.items)
    }
    selected = []
    for path in paths:
        normalized = Path(path).as_posix().removeprefix("./")
        test = primitive_by_path.get(normalized) or harness.db.get_test(normalized)
        if test is None:
            test = test_case_from_path(harness.config.project.node_repo, normalized)
            harness.db.upsert_tests([test])
        selected.append(test)
    return selected


def command_init(harness: Harness, args: argparse.Namespace) -> int:
    integration = harness.initialize(run_setup=not args.no_setup)
    tests = harness.discover()
    ok, _, reason = validate_adapter_controls(
        harness.config,
        harness.runner,
        worktree=integration,
        run_id="init-controls",
        iteration=0,
    )
    print(f"integration worktree: {integration}")
    print(f"integration branch: {harness.config.project.integration_branch}")
    print(f"tests: {len(tests)}")
    if ok:
        print("adapter controls: pass")
    else:
        print(f"adapter controls: not yet passing ({reason})")
    return 0


def command_scan(harness: Harness, args: argparse.Namespace) -> int:
    loop = harness.config.loop
    loop_overrides = {}
    target_concurrency = getattr(args, "target_concurrency", None)
    timeout_seconds = getattr(args, "timeout_seconds", None)
    failure_limit = getattr(args, "failure_limit", None)
    if target_concurrency is not None:
        if target_concurrency < 1:
            raise ValueError("--target-concurrency must be at least 1")
        loop_overrides["target_concurrency"] = target_concurrency
    if timeout_seconds is not None:
        if timeout_seconds <= 0:
            raise ValueError("--timeout-seconds must be greater than 0")
        loop_overrides["scan_timeout_seconds"] = timeout_seconds
    if failure_limit is not None:
        if failure_limit < 0:
            raise ValueError("--failure-limit must be 0 or greater")
        loop_overrides["scan_failure_limit"] = failure_limit
    if loop_overrides:
        updated_config = replace(harness.config, loop=replace(loop, **loop_overrides))
        harness.config = updated_config
        harness.runner.config = updated_config

    harness.initialize(run_setup=True)
    harness.discover()
    selected = _select_tests(harness, args.tests)
    if getattr(args, "browser_only", False):
        selected = [test for test in selected if test.scope == "browser_js"]
        print(f"browser-only scan: {len(selected)} test(s)")
    run_id = make_run_id("scan")
    harness.db.start_run(
        run_id,
        harness.git.head(harness.git.integration),
        variant=harness.config.project.variant,
    )
    try:
        results = harness.scan(
            run_id=run_id,
            iteration=0,
            tests=selected,
            refresh=args.refresh,
            run_oracle=not args.no_oracle,
            failure_limit=failure_limit,
            include_oracle_ineligible=args.include_oracle_ineligible,
            retry_infra=args.retry_infra,
            retry_unknown=args.retry_unknown,
        )
        harness.db.update_run(run_id, status="complete")
    except Exception:
        harness.db.update_run(run_id, status="failed")
        raise
    print(harness.status_text())
    if args.include_oracle_ineligible or args.retry_infra or args.retry_unknown:
        counts = Counter(result.status for result in results)
        summary = ", ".join(f"{status}={count}" for status, count in sorted(counts.items()))
        if args.include_oracle_ineligible:
            label = "exploratory browser"
        elif args.retry_infra:
            label = "infrastructure retry"
        else:
            label = "unknown-result retry"
        print(f"{label} results: {summary or 'no tests selected'}")
    return 0


def command_status(harness: Harness, args: argparse.Namespace) -> int:
    if args.json:
        print(
            json.dumps(
                {
                    "summary": harness.db.summary(),
                    "scope": json.loads(harness.db.get_meta("scope_summary") or "{}"),
                    "failure_clusters": harness.db.top_failure_clusters(),
                },
                indent=2,
            )
        )
    else:
        print(harness.status_text())
    return 0


def command_start(harness: Harness, args: argparse.Namespace) -> int:
    prepare_target_repository(harness.config.project)
    harness.git.validate_repo()
    prepare_node_source(harness.config.project)

    loop_command = [
        sys.executable,
        "-m",
        "browser_node_harness",
        "--config",
        str(harness.config.path),
        "loop",
    ]
    if args.variant:
        loop_command.extend(("--variant", args.variant))
    if args.refresh:
        loop_command.append("--refresh")
    if args.max_iterations is not None:
        loop_command.extend(("--max-iterations", str(args.max_iterations)))

    server = create_dashboard_server(
        harness.config.project.state_dir / "state.sqlite3",
        host=args.host,
        port=args.port,
        variant=getattr(harness.config.project, "variant", None),
    )
    try:
        loop_process = subprocess.Popen(
            loop_command,
            cwd=str(harness.config.root),
            env=os.environ.copy(),
            start_new_session=(os.name != "nt"),
        )
        print(f"dashboard: http://{args.host}:{server.server_port}/", flush=True)
        print(f"loop process: {loop_process.pid}", flush=True)
        server.serve_forever()
    finally:
        server.server_close()
        if "loop_process" in locals() and loop_process.poll() is None:
            loop_process.terminate()
            try:
                loop_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                loop_process.kill()
                loop_process.wait()
    return 0


def command_dashboard(harness: Harness, args: argparse.Namespace) -> int:
    server = create_dashboard_server(
        harness.config.project.state_dir / "state.sqlite3",
        host=args.host,
        port=args.port,
        variant=getattr(harness.config.project, "variant", None),
    )
    try:
        print(f"dashboard: http://{args.host}:{server.server_port}/", flush=True)
        server.serve_forever()
    finally:
        server.server_close()
    return 0


def _evidence_rows(harness: Harness) -> list[FailureEvidence]:
    return [
        FailureEvidence(
            path=row["path"],
            suite=row["suite"],
            modules=tuple(json.loads(row["modules_json"])),
            status=str(row["target_status"]),
            size_bytes=int(row["size_bytes"]),
            stderr=str(row["stderr"]),
        )
        for row in harness.db.latest_target_evidence()
    ]


def _print_gap_rows(rows: list[dict], as_json: bool) -> None:
    if as_json:
        print(json.dumps(rows, indent=2))
        return
    if not rows:
        print("no gaps recorded")
        return
    for row in rows:
        symbols = row.get("symbols", [])
        preview = ", ".join(symbols[:4]) + ("…" if len(symbols) > 4 else "")
        print(
            f"{row['status']:<7} {row['kind']:<18} {row['module']:<18} "
            f"affected={row['affected_count']:<5} {len(symbols)} symbol(s) {preview}"
        )


def _extract_gaps(harness: Harness, args: argparse.Namespace) -> int:
    config = harness.config
    if config.oracle is None:
        raise ValueError("gap extraction needs an [oracle] adapter to diff against")
    worktree = harness.initialize(run_setup=False)
    run_id = make_run_id("gaps")

    if args.reuse_surfaces:
        stored_oracle = harness.db.get_meta("surface:oracle")
        stored_target = harness.db.get_meta("surface:target")
        if not stored_oracle or not stored_target:
            raise ValueError("no stored surfaces to reuse; run gap extraction without --reuse-surfaces")
        oracle_surfaces = surfaces_from_json(stored_oracle)
        target_surfaces = surfaces_from_json(stored_target)
    else:
        oracle_modules = list_builtin_modules(
            harness.runner, spec=config.oracle, worktree=worktree, run_id=run_id
        )
        try:
            target_modules = list_builtin_modules(
                harness.runner, spec=config.target, worktree=worktree, run_id=run_id
            )
        except SurfaceProbeError as exc:
            print(f"warning: target cannot list builtins yet ({exc}); probing oracle list only")
            target_modules = ()
        # Subpath builtins (fs/promises, stream/web, …) are probed as their
        # own surfaces; collapsing them here would manufacture phantom
        # modules like bare `internal` that neither side can load.
        modules = sorted(
            {
                name.removeprefix("node:")
                for name in (*oracle_modules, *target_modules)
                if name.removeprefix("node:")
            }
        )
        print(f"probing {len(modules)} builtin module(s) on oracle and target…")
        oracle_surfaces = run_surface_probe(
            harness.runner, spec=config.oracle, worktree=worktree, modules=modules, run_id=run_id
        )
        target_surfaces = run_surface_probe(
            harness.runner, spec=config.target, worktree=worktree, modules=modules, run_id=run_id
        )
        harness.db.set_meta("surface:oracle", surfaces_to_json(oracle_surfaces))
        harness.db.set_meta("surface:target", surfaces_to_json(target_surfaces))

    surface_gaps = diff_surfaces(oracle_surfaces, target_surfaces)
    gaps = form_gaps(surface_gaps, _evidence_rows(harness), config.project.node_repo)
    harness.db.replace_gaps(gaps)
    statuses = {
        row["id"]: row["status"]
        for row in harness.db.list_gaps()
    }
    open_gaps = [gap for gap in gaps if statuses.get(gap.gap_id) == "open"]
    open_rows = [
        {**gap.to_row(), "status": "open"}
        for gap in open_gaps
    ]

    missing_modules = sorted({gap.module for gap in surface_gaps})
    print(
        f"surface diff: {len(surface_gaps)} module(s) with gaps "
        f"({', '.join(missing_modules[:8])}{'…' if len(missing_modules) > 8 else ''})"
    )
    print(f"formed {len(gaps)} surface gap card(s); {len(open_gaps)} open card(s); top:")
    _print_gap_rows(open_rows[:10], as_json=False)
    if args.emit:
        emit_dir = Path(args.emit).expanduser().resolve()
        emitted = emit_gap_cards(
            open_gaps, emit_dir, node_repo=config.project.node_repo, config_path=config.path
        )
        emit_worklist_index(open_gaps, emit_dir)
        print(f"emitted {len(emitted)} card(s) and WORKLIST.md into {emit_dir}")
    if args.json:
        _print_gap_rows(open_rows, as_json=True)
    return 0


def _verify_gaps(harness: Harness) -> int:
    config = harness.config
    open_rows = harness.db.list_gaps(status="open")
    api_rows = [row for row in open_rows if row["kind"] == MISSING_API]
    if not api_rows:
        print("no open missing-api gaps to verify")
        return 0
    worktree = harness.initialize(run_setup=False)
    run_id = make_run_id("gaps-verify")
    modules = sorted({row["module"] for row in api_rows})
    target_surfaces = run_surface_probe(
        harness.runner, spec=config.target, worktree=worktree, modules=modules, run_id=run_id
    )
    filled = 0
    for row in api_rows:
        surface = target_surfaces.get(row["module"])
        if surface is None or surface.load_error:
            continue
        present = set(surface.symbols)
        if all(symbol in present for symbol in row["symbols"]):
            harness.db.set_gap_status(row["id"], "filled")
            filled += 1
    print(f"verified {len(api_rows)} open missing-api gap(s): {filled} filled")
    return 0


def command_gaps(harness: Harness, args: argparse.Namespace) -> int:
    if args.list:
        _print_gap_rows(harness.db.list_gaps(), as_json=args.json)
        return 0
    if args.verify:
        return _verify_gaps(harness)
    return _extract_gaps(harness, args)


def command_prune(harness: Harness, args: argparse.Namespace) -> int:
    logs_dir = harness.config.project.state_dir / "logs"
    if not logs_dir.is_dir():
        print(f"no log directory at {logs_dir}")
        return 0
    keep = max(0, args.keep)
    run_dirs = sorted(
        (entry for entry in logs_dir.iterdir() if entry.is_dir()),
        key=lambda path: (path.stat().st_mtime, path.name),
        reverse=True,
    )
    doomed = run_dirs[keep:]
    if not doomed:
        print(f"nothing to prune: only {len(run_dirs)} run log directory(ies) exist")
        return 0

    def tree_size(path: Path) -> int:
        return sum(item.stat().st_size for item in path.rglob("*") if item.is_file())

    total_bytes = sum(tree_size(path) for path in doomed)
    for path in doomed:
        print(f"{'would delete' if args.dry_run else 'deleting'} {path.name}")
        if not args.dry_run:
            shutil.rmtree(path)
    print(
        f"{len(doomed)} run log directory(ies) "
        f"{'would free' if args.dry_run else 'freed'} {total_bytes / 1_000_000:.1f} MB; "
        f"kept {min(keep, len(run_dirs))} most recent"
    )
    return 0


def command_addon_build(harness: Harness, args: argparse.Namespace) -> int:
    config = harness.config
    test_paths = list(args.tests) or addon_native_failing_tests(harness.db)
    if not test_paths:
        print("no failing native-scope tests recorded; pass explicit test paths to build anyway")
        return 0
    print(f"building addons for {len(test_paths)} native test(s)…")
    manifest = build_addon_manifest(
        node_repo=config.project.node_repo,
        state_dir=config.project.state_dir,
        test_paths=test_paths,
        bootstrap=args.bootstrap,
    )
    for artifact in manifest["artifacts"]:
        print(f"built {artifact['node']} -> {artifact['wasm']}")
    for failure in manifest["failures"]:
        print(f"FAILED {failure['addon']}: {failure['error']}")
    print(
        f"manifest: {config.project.state_dir / 'addon-manifest.json'} "
        f"({len(manifest['artifacts'])} artifact(s), {len(manifest['failures'])} failure(s))"
    )
    return 0 if not manifest["failures"] else 1


def command_test(harness: Harness, args: argparse.Namespace) -> int:
    requested_worktree = getattr(args, "worktree", None)
    if requested_worktree is None:
        worktree = harness.git.integration.resolve()
        label = f"configured {harness.config.project.variant} integration worktree"
    else:
        worktree = Path(requested_worktree).expanduser().resolve()
        label = "test worktree"
    if not worktree.is_dir():
        raise ValueError(f"{label} does not exist: {worktree}")
    tests = _select_tests(harness, args.tests)
    results = harness.runner.run_many(
        tests,
        spec=harness.config.target,
        worktree=worktree,
        phase="agent-reproduce",
        run_id="adhoc",
        iteration=0,
        concurrency=1,
    )
    for result in results:
        if args.json:
            print(
                json.dumps(
                    {
                        "test": result.test_path,
                        "status": result.status,
                        "exit_code": result.exit_code,
                        "duration_ms": result.duration_ms,
                        "fingerprint": result.fingerprint,
                        "log_dir": str(result.log_dir or ""),
                    }
                )
            )
        else:
            print(
                f"{result.status.upper():<11} {result.duration_ms:>7} ms  "
                f"{result.test_path}  log={result.log_dir}"
            )
            if result.status != "pass" and result.stderr:
                print(result.stderr[-4_000:])
    return 0 if all(result.status == "pass" for result in results) else 1


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == "adapter":
        if args.adapter_command == "reference-node":
            raw = args.request or os.environ.get("BNH_REQUEST_FILE")
            if not raw:
                parser.error("reference-node requires a request path or BNH_REQUEST_FILE")
            return run_reference_request(Path(raw).resolve())
        parser.error(f"unknown adapter command: {args.adapter_command}")

    try:
        harness = _load_harness(args.config, args.variant)
        if args.command == "init":
            return command_init(harness, args)
        if args.command == "discover":
            harness.initialize(run_setup=False)
            harness.discover()
            return 0
        if args.command == "scan":
            return command_scan(harness, args)
        if args.command == "loop":
            run_id = harness.loop(refresh=args.refresh, max_iterations_override=args.max_iterations)
            print(harness.status_text())
            run = harness.db.get_run(run_id) or {}
            return 0 if run.get("status") == "green" else 1
        if args.command == "start":
            return command_start(harness, args)
        if args.command == "dashboard":
            return command_dashboard(harness, args)
        if args.command == "status":
            return command_status(harness, args)
        if args.command == "test":
            return command_test(harness, args)
        if args.command == "gaps":
            return command_gaps(harness, args)
        if args.command == "prune":
            return command_prune(harness, args)
        if args.command == "addon-build":
            return command_addon_build(harness, args)
        if args.command == "report":
            output = harness.write_report(Path(args.output).expanduser().resolve())
            print(output)
            return 0
        parser.error(f"unknown command: {args.command}")
    except (ConfigError, GitError, FileNotFoundError, RuntimeError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("interrupted", file=sys.stderr)
        return 130
    return 0
