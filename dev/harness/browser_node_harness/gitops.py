from __future__ import annotations

import hashlib
import os
import selectors
import shutil
import stat
import subprocess
import time
from pathlib import Path

from .config import HarnessConfig, ValidationConfig
from .models import PatchInfo
from .process import run_process
from .runtime_links import link_shared_runtime

_HARNESS_CONTROL_MARKERS = (
    "BNH_NEGATIVE_CONTROL",
    "BNH_MUTATION_",
    ".bnh/canary/",
)

_SNAPSHOT_GIT_TIMEOUT = 120.0
_SNAPSHOT_RECORD_BYTES = 8 * 1024 * 1024


def _readonly_git_environment() -> dict[str, str]:
    environment = dict(os.environ)
    environment["GIT_OPTIONAL_LOCKS"] = "0"
    return environment


def _read_git_records(
    args: tuple[str, ...],
    worktree: Path,
    *,
    max_records: int,
) -> tuple[tuple[bytes, ...], bool]:
    """Read a bounded NUL-delimited Git result without changing the worktree."""

    process = subprocess.Popen(
        ["git", *args],
        cwd=worktree,
        env=_readonly_git_environment(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    selector = selectors.DefaultSelector()
    assert process.stdout is not None
    assert process.stderr is not None
    selector.register(process.stdout, selectors.EVENT_READ, "stdout")
    selector.register(process.stderr, selectors.EVENT_READ, "stderr")
    records: list[bytes] = []
    pending = bytearray()
    stderr = bytearray()
    output_bytes = 0
    truncated = False
    deadline = time.monotonic() + _SNAPSHOT_GIT_TIMEOUT

    def stop_process() -> None:
        if process.poll() is None:
            process.kill()

    try:
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                stop_process()
                raise GitError(f"git {' '.join(args)} timed out in {worktree}")
            events = selector.select(min(0.25, remaining))
            if not events:
                continue
            for key, _ in events:
                data = os.read(key.fd, 65_536)
                if not data:
                    selector.unregister(key.fileobj)
                    continue
                if key.data == "stderr":
                    stderr.extend(data[:8_192 - len(stderr)])
                    continue
                output_bytes += len(data)
                pending.extend(data)
                while b"\0" in pending:
                    record, _, pending = pending.partition(b"\0")
                    records.append(bytes(record))
                    if len(records) > max_records:
                        truncated = True
                        stop_process()
                        break
                if output_bytes > _SNAPSHOT_RECORD_BYTES or len(pending) > _SNAPSHOT_RECORD_BYTES:
                    truncated = True
                    stop_process()
                if truncated:
                    selector.unregister(key.fileobj)
                    break
    finally:
        if truncated:
            stop_process()
        selector.close()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        process.stdout.close()
        process.stderr.close()

    if process.returncode != 0 and not truncated:
        detail = bytes(stderr).decode(errors="replace").strip()
        raise GitError(
            f"git {' '.join(args)} failed in {worktree} (exit={process.returncode}):\n{detail}"
        )
    if pending:
        records.append(bytes(pending))
    return tuple(records[:max_records]), truncated


def _snapshot_field(digest: "hashlib._Hash", value: bytes) -> None:
    digest.update(len(value).to_bytes(8, "big"))
    digest.update(value)


def _hash_snapshot_entry(
    digest: "hashlib._Hash",
    worktree: Path,
    path_bytes: bytes,
    *,
    index_metadata: bytes,
    remaining_bytes: int,
) -> int:
    """Hash one manifest entry and return the content bytes sampled."""

    relative = os.fsdecode(path_bytes)
    path = worktree / relative
    digest.update(b"entry\0")
    _snapshot_field(digest, path_bytes)
    _snapshot_field(digest, index_metadata)
    try:
        info = path.lstat()
    except FileNotFoundError:
        digest.update(b"missing\0")
        return 0
    except OSError as error:
        digest.update(b"unreadable\0")
        _snapshot_field(digest, str(error).encode("utf-8", errors="replace"))
        return 0

    digest.update(stat.filemode(info.st_mode).encode())
    digest.update(info.st_size.to_bytes(8, "big", signed=False))
    if stat.S_ISLNK(info.st_mode):
        content = os.fsencode(os.readlink(path))
    elif not stat.S_ISREG(info.st_mode):
        digest.update(b"non-regular\0")
        return 0
    elif remaining_bytes <= 0:
        digest.update(b"content-truncated\0")
        return 0
    else:
        try:
            with path.open("rb") as stream:
                content = stream.read(min(remaining_bytes, info.st_size))
        except OSError as error:
            digest.update(b"unreadable\0")
            _snapshot_field(digest, str(error).encode("utf-8", errors="replace"))
            return 0

    sampled = content[:remaining_bytes]
    _snapshot_field(digest, hashlib.sha256(sampled).digest())
    if len(content) < info.st_size or len(content) > remaining_bytes:
        digest.update(b"content-truncated\0")
    else:
        digest.update(b"content-complete\0")
    return len(sampled)


def worktree_snapshot_identity(
    worktree: Path,
    *,
    max_files: int = 4_096,
    max_bytes: int = 16 * 1024 * 1024,
) -> str:
    """Return a deterministic, read-only identity for a Git worktree snapshot.

    Clean worktrees are identified by HEAD. Dirty worktrees include sorted
    tracked index entries and standard untracked paths, plus bounded samples of
    their current filesystem content. Truncation is encoded in the identity so
    callers never mistake a bounded sample for a complete snapshot.
    """

    if max_files < 1:
        raise ValueError("max_files must be positive")
    if max_bytes < 1:
        raise ValueError("max_bytes must be positive")
    worktree = Path(worktree)

    head_result = run_process(
        ["git", "rev-parse", "--verify", "HEAD"],
        cwd=worktree,
        env=_readonly_git_environment(),
        timeout_seconds=_SNAPSHOT_GIT_TIMEOUT,
        max_output_chars=200,
    )
    if head_result.timed_out or head_result.exit_code not in (0, 1):
        raise GitError(f"git rev-parse HEAD failed in {worktree}: {head_result.stderr or head_result.stdout}")
    head = head_result.stdout.strip() if head_result.exit_code == 0 else "<unborn>"

    status, status_truncated = _read_git_records(
        ("status", "--porcelain=v1", "-z", "--untracked-files=all"),
        worktree,
        max_records=max_files,
    )
    if not status and not status_truncated:
        return hashlib.sha256(f"gitops-snapshot-v1\0clean\0{head}".encode()).hexdigest()

    tracked, tracked_truncated = _read_git_records(
        ("ls-files", "-s", "-z"),
        worktree,
        max_records=max_files,
    )
    tracked = tuple(sorted(tracked[:max_files]))
    remaining_files = max_files - len(tracked)
    if remaining_files:
        untracked, untracked_truncated = _read_git_records(
            ("ls-files", "--others", "--exclude-standard", "-z"),
            worktree,
            max_records=remaining_files,
        )
        untracked = tuple(sorted(untracked[:remaining_files]))
    else:
        untracked_probe, probe_truncated = _read_git_records(
            ("ls-files", "--others", "--exclude-standard", "-z"),
            worktree,
            max_records=1,
        )
        untracked = ()
        untracked_truncated = bool(untracked_probe) or probe_truncated

    digest = hashlib.sha256()
    for field in (b"gitops-snapshot-v1", b"dirty", head.encode()):
        _snapshot_field(digest, field)
    for marker, value in (
        (b"status-truncated", status_truncated),
        (b"tracked-truncated", tracked_truncated),
        (b"untracked-truncated", untracked_truncated),
    ):
        if value:
            digest.update(marker + b"\0")

    entries: list[tuple[bytes, bytes, bytes]] = []
    for record in tracked:
        metadata, separator, path = record.partition(b"\t")
        if not separator:
            path = record
            metadata = b"malformed-index-entry"
        entries.append((path, b"tracked", metadata))
    entries.extend((path, b"untracked", b"") for path in untracked)
    entries.sort()

    remaining_bytes = max_bytes
    for path, kind, metadata in entries[:max_files]:
        digest.update(kind + b"\0")
        remaining_bytes -= _hash_snapshot_entry(
            digest,
            worktree,
            path,
            index_metadata=metadata,
            remaining_bytes=remaining_bytes,
        )
    if remaining_bytes == 0:
        digest.update(b"content-budget-exhausted\0")
    return digest.hexdigest()


class GitError(RuntimeError):
    pass


class GitManager:
    def __init__(self, config: HarnessConfig):
        self.config = config
        self.repo = config.project.target_repo
        self.worktrees_root = config.project.state_dir / "worktrees"
        variant_name = "".join(
            character if character.isalnum() or character in "-_." else "-"
            for character in config.project.variant
        )
        integration_name = "integration" if variant_name == "default" else f"integration-{variant_name}"
        self.integration = self.worktrees_root / integration_name
        self.agents_root = self.worktrees_root / "agents"
        self.patches_root = config.project.state_dir / "patches"
        self._integration_is_new = False
        for path in (self.worktrees_root, self.agents_root, self.patches_root):
            path.mkdir(parents=True, exist_ok=True)

    def _git(
        self,
        *args: str,
        cwd: Path | None = None,
        timeout: float = 120,
        check: bool = True,
        max_output_chars: int = 200_000,
    ) -> str:
        location = cwd or self.repo
        result = run_process(
            ["git", *args],
            cwd=location,
            env=os.environ,
            timeout_seconds=timeout,
            max_output_chars=max_output_chars,
        )
        if check and (result.timed_out or result.exit_code != 0):
            raise GitError(
                f"git {' '.join(args)} failed in {location} "
                f"(exit={result.exit_code}, timeout={result.timed_out}):\n{result.stderr or result.stdout}"
            )
        return result.stdout.strip()

    def _git_raw(
        self,
        *args: str,
        cwd: Path | None = None,
        timeout: float = 120,
        check: bool = True,
        max_output_chars: int = 200_000,
    ) -> str:
        location = cwd or self.repo
        result = run_process(
            ["git", *args],
            cwd=location,
            env=os.environ,
            timeout_seconds=timeout,
            max_output_chars=max_output_chars,
        )
        if check and (result.timed_out or result.exit_code != 0):
            raise GitError(
                f"git {' '.join(args)} failed in {location} "
                f"(exit={result.exit_code}, timeout={result.timed_out}):\n{result.stderr or result.stdout}"
            )
        return result.stdout

    def validate_repo(self) -> None:
        if not self.repo.exists():
            raise GitError(f"target repository does not exist: {self.repo}")
        inside = self._git("rev-parse", "--is-inside-work-tree")
        if inside != "true":
            raise GitError(f"target is not a Git working tree: {self.repo}")
        self._git("rev-parse", "--verify", f"{self.config.project.base_ref}^{{commit}}")

    def ensure_integration(self) -> Path:
        self.validate_repo()
        if (self.integration / ".git").exists():
            self._integration_is_new = False
            self._git("status", "--porcelain", cwd=self.integration)
            return self.integration
        if self.integration.exists() and any(self.integration.iterdir()):
            raise GitError(f"integration worktree path is non-empty: {self.integration}")
        self.integration.parent.mkdir(parents=True, exist_ok=True)
        branch = self.config.project.integration_branch
        existing = self._git("show-ref", "--verify", f"refs/heads/{branch}", check=False)
        self._integration_is_new = not bool(existing)
        if not existing:
            self._git("branch", branch, self.config.project.base_ref)
        self._git("worktree", "add", str(self.integration), branch, timeout=300)
        return self.integration

    def ensure_shared_browser_runtime(self) -> str | None:
        """Seed the canonical browser runtime into a new target integration."""

        source_root = self.config.root / "adapters" / "playwright"
        source_runtime = source_root / "runtime.js"
        source_modules = source_root / "runtime"
        source_server = source_root / "server.js"
        source_bridge = source_root / "target-bridge.example.js"
        if (
            not source_runtime.is_file()
            or not source_modules.is_dir()
            or not source_server.is_file()
            or not source_bridge.is_file()
        ):
            return None

        if not self._integration_is_new:
            return None
        if self._git("status", "--porcelain", cwd=self.integration):
            raise GitError("integration worktree is dirty before shared browser runtime bootstrap")
        target_runtime = self.integration / "runtime.js"
        target_modules = self.integration / "runtime"
        target_server = self.integration / "server.js"
        target_bridge = self.integration / "target-bridge.js"
        target_harness = self.integration / "harness.html"
        existing_targets = [
            path
            for path in (
                target_runtime,
                target_modules,
                target_server,
                target_bridge,
                target_harness,
            )
            if path.exists() or path.is_symlink()
        ]
        if existing_targets and len(existing_targets) != 5:
            paths = ", ".join(str(path.relative_to(self.integration)) for path in existing_targets)
            raise GitError(
                "new integration contains partial shared browser runtime paths; "
                f"refusing to overwrite target-owned content: {paths}"
            )

        changed = link_shared_runtime(
            source_root,
            self.integration,
            backup_root=self.config.project.state_dir / "runtime-link-backups" / self.integration.name,
        )
        if not target_bridge.is_file():
            shutil.copy2(source_bridge, target_bridge)
        if not target_harness.is_file():
            target_harness.write_text(
                "<!DOCTYPE html>\n"
                "<html>\n"
                "<head><meta charset=\"utf-8\"></head>\n"
                "<body>\n"
                "<script type=\"module\" src=\"./target-bridge.js\"></script>\n"
                "</body>\n"
                "</html>\n",
                encoding="utf-8",
            )
        if not changed and existing_targets:
            return None
        self._git(
            "add",
            "harness.html",
            "runtime.js",
            "runtime",
            "server.js",
            "target-bridge.js",
            cwd=self.integration,
            timeout=300,
        )
        return self.commit_integration("bnh: seed shared browser runtime")

    def head(self, worktree: Path | None = None) -> str:
        return self._git("rev-parse", "HEAD", cwd=worktree or self.integration)

    def workspace_identity(self, worktree: Path | None = None) -> str:
        return worktree_snapshot_identity(worktree or self.integration)

    def is_clean(self, worktree: Path) -> bool:
        return not bool(self._git("status", "--porcelain", cwd=worktree))

    def reset_worktree(self, worktree: Path, commit: str) -> None:
        """Discard an interrupted agent attempt before restarting it."""

        self._git("reset", "--hard", commit, cwd=worktree)
        self._git("clean", "-fd", cwd=worktree, check=False)

    def create_agent_worktree(self, name: str, base_commit: str) -> Path:
        path = self.agents_root / name
        # An interrupted process can leave Git's registration behind after the
        # worktree directory has disappeared. Prune before reusing attempt IDs.
        self._git("worktree", "prune", check=False)
        if path.exists():
            self.remove_worktree(path)
        self._git("worktree", "add", "--detach", str(path), base_commit, timeout=300)
        return path

    def remove_worktree(self, path: Path) -> None:
        self._git("worktree", "remove", "--force", str(path), timeout=300, check=False)
        if path.exists():
            shutil.rmtree(path, ignore_errors=True)
        self._git("worktree", "prune", check=False)

    def collect_patch(
        self,
        *,
        worktree: Path,
        base_commit: str,
        attempt_id: str,
        validation: ValidationConfig,
    ) -> PatchInfo:
        context = worktree / ".bnh-context"
        self._git("reset", "--quiet", base_commit, "--", ".bnh-context", cwd=worktree, check=False)

        raw_untracked = self._git_raw("ls-files", "--others", "--exclude-standard", "-z", cwd=worktree)
        untracked = [item for item in raw_untracked.split("\0") if item and not item.startswith(".bnh-context/")]
        if untracked:
            self._git("add", "-N", "--", *untracked, cwd=worktree, timeout=300)

        changed_raw = self._git_raw("diff", "--name-only", "-z", base_commit, cwd=worktree)
        changed_files = tuple(item for item in changed_raw.split("\0") if item and not item.startswith(".bnh-context/"))
        patch_path = self.patches_root / f"{attempt_id}.patch"
        patch_text = self._git_raw(
            "diff",
            "--binary",
            "--full-index",
            base_commit,
            "--",
            ".",
            ":(exclude).bnh-context/**",
            cwd=worktree,
            timeout=300,
            max_output_chars=max(validation.max_patch_bytes * 2, 2_000_000),
        )
        patch_path.write_text(patch_text, encoding="utf-8")
        patch_bytes = patch_path.stat().st_size
        sha = hashlib.sha256(patch_path.read_bytes()).hexdigest() if patch_bytes else ""
        stat = self._git("diff", "--stat", base_commit, cwd=worktree, check=False)

        reason = ""
        if not changed_files or patch_bytes == 0:
            reason = "agent produced no patch"
        elif patch_bytes > validation.max_patch_bytes:
            reason = f"patch is {patch_bytes} bytes; limit is {validation.max_patch_bytes}"
        elif len(changed_files) > validation.max_changed_files:
            reason = f"patch changes {len(changed_files)} files; limit is {validation.max_changed_files}"
        else:
            import fnmatch

            forbidden = [
                path
                for path in changed_files
                if any(fnmatch.fnmatch(path, pattern) for pattern in validation.forbidden_globs)
            ]
            if forbidden:
                reason = "patch changes forbidden paths: " + ", ".join(forbidden[:8])
            else:
                added_lines = "\n".join(
                    line[1:]
                    for line in patch_text.splitlines()
                    if line.startswith("+") and not line.startswith("+++")
                )
                marker = next(
                    (value for value in _HARNESS_CONTROL_MARKERS if value in added_lines),
                    None,
                )
                if marker is not None:
                    reason = f"patch contains harness control marker: {marker}"
                else:
                    check = self._git("diff", "--check", base_commit, cwd=worktree, check=False)
                    if check:
                        reason = f"git diff --check failed:\n{check}"

        if context.exists():
            # Context is deliberately left for post-mortem inspection until worktree cleanup.
            pass
        return PatchInfo(
            path=patch_path,
            sha256=sha,
            size_bytes=patch_bytes,
            changed_files=changed_files,
            diff_stat=stat,
            valid=not reason,
            rejection_reason=reason,
        )

    def has_staged_changes(self) -> bool:
        result = run_process(
            ["git", "diff", "--cached", "--quiet"],
            cwd=self.integration,
            env=os.environ,
            timeout_seconds=60,
        )
        return result.exit_code == 1

    def has_unstaged_tracked_changes(self) -> bool:
        result = run_process(
            ["git", "diff", "--quiet"],
            cwd=self.integration,
            env=os.environ,
            timeout_seconds=60,
        )
        return result.exit_code == 1

    def apply_patch(self, patch: Path) -> None:
        if not self.is_clean(self.integration):
            raise GitError("integration worktree is dirty before patch application")
        self._git("apply", "--index", "--3way", str(patch), cwd=self.integration, timeout=300)

    def rollback_integration(self) -> None:
        self._git("reset", "--hard", "HEAD", cwd=self.integration, timeout=300, check=False)
        self._git("clean", "-fd", cwd=self.integration, timeout=300, check=False)

    def commit_integration(self, message: str) -> str:
        self._git(
            "-c",
            "user.name=Nacelle Harness",
            "-c",
            "user.email=browser-node-harness@localhost",
            "commit",
            "-m",
            message,
            cwd=self.integration,
            timeout=300,
        )
        return self.head(self.integration)
