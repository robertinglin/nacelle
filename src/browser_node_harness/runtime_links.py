"""Safely connect target worktrees to the shared browser runtime."""

from __future__ import annotations

import argparse
import filecmp
import os
import sys
from pathlib import Path


class RuntimeLinkError(RuntimeError):
    """Raised when a runtime link would overwrite different target content."""


def integration_directory(state_dir: Path, variant: str) -> Path:
    """Return the configured integration worktree path for a variant."""

    safe_variant = "".join(
        character if character.isalnum() or character in "-_." else "-"
        for character in variant
    )
    name = "integration" if safe_variant == "default" else f"integration-{safe_variant}"
    return state_dir / "worktrees" / name


def _entry_kind(path: Path) -> str | None:
    if path.is_symlink():
        return "symlink"
    if path.is_file():
        return "file"
    if path.is_dir():
        return "directory"
    if path.exists():
        return "other"
    return None


def _tree_entries(root: Path) -> list[tuple[str, str, str | None]]:
    entries: list[tuple[str, str, str | None]] = []
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        if path.is_symlink():
            entries.append((relative, "symlink", os.readlink(path)))
        elif path.is_dir():
            entries.append((relative, "directory", None))
        elif path.is_file():
            entries.append((relative, "file", None))
        else:
            entries.append((relative, "other", None))
    return entries


def _target_content_matches_source(source: Path, target: Path) -> bool:
    source_kind = _entry_kind(source)
    target_kind = _entry_kind(target)
    if source_kind != target_kind:
        return False
    if source_kind == "file":
        return filecmp.cmp(source, target, shallow=False)
    if source_kind != "directory":
        return source_kind == "symlink" and os.readlink(source) == os.readlink(target)
    source_entries = {relative: (kind, link) for relative, kind, link in _tree_entries(source)}
    for relative, kind, link in _tree_entries(target):
        if source_entries.get(relative) != (kind, link):
            return False
        path = target / relative
        if path.is_file() and not path.is_symlink():
            if not filecmp.cmp(source / relative, path, shallow=False):
                return False
    return True


def _expected_link(source: Path, target: Path) -> str:
    return os.path.relpath(source, start=target.parent)


def _has_expected_link(source: Path, target: Path) -> bool:
    return target.is_symlink() and os.path.normpath(os.readlink(target)) == os.path.normpath(
        _expected_link(source, target)
    )


def _resolves_to_source(source: Path, target: Path) -> bool:
    return target.is_symlink() and target.resolve() == source.resolve()


def _backup_name(target: Path, backup_root: Path) -> Path:
    candidate = backup_root / target.name
    suffix = 1
    while candidate.exists() or candidate.is_symlink():
        candidate = backup_root / f"{target.name}.{suffix}"
        suffix += 1
    return candidate


def _link_path(source: Path, target: Path, *, backup_root: Path | None) -> bool:
    if _has_expected_link(source, target):
        return False
    backup_path: Path | None = None
    if target.exists() or target.is_symlink():
        if not _resolves_to_source(source, target) and not _target_content_matches_source(source, target):
            raise RuntimeLinkError(
                f"refusing to replace different target content at {target}; "
                f"compare it with {source} before linking"
            )
        if backup_root is None:
            raise RuntimeLinkError(
                f"target content already exists at {target}; "
                "a backup directory is required before linking it"
            )
        backup_root.mkdir(parents=True, exist_ok=True)
        backup_path = _backup_name(target, backup_root)
        target.rename(backup_path)
    try:
        target.symlink_to(_expected_link(source, target))
    except OSError:
        if backup_path is not None:
            backup_path.rename(target)
        raise
    return True


def link_shared_runtime(
    source_root: Path,
    target_root: Path,
    *,
    backup_root: Path | None = None,
) -> tuple[Path, ...]:
    """Link shared runtime files and the target server to the adapter copy."""

    source_root = source_root.resolve()
    target_root = target_root.resolve()
    source_entry = source_root / "runtime.js"
    source_modules = source_root / "runtime"
    source_server = source_root / "server.js"
    target_entry = target_root / "runtime.js"
    target_modules = target_root / "runtime"
    target_server = target_root / "server.js"
    if not source_entry.is_file() or not source_modules.is_dir():
        raise RuntimeLinkError(f"shared browser runtime is incomplete under {source_root}")
    if not target_root.is_dir():
        raise RuntimeLinkError(f"target integration directory does not exist: {target_root}")
    if source_root == target_root:
        raise RuntimeLinkError("source and target runtime directories must be different")

    entries = [(source_entry, target_entry), (source_modules, target_modules)]
    if source_server.is_file():
        entries.append((source_server, target_server))
    for source, target in entries:
        if target.exists() or target.is_symlink():
            if (
                not _has_expected_link(source, target)
                and not _resolves_to_source(source, target)
                and not _target_content_matches_source(source, target)
            ):
                raise RuntimeLinkError(
                    f"refusing to replace different target content at {target}; "
                    f"compare it with {source} before linking"
                )

    changed: list[Path] = []
    for source, target in entries:
        if _link_path(source, target, backup_root=backup_root):
            changed.append(target)
    return tuple(changed)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Link an integration worktree to the shared runtime and server."
    )
    parser.add_argument(
        "--source-root",
        type=Path,
        help="adapter directory containing runtime.js, runtime/, and optionally server.js (default: adapters/playwright)",
    )
    parser.add_argument(
        "--integration",
        type=Path,
        help="integration worktree to update (default: .bnh-state/<variant>/worktrees/integration-<variant>)",
    )
    parser.add_argument("--config", type=Path, default=Path("harness.toml"))
    parser.add_argument("--variant", default="v22")
    parser.add_argument(
        "--backup-dir",
        type=Path,
        help="directory for matching regular runtime copies replaced by links",
    )
    return parser


def main(argv: list[str] | None = None, *, project_root: Path | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    root = (project_root or Path(__file__).resolve().parents[2]).resolve()
    try:
        if args.source_root is None:
            source_root = root / "adapters" / "playwright"
        else:
            source_root = args.source_root
            if not source_root.is_absolute():
                source_root = root / source_root

        if args.integration is None:
            from .config import load_config

            config_path = root / args.config if not args.config.is_absolute() else args.config
            config = load_config(config_path, variant=args.variant)
            target_root = integration_directory(config.project.state_dir, config.project.variant)
        else:
            target_root = args.integration
            if not target_root.is_absolute():
                target_root = root / target_root

        backup_root = args.backup_dir
        if backup_root is None:
            backup_root = root / ".bnh-state" / "runtime-link-backups" / target_root.name
        elif not backup_root.is_absolute():
            backup_root = root / backup_root
        changed = link_shared_runtime(source_root, target_root, backup_root=backup_root)
    except (OSError, RuntimeLinkError, ValueError) as error:
        print(f"runtime link failed: {error}", file=sys.stderr)
        return 1

    if changed:
        for path in changed:
            print(f"linked {path}")
    else:
        print(f"runtime links already point to {Path(source_root).resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
