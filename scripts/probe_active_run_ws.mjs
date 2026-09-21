#!/usr/bin/env node

const baseUrl = process.argv[2];
const protocol = "fullmag.live.v1";
const timeoutMs = 15_000;

if (!baseUrl) {
  console.error("usage: probe_active_run_ws.mjs <http-base-url>");
  process.exit(2);
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function json(path) {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${path} -> HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : null;
}

function parseMessage(data) {
  if (typeof data === "string") return JSON.parse(data);
  if (data instanceof ArrayBuffer) return JSON.parse(Buffer.from(data).toString("utf8"));
  if (ArrayBuffer.isView(data)) {
    return JSON.parse(Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8"));
  }
  throw new Error(`unsupported websocket message type: ${typeof data}`);
}

async function snapshot(label) {
  const [status, run, stages, solver, commands] = await Promise.all([
    json("/v2/sessions/current/status"),
    json("/v2/sessions/current/simulation/runs/current"),
    json("/v2/sessions/current/simulation/stages/execution"),
    json("/v2/sessions/current/simulation/solver/status"),
    json("/v2/sessions/current/simulation/commands"),
  ]);
  return {
    label,
    session_id: status?.session?.session_id ?? null,
    run_id: status?.run?.run_id ?? run?.run_id ?? null,
    solver_state: status?.solver?.state ?? solver?.runtime_state ?? null,
    steps: status?.run?.solver_steps ?? run?.total_steps ?? solver?.step_index ?? null,
    lifecycle: status?.lifecycle?.solver ?? null,
    run_revision: run?.revision ?? null,
    stages_revision: stages?.revision ?? null,
    solver_revision: solver?.revision ?? null,
    commands_revision: commands?.revision ?? null,
    commandable: commands?.can_accept_commands ?? null,
  };
}

async function waitForActiveRun() {
  const deadline = Date.now() + 45_000;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await snapshot("active-run-ready");
    if (
      latest.session_id &&
      latest.run_id &&
      Number(latest.steps) >= 1 &&
      ["materializing_script", "preparing", "running", "paused"].includes(latest.solver_state)
    ) {
      return latest;
    }
    await sleep(250);
  }
  throw new Error(`active run did not become observable: ${JSON.stringify(latest)}`);
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, protocol);
    const events = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.close();
        reject(new Error(`timed out waiting for hello at ${url}`));
      }
    }, timeoutMs);
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    socket.addEventListener("error", () => fail(new Error(`websocket error at ${url}`)));
    socket.addEventListener("close", (event) => {
      if (!settled) fail(new Error(`socket closed before hello: ${event.code}`));
    });
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = parseMessage(event.data);
      } catch (error) {
        fail(error);
        return;
      }
      events.push(message);
      if (message?.type !== "hello") return;
      if (message.contract_version !== "1.0.0") {
        fail(new Error(`unexpected realtime contract version: ${message.contract_version}`));
        return;
      }
      if (socket.protocol !== protocol) {
        fail(new Error(`server selected ${socket.protocol || "<none>"}, expected ${protocol}`));
        return;
      }
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ socket, hello: message, events });
      }
    });
  });
}

function close(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out closing websocket")), timeoutMs);
    socket.addEventListener("close", (event) => {
      clearTimeout(timer);
      resolve({ code: event.code, reason: event.reason });
    }, { once: true });
    socket.close(1000, "managed active-run reconnect smoke");
  });
}

try {
  const before = await waitForActiveRun();
  const wsUrl = baseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:") + "/v2/sessions/current/events/ws";
  const first = await connect(wsUrl);
  await sleep(250);
  const during = await snapshot("during_socket_open");
  const firstClose = await close(first.socket);
  await sleep(400);
  const afterDrop = await snapshot("after_disconnect");
  const second = await connect(`${wsUrl}?after_seq=${encodeURIComponent(first.hello.seq)}`);
  await sleep(250);
  const afterReconnect = await snapshot("after_reconnect");
  const secondClose = await close(second.socket);

  const failures = [];
  if (first.hello.session_id !== second.hello.session_id) failures.push("hello_session_changed");
  if (first.hello.run_id !== second.hello.run_id) failures.push("hello_run_changed");
  if (before.session_id !== afterReconnect.session_id) failures.push("http_session_changed");
  if (before.run_id !== afterReconnect.run_id) failures.push("http_run_changed");
  if (![
    "materializing_script",
    "preparing",
    "running",
    "paused",
  ].includes(afterReconnect.solver_state)) failures.push(`unexpected_solver_state:${afterReconnect.solver_state}`);
  if (Number(afterReconnect.steps) < Number(before.steps)) failures.push("solver_steps_went_backwards");
  for (const key of ["run_revision", "stages_revision", "solver_revision"]) {
    if (Number(afterReconnect[key]) < Number(before[key])) failures.push(`${key}_went_backwards`);
  }
  if (failures.length > 0) throw new Error(`active reconnect assertions failed: ${failures.join(",")}`);

  console.log(JSON.stringify({
    state: "passed",
    scope: "managed-active-run-reconnect",
    base_url: baseUrl,
    protocol,
    first_hello: {
      session_id: first.hello.session_id,
      run_id: first.hello.run_id ?? null,
      seq: first.hello.seq,
      current_seq: first.hello.payload?.current_seq,
      event_count: first.events.length,
    },
    reconnect_hello: {
      session_id: second.hello.session_id,
      run_id: second.hello.run_id ?? null,
      seq: second.hello.seq,
      current_seq: second.hello.payload?.current_seq,
      after_seq: first.hello.seq,
      event_count: second.events.length,
    },
    close_codes: [firstClose.code, secondClose.code],
    snapshots: [before, during, afterDrop, afterReconnect],
    assertions: {
      same_session: true,
      same_run: true,
      solver_continued: true,
      http_resources_reachable: true,
      revisions_non_decreasing: true,
    },
  }));
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
}
