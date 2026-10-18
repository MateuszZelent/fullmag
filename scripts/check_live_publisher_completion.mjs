// Interpreted source contract; managed HTTP is the runtime publication proof.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const live = readFileSync(resolve(root, "crates/fullmag-cli/src/live_workspace.rs"), "utf8");
const orchestrator = readFileSync(resolve(root, "crates/fullmag-cli/src/orchestrator.rs"), "utf8");
const control = readFileSync(resolve(root, "crates/fullmag-cli/src/control_room.rs"), "utf8");
let checks = 0;
function requireOrdered(source, tokens, message) {
  let after = -1;
  for (const token of tokens) {
    const next = source.indexOf(token, after + 1);
    assert(next >= 0, `${message}: missing/out-of-order ${token}`);
    after = next;
    checks++;
  }
}
assert(live.includes("worker: std::thread::JoinHandle<()>"), "publisher must own worker until completion");
checks++;
const finish = live.slice(live.indexOf("    fn finish_publish(&self, timeout:"), live.indexOf("    #[cfg(test)]", live.indexOf("    fn finish_publish(&self, timeout:")));
requireOrdered(finish, ["self.stopping.store(true", "self.pending.store(true", "self.wake_tx.try_send", "worker.receipt.recv_timeout(timeout)", "completion.take()", "worker.worker.join()", "        published"], "completion barrier");
assert(!finish.includes(".unwrap_or"), "publication failure must never become success");
assert(finish.includes("let Some(worker) = completion.as_ref() else"), "disabled API completion is immediate");
assert(!finish.includes("api_is_ready"), "completion must not wait for API readiness or retry unavailable API");
checks += 2;
checks++;
const spawn = live.slice(live.indexOf("        let worker = std::thread::Builder::new()"), live.indexOf("    fn finish_publish(&self, timeout:"));
requireOrdered(spawn, ["let result = current_live_publisher_loop(", "worker_stopping", "receipt_tx.send(result)"], "receipt follows actual worker result");
const loop = live.slice(live.indexOf("fn current_live_publisher_loop("), live.indexOf("fn owner_session_lost("));
assert(loop.includes("while !stopping.load(Ordering::Acquire) && pending.swap"), "stop must retire stale delta retries");
checks++;
assert(!/\breturn\s*;/.test(loop), "Result-returning publisher must report every exit through its owned completion receipt");
checks++;
const terminal = loop.slice(loop.indexOf("    if stopping.load(Ordering::Acquire) || pending.swap"));
requireOrdered(terminal, ["build_pending_payload_from_workspace", "let mut snapshot", "if stopping.load(Ordering::Acquire)", "full_sync(&session_id, &snapshot)", "published?;", "return Ok(())"], "canonical terminal snapshot before real HTTP ACK");
const end = orchestrator.slice(orchestrator.indexOf("    let finished_at_unix_ms = unix_time_millis()?;", orchestrator.indexOf("let synthetic_completed_at_unix_ms")));
requireOrdered(end, ["state.session = build_session_manifest(", "state.run = run_manifest_from_steps(", "set_live_state_status", "Workspace {summary_verb}", "live_workspace.finish_publish()?;", "print_script_summary(&summary)", "storage_lease.finish(true)?;"], "CLI success waits for canonical terminal receipt");
const http = control.slice(control.indexOf("pub(crate) fn sync_current_live_snapshot("), control.indexOf("fn sync_current_live_session_frame("));
requireOrdered(http, ["internal_live_api_url(\"snapshot\")", "stage_execution: payload.stage_execution.as_ref()", ".send()", ".error_for_status()", "Ok(())"], "ACK is actual accepted HTTP snapshot");

const headless = control.slice(control.indexOf("fn resolve_headless_api_port_with("), control.indexOf("pub(crate) fn init_api_port_explicit("));
assert(headless.includes("return Ok(0)"), "offline headless must keep API disabled");
assert(headless.includes("must already serve a compatible fullmag-api"), "explicit API headless requires existing server");
checks += 2;
console.log(JSON.stringify({ status: "PASS", checks, runtime_verified: false }));
