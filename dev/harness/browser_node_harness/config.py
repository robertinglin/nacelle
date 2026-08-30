from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


class ConfigError(ValueError):
    pass


_DEFAULT_INCLUDE = (
    # Mirror Node's testpy JavaScript suites, including ESM tests and the
    # suites whose testcfg uses a non-test-* filename layout.
    "test/*/test-*.js",
    "test/*/test-*.mjs",
    "test/*/test-*.cjs",
    "test/message/*.js",
    "test/message/*.mjs",
    "test/pseudo-tty/*.js",
    "test/pseudo-tty/*.mjs",
    "test/addons/*/*.js",
    "test/addons/*/*.mjs",
    "test/js-native-api/*/*.js",
    "test/js-native-api/*/*.mjs",
    "test/node-api/*/*.js",
    "test/node-api/*/*.mjs",
    "test/sqlite/*/*.js",
    "test/sqlite/*/*.mjs",
)
_DEFAULT_CORE_FEATURES = (
    "globals",
    "console",
    "buffer-encoding",
    "assert",
    "structured-clone",
    "promise-microtasks",
    "abort-signal",
    "event-emitter",
    "error-lifecycle",
    "stdout",
    "stderr",
    "vfs",
    "vfs-io",
    "network",
    "http-fetch",
    "streams",
    "streams-backpressure",
    "workers-communication",
    "ipc",
    "transferables",
    "process",
    "timers",
    "module-loader",
    "crypto",
    "os-platform",
    "diagnostics",
    "compression",
    "wasm",
    "native-boundaries",
)
_DEFAULT_PRIMITIVES = (
    "stdout-stderr",
    "vfs",
    "shell",
    "network",
    "ipc",
    "streams",
    "process",
    "timers",
    "module-loader",
    "globals",
    "console",
    "buffer-encoding",
    "assert",
    "structured-clone",
    "promise-microtasks",
    "abort-signal",
    "event-emitter",
    "uncaught-exception",
    "unhandled-rejection",
    "exit-behavior",
    "data-encoding-serialization",
    "vfs-io",
    "http-fetch",
    "streams-backpressure",
    "workers-communication",
    "system-platform-process",
    "system-platform-module-loading",
    "system-platform-crypto",
    "system-platform-os-platform",
    "system-platform-diagnostics",
    "system-platform-compression",
    "system-platform-wasm",
    "system-platform-unsupported-boundaries",
)


@dataclass(frozen=True, slots=True)
class CommandConfig:
    command: tuple[str, ...]
    cwd: str
    timeout_seconds: float
    env: dict[str, str] = field(default_factory=dict)
    inherit_env: bool = False
    max_output_chars: int = 80_000
    protocol: str = "oneshot"
    proxy: dict[str, Any] | None = None


@dataclass(frozen=True, slots=True)
class ProjectConfig:
    target_repo: Path
    node_repo: Path
    state_dir: Path
    base_ref: str = "HEAD"
    integration_branch: str = "bnh/integration"
    node_binary: str = "node"
    target_repo_url: str | None = None
    target_repo_ref: str = "main"
    node_repo_url: str | None = None
    node_repo_ref: str = "main"
    variant: str = "default"
    variant_base: str | None = None
    available_variants: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class DiscoveryConfig:
    include: tuple[str, ...] = _DEFAULT_INCLUDE
    exclude: tuple[str, ...] = ()
    limit: int = 0
    max_source_chars_in_prompt: int = 24_000


@dataclass(frozen=True, slots=True)
class AgentConfig:
    command: tuple[str, ...]
    cwd: str = "{worktree}"
    prompt_transport: str = "stdin"
    provider: str = ""
    model: str = ""
    core_features: tuple[str, ...] = _DEFAULT_CORE_FEATURES
    timeout_seconds: float = 1_800
    env: dict[str, str] = field(default_factory=dict)
    inherit_env: bool = True
    max_output_chars: int = 200_000




@dataclass(frozen=True, slots=True)
class WorkspaceConfig:
    setup: CommandConfig | None = None

@dataclass(frozen=True, slots=True)
class LoopConfig:
    workers: int = 2
    target_concurrency: int = 2
    scan_failure_limit: int = 12
    scan_timeout_seconds: float = 15.0
    queue_depth: int = 12
    batch_size: int = 2
    guard_tests: int = 12
    mutation_tests: int = 1
    max_iterations: int = 0
    stall_iterations: int = 5
    refresh_all_every: int = 5
    random_seed: int = 7
    accept_partial: bool = True
    max_attempts_per_test: int = 0


@dataclass(frozen=True, slots=True)
class ValidationConfig:
    max_patch_bytes: int = 1_500_000
    max_changed_files: int = 80
    forbidden_globs: tuple[str, ...] = ()
    require_source_override: bool = True
    check: CommandConfig | None = None


@dataclass(frozen=True, slots=True)
class PrimitiveConfig:
    enabled: bool = False
    items: tuple[str, ...] = _DEFAULT_PRIMITIVES
    max_rounds: int = 3


@dataclass(frozen=True, slots=True)
class HarnessConfig:
    path: Path
    project: ProjectConfig
    discovery: DiscoveryConfig
    target: CommandConfig
    oracle: CommandConfig | None
    agent: AgentConfig
    workspace: WorkspaceConfig
    loop: LoopConfig
    validation: ValidationConfig
    primitives: PrimitiveConfig = field(default_factory=PrimitiveConfig)

    @property
    def root(self) -> Path:
        return self.path.parent


def _as_table(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ConfigError(f"[{name}] must be a TOML table")
    return value


def _as_str_tuple(value: Any, name: str, default: tuple[str, ...] = ()) -> tuple[str, ...]:
    if value is None:
        return default
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ConfigError(f"{name} must be an array of strings")
    return tuple(value)


def _resolve_path(base: Path, raw: str, name: str) -> Path:
    if not isinstance(raw, str) or not raw:
        raise ConfigError(f"{name} must be a non-empty path string")
    expanded = Path(os.path.expandvars(os.path.expanduser(raw)))
    if not expanded.is_absolute():
        expanded = base / expanded
    return expanded.resolve()


def _command(table: dict[str, Any], name: str, *, default_cwd: str, required: bool = True) -> CommandConfig | None:
    raw = table.get("command")
    if raw is None and not required:
        return None
    command = _as_str_tuple(raw, f"{name}.command")
    if not command:
        raise ConfigError(f"{name}.command cannot be empty")
    cwd = table.get("cwd", default_cwd)
    if not isinstance(cwd, str):
        raise ConfigError(f"{name}.cwd must be a string")
    env = table.get("env", {})
    if not isinstance(env, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in env.items()):
        raise ConfigError(f"{name}.env must be a string-to-string table")
    protocol = str(table.get("protocol", "oneshot"))
    if protocol not in {"oneshot", "jsonl"}:
        raise ConfigError(f"{name}.protocol must be oneshot or jsonl")
    proxy = table.get("proxy")
    if proxy is not None and not isinstance(proxy, dict):
        raise ConfigError(f"{name}.proxy must be a TOML table")
    return CommandConfig(
        command=command,
        cwd=cwd,
        timeout_seconds=float(table.get("timeout_seconds", 120)),
        env=dict(env),
        inherit_env=bool(table.get("inherit_env", False)),
        max_output_chars=int(table.get("max_output_chars", 80_000)),
        protocol=protocol,
        proxy=dict(proxy) if proxy is not None else None,
    )


def load_config(path: str | Path, *, variant: str | None = None) -> HarnessConfig:
    config_path = Path(path).expanduser().resolve()
    with config_path.open("rb") as handle:
        data = tomllib.load(handle)

    version = data.get("version", 1)
    if version != 1:
        raise ConfigError(f"unsupported config version: {version!r}")

    base = config_path.parent
    project_raw = _as_table(data.get("project", {}), "project")
    variants_raw = data.get("variants", {})
    if not isinstance(variants_raw, dict) or not all(
        isinstance(name, str) and isinstance(value, dict)
        for name, value in variants_raw.items()
    ):
        raise ConfigError("variants must be a table of variant tables")
    configured_variants = tuple(variants_raw)
    selected_variant = variant or str(project_raw.get("default_variant", "default"))
    if configured_variants and selected_variant not in variants_raw:
        available = ", ".join(configured_variants)
        raise ConfigError(f"unknown variant {selected_variant!r}; choose one of: {available}")
    if not configured_variants and selected_variant != "default":
        raise ConfigError("--variant requires a [variants.<name>] entry in the config")

    base_ref = str(project_raw.get("base_ref", "HEAD"))
    integration_branch = str(project_raw.get("integration_branch", "bnh/integration"))
    node_repo_ref = str(project_raw.get("node_repo_ref", "main"))
    target_repo_ref = str(project_raw.get("target_repo_ref", "main"))
    variant_base: str | None = None
    if configured_variants:
        variant_raw = _as_table(variants_raw[selected_variant], f"variants.{selected_variant}")
        node_repo_ref = str(variant_raw.get("node_ref", node_repo_ref))
        target_ref = str(
            variant_raw.get(
                "target_ref",
                node_repo_ref if project_raw.get("target_repo_url") else target_repo_ref,
            )
        )
        target_repo_ref = target_ref
        variant_base_raw = variant_raw.get("base_variant")
        if variant_base_raw is not None:
            variant_base = str(variant_base_raw)
            if variant_base not in variants_raw:
                raise ConfigError(
                    f"variants.{selected_variant}.base_variant refers to unknown variant {variant_base!r}"
                )
            base_variant_raw = _as_table(variants_raw[variant_base], f"variants.{variant_base}")
            base_ref = str(
                base_variant_raw.get(
                    "target_branch",
                    f"{integration_branch}-{variant_base}",
                )
            )
        else:
            base_ref = str(
                variant_raw.get(
                    "base_ref",
                    target_ref if project_raw.get("target_repo_url") else base_ref,
                )
            )
        integration_branch = str(
            variant_raw.get("target_branch", f"{integration_branch}-{selected_variant}")
        )

    def project_path(name: str, default: str) -> Path:
        raw = project_raw.get(name, default)
        if not isinstance(raw, str):
            raise ConfigError(f"project.{name} must be a non-empty path string")
        return _resolve_path(base, raw.replace("{variant}", selected_variant), f"project.{name}")

    project = ProjectConfig(
        target_repo=project_path("target_repo", ""),
        node_repo=project_path("node_repo", ""),
        state_dir=project_path("state_dir", ".bnh-state"),
        base_ref=base_ref,
        integration_branch=integration_branch,
        node_binary=str(project_raw.get("node_binary", "node")),
        target_repo_url=(str(project_raw["target_repo_url"]) if project_raw.get("target_repo_url") else None),
        target_repo_ref=target_repo_ref,
        node_repo_url=(str(project_raw["node_repo_url"]) if project_raw.get("node_repo_url") else None),
        node_repo_ref=node_repo_ref,
        variant=selected_variant,
        variant_base=variant_base,
        available_variants=configured_variants,
    )

    discovery_raw = _as_table(data.get("discovery", {}), "discovery")
    discovery = DiscoveryConfig(
        include=_as_str_tuple(discovery_raw.get("include"), "discovery.include", _DEFAULT_INCLUDE),
        exclude=_as_str_tuple(discovery_raw.get("exclude"), "discovery.exclude"),
        limit=int(discovery_raw.get("limit", 0)),
        max_source_chars_in_prompt=int(discovery_raw.get("max_source_chars_in_prompt", 24_000)),
    )

    target_raw = _as_table(data.get("target", {}), "target")
    target = _command(target_raw, "target", default_cwd="{worktree}")
    assert target is not None

    oracle_raw = data.get("oracle")
    oracle: CommandConfig | None = None
    if oracle_raw is not None:
        oracle_table = _as_table(oracle_raw, "oracle")
        if bool(oracle_table.get("enabled", True)):
            oracle = _command(oracle_table, "oracle", default_cwd="{node_repo}")

    agent_raw = _as_table(data.get("agent", {}), "agent")
    agent_command = _as_str_tuple(agent_raw.get("command"), "agent.command")
    if not agent_command:
        raise ConfigError("agent.command cannot be empty")
    agent_env = agent_raw.get("env", {})
    if not isinstance(agent_env, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in agent_env.items()):
        raise ConfigError("agent.env must be a string-to-string table")
    prompt_transport = str(agent_raw.get("prompt_transport", "stdin"))
    if prompt_transport not in {"stdin", "argument", "file"}:
        raise ConfigError("agent.prompt_transport must be stdin, argument, or file")
    agent = AgentConfig(
        command=agent_command,
        cwd=str(agent_raw.get("cwd", "{worktree}")),
        prompt_transport=prompt_transport,
        provider=str(agent_raw.get("provider", "")),
        model=str(agent_raw.get("model", "")),
        core_features=_as_str_tuple(
            agent_raw.get("core_features"),
            "agent.core_features",
            _DEFAULT_CORE_FEATURES,
        ),
        timeout_seconds=float(agent_raw.get("timeout_seconds", 1_800)),
        env=dict(agent_env),
        inherit_env=bool(agent_raw.get("inherit_env", True)),
        max_output_chars=int(agent_raw.get("max_output_chars", 200_000)),
    )

    workspace_raw = _as_table(data.get("workspace", {}), "workspace")
    workspace_setup = None
    if "setup" in workspace_raw:
        workspace_setup = _command(
            _as_table(workspace_raw["setup"], "workspace.setup"),
            "workspace.setup",
            default_cwd="{worktree}",
        )
        if workspace_setup is not None and workspace_setup.protocol != "oneshot":
            raise ConfigError("workspace.setup.protocol must be oneshot")
    workspace = WorkspaceConfig(setup=workspace_setup)

    loop_raw = _as_table(data.get("loop", {}), "loop")
    loop = LoopConfig(
        workers=max(1, int(loop_raw.get("workers", 2))),
        target_concurrency=max(1, int(loop_raw.get("target_concurrency", 2))),
        scan_failure_limit=max(0, int(loop_raw.get("scan_failure_limit", 12))),
        scan_timeout_seconds=max(1.0, float(loop_raw.get("scan_timeout_seconds", 15.0))),
        queue_depth=max(1, int(loop_raw.get("queue_depth", 12))),
        batch_size=max(1, int(loop_raw.get("batch_size", 2))),
        guard_tests=max(0, int(loop_raw.get("guard_tests", 12))),
        mutation_tests=max(0, int(loop_raw.get("mutation_tests", 1))),
        max_iterations=max(0, int(loop_raw.get("max_iterations", 0))),
        stall_iterations=max(1, int(loop_raw.get("stall_iterations", 5))),
        refresh_all_every=max(1, int(loop_raw.get("refresh_all_every", 5))),
        random_seed=int(loop_raw.get("random_seed", 7)),
        accept_partial=bool(loop_raw.get("accept_partial", True)),
        max_attempts_per_test=max(0, int(loop_raw.get("max_attempts_per_test", 0))),
    )

    validation_raw = _as_table(data.get("validation", {}), "validation")
    check = None
    if "check" in validation_raw:
        check = _command(_as_table(validation_raw["check"], "validation.check"), "validation.check", default_cwd="{worktree}")
        if check is not None and check.protocol != "oneshot":
            raise ConfigError("validation.check.protocol must be oneshot")
    validation = ValidationConfig(
        max_patch_bytes=max(1, int(validation_raw.get("max_patch_bytes", 1_500_000))),
        max_changed_files=max(1, int(validation_raw.get("max_changed_files", 80))),
        forbidden_globs=_as_str_tuple(validation_raw.get("forbidden_globs"), "validation.forbidden_globs"),
        require_source_override=bool(validation_raw.get("require_source_override", True)),
        check=check,
    )

    primitives_raw = _as_table(data.get("primitives", {}), "primitives")
    primitives = PrimitiveConfig(
        enabled=bool(primitives_raw.get("enabled", False)),
        items=_as_str_tuple(primitives_raw.get("items"), "primitives.items", _DEFAULT_PRIMITIVES),
        max_rounds=max(1, int(primitives_raw.get("max_rounds", 3))),
    )

    return HarnessConfig(
        path=config_path,
        project=project,
        discovery=discovery,
        target=target,
        oracle=oracle,
        agent=agent,
        workspace=workspace,
        loop=loop,
        validation=validation,
        primitives=primitives,
    )
