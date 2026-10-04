import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { webcrypto } from "node:crypto";
import vm from "node:vm";

// Run the production facade with native type erasure and isolated module mocks.
const context = vm.createContext({
  AbortController,
  AbortSignal,
  ArrayBuffer,
  Blob,
  DOMException,
  Headers,
  Request,
  Response,
  TextDecoder,
  TextEncoder,
  URL,
  URLSearchParams,
  clearTimeout,
  crypto: webcrypto,
  performance,
  setTimeout,
  structuredClone,
});

const sourceText = readFileSync(new URL("../src/kernel/api/ControlRoomApi.ts", import.meta.url), "utf8");
const importedNames = new Map();
for (const match of sourceText.matchAll(/\bimport\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\s+["']([^"']+)["'];/g)) {
  const [, bindings, specifier] = match;
  const names = importedNames.get(specifier) ?? new Set();
  for (const binding of bindings.split(",")) {
    const value = binding.trim().replace(/^type\s+/, "");
    if (!value) continue;
    names.add(value.split(/\s+as\s+/)[0]);
  }
  importedNames.set(specifier, names);
}

const generatedPaths = new vm.SourceTextModule(
  stripTypeScriptTypes(readFileSync(new URL("../src/kernel/api/generated/openapi-v2-paths.ts", import.meta.url), "utf8")),
  { context },
);
const apiPaths = new vm.SourceTextModule(
  stripTypeScriptTypes(readFileSync(new URL("../src/kernel/api/apiPaths.ts", import.meta.url), "utf8")),
  { context },
);
const apiInstancePin = new vm.SourceTextModule(
  stripTypeScriptTypes(readFileSync(new URL("../src/kernel/api/apiInstancePin.ts", import.meta.url), "utf8")),
  { context },
);

let responseParse = async (response) => response.json();
const transportMock = new vm.SyntheticModule(
  ["createOpenApiV2Transport"],
  function () {
    this.setExport("createOpenApiV2Transport", ({ baseUrl, fetch }) => {
      const send = async (method, path, options = {}) => {
        const pathParams = options.params?.path ?? {};
        let expandedPath = path;
        for (const [key, value] of Object.entries(pathParams)) {
          expandedPath = expandedPath.replace(`{${key}}`, encodeURIComponent(String(value)));
        }
        const url = new URL(expandedPath, baseUrl);
        for (const [key, value] of Object.entries(options.params?.query ?? {})) {
          if (value == null) continue;
          if (Array.isArray(value)) {
            for (const item of value) url.searchParams.append(key, String(item));
          } else {
            url.searchParams.set(key, String(value));
          }
        }
        const headers = new Headers(options.headers);
        const requestInit = {
          cache: options.cache ?? "no-store",
          headers,
          method,
          signal: options.signal,
        };
        if (options.body !== undefined) {
          headers.set("content-type", headers.get("content-type") ?? "application/json");
          requestInit.body = JSON.stringify(options.body);
        }
        const response = await (options.fetch ?? fetch)(new Request(url, requestInit));
        if (response.status === 204 || response.status === 304) {
          return { data: undefined, response };
        }
        try {
          const data = options.parseAs === "arrayBuffer"
            ? await response.arrayBuffer()
            : await responseParse(response);
          return { data, ...(response.ok ? {} : { error: data }), response };
        } catch (error) {
          return { error, response };
        }
      };
      return {
        GET: (path, options) => send("GET", path, options),
        POST: (path, options) => send("POST", path, options),
        PATCH: (path, options) => send("PATCH", path, options),
        PUT: (path, options) => send("PUT", path, options),
        DELETE: (path, options) => send("DELETE", path, options),
      };
    });
  },
  { context },
);

function fallbackImport(specifier, name) {
  if (name === "boundedBinaryResponse") return (response) => response;
  if (name === "createBinaryDecodeScheduler") {
    return () => async ({ buffer, decodeInline }) => decodeInline(buffer);
  }
  if (name === "recordVisualizationDebugPerformanceMetric") return () => undefined;
  if (name === "FMMT_HEADER_LEN") return 24;
  if (name.endsWith("ByteLimit") || name === "savedTopologyByteLimit") {
    return () => Number.MAX_SAFE_INTEGER;
  }
  if (/^(decode|canonical|field|stored|resolve|validate|verify|expected|topology|is)/.test(name)) {
    return (...args) => args[0];
  }
  return () => {
    throw new Error(`Unexpected facade dependency: ${specifier}.${name}`);
  };
}

const stubModules = new Map();
for (const [specifier, names] of importedNames) {
  if (["./apiInstancePin", "./apiPaths", "./generated/openapi-v2-client"].includes(specifier)) continue;
  stubModules.set(specifier, new vm.SyntheticModule(
    [...names],
    function () {
      for (const name of names) this.setExport(name, fallbackImport(specifier, name));
    },
    { context },
  ));
}

const facade = new vm.SourceTextModule(
  stripTypeScriptTypes(sourceText, { mode: "transform" }),
  { context },
);
await facade.link((specifier) => {
  if (specifier === "./apiInstancePin") return apiInstancePin;
  if (specifier === "./apiPaths") return apiPaths;
  if (specifier === "./generated/openapi-v2-client") return transportMock;
  if (specifier === "./generated/openapi-v2-paths") return generatedPaths;
  const stub = stubModules.get(specifier);
  assert.ok(stub, `Unexpected facade import: ${specifier}`);
  return stub;
});
await facade.evaluate();

const { ControlRoomApi, ControlRoomApiError } = facade.namespace;
const paths = apiPaths.namespace;
const apiPin = apiInstancePin.namespace;
const oldPin = "11111111-1111-4111-8111-111111111111";
const token = "0123456789abcdef0123456789abcdef";
const apiInstanceHeader = apiPin.API_INSTANCE_HEADER;
const contractHeader = paths.API_CONTRACT_VERSION_HEADER;
const contractVersion = paths.EXPECTED_API_CONTRACT_VERSION;
const requestCalls = [];
let groups = 0;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function jsonResponse(body = {}, {
  status = 200,
  pinned = true,
  instance = oldPin,
  contract = true,
  contractValue = contractVersion,
} = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (pinned) headers.set(apiInstanceHeader, instance);
  if (contract) headers.set(contractHeader, contractValue);
  return new Response(JSON.stringify(body), { status, headers });
}

function makeApi(overrides = {}) {
  requestCalls.length = 0;
  return new ControlRoomApi({
    baseUrl: "http://fullmag.test",
    expectedApiInstance: oldPin,
    maxGetRetries: 0,
    retryDelayMs: 0,
    requestIdFactory: () => `request-${requestCalls.length + 1}`,
    fetchImpl: async (url, init) => {
      const call = {
        headers: new Headers(init?.headers),
        method: init?.method ?? "GET",
        url: String(url),
      };
      requestCalls.push(call);
      if (overrides.fetchImpl) return overrides.fetchImpl(url, init, call);
      if (new URL(call.url).pathname === paths.DATA_DOMAIN_TOPOLOGY_PATH) {
        return new Response(new Uint8Array([1, 2, 3]).buffer, {
          status: 200,
          headers: new Headers({
            [apiInstanceHeader]: oldPin,
            [contractHeader]: contractVersion,
            "content-type": "application/octet-stream",
          }),
        });
      }
      return jsonResponse({ accepted: true });
    },
    ...overrides.options,
  });
}

function assertTypedCode(error, expectedCode) {
  assert.ok(error instanceof ControlRoomApiError);
  assert.equal(error.code, expectedCode);
  return true;
}

{
  const api = makeApi();
  const release = api.beginDevelopmentHandoffTransportPause();
  await assert.rejects(api.sessions.current.status(), (error) => assertTypedCode(error, "DEVELOPMENT_TRANSPORT_PAUSED"));
  await assert.rejects(api.sessions.create({}), (error) => assertTypedCode(error, "DEVELOPMENT_TRANSPORT_PAUSED"));
  await assert.rejects(
    api.transport.GET(paths.SESSION_STATUS_PATH, {}),
    (error) => assertTypedCode(error, "DEVELOPMENT_TRANSPORT_PAUSED"),
  );
  assert.equal(requestCalls.length, 0);
  release();
  groups++;
}

{
  const api = makeApi();
  const release = api.beginDevelopmentHandoffTransportPause();
  await api.platform.developmentBackend();
  await api.platform.submitDevelopmentRestartRequest({ request_id: "request-1" }, token);
  await api.platform.developmentRestartRequest("request-1", token);
  assert.deepEqual(requestCalls.map(({ method, url }) => [method, new URL(url).pathname]), [
    ["GET", paths.PLATFORM_DEVELOPMENT_BACKEND_PATH],
    ["POST", paths.PLATFORM_DEVELOPMENT_RESTART_REQUESTS_PATH],
    ["GET", "/v2/platform/development-restart-requests/request-1"],
  ]);
  assert.equal(requestCalls[0].headers.get(apiInstanceHeader), oldPin);
  assert.equal(requestCalls[1].headers.get(apiInstanceHeader), oldPin);
  assert.equal(requestCalls[1].headers.get("authorization"), `Bearer ${token}`);
  assert.equal(requestCalls[2].headers.get(apiInstanceHeader), null);
  assert.equal(requestCalls[2].headers.get("authorization"), `Bearer ${token}`);
  assert.equal(requestCalls[2].headers.has("x-fullmag-internal-api-instance-policy"), false);

  await assert.rejects(
    api.executeOpenApiFetch(new Request("http://fullmag.test/v2/platform/development-restart-requests/request-2"), undefined),
    (error) => assertTypedCode(error, "DEVELOPMENT_TRANSPORT_PAUSED"),
  );
  await assert.rejects(
    api.executeOpenApiFetch(new Request("http://fullmag.test/v2/platform/development-restart-requests/request-2", {
      headers: { authorization: `Bearer ${token}` },
    }), undefined),
    (error) => assertTypedCode(error, "DEVELOPMENT_TRANSPORT_PAUSED"),
  );
  await assert.rejects(
    api.executeOpenApiFetch(new Request("http://fullmag.test/v2/platform/development-backend?probe=1"), undefined),
    (error) => assertTypedCode(error, "DEVELOPMENT_TRANSPORT_PAUSED"),
  );
  await assert.rejects(
    api.executeOpenApiFetch(new Request("http://other.test/v2/platform/development-backend"), undefined),
    (error) => assertTypedCode(error, "DEVELOPMENT_TRANSPORT_PAUSED"),
  );
  await assert.rejects(
    api.executeOpenApiFetch(new Request("http://fullmag.test/v2/platform/development-restart-requests", {
      method: "POST",
      body: "{}",
    }), undefined),
    (error) => assertTypedCode(error, "DEVELOPMENT_TRANSPORT_PAUSED"),
  );
  assert.equal(requestCalls.length, 3);
  release();
  groups++;
}

{
  const replacementPin = "22222222-2222-4222-8222-222222222222";
  const api = makeApi({
    fetchImpl: async () =>
      jsonResponse(
        { request_id: "request-new-owner" },
        { instance: replacementPin },
      ),
  });
  const release = api.beginDevelopmentHandoffTransportPause();
  const result = await api.platform.developmentRestartRequest("request-5", token);
  assert.equal(result.request_id, "request-new-owner");
  assert.equal(requestCalls[0].headers.get(apiInstanceHeader), null);
  release();
  groups++;
}

{
  const replacementPin = "22222222-2222-4222-8222-222222222222";
  const api = makeApi({
    fetchImpl: async () =>
      jsonResponse(
        { request_id: "request-new-owner" },
        { instance: replacementPin, contract: false },
      ),
  });
  const release = api.beginDevelopmentHandoffTransportPause();
  await assert.rejects(
    api.platform.developmentRestartRequest("request-6", token),
    (error) =>
      error instanceof ControlRoomApiError &&
      error.message.includes("API contract version mismatch") &&
      error.message.includes("missing"),
  );
  assert.equal(requestCalls[0].headers.get(apiInstanceHeader), null);
  release();
  groups++;
}

{
  const parseStarted = deferred();
  const parseRelease = deferred();
  responseParse = async (response) => {
    parseStarted.resolve();
    await parseRelease.promise;
    return response.json();
  };
  const api = makeApi();
  const firstRelease = api.beginDevelopmentHandoffTransportPause();
  const request = api.platform.developmentRestartRequest("request-4", token);
  await parseStarted.promise;
  const secondRelease = api.beginDevelopmentHandoffTransportPause();
  secondRelease();
  parseRelease.resolve();
  await request;
  responseParse = async (response) => response.json();
  firstRelease();
  groups++;
}

{
  requestCalls.length = 0;
  const fetchStarted = deferred();
  const fetchRelease = deferred();
  const api = makeApi({
    fetchImpl: async (_url, _init, call) => {
      fetchStarted.resolve(call);
      return fetchRelease.promise;
    },
  });
  const request = api.sessions.create({ name: "uncertain write" });
  await fetchStarted.promise;
  assert.throws(() => api.beginDevelopmentHandoffTransportPause(), (error) => assertTypedCode(error, "DEVELOPMENT_TRANSPORT_BUSY"));
  assert.equal(requestCalls.length, 1);
  fetchRelease.resolve(jsonResponse({ session_id: "created" }));
  await request;
  const release = api.beginDevelopmentHandoffTransportPause();
  release();
  groups++;
}

{
  const parseStarted = deferred();
  const parseRelease = deferred();
  responseParse = async (response) => {
    parseStarted.resolve();
    await parseRelease.promise;
    return response.json();
  };
  const api = makeApi();
  const request = api.sessions.current.status();
  await parseStarted.promise;
  assert.throws(() => api.beginDevelopmentHandoffTransportPause(), (error) => assertTypedCode(error, "DEVELOPMENT_TRANSPORT_BUSY"));
  parseRelease.resolve();
  await request;
  responseParse = async (response) => response.json();
  const release = api.beginDevelopmentHandoffTransportPause();
  release();
  groups++;
}

{
  const parseStarted = deferred();
  const parseRelease = deferred();
  responseParse = async (response) => {
    parseStarted.resolve();
    await parseRelease.promise;
    return response.json();
  };
  const api = makeApi();
  const request = api.transport.GET(paths.SESSION_STATUS_PATH, {});
  await parseStarted.promise;
  assert.throws(() => api.beginDevelopmentHandoffTransportPause(), (error) => assertTypedCode(error, "DEVELOPMENT_TRANSPORT_BUSY"));
  parseRelease.resolve();
  const result = await request;
  assert.equal(result.data.accepted, true);
  responseParse = async (response) => response.json();
  const release = api.beginDevelopmentHandoffTransportPause();
  release();
  groups++;
}

{
  const decodeStarted = deferred();
  const decodeRelease = deferred();
  const api = makeApi({
    options: {
      binaryDecodeScheduler: async ({ buffer, decodeInline }) => {
        decodeStarted.resolve();
        await decodeRelease.promise;
        return decodeInline(buffer);
      },
    },
  });
  const request = api.data.domain.topology();
  await decodeStarted.promise;
  assert.throws(() => api.beginDevelopmentHandoffTransportPause(), (error) => assertTypedCode(error, "DEVELOPMENT_TRANSPORT_BUSY"));
  decodeRelease.resolve();
  await request;
  const release = api.beginDevelopmentHandoffTransportPause();
  release();
  groups++;
}

{
  const api = makeApi();
  const firstRelease = api.beginDevelopmentHandoffTransportPause();
  const secondRelease = api.beginDevelopmentHandoffTransportPause();
  firstRelease();
  firstRelease();
  await assert.rejects(api.sessions.current.status(), (error) => assertTypedCode(error, "DEVELOPMENT_TRANSPORT_PAUSED"));
  secondRelease();
  await api.sessions.current.status();
  assert.equal(requestCalls.length, 1);
  groups++;
}

{
  const api = makeApi();
  const release = api.beginDevelopmentHandoffTransportPause();
  api.retireDevelopmentHandoffTransport();
  release();
  await assert.rejects(api.sessions.current.status(), (error) => assertTypedCode(error, "DEVELOPMENT_TRANSPORT_RETIRED"));
  await api.platform.developmentRestartRequest("request-3", token);
  assert.throws(() => api.beginDevelopmentHandoffTransportPause(), (error) => assertTypedCode(error, "DEVELOPMENT_TRANSPORT_RETIRED"));
  assert.equal(requestCalls.length, 1);
  assert.equal(requestCalls[0].headers.get(apiInstanceHeader), null);
  groups++;
}

{
  const api = makeApi({
    fetchImpl: async () => { throw new TypeError("offline"); },
  });
  await assert.rejects(api.sessions.current.status(), /offline/);
  const release = api.beginDevelopmentHandoffTransportPause();
  release();
  groups++;
}

{
  requestCalls.length = 0;
  const fetchStarted = deferred();
  const fetchRelease = deferred();
  const api = new ControlRoomApi({
    baseUrl: "http://fullmag.test",
    expectedApiInstance: oldPin,
    maxGetRetries: 1,
    retryDelayMs: 0,
    requestIdFactory: () => "retry-request",
    fetchImpl: async (url, init) => {
      requestCalls.push({ method: init?.method ?? "GET", url: String(url) });
      fetchStarted.resolve();
      return fetchRelease.promise;
    },
  });
  const request = api.sessions.current.status();
  await fetchStarted.promise;
  api.retireDevelopmentHandoffTransport();
  fetchRelease.resolve(jsonResponse({}, { status: 503 }));
  await assert.rejects(request, (error) => assertTypedCode(error, "DEVELOPMENT_TRANSPORT_RETIRED"));
  assert.equal(requestCalls.length, 1);
  groups++;
}

console.log(JSON.stringify({ check: "development-transport-pause", groups, passed: true, emitted_code: false }));
