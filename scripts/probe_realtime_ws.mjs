#!/usr/bin/env node

const [websocketUrl] = process.argv.slice(2);
const protocol = "fullmag.live.v1";
const timeoutMs = 10000;

if (!websocketUrl) {
  console.error("usage: probe_realtime_ws.mjs <ws-url>");
  process.exit(2);
}

function parseMessage(data) {
  if (typeof data === "string") return JSON.parse(data);
  if (data instanceof ArrayBuffer) return JSON.parse(Buffer.from(data).toString("utf8"));
  if (ArrayBuffer.isView(data)) {
    return JSON.parse(Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8"));
  }
  throw new Error(`unsupported websocket message type: ${typeof data}`);
}

function connectAndReadHello(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, protocol);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.close();
      reject(new Error(`timed out waiting for realtime hello at ${url}`));
    }, timeoutMs);

    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    socket.addEventListener("error", () => fail(new Error(`websocket error at ${url}`)));
    socket.addEventListener("close", (event) => {
      if (!settled) fail(new Error(`websocket closed before hello at ${url}: ${event.code}`));
    });
    socket.addEventListener("message", (event) => {
      if (settled) return;
      let message;
      try {
        message = parseMessage(event.data);
      } catch (error) {
        fail(error);
        return;
      }
      if (message?.type !== "hello") {
        fail(new Error(`expected hello as first realtime frame, received ${message?.type ?? "unknown"}`));
        return;
      }
      if (message.contract_version !== "1.0.0") {
        fail(new Error(`unexpected realtime contract version: ${message.contract_version}`));
        return;
      }
      if (socket.protocol !== protocol) {
        fail(new Error(`server did not select ${protocol}; selected ${socket.protocol || "<none>"}`));
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ socket, message });
    });
  });
}

function closeSocket(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out closing realtime websocket")), timeoutMs);
    socket.addEventListener("close", (event) => {
      clearTimeout(timer);
      resolve({ code: event.code, reason: event.reason });
    }, { once: true });
    socket.close(1000, "managed realtime smoke");
  });
}

try {
  const first = await connectAndReadHello(websocketUrl);
  const firstHello = first.message;
  const firstClose = await closeSocket(first.socket);
  const reconnectUrl = `${websocketUrl}?after_seq=${encodeURIComponent(firstHello.seq)}`;
  const second = await connectAndReadHello(reconnectUrl);
  const secondHello = second.message;
  const secondClose = await closeSocket(second.socket);

  if (!firstHello.session_id || firstHello.session_id !== secondHello.session_id) {
    throw new Error("reconnect changed the current session identity");
  }
  if (secondHello.seq < firstHello.seq) {
    throw new Error("reconnect hello sequence moved backwards");
  }
  if (secondHello.payload?.current_seq !== secondHello.seq) {
    throw new Error("reconnect hello current_seq does not match the envelope sequence");
  }

  console.log(JSON.stringify({
    state: "passed",
    websocket_url: websocketUrl,
    protocol,
    first: {
      type: firstHello.type,
      session_id: firstHello.session_id,
      run_id: firstHello.run_id ?? null,
      seq: firstHello.seq,
      current_seq: firstHello.payload?.current_seq,
      replay_available_after_seq: firstHello.payload?.replay_available_after_seq,
      close_code: firstClose.code,
    },
    reconnect: {
      type: secondHello.type,
      session_id: secondHello.session_id,
      run_id: secondHello.run_id ?? null,
      seq: secondHello.seq,
      current_seq: secondHello.payload?.current_seq,
      replay_available_after_seq: secondHello.payload?.replay_available_after_seq,
      after_seq: firstHello.seq,
      close_code: secondClose.code,
      same_session_id: true,
    },
  }));
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
}
