from __future__ import annotations

import json
import os
import re
import threading
from pathlib import Path
from collections.abc import Callable, Mapping

from .config import HarnessConfig
from .models import AgentRun, Task, TestResult
from .process import render, render_argv, run_process, sanitized_environment
from .prompting import prepare_task_context


def run_agent(
    *,
    config: HarnessConfig,
    worktree: Path,
    task: Task,
    failures: Mapping[str, TestResult | Mapping | None],
    previous_attempts: list[Mapping],
    run_id: str,
    iteration: int,
    attempt_dir: Path,
    model_offset: int = 0,
    on_metadata: Callable[..., None] | None = None,
    control_action: Callable[[], str | None] | None = None,
    clear_control_action: Callable[[], None] | None = None,
    on_restart: Callable[[], None] | None = None,
) -> AgentRun:
    prompt_path, prompt = prepare_task_context(
        config=config,
        worktree=worktree,
        task=task,
        failures=failures,
        previous_attempts=previous_attempts,
    )
    mapping = {
        "config": str(config.path),
        "config_dir": str(config.root),
        "target_repo": str(config.project.target_repo),
        "node_repo": str(config.project.node_repo),
        "state_dir": str(config.project.state_dir),
        "worktree": str(worktree),
        "prompt_file": str(prompt_path),
        "prompt": prompt,
        "task_id": task.task_id,
        "run_id": run_id,
        "iteration": str(iteration),
    }
    argv = render_argv(config.agent.command, mapping)
    cwd = Path(render(config.agent.cwd, mapping)).resolve()
    env = sanitized_environment(
        inherit=config.agent.inherit_env,
        extra=config.agent.env,
        mapping=mapping,
    )
    # The agent runs from a detached Node worktree, not from the harness
    # checkout. Keep the generated reproduction runner importable even when a
    # user-supplied agent configuration omitted PYTHONPATH.
    harness_src = (config.root / "src").resolve()
    existing_pythonpath = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = (
        str(harness_src)
        if not existing_pythonpath
        else str(harness_src) + os.pathsep + existing_pythonpath
    )
    env.update(
        {
            "BNH_TASK_ID": task.task_id,
            "BNH_TASK_FILE": str(worktree / ".bnh-context" / "task.json"),
            "BNH_CONFIG": str(config.path),
            "BNH_AGENT_METADATA_FILE": str(attempt_dir / "agent-metadata.json"),
            "BNH_AGENT_ATTEMPT_ID": attempt_dir.name,
            "BNH_OPENCODE_MODEL_OFFSET": str(model_offset),
        }
    )
    stdin_text = prompt if config.agent.prompt_transport == "stdin" else None
    attempt_dir.mkdir(parents=True, exist_ok=True)
    stdout_path = attempt_dir / "agent.stdout.log"
    stderr_path = attempt_dir / "agent.stderr.log"
    output_path = attempt_dir / "agent.output.log"
    output_lock = threading.Lock()
    provider = config.agent.provider or Path(config.agent.command[0]).name
    model = config.agent.model or str(config.agent.env.get("BNH_AGENT_MODEL", "configured"))
    restart_count = 0
    all_stdout: list[str] = []
    all_stderr: list[str] = []

    def notify(**fields: object) -> None:
        if on_metadata is not None:
            on_metadata(
                provider=nonlocal_provider[0],
                model=nonlocal_model[0],
                restart_count=restart_count,
                **fields,
            )

    def output(stream: str, text: str) -> None:
        target = stdout_path if stream == "stdout" else stderr_path
        with output_lock:
            with target.open("a", encoding="utf-8") as handle:
                handle.write(text)
            with output_path.open("a", encoding="utf-8") as handle:
                handle.write(text)
        (all_stdout if stream == "stdout" else all_stderr).append(text)
        if stream == "stderr":
            match = re.search(r"bnh-opencode: trying ([^ ]+)", text)
            if match:
                provider, model_id = match.group(1).split("/", 1)
                nonlocal_provider[0] = provider
                nonlocal_model[0] = model_id
                notify(status="running")

    nonlocal_provider = [provider]
    nonlocal_model = [model]

    def current_metadata() -> None:
        nonlocal provider, model
        provider, model = nonlocal_provider[0], nonlocal_model[0]
        metadata_path = attempt_dir / "agent-metadata.json"
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        if isinstance(metadata, dict):
            provider = str(metadata.get("provider", provider))
            model = str(metadata.get("model", model))
            nonlocal_provider[0] = provider
            nonlocal_model[0] = model

    while True:
        if restart_count:
            separator = f"\n\n===== agent restart {restart_count} =====\n\n"
            with output_lock:
                with stdout_path.open("a", encoding="utf-8") as stdout_handle:
                    stdout_handle.write(separator)
                with stderr_path.open("a", encoding="utf-8") as stderr_handle:
                    stderr_handle.write(separator)
                with output_path.open("a", encoding="utf-8") as output_handle:
                    output_handle.write(separator)
        notify(status="running", pid=None)
        result = run_process(
            argv,
            cwd=cwd,
            env=env,
            timeout_seconds=config.agent.timeout_seconds,
            stdin_text=stdin_text,
            max_output_chars=config.agent.max_output_chars,
            on_output=output,
            stop_requested=control_action,
            on_started=lambda pid: notify(status="running", pid=pid),
        )
        current_metadata()
        action = result.termination_reason
        if not action and control_action is not None:
            action = control_action() or ""
        if action == "restart":
            if clear_control_action is not None:
                clear_control_action()
            if on_restart is not None:
                on_restart()
            restart_count += 1
            notify(status="restarting", pid=result.pid)
            continue
        if action == "stop":
            notify(status="stopped", pid=result.pid, finished=True)
            return AgentRun(
                exit_code=result.exit_code,
                timed_out=result.timed_out,
                duration_ms=result.duration_ms,
                stdout="".join(all_stdout),
                stderr="".join(all_stderr),
                summary="agent stopped by dashboard",
                provider=provider,
                model=model,
                pid=result.pid,
                stdout_path=stdout_path,
                stderr_path=stderr_path,
                output_path=output_path,
                control_action="stop",
                stopped=True,
            )
        notify(status="finished", pid=result.pid, finished=True)
        summary_source = result.stdout.strip() or result.stderr.strip()
        return AgentRun(
            exit_code=result.exit_code,
            timed_out=result.timed_out,
            duration_ms=result.duration_ms,
            stdout="".join(all_stdout),
            stderr="".join(all_stderr),
            summary=summary_source[-6_000:],
            provider=provider,
            model=model,
            pid=result.pid,
            stdout_path=stdout_path,
            stderr_path=stderr_path,
            output_path=output_path,
        )
