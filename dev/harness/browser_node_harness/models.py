from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, ClassVar, Literal

from .scope import ScopeKind, ScopeRequirement, classify_test_path

Status = Literal["unknown", "pass", "fail", "skip", "timeout", "infra_error"]


@dataclass(frozen=True, slots=True)
class TestCase:
    __test__: ClassVar[bool] = False

    path: str
    suite: str
    source_sha256: str
    flags: tuple[str, ...] = ()
    modules: tuple[str, ...] = ()
    size_bytes: int = 0
    source_override: str | None = None
    scope: ScopeKind | None = None
    expected_output_path: str | None = None
    expected_output: str | None = None
    expected_input_path: str | None = None
    expected_input: str | None = None

    def __post_init__(self) -> None:
        if self.scope is None:
            object.__setattr__(self, "scope", classify_test_path(self.path, self.suite).kind)

    @property
    def is_synthetic(self) -> bool:
        return self.source_override is not None or self.path.startswith(".bnh/")

    @property
    def scope_requirement(self) -> ScopeRequirement:
        return classify_test_path(self.path, self.suite)


@dataclass(slots=True)
class TestResult:
    test_path: str
    status: Status
    exit_code: int | None
    duration_ms: int
    stdout: str = ""
    stderr: str = ""
    fingerprint: str = ""
    details: dict[str, Any] = field(default_factory=dict)
    log_dir: Path | None = None

    @property
    def passed(self) -> bool:
        return self.status == "pass"


@dataclass(frozen=True, slots=True)
class Task:
    task_id: str
    tests: tuple[TestCase, ...]
    cluster_key: str
    strategy: str
    replica: int


@dataclass(slots=True)
class AgentRun:
    exit_code: int | None
    timed_out: bool
    duration_ms: int
    stdout: str
    stderr: str
    summary: str = ""
    provider: str = ""
    model: str = ""
    pid: int | None = None
    stdout_path: Path | None = None
    stderr_path: Path | None = None
    output_path: Path | None = None
    control_action: str = ""
    stopped: bool = False


@dataclass(slots=True)
class PatchInfo:
    path: Path
    sha256: str
    size_bytes: int
    changed_files: tuple[str, ...]
    diff_stat: str
    valid: bool
    rejection_reason: str = ""


@dataclass(slots=True)
class CandidateAttempt:
    attempt_id: str
    task: Task
    worktree: Path
    base_commit: str
    agent: AgentRun
    patch: PatchInfo
    assigned_results: list[TestResult] = field(default_factory=list)
    guard_results: list[TestResult] = field(default_factory=list)
    check_ok: bool = True
    check_output: str = ""
    mutation_ok: bool = True
    score: float = 0.0
    accepted: bool = False
    reason: str = ""


@dataclass(slots=True)
class ProcessResult:
    argv: tuple[str, ...]
    cwd: Path
    exit_code: int | None
    stdout: str
    stderr: str
    duration_ms: int
    timed_out: bool = False
    pid: int | None = None
    termination_reason: str = ""
