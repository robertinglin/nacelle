"""Bootstrap and update the upstream Node.js source checkout."""

from __future__ import annotations

import os
import fcntl
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from .config import ProjectConfig
from .models import ProcessResult
from .process import run_process


class NodeSourceError(RuntimeError):
    """Raised when the configured upstream source cannot be prepared."""


_BUILD_TIMEOUT_SECONDS = 1_800
_MAX_BUILD_JOBS = 4


def _run_git(args: list[str], *, cwd: Path) -> ProcessResult:
    result = run_process(
        ["git", *args],
        cwd=cwd,
        env=os.environ,
        timeout_seconds=1_800,
        max_output_chars=200_000,
    )
    if result.timed_out or result.exit_code != 0:
        detail = result.stderr or result.stdout or "no git output"
        raise NodeSourceError(
            f"git {' '.join(args)} failed in {cwd} (exit={result.exit_code}, timeout={result.timed_out}): {detail}"
        )
    return result


def _managed_node_binary(project: ProjectConfig) -> Path | None:
    """Return a repository-contained binary path, or None for external commands."""

    configured = Path(project.node_binary)
    if configured.is_absolute():
        return None

    repository = project.node_repo.resolve()
    candidate = (project.node_repo / configured).resolve(strict=False)
    try:
        candidate.relative_to(repository)
    except ValueError:
        return None
    return candidate


def _build_jobs() -> int:
    return max(1, min(_MAX_BUILD_JOBS, (os.cpu_count() or 2) // 2))


def _run_build_command(args: list[str], *, cwd: Path) -> ProcessResult:
    result = run_process(
        args,
        cwd=cwd,
        env=os.environ,
        timeout_seconds=_BUILD_TIMEOUT_SECONDS,
        max_output_chars=200_000,
    )
    if result.timed_out or result.exit_code != 0:
        detail = result.stderr or result.stdout or "no build output"
        raise NodeSourceError(
            f"{' '.join(args)} failed in {cwd} "
            f"(exit={result.exit_code}, timeout={result.timed_out}): {detail}"
        )
    return result


def _ensure_node_binary(project: ProjectConfig) -> None:
    binary = _managed_node_binary(project)
    if binary is None or binary.is_file():
        return

    repository = project.node_repo
    configured = repository / "config.gypi"
    makefile = repository / "out" / "Makefile"
    if not configured.is_file() or not makefile.is_file():
        _run_build_command(["./configure", "--without-npm"], cwd=repository)

    _run_build_command(["make", f"-j{_build_jobs()}", "node"], cwd=repository)
    if not binary.is_file():
        raise NodeSourceError(
            f"Node build completed without producing configured binary: {binary}"
        )


def _clone(path: Path, url: str, ref: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    _run_git(
        [
            "clone",
            "--depth",
            "1",
            "--single-branch",
            "--branch",
            ref,
            url,
            str(path),
        ],
        cwd=path.parent,
    )


def _update(project: ProjectConfig) -> None:
    if not (project.node_repo / ".git").exists():
        raise NodeSourceError(
            f"configured Node source path is not a Git checkout: {project.node_repo}; "
            "remove it or point node_repo at a checkout"
        )
    status = _run_git(["status", "--porcelain"], cwd=project.node_repo)
    if status.stdout.strip():
        raise NodeSourceError(
            f"configured Node source checkout has local changes: {project.node_repo}; "
            "commit or remove them before automatic update"
        )
    _run_git(["fetch", "--depth", "1", "origin", project.node_repo_ref], cwd=project.node_repo)
    _run_git(["checkout", "--detach", "FETCH_HEAD"], cwd=project.node_repo)


def prepare_node_source(project: ProjectConfig) -> Path:
    """Clone or update the selected Node source variant and return its path."""

    if project.node_repo_url is None:
        if not project.node_repo.is_dir():
            raise NodeSourceError(
                f"Node.js source repository does not exist: {project.node_repo}; "
                "set project.node_repo_url to enable automatic clone"
            )
        _ensure_node_binary(project)
        return project.node_repo

    if project.node_repo.exists():
        _update(project)
    else:
        assert project.node_repo_url is not None
        _clone(project.node_repo, project.node_repo_url, project.node_repo_ref)
    _ensure_node_binary(project)
    return project.node_repo


@contextmanager
def _target_repository_lock(project: ProjectConfig) -> Iterator[None]:
    lock_path = project.target_repo.parent / f".{project.target_repo.name}.bnh.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def prepare_target_repository(project: ProjectConfig) -> Path:
    """Clone the configured target repository, or fetch its upstream ref."""

    if project.target_repo_url is None:
        if not project.target_repo.is_dir():
            raise NodeSourceError(
                f"target repository does not exist: {project.target_repo}; "
                "set project.target_repo_url to enable automatic clone"
            )
        return project.target_repo

    with _target_repository_lock(project):
        if not project.target_repo.exists():
            _clone(project.target_repo, project.target_repo_url, project.target_repo_ref)
            return project.target_repo

        if not (project.target_repo / ".git").exists():
            raise NodeSourceError(f"configured target path is not a Git checkout: {project.target_repo}")
        status = _run_git(["status", "--porcelain"], cwd=project.target_repo)
        if status.stdout.strip():
            raise NodeSourceError(
                f"configured target checkout has local changes: {project.target_repo}; "
                "commit or remove them before automatic update"
            )
        _run_git(["fetch", "--depth", "1", "origin", project.target_repo_ref], cwd=project.target_repo)
        return project.target_repo
