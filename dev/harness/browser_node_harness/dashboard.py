from __future__ import annotations

import json
import os
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from .db import Database


_PAGE = r"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Nacelle Harness</title>
  <style>
    :root { color-scheme: dark; --bg:#0d1117; --panel:#161b22; --line:#30363d; --text:#e6edf3; --muted:#8b949e; --green:#3fb950; --red:#f85149; --yellow:#d29922; --blue:#58a6ff; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font:14px/1.45 system-ui,-apple-system,sans-serif; }
    main { max-width:1500px; margin:0 auto; padding:28px; }
    header { display:flex; justify-content:space-between; align-items:end; gap:20px; margin-bottom:24px; }
    h1,h2 { margin:0; letter-spacing:-.02em; } h1 { font-size:28px; } h2 { font-size:16px; margin-bottom:12px; }
    .section-head { display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:12px; }
    .muted { color:var(--muted); } #updated { color:var(--muted); font-size:12px; text-align:right; }
    .cards { display:grid; grid-template-columns:repeat(8,minmax(100px,1fr)); gap:10px; margin-bottom:18px; }
    .card,.panel { background:var(--panel); border:1px solid var(--line); border-radius:10px; }
    .card { padding:14px; } .card .value { display:block; font-size:26px; font-weight:700; margin-top:4px; }
    .label { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.06em; }
    .pass { color:var(--green); } .fail { color:var(--red); } .warn { color:var(--yellow); } .info { color:var(--blue); }
    .grid { display:grid; grid-template-columns:minmax(0,1.25fr) minmax(360px,.75fr); gap:18px; }
    .panel { padding:16px; margin-bottom:18px; overflow:hidden; } .full { grid-column:1/-1; }
    .run-line { display:flex; flex-wrap:wrap; gap:16px; color:var(--muted); margin-top:8px; }
    table { width:100%; border-collapse:collapse; } th,td { text-align:left; vertical-align:top; padding:9px 8px; border-top:1px solid var(--line); }
    th { color:var(--muted); font-size:12px; font-weight:500; } td { max-width:480px; word-break:break-word; }
    code { color:#c9d1d9; font:12px ui-monospace,SFMono-Regular,monospace; }
    .event { display:grid; grid-template-columns:150px 90px 1fr; gap:10px; padding:8px 0; border-top:1px solid var(--line); }
    .event:first-child { border-top:0; } .event-time { color:var(--muted); font-size:12px; }
    .pill { display:inline-block; padding:2px 7px; border:1px solid var(--line); border-radius:999px; font-size:12px; }
    .empty { color:var(--muted); padding:14px 0; }
    .agent-card { border-top:1px solid var(--line); padding:12px 0; } .agent-card:first-child { border-top:0; }
    .agent-head { display:flex; justify-content:space-between; gap:12px; align-items:start; }
    .agent-name { font-weight:700; } .agent-tests { color:var(--muted); font-size:12px; margin-top:4px; }
    button { background:transparent; color:var(--text); border:1px solid var(--line); border-radius:6px; padding:4px 8px; cursor:pointer; }
    button:hover { border-color:var(--blue); color:var(--blue); } button.danger:hover { border-color:var(--red); color:var(--red); }
    #events { max-height:520px; overflow:auto; padding-right:4px; }
    pre { white-space:pre-wrap; max-height:260px; overflow:auto; background:#0d1117; border:1px solid var(--line); border-radius:6px; padding:10px; color:#c9d1d9; font:12px/1.4 ui-monospace,SFMono-Regular,monospace; }
    @media (max-width:900px) { main { padding:16px; } .cards { grid-template-columns:repeat(4,1fr); } .grid { grid-template-columns:1fr; } }
    @media (max-width:560px) { .cards { grid-template-columns:repeat(2,1fr); } header { display:block; } #updated { text-align:left; margin-top:8px; } .event { grid-template-columns:1fr; gap:2px; } }
  </style>
</head>
<body>
<main>
  <header>
    <div><h1>Nacelle Harness</h1><div id="run-line" class="run-line">Waiting for a run…</div></div>
    <div id="updated">Connecting…</div>
  </header>
  <section id="cards" class="cards"></section>
  <div class="grid">
    <section class="panel"><h2>What is happening</h2><div id="events" data-autoscroll></div></section>
    <section class="panel"><h2>Active agents</h2><div id="active"></div></section>
    <section class="panel"><h2>Active test runners</h2><div id="runners"></div></section>
    <section class="panel full"><h2>Proof scope</h2><div id="scope"></div></section>
    <section class="panel full"><h2>Target regressions</h2><div id="target-results"></div></section>
    <section class="panel full"><h2>Live process output</h2><div id="agent-output"></div></section>
    <section class="panel full"><div class="section-head"><h2>Recent agent attempts</h2><button id="clear-attempts">Clear</button></div><div id="attempts"></div></section>
    <section class="panel"><h2>Accepted patches</h2><div id="merges"></div></section>
    <section class="panel"><h2>Failure clusters</h2><div id="clusters"></div></section>
    <section class="panel full"><h2>Open gaps</h2><div id="gaps"></div></section>
  </div>
</main>
<script>
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const empty = text => `<div class="empty">${esc(text)}</div>`;
const pill = (text, cls='') => `<span class="pill ${cls}">${esc(text)}</span>`;
const providerLabel = agent => agent.provider === 'nvidia' ? 'opencode → nvidia' : agent.provider;
const fmt = value => value ? new Date(value).toLocaleTimeString() : '—';
const scrollState = new Map();
let hiddenAttemptKey = '';
let hiddenAttemptIds = new Set();
function sessionStorageKey(data) {
  const session = data.session || {};
  return `bnh-hidden-attempts:${session.id || data.run?.id || 'default'}`;
}
function loadHiddenAttempts(data) {
  const key = sessionStorageKey(data);
  if (key === hiddenAttemptKey) return;
  hiddenAttemptKey = key;
  try {
    hiddenAttemptIds = new Set(JSON.parse(localStorage.getItem(key) || '[]'));
  } catch (_) {
    hiddenAttemptIds = new Set();
  }
}
function saveHiddenAttempts() {
  localStorage.setItem(hiddenAttemptKey, JSON.stringify([...hiddenAttemptIds]));
}
function rememberScroll() {
  document.querySelectorAll('[data-autoscroll]').forEach(element => {
    scrollState.set(element.id, {
      atBottom: element.scrollHeight - element.scrollTop - element.clientHeight < 24,
      top: element.scrollTop,
    });
  });
}
function restoreScroll() {
  requestAnimationFrame(() => document.querySelectorAll('[data-autoscroll]').forEach(element => {
    const state = scrollState.get(element.id);
    if (!state || state.atBottom) {
      element.scrollTop = element.scrollHeight;
      return;
    }
    element.scrollTop = Math.min(state.top, Math.max(0, element.scrollHeight - element.clientHeight));
  }));
}
function render(data) {
  rememberScroll();
  loadHiddenAttempts(data);
  const s = data.summary || {};
  const cards = [['Entries',s.total,''],['Pass',s.pass,'pass'],['Fail',s.fail,'fail'],['Regressions',s.regression_count,'fail'],['Unknown',s.unknown,'warn'],['Skip',s.skip,'warn'],['Timeout',s.timeout,'warn'],['Infra',s.infra_error,'fail']];
  document.querySelector('#cards').innerHTML = cards.map(([label,value,cls]) => `<div class="card"><span class="label">${label}</span><span class="value ${cls}">${value ?? 0}</span></div>`).join('');
  const run = data.run;
  document.querySelector('#run-line').innerHTML = run ? `${pill(run.status, run.status === 'green' ? 'pass' : run.status === 'running' ? 'info' : 'warn')} <span>variant ${esc(run.variant || 'default')}</span><span>run ${esc(run.id)}</span><span>iteration ${esc(run.iteration)}</span>` : 'No run recorded';
  document.querySelector('#updated').textContent = `Updated ${new Date(data.generated_at).toLocaleTimeString()} · auto-refresh 2s`;

  const scope = data.scope || {};
  const scopeCounts = scope.counts || {};
  const requirements = scope.requirements || [];
  const sourceInventory = scope.source_inventory || {};
  const runnableInventory = scope.runnable_inventory || {};
  const runnableTotal = runnableInventory.total ?? scope.total ?? 0;
  const sourceTestFiles = sourceInventory.source_test_files ?? sourceInventory.test_files;
  const sourceJavaScriptTestFiles = sourceInventory.source_javascript_test_files ?? sourceInventory.javascript_test_files;
  const proofCoverage = scope.proof_coverage || {};
  const scopeMeta = runnableTotal ? `<div class="run-line"><span>${esc(runnableTotal)} runnable harness entries</span><span>${esc(sourceTestFiles ?? '—')} Node test-* source files</span><span>${esc(sourceJavaScriptTestFiles ?? '—')} Node JS/MJS/CJS source files</span><span>${esc(runnableInventory.node_test_file_entries ?? scope.test_file_entries ?? 0)} runnable test-* entries</span><span>${esc(runnableInventory.special_layout_entries ?? scope.special_layout_entries ?? 0)} runnable special-layout entries</span><span>${esc(proofCoverage.categorized_entries ?? runnableTotal)}/${esc(runnableTotal)} entries have proof category + runner</span></div>` : '';
  document.querySelector('#scope').innerHTML = requirements.length ? `${scopeMeta}<table><thead><tr><th>Count</th><th>Category</th><th>Runner</th><th>Required proof</th></tr></thead><tbody>${requirements.map(r => `<tr><td>${esc(scopeCounts[r.kind] || 0)}</td><td>${esc(r.proof_category || r.kind)}</td><td><code>${esc(r.runner)}</code></td><td>${esc(r.proof)}</td></tr>`).join('')}</tbody></table>` : empty('Scope has not been discovered yet.');

  const regressions = data.regressions || [];
  document.querySelector('#target-results').innerHTML = regressions.length ? `<table><thead><tr><th>Test</th><th>Current target</th><th>Prior canonical target</th><th>Regression count</th></tr></thead><tbody>${regressions.map(t => { const prior = t.prior_target_snapshot || {}; return `<tr><td><code>${esc(t.path)}</code><br><span class="muted">${esc(t.suite)}</span></td><td>${pill(t.target_status, 'fail')}<br><span class="muted">latest canonical result</span></td><td>${pill(t.prior_target_status || prior.status || 'unknown', 'pass')}<br><span class="muted">${fmt(prior.created_at)} · ${esc(prior.run_id || 'historical')}</span></td><td class="fail">${esc(t.target_regression_count)}</td></tr>`; }).join('')}</tbody></table>` : empty('No current target regressions.');

  const events = (data.events || []).slice().reverse();
  document.querySelector('#events').innerHTML = events.length ? events.map(e => `<div class="event"><span class="event-time">${fmt(e.created_at)}</span>${pill(e.kind + (e.status !== 'info' ? ' · ' + e.status : ''))}<span>${esc(e.message)}</span></div>`).join('') : empty('The loop has not emitted any events yet.');

  const active = data.active_agents || [];
  document.querySelector('#active').innerHTML = active.length ? active.map(a => `<div class="agent-card"><div class="agent-head"><div><div class="agent-name">${esc(providerLabel(a))}/${esc(a.model)}</div><code>${esc(a.attempt_id)}</code><div class="agent-tests">${esc(a.strategy)} · ${esc((a.assigned_tests || []).join(', '))}</div></div><div><button data-agent-action="restart" data-attempt="${esc(a.attempt_id)}">Restart</button> <button class="danger" data-agent-action="stop" data-attempt="${esc(a.attempt_id)}">Kill</button></div></div><div class="muted">PID ${esc(a.pid || '—')} · iteration ${esc(a.iteration)} · started ${fmt(a.started_at)}</div></div>`).join('') : empty('No agent is running right now.');

  document.querySelectorAll('[data-agent-action]').forEach(button => button.onclick = async () => {
    button.disabled = true;
    await fetch(`/api/agents/${encodeURIComponent(button.dataset.attempt)}/action`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({action:button.dataset.agentAction})});
    setTimeout(refresh, 250);
  });

  const runners = data.active_runners || [];
  document.querySelector('#runners').innerHTML = runners.length ? runners.map(r => `<div class="agent-card"><div class="agent-name">${esc(r.title || 'Test runner')}</div><code>${esc(r.attempt_id)}</code><div class="agent-tests">${esc(r.message || 'running')}</div><div class="muted">iteration ${esc(r.iteration)} · started ${fmt(r.created_at)}</div></div>`).join('') : empty('No oracle or target runner is active.');

  const runnerOutput = runners.map(r => {
    const logId = `runner-log-${String(r.attempt_id).replace(/[^A-Za-z0-9_-]/g, '-')}`;
    return `<div class="agent-card"><div class="agent-name">${esc(r.title || 'Test runner')}</div><div class="muted">runner progress</div><pre id="${logId}" data-autoscroll>${esc(r.message || '(running)')}</pre></div>`;
  });
  const agentOutput = (data.active_agents || []).map(a => {
    const logId = `agent-log-${String(a.attempt_id).replace(/[^A-Za-z0-9_-]/g, '-')}`;
    const label = a.provider === 'nvidia' ? 'OpenCode → NVIDIA NIM output (stdout + stderr)' : a.provider === 'opencode' ? 'OpenCode output (stdout + stderr)' : 'agent output (stdout + stderr)';
    return `<div class="agent-card"><div class="agent-name">${esc(providerLabel(a))}/${esc(a.model)} · ${esc(a.attempt_id)}</div><div class="muted">${label}</div><pre id="${logId}" data-autoscroll>${esc(a.output_tail || '(no output yet)')}</pre></div>`;
  });
  const output = [...runnerOutput, ...agentOutput];
  document.querySelector('#agent-output').innerHTML = output.length ? output.join('') : empty('No live agents or test runners.');

  const allAttempts = data.attempts || [];
  const attempts = allAttempts.filter(a => !hiddenAttemptIds.has(a.id));
  document.querySelector('#clear-attempts').onclick = () => {
    allAttempts.forEach(a => hiddenAttemptIds.add(a.id));
    saveHiddenAttempts();
    render(data);
  };
  document.querySelector('#attempts').innerHTML = attempts.length ? `<table><thead><tr><th>Attempt</th><th>Assigned tests</th><th>Agent</th><th>Patch</th><th>Result</th></tr></thead><tbody>${attempts.map(a => { const tests = JSON.parse(a.assigned_tests_json || '[]'); const files = JSON.parse(a.changed_files_json || '[]'); const pending = !a.accepted && /^candidate passed \d+\/\d+ assigned tests$/.test(a.reason || ''); const result = pending ? pill('pending','warn') : a.accepted ? pill('accepted','pass') : pill('rejected','fail'); return `<tr><td><code>${esc(a.id)}</code><br><span class="muted">${fmt(a.created_at)} · ${esc(a.strategy)}</span></td><td>${tests.length}<br><span class="muted">${esc(tests.slice(0,8).join(', '))}${tests.length > 8 ? '…' : ''}</span></td><td><b>${esc(providerLabel(a))}/${esc(a.model || 'auto')}</b><br>${esc(a.agent_duration_ms)} ms<br><code>${esc((a.agent_summary || '').slice(-500))}</code></td><td>${files.length} file(s)<br>${esc(a.patch_bytes)} bytes</td><td>${result}<br><span class="muted">${esc(a.reason || '')}</span></td></tr>`; }).join('')}</tbody></table>` : empty('No visible agent attempts in this session.');

  const merges = data.merges || [];
  document.querySelector('#merges').innerHTML = merges.length ? `<table><thead><tr><th>Time</th><th>Commit</th><th>Tests</th></tr></thead><tbody>${merges.map(m => { const tests = JSON.parse(m.tests_json || '[]'); return `<tr><td>${fmt(m.created_at)}</td><td><code>${esc(m.commit_sha.slice(0,12))}</code></td><td>${tests.length}<br><span class="muted">${esc(tests.slice(0,2).join(', '))}</span></td></tr>`; }).join('')}</tbody></table>` : empty('No patches accepted yet.');

  const clusters = data.failure_clusters || [];
  document.querySelector('#clusters').innerHTML = clusters.length ? `<table><thead><tr><th>Count</th><th>Suite</th><th>Example</th></tr></thead><tbody>${clusters.map(c => `<tr><td class="fail">${esc(c.count)}</td><td>${esc(c.suite)}</td><td><code>${esc(c.example)}</code><br><span class="muted">${esc(c.failure_fingerprint || 'unknown')}</span></td></tr>`).join('')}</tbody></table>` : empty('No unresolved failure clusters.');

  const gaps = (data.gaps || []).filter(g => g.status === 'open');
  document.querySelector('#gaps').innerHTML = gaps.length ? `<table><thead><tr><th>Affected tests</th><th>Kind</th><th>Module</th><th>Symbols</th><th>Gap</th></tr></thead><tbody>${gaps.map(g => `<tr><td class="fail">${esc(g.affected_count)}</td><td>${esc(g.kind)}</td><td><code>${esc(g.module)}</code></td><td>${esc((g.symbols || []).slice(0,6).join(', '))}${(g.symbols || []).length > 6 ? '…' : ''}</td><td><code>${esc(g.id)}</code></td></tr>`).join('')}</tbody></table>` : empty('No open gaps; run `bnh gaps` to extract them.');
  restoreScroll();
}
async function refresh() { try { const response = await fetch('/api/status', {cache:'no-store'}); if (!response.ok) throw new Error(`${response.status}`); render(await response.json()); } catch (error) { document.querySelector('#updated').textContent = `Dashboard error: ${error}`; } }
refresh(); setInterval(refresh, 2000);
</script>
</body>
</html>"""


def _decode_json(value: str, default: Any) -> Any:
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return default


def _tail_file(path: Path, limit: int = 12_000) -> str:
    try:
        with path.open("rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - limit), os.SEEK_SET)
            return handle.read().decode("utf-8", errors="replace")
    except OSError:
        return ""


def dashboard_snapshot(db: Database, *, variant: str | None = None) -> dict[str, Any]:
    run = db.latest_run() if variant is None else db.latest_run(variant=variant)
    run_id = str(run["id"]) if run else None
    attempts = db.recent_attempts(run_id=run_id)
    session_id = db.get_meta("current_session_id")
    session_started_at = db.get_meta("current_session_started_at")
    if session_started_at:
        attempts = [
            attempt
            for attempt in attempts
            if bool(attempt.get("accepted")) or str(attempt.get("created_at", "")) >= session_started_at
        ]
    for attempt in attempts:
        attempt["assigned_tests"] = _decode_json(attempt.get("assigned_tests_json"), [])
        attempt["changed_files"] = _decode_json(attempt.get("changed_files_json"), [])
    merges = db.recent_merges(run_id=run_id)
    for merge in merges:
        merge["tests"] = _decode_json(merge.get("tests_json"), [])
    active_agents = db.active_agents(run_id=run_id)
    if session_started_at:
        active_agents = [
            agent
            for agent in active_agents
            if str(agent.get("started_at") or agent.get("created_at") or "") >= session_started_at
        ]
    for agent in active_agents:
        agent["assigned_tests"] = _decode_json(agent.get("assigned_tests_json"), [])
        agent["stdout_tail"] = _tail_file(Path(agent["stdout_path"])) if agent.get("stdout_path") else ""
        agent["stderr_tail"] = _tail_file(Path(agent["stderr_path"])) if agent.get("stderr_path") else ""
        if agent.get("output_path"):
            agent["output_tail"] = _tail_file(Path(agent["output_path"]))
        else:
            agent["output_tail"] = agent["stdout_tail"] + agent["stderr_tail"]
    active_runners = db.active_runners(run_id=run_id)
    if session_started_at:
        active_runners = [
            runner
            for runner in active_runners
            if str(runner.get("created_at", "")) >= session_started_at
        ]
    for runner in active_runners:
        runner_id = str(runner.get("attempt_id", ""))
        runner["title"] = (
            "Node oracle baseline"
            if runner_id.startswith("canonical-oracle-")
            else "Browser target baseline"
            if runner_id.startswith("canonical-target-")
            else "Browser exploratory target"
            if runner_id.startswith("exploratory-target-")
            else "Test runner"
        )
    sessions = db.recent_agent_sessions(run_id=run_id)
    for session in sessions:
        session["assigned_tests"] = _decode_json(session.get("assigned_tests_json"), [])
    scope_summary = _decode_json(db.get_meta("scope_summary"), {})
    target_results = (
        db.dashboard_target_results()
        if hasattr(db, "dashboard_target_results")
        else []
    )
    for target in target_results:
        target["target_snapshot"] = _decode_json(target.get("target_snapshot_json"), None)
        target["prior_target_snapshot"] = _decode_json(
            target.get("prior_target_snapshot_json"), None
        )
        target["is_regression"] = (
            target.get("prior_target_status") == "pass"
            and target.get("target_status") != "pass"
        )
    regressions = [target for target in target_results if target["is_regression"]]
    summary = db.summary()
    summary.setdefault("regression_count", len(regressions))
    return {
        "generated_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "session": {"id": session_id, "started_at": session_started_at},
        "run": run,
        "summary": summary,
        "target_results": target_results,
        "regressions": regressions,
        "regression_count": len(regressions),
        "scope": scope_summary,
        "active_agents": active_agents,
        "active_runners": active_runners,
        "agent_sessions": sessions,
        "events": db.recent_events(run_id=run_id),
        "attempts": attempts,
        "merges": merges,
        "failure_clusters": db.top_failure_clusters(12),
        "gaps": db.list_gaps(limit=24) if hasattr(db, "list_gaps") else [],
    }


def create_dashboard_server(
    db_path: Path,
    *,
    host: str,
    port: int,
    variant: str | None = None,
) -> ThreadingHTTPServer:
    class DashboardHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            path = urlsplit(self.path).path
            if path == "/api/status":
                self._send_json(dashboard_snapshot(Database(db_path), variant=variant))
                return
            if path.startswith("/api/agents/") and path.endswith("/logs"):
                attempt_id = path[len("/api/agents/") : -len("/logs")].strip("/")
                if Path(attempt_id).name != attempt_id:
                    self.send_error(400, "invalid attempt id")
                    return
                query = urlsplit(self.path).query
                stream = "stdout" if "stream=stdout" in query else "stderr" if "stream=stderr" in query else "output"
                log_path = db_path.parent / "attempts" / attempt_id / f"agent.{stream}.log"
                self._send_json({"attempt_id": attempt_id, "stream": stream, "content": _tail_file(log_path, 50_000)})
                return
            if path == "/" or path == "/index.html":
                body = _PAGE.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            self.send_error(404)

        def do_POST(self) -> None:  # noqa: N802
            prefix = "/api/agents/"
            suffix = "/action"
            path = urlsplit(self.path).path
            if not (path.startswith(prefix) and path.endswith(suffix)):
                self.send_error(404)
                return
            attempt_id = path[len(prefix) : -len(suffix)].strip("/")
            if Path(attempt_id).name != attempt_id:
                self.send_error(400, "invalid attempt id")
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                payload = json.loads(self.rfile.read(length) or b"{}")
                action = str(payload.get("action", ""))
                accepted = Database(db_path).request_agent_action(attempt_id, action)
            except (ValueError, json.JSONDecodeError) as exc:
                self.send_error(400, str(exc))
                return
            self._send_json({"attempt_id": attempt_id, "action": action, "accepted": accepted}, status=202 if accepted else 409)

        def _send_json(self, payload: dict[str, Any], *, status: int = 200) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: Any) -> None:
            return

    return ThreadingHTTPServer((host, port), DashboardHandler)
