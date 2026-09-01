# Security model

Nacelle Harness executes four classes of untrusted code:

1. upstream Node.js tests;
2. coding-agent output and any commands the agent runs;
3. target repository setup, build, lint, and development-server commands;
4. the browser-native runtime itself.

Run the harness in a disposable VM, isolated CI worker, or hardened container with only the repositories and credentials it needs. Do not run it on a workstation that contains unrelated source trees, production credentials, browser profiles, SSH agents, cloud metadata access, or sensitive local services.

## Environment handling

Target adapters, workspace setup, and validation commands default to a reduced environment when `inherit_env = false`. The reduced environment retains basic process variables such as `PATH`, `HOME`, temporary directories, locale, and shell values. It is not a complete sandbox.

The sample agent uses `inherit_env = true` because agent CLIs often require authentication. That exposes the inherited environment to the agent process and anything it launches. Prefer a narrowly scoped token, a dedicated machine account, and an outer container/VM boundary. Set explicit `agent.env` values and disable inheritance when your agent CLI supports another credential mechanism.

Do not place secrets in the target repository, harness TOML, prompts, test fixtures, or state directory. Logs and SQLite records retain agent output, command output, test streams, file paths, and failure details.

## Network and filesystem

The harness does not disable network access. Agent sandboxes are advisory defense in depth, not the security boundary for the orchestration process or its validation commands. Upstream tests and the target development server can reach whatever the host permits.

Use operating-system controls to restrict:

- outbound network destinations;
- access to cloud instance metadata;
- mounted directories and Unix sockets;
- Docker or container-engine sockets;
- SSH agents and credential helpers;
- host browsers and user profiles;
- process count, memory, CPU, disk, and wall-clock time.

Nacelle+ is an optional browser extension boundary, not a runtime escape hatch.
It requests host access per page/target-origin pair, omits credentials by
default, limits response bodies, and only handles explicitly granted HTTP
requests. Treat the extension's requested host permissions as sensitive and
review its allowlist before installing it.

The supplied Playwright adapter launches fresh headless browser contexts and a worktree-scoped development server. The browser process and server still run with the host account's permissions.

## Patch validation is not containment

The acceptance gate is designed to catch incorrect and reward-hacking patches. It is not a malware detector. A patch can pass tests and still contain hostile behavior. Review accepted commits before publishing or running them in a less restricted environment.

The harness keeps the target adapter outside the agent worktree, rejects configured forbidden paths, reruns hidden guards, injects randomized source controls, reapplies patches to the current integration head, and checks for validation-time tracked-file mutations. These controls improve result integrity but do not replace code review or isolation.

## Recommended deployment

Use one short-lived worker per harness state directory. Mount only:

- the target Git repository;
- the matching Node source checkout;
- the harness source and configuration;
- a writable state directory;
- the minimum credential needed by the selected coding-agent service.

Run as a non-root user. Apply CPU, memory, process, file-size, disk, and execution-time limits. Destroy the worker after exporting the integration branch, patches, database, and logs needed for review.
