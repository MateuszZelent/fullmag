import assert from "node:assert/strict";
import { mkdir, writeFile, realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { chromium } from "playwright";

const target = JSON.parse(process.env.FULLMAG_MANAGED_BROWSER_TARGET ?? "null");
const workspace = new URL(process.env.CONTROL_ROOM_URL);
const reportRoot = resolve(process.env.FULLMAG_ANTENNA_WORKSPACE_REPORT_DIR);
const runRoot = await realpath(process.env.FULLMAG_FRONTEND_SOURCE_RUN_ROOT);
const suffix = relative(runRoot, reportRoot);
assert.ok(suffix && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
assert.equal(workspace.hostname, "127.0.0.1"); assert.equal(workspace.port, "3274");
assert.equal(workspace.searchParams.get("fullmag_api_instance"), target.api_instance);
assert.equal(target.session_storage, "disposable_tmpfs");
assert.match(target.container_id, /^[0-9a-f]{64}$/);
const apiBase = new URL(target.api_base);
assert.equal(apiBase.hostname, "127.0.0.1"); assert.notEqual(apiBase.port, "3197");
await mkdir(reportRoot, { recursive: true });
const checks = [], screenshots = [], pageErrors = [], consoleErrors = [], httpErrors = [], writes = [], visualizationAcks = [], websockets = [];
const sessionReads = [], pendingSessionReads = new Set();
let sessionTransition = null;
let browser, page, failure = null, scope = null, sessionId = null;
const startedAt = new Date().toISOString();
const headers = () => ({ "x-fullmag-api-instance": target.api_instance, ...(scope ? { "x-fullmag-session-scope": scope } : {}) });
async function json(response) {
  assert.equal(response.headers()["x-fullmag-api-instance"], target.api_instance, "API process identity changed");
  assert.equal(response.headers()["x-api-contract-version"], "1.0.0");
  const body = await response.text();
  assert.ok(response.ok(), `HTTP ${response.status()} ${response.url()}: ${body.slice(0, 1500)}`);
  return JSON.parse(body);
}
try {
  browser = await chromium.launch({ headless: true, channel: process.env.FULLMAG_ANTENNA_WORKSPACE_BROWSER_CHANNEL ?? "chrome" });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  const sessions = await json(await context.request.get(`${target.api_base}/v2/sessions`, { headers: headers() }));
  assert.deepEqual(sessions.sessions, [], "Do not replace an existing API session");
  const created = await json(await context.request.post(`${target.api_base}/v2/sessions`, {
    headers: headers(), data: { name: "Managed antenna workspace authoring", backend: "fem", device: "cpu", precision: "double", replace_current: false },
  }));
  sessionId = created.session_id; assert.ok(sessionId);
  const status = await json(await context.request.get(`${target.api_base}/v2/sessions/current/status`, { headers: headers() }));
  assert.equal(status.session.session_id, sessionId);
  const owner = status.session;
  for (const key of ["session_id", "session_epoch", "request_scope_epoch"]) assert.ok(owner[key]?.trim());
  scope = `session=${encodeURIComponent(owner.session_id)}&epoch=${encodeURIComponent(owner.session_epoch)}&request_scope_epoch=${encodeURIComponent(owner.request_scope_epoch)}`;
  const scene = () => context.request.get(`${target.api_base}/v2/sessions/current/model/scene`, { headers: headers() }).then(json);
  const waitScene = async (predicate) => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) { const current = await scene(); if (predicate(current)) return current; await new Promise(done => setTimeout(done, 250)); }
    throw new Error("Authoritative scene did not confirm the UI transaction");
  };
  checks.push({ name: "fresh receipt-attested API creates its own FEM CPU session without replacement", passed: true });
  page = await context.newPage(); page.setDefaultTimeout(30_000);
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("console", message => { if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) consoleErrors.push(message.text()); });
  page.on("websocket", socket => websockets.push(socket.url()));
  page.on("response", response => {
    const path = new URL(response.url()).pathname;
    if (response.status() >= 400) httpErrors.push({ status: response.status(), url: response.url() });
    if (response.url().startsWith(target.api_base) && response.request().method() === "GET" && ["/v2/sessions", "/v2/sessions/current/status"].includes(path)) {
      const record = { path, status: response.status(), at: new Date().toISOString() };
      sessionReads.push(record); if (sessionReads.length > 64) sessionReads.shift();
      const task = response.json().then(body => { record.data = path === "/v2/sessions" ? body : { session: body.session }; }).catch(error => { record.error = String(error); });
      pendingSessionReads.add(task); void task.finally(() => pendingSessionReads.delete(task));
    }
  });
  page.on("request", request => {
    if (request.url().startsWith(target.api_base) && !["GET", "OPTIONS"].includes(request.method())) {
      const record = { method: request.method(), path: new URL(request.url()).pathname, body: request.postDataJSON(), instance: request.headers()["x-fullmag-api-instance"], scope: request.headers()["x-fullmag-session-scope"] };
      if (record.path === "/v2/sessions/current/visualization/client-acks") visualizationAcks.push(record);
      else writes.push(record);
    }
  });
  const checkpoint = name => console.log(JSON.stringify({ checkpoint: name, elapsedMs: Date.now() - Date.parse(startedAt) }));
  const screenshot = async name => { const path = resolve(reportRoot, `${name}.png`); await page.screenshot({ path, fullPage: true, animations: "disabled" }); screenshots.push(path); checkpoint(name); };
  await page.goto(workspace.href, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.getByText("Managed antenna workspace authoring", { exact: true }).first().waitFor();
  await page.locator('[data-node-id="model:objects"]').waitFor({ state: "visible" });
  await page.getByRole("button", { name: /command search/i }).first().click();
  await page.getByPlaceholder("Search commands").fill("Add Microstrip Antenna");
  await page.getByRole("option").filter({ hasText: "Add Microstrip Antenna" }).first().click();
  const authored = await waitScene(s => s.objects?.some(o => o.role === "antenna"));
  const objects = authored.objects.filter(o => o.role === "antenna"); assert.equal(objects.length, 1);
  const object = objects[0], objectId = object.id;
  const stages = authored.antenna_field_solve_stages.filter(s => s.source_object_id === objectId); assert.equal(stages.length, 1);
  const stage = stages[0];
  checks.push({ name: "public command creates microstrip, current transport, observation port and field definition through real API", passed: true });
  await page.getByTitle("Expand All").click();
  const selectNode = async id => { const node = page.locator(`[data-node-id="${id}"]`); await node.waitFor({ state: "visible" }); await node.click(); };
  await selectNode(`model:object:${objectId}:antenna:terminals`);
  const terminals = page.locator('[data-inspector-owner="object.antenna.terminals"]');
  await terminals.getByRole("combobox", { name: "Terminal preparation port" }).waitFor();
  assert.equal(await terminals.getByTestId("antenna-terminal-source").count(), 0);
  checks.push({ name: "legacy microstrip keeps the explicit inspection preparation form", passed: true });
  await selectNode(`model:object:${objectId}:geometry`);
  const geometry = page.locator('[data-inspector-owner="object.antenna.geometry"]');
  await geometry.getByRole("checkbox", { name: "Full 3D conducting circuit", exact: true }).check();
  for (const end of ["inlet", "outlet"]) {
    for (const [name, value] of [["length", "1e-7"], ["width", "5e-8"], ["center v", "0"], ["part ID", `${end}_bridge`], ["conductivity", "58000000"]]) {
      await geometry.getByRole("textbox", { name: `${end} bridge ${name}`, exact: true }).fill(value);
    }
  }
  await geometry.getByRole("textbox", { name: "Inlet source-cut potential jump", exact: true }).fill("0.25");
  await screenshot("01-circuit-draft");
  const save = geometry.getByRole("button", { name: "Save conductor authoring", exact: true });
  assert.equal(await save.isEnabled(), true, await geometry.innerText()); await save.click();
  const closed = await waitScene(s => s.objects.find(o => o.id === objectId)?.geometry?.geometry_params?.loop?.enabled === true);
  const current = closed.current_transports.find(c => c.name === stage.current_transport_id);
  assert.equal(current.structured_current_closure.kind, "closed_geometry");
  assert.equal(current.structured_current_closure.source_cuts[0].drive.potential_jump_V, 0.25);
  assert.equal(current.materials.length, 4);
  assert.equal(closed.antenna_port_modes.find(p => p.source_object_id === objectId).schema_version, "antenna_port_mode.v3");
  await geometry.getByText("Conductor authoring committed.", { exact: false }).waitFor();
  await screenshot("02-circuit-committed");
  checks.push({ name: "Geometry commits both physical bridges, voltage cut, four materials and v3 port atomically", passed: true });
  await page.getByTitle("Expand All").click();
  await selectNode(`model:object:${objectId}:antenna:terminals`);
  const source = terminals.getByTestId("antenna-terminal-source");
  await source.getByText("Authored voltage source", { exact: true }).waitFor();
  const sourceText = await source.innerText();
  for (const expected of ["0.25", "V⁺ − V⁻", "Coordinate frame", "object", "Inlet observation", "Outlet observation"]) assert.ok(sourceText.includes(expected), expected);
  assert.equal(await terminals.getByRole("combobox", { name: "Terminal preparation port" }).count(), 0);
  assert.equal(await terminals.getByRole("button", { name: "Apply inspection preparation" }).count(), 0);
  await screenshot("04-explicit-source-and-observations");
  const writesBeforeNavigation = writes.length;
  await source.getByRole("button", { name: "Open Geometry", exact: true }).click();
  await geometry.waitFor();
  await selectNode(`model:object:${objectId}:antenna:terminals`);
  const port = closed.antenna_port_modes.find(p => p.source_object_id === objectId);
  const openPort = source.getByRole("button", { name: `Open port ${port.id}`, exact: true });
  assert.equal(await openPort.isEnabled(), true, await source.innerText());
  await openPort.scrollIntoViewIfNeeded();
  await screenshot("05-port-observations");
  await openPort.click();
  await page.getByText("Port terminal pairs", { exact: true }).waitFor();
  assert.equal(writes.length, writesBeforeNavigation, "Source navigation must not mutate the scene");
  checks.push({ name: "closed circuit presents its voltage source and observations with scoped read-only Geometry/Port navigation", passed: true });
  await selectNode(`model:object:${objectId}:antenna:conductor`);
  const materialEditor = page.getByTestId("antenna-conductor-material-editor");
  const conductivity = materialEditor.getByRole("textbox", { name: "Layout conductor conductivity", exact: true });
  await conductivity.waitFor();
  const beforeConductivityWrites = writes.length;
  await conductivity.fill("0");
  assert.equal(await materialEditor.getByRole("button", { name: "Apply conductivity", exact: true }).isEnabled(), false);
  assert.equal(writes.length, beforeConductivityWrites);
  await conductivity.fill("41000000");
  await materialEditor.getByRole("textbox", { name: "Inlet bridge conductivity", exact: true }).fill("32000000");
  await materialEditor.getByRole("textbox", { name: "Outlet bridge conductivity", exact: true }).fill("27000000");
  await conductivity.focus();
  await page.evaluate(() => {
    const root = document.querySelector('[data-testid="antenna-conductor-material-editor"]'), input = document.activeElement;
    const scroll = root.closest(".fm-inspector__body");
    const controls = [...root.querySelectorAll("input")].map(element => ({ element, disabled: element.disabled, opacity: getComputedStyle(element).opacity }));
    const proof = { root, input, scroll, scrollTop: scroll.scrollTop, controls, rootChanges: 0, controlChanges: 0, disabledChanges: 0, opacityChanges: 0, opacityAnimations: 0, samples: 0 };
    const sample = () => {
      proof.samples++;
      if (document.querySelector('[data-testid="antenna-conductor-material-editor"]') !== root) proof.rootChanges++;
      for (const saved of controls) {
        if (!saved.element.isConnected) proof.controlChanges++;
        if (saved.element.disabled !== saved.disabled) proof.disabledChanges++;
        if (getComputedStyle(saved.element).opacity !== saved.opacity) proof.opacityChanges++;
      }
      proof.opacityAnimations += root.getAnimations({ subtree: true }).filter(animation => (animation.playState === "running" || animation.pending) && animation.effect?.getKeyframes().some(frame => "opacity" in frame)).length;
    };
    const observer = new MutationObserver(sample); observer.observe(root, { attributes: true, childList: true, subtree: true });
    sample(); window.__antennaConductivityProof = { proof, observer, sample };
  });
  assert.equal(await materialEditor.getByRole("button", { name: "Apply conductivity", exact: true }).isEnabled(), true);
  // DOM activation exercises the actual Apply handler without moving the input focus under inspection.
  await materialEditor.getByRole("button", { name: "Apply conductivity", exact: true }).evaluate(button => button.click());
  const materialScene = await waitScene(s => s.objects.find(o => o.id === objectId)?.geometry?.geometry_params?.conductivity_s_per_m === 41000000);
  await materialEditor.getByText("Conductivity committed to geometry and charge materials.", { exact: false }).waitFor();
  const materialTransport = materialScene.current_transports.find(c => c.name === stage.current_transport_id);
  const params = materialScene.objects.find(o => o.id === objectId).geometry.geometry_params;
  assert.equal(params.loop.inlet_connection_conductivity_s_per_m, 32000000);
  assert.equal(params.loop.outlet_connection_conductivity_s_per_m, 27000000);
  for (const assignment of materialTransport.materials) assert.equal(assignment.material.sigma_Spm,
    assignment.region.region_id === params.loop.inlet_connection_part_id ? 32000000 : assignment.region.region_id === params.loop.outlet_connection_part_id ? 27000000 : 41000000);
  assert.deepEqual(materialTransport.structured_current_closure, current.structured_current_closure);
  assert.deepEqual(materialTransport.solver, current.solver);
  assert.deepEqual(materialScene.antenna_port_modes, closed.antenna_port_modes);
  assert.equal(writes.length, beforeConductivityWrites + 1);
  const stability = await page.evaluate(() => {
    const { proof, observer, sample } = window.__antennaConductivityProof; sample(); observer.disconnect();
    return { root: proof.root.isConnected, focus: document.activeElement === proof.input, scroll: proof.scroll.scrollTop === proof.scrollTop,
      rootChanges: proof.rootChanges, controlChanges: proof.controlChanges, disabledChanges: proof.disabledChanges, opacityChanges: proof.opacityChanges, opacityAnimations: proof.opacityAnimations, samples: proof.samples };
  });
  assert.ok(stability.samples > 1 && stability.samples < 100);
  assert.deepEqual({ ...stability, samples: 0 }, { root: true, focus: true, scroll: true, rootChanges: 0, controlChanges: 0, disabledChanges: 0, opacityChanges: 0, opacityAnimations: 0, samples: 0 });
  await screenshot("06-conductor-conductivity-committed");
  checks.push({ name: "Conductor atomically updates layout and charge conductivity while preserving source, solver, port, focus, scroll and input stability", passed: true, stability });
  const beforeMeshWrites = writes.length;
  const meshNode = page.locator(`[data-node-id="model:object:${objectId}:mesh"]`);
  await meshNode.waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Open Mesh Policy", exact: true }).click();
  const meshPolicy = page.locator('[data-mesh-policy-draft="object"]');
  await meshPolicy.getByRole("checkbox", { name: "Use object policy", exact: true }).waitFor();
  assert.equal(writes.length, beforeMeshWrites, "Opening mesh policy must not build or write");
  await meshPolicy.getByRole("checkbox", { name: "Use object policy", exact: true }).check();
  const maximumSize = meshPolicy.getByRole("textbox", { name: "Maximum element size", exact: true });
  await maximumSize.fill("2e-8");
  await maximumSize.focus();
  await page.evaluate(() => {
    const root = document.querySelector('[data-mesh-policy-draft="object"]'), input = document.activeElement, scroll = root.closest(".fm-inspector__body");
    const controls = [...root.querySelectorAll("input")].map(element => ({ element, disabled: element.disabled, opacity: getComputedStyle(element).opacity }));
    const proof = { root, input, scroll, scrollTop: scroll.scrollTop, rootChanges: 0, controlChanges: 0, disabledChanges: 0, opacityChanges: 0, opacityAnimations: 0, samples: 0 };
    const sample = () => {
      proof.samples++;
      if (document.querySelector('[data-mesh-policy-draft="object"]') !== root) proof.rootChanges++;
      for (const saved of controls) {
        if (!saved.element.isConnected) proof.controlChanges++;
        if (saved.element.disabled !== saved.disabled) proof.disabledChanges++;
        if (getComputedStyle(saved.element).opacity !== saved.opacity) proof.opacityChanges++;
      }
      proof.opacityAnimations += root.getAnimations({ subtree: true }).filter(animation => (animation.playState === "running" || animation.pending) && animation.effect?.getKeyframes().some(frame => "opacity" in frame)).length;
    };
    const observer = new MutationObserver(sample); observer.observe(root, { attributes: true, childList: true, subtree: true });
    sample(); window.__antennaMeshPolicyProof = { proof, observer, sample };
  });
  const applyPolicy = meshPolicy.getByRole("button", { name: "Apply Policy", exact: true });
  assert.equal(await applyPolicy.isEnabled(), true, await meshPolicy.innerText());
  await applyPolicy.evaluate(button => button.click());
  await meshPolicy.getByText("Policy saved. Current solver mesh is stale until a mesh build completes.", { exact: true }).waitFor();
  const meshScene = await waitScene(s => s.objects.find(o => o.id === objectId)?.object_mesh?.maximum_element_size === "2e-8");
  const meshWrites = writes.slice(beforeMeshWrites);
  assert.equal(meshWrites.length, 1); assert.equal(meshWrites[0].method, "PUT");
  assert.ok(meshWrites[0].path.includes(encodeURIComponent(objectId)));
  const policyRead = await json(await context.request.get(`${target.api_base}${meshWrites[0].path}`, { headers: headers() }));
  assert.equal(policyRead.object_id, objectId); assert.equal(policyRead.config.maximum_element_size, "2e-8"); assert.equal(policyRead.config.mode, "custom");
  assert.deepEqual(meshScene.current_transports, materialScene.current_transports);
  assert.deepEqual(meshScene.antenna_port_modes, materialScene.antenna_port_modes);
  const meshObject = meshScene.objects.find(o => o.id === objectId), beforeMeshObject = materialScene.objects.find(o => o.id === objectId);
  assert.deepEqual(meshObject.geometry, beforeMeshObject.geometry); assert.deepEqual(meshObject.transform, beforeMeshObject.transform);
  assert.equal(meshObject.magnetization_ref ?? null, beforeMeshObject.magnetization_ref ?? null);
  const meshStability = await page.evaluate(() => {
    const { proof, observer, sample } = window.__antennaMeshPolicyProof; sample(); observer.disconnect();
    return { root: proof.root.isConnected, focus: document.activeElement === proof.input, scroll: proof.scroll.scrollTop === proof.scrollTop,
      rootChanges: proof.rootChanges, controlChanges: proof.controlChanges, disabledChanges: proof.disabledChanges, opacityChanges: proof.opacityChanges, opacityAnimations: proof.opacityAnimations, samples: proof.samples };
  });
  assert.ok(meshStability.samples > 1 && meshStability.samples < 100);
  assert.deepEqual({ ...meshStability, samples: 0 }, { root: true, focus: true, scroll: true, rootChanges: 0, controlChanges: 0, disabledChanges: 0, opacityChanges: 0, opacityAnimations: 0, samples: 0 });
  for (const label of ["Report state", "Quality state"]) {
    await meshPolicy.getByText(label, { exact: true }).locator("..").getByText("not published", { exact: true }).waitFor();
  }
  await screenshot("07-antenna-object-mesh-policy");
  await selectNode(`model:object:${objectId}:antenna:conductor`);
  await page.locator('[data-inspector-owner="object.antenna.conductor"]').getByText("authored", { exact: true }).waitFor();
  await selectNode(`model:object:${objectId}:mesh`);
  await meshPolicy.getByRole("checkbox", { name: "Use object policy", exact: true }).waitFor();
  assert.equal(await maximumSize.inputValue(), "2e-8");
  checks.push({ name: "Antenna Mesh node and Conductor link use the canonical object policy, save 20 nm without building, and retain source physics and Inspector stability", passed: true, stability: meshStability });


  await page.getByTitle("Expand All").click();
  await selectNode(`model:object:${objectId}:antenna:solution:${encodeURIComponent(stage.id)}`);
  const beforeProjection = await scene(), beforeProjectionWrites = writes.length;
  const composer = page.getByTestId("antenna-projection-composer");
  const projectionTarget = composer.getByRole("combobox", { name: "Projection target", exact: true });
  await page.getByRole("combobox", { name: "Field-sampling domain", exact: true }).selectOption(JSON.stringify(["object", objectId]));
  await selectNode(`model:object:${objectId}:geometry`);
  const dirtyGuard = page.getByRole("dialog", { name: "Unapplied Inspector changes" });
  await dirtyGuard.waitFor();
  assert.equal(await dirtyGuard.getByRole("button", { name: "Apply and continue", exact: true }).isEnabled(), true);
  await dirtyGuard.getByRole("button", { name: "Cancel", exact: true }).click();
  await projectionTarget.selectOption(JSON.stringify(["global"]));
  await selectNode(`model:object:${objectId}:geometry`);
  await dirtyGuard.waitFor();
  assert.equal(await dirtyGuard.getByRole("button", { name: "Apply and continue", exact: true }).isEnabled(), false);
  await dirtyGuard.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Revert field-solve settings", exact: true }).click();
  assert.equal(writes.length, beforeProjectionWrites);
  checks.push({ name: "A clean projection form cannot hide dirty sampling; two dirty forms block aggregate Apply and retain separate drafts without writes", passed: true });

  assert.equal(await composer.getByRole("combobox", { name: "Run stage", exact: true }).count(), 0);
  await projectionTarget.focus();
  await page.evaluate(() => {
    const root = document.querySelector('[data-testid="antenna-projection-composer"]'), input = document.activeElement, scroll = root.closest(".fm-inspector__body");
    const controls = [...root.querySelectorAll("input, select")].map(element => ({ element, disabled: element.disabled, opacity: getComputedStyle(element).opacity }));
    const proof = { root, input, scroll, top: scroll.scrollTop, rootChanges: 0, controlChanges: 0, disabledChanges: 0, opacityChanges: 0, opacityAnimations: 0, samples: 0 };
    const sample = () => {
      proof.samples++;
      if (document.querySelector('[data-testid="antenna-projection-composer"]') !== root) proof.rootChanges++;
      for (const saved of controls) {
        if (!saved.element.isConnected) proof.controlChanges++;
        if (saved.element.disabled !== saved.disabled) proof.disabledChanges++;
        if (getComputedStyle(saved.element).opacity !== saved.opacity) proof.opacityChanges++;
      }
      proof.opacityAnimations += root.getAnimations({ subtree: true }).filter(animation => (animation.playState === "running" || animation.pending) && animation.effect?.getKeyframes().some(frame => "opacity" in frame)).length;
    };
    const observer = new MutationObserver(sample); observer.observe(root, { attributes: true, childList: true, subtree: true }); sample();
    window.__projectionProof = { proof, observer, sample };
  });
  await composer.getByRole("button", { name: "Create projection", exact: true }).evaluate(button => button.click());
  await composer.getByText("Projection committed without a drive or Run stage.", { exact: false }).waitFor();
  const projected = await waitScene(s => s.antenna_target_projections?.length === (beforeProjection.antenna_target_projections?.length ?? 0) + 1);
  assert.deepEqual(projected.solved_antenna_drives, beforeProjection.solved_antenna_drives);
  assert.deepEqual(projected.study, beforeProjection.study);
  assert.deepEqual(projected.current_transports, beforeProjection.current_transports);
  assert.deepEqual(projected.antenna_field_solve_stages, beforeProjection.antenna_field_solve_stages);
  const projection = projected.antenna_target_projections.at(-1);
  assert.deepEqual(projection.target, { kind: "global" });
  assert.equal(projection.solution.stage_id, stage.id);
  assert.equal(writes.length, beforeProjectionWrites + 1);
  assert.deepEqual(Object.keys(writes.at(-1).body.merge_patch), ["antenna_target_projections"]);
  assert.equal(await composer.getByRole("button", { name: "Create projection", exact: true }).isEnabled(), false);
  const projectionStable = await page.evaluate(() => {
    const { proof: p, observer, sample } = window.__projectionProof; sample(); observer.disconnect();
    return { root: document.querySelector('[data-testid="antenna-projection-composer"]') === p.root, focus: document.activeElement === p.input, scroll: p.scroll.scrollTop === p.top, rootChanges: p.rootChanges, controlChanges: p.controlChanges, disabledChanges: p.disabledChanges, opacityChanges: p.opacityChanges, opacityAnimations: p.opacityAnimations, samples: p.samples };
  });
  assert.ok(projectionStable.samples > 1 && projectionStable.samples < 100);
  assert.deepEqual({ ...projectionStable, samples: 0 }, { root: true, focus: true, scroll: true, rootChanges: 0, controlChanges: 0, disabledChanges: 0, opacityChanges: 0, opacityAnimations: 0, samples: 0 });
  await screenshot("08-independent-projection");
  checks.push({ name: "Projection-only creation uses one scoped real transaction, retains Inspector identity and focus, preserves physics and adds no Run or drive", passed: true, stability: projectionStable });
  await page.getByTitle("Expand All").click();
  await selectNode(`model:object:${objectId}:antenna:projection:${encodeURIComponent(projection.id)}`);
  const projectionEditor = page;
  await projectionEditor.getByRole("combobox", { name: "Target", exact: true }).selectOption(JSON.stringify(["object", objectId]));
  await projectionEditor.getByRole("button", { name: "Apply projection", exact: true }).click();
  const rebound = await waitScene(s => s.antenna_target_projections?.find(p => p.id === projection.id)?.target?.object_id === objectId);
  assert.deepEqual(rebound.antenna_target_projections.find(p => p.id === projection.id).solution, projection.solution);
  await projectionEditor.getByText("Resource committed.", { exact: false }).waitFor();
  const removeProjection = projectionEditor.getByRole("button", { name: "Remove projection (no cascade)", exact: true });
  await removeProjection.click();
  const removedProjection = await waitScene(s => !s.antenna_target_projections?.some(p => p.id === projection.id));
  assert.deepEqual(removedProjection.antenna_field_solve_stages, beforeProjection.antenna_field_solve_stages);
  assert.deepEqual(removedProjection.solved_antenna_drives, beforeProjection.solved_antenna_drives);
  assert.equal(writes.length, beforeProjectionWrites + 3);
  checks.push({ name: "Existing typed projection inspector edits the target while preserving source pins and removes the declaration without cascading", passed: true });
  await selectNode(`model:object:${objectId}:antenna:solution:${encodeURIComponent(stage.id)}`);
  const beforeFFT = await scene(), beforeFFTWrites = writes.length;
  const fftComposer = page.getByTestId("antenna-spectrum-composer");
  await fftComposer.getByRole("combobox", { name: "FFT target object", exact: true }).selectOption(objectId);
  const fillFFTVector = async (owner, label, values) => { for (const [index, axis] of ["X", "Y", "Z"].entries()) await owner.getByRole("textbox", { name: `${label} ${axis}`, exact: true }).fill(values[index]); };
  await fillFFTVector(fftComposer, "Plane origin", ["0", "0", "0"]);
  await fftComposer.getByRole("combobox", { name: "Plane orientation", exact: true }).selectOption("xz");
  assert.equal(await fftComposer.getByRole("textbox", { name: "Axis v Z", exact: true }).inputValue(), "1");
  assert.equal(await fftComposer.getByRole("textbox", { name: "Plane origin Z", exact: true }).inputValue(), "0");
  await fftComposer.getByRole("combobox", { name: "Plane orientation", exact: true }).selectOption("yz");
  await fftComposer.getByRole("combobox", { name: "Plane orientation", exact: true }).selectOption("xy");
  const originZ = fftComposer.getByRole("textbox", { name: "Plane origin Z", exact: true });
  await originZ.fill("1e-"); assert.equal(await originZ.inputValue(), "1e-");
  const originX = fftComposer.getByRole("textbox", { name: "Plane origin X", exact: true });
  await originX.fill("1,2"); assert.equal(await originX.inputValue(), "1,2");
  assert.equal(await originX.evaluate(input => input === document.activeElement), true);
  assert.equal(await fftComposer.getByTestId("antenna-sampling-plane-fields").locator("input").count(), 9);
  await originX.fill("0"); await originZ.fill("0");
  await fillFFTVector(fftComposer, "Axis v", ["1", "0", "0"]);
  for (const [name, value] of [["Extent u", "2e-7"], ["Extent v", "1e-7"], ["Samples u", "16"], ["Samples v", "8"]]) {
    await fftComposer.getByRole("textbox", { name, exact: true }).fill(value);
  }
  await fftComposer.getByRole("combobox", { name: "Window", exact: true }).selectOption("hann");
  const createFFT = fftComposer.getByRole("button", { name: "Create source FFT request", exact: true });
  assert.equal(await createFFT.isEnabled(), false);
  await fftComposer.getByText("Sampling axes must be orthonormal unit vectors.", { exact: true }).waitFor();
  await fftComposer.getByRole("combobox", { name: "Plane orientation", exact: true }).selectOption("xy");
  await fftComposer.getByRole("textbox", { name: "Samples u", exact: true }).fill("10000000");
  assert.equal(await createFFT.isEnabled(), false);
  await fftComposer.getByText("FFT grid exceeds the runtime limit of 10000000 samples.", { exact: true }).waitFor();
  const samplingResolution = fftComposer.getByTestId("antenna-sampling-resolution");
  await samplingResolution.getByText("80,000,000 samples · over budget", { exact: true }).waitFor();
  await fftComposer.getByRole("textbox", { name: "Samples u", exact: true }).fill("16");
  await samplingResolution.getByRole("button", { name: /Sampling resolution/ }).click();
  await samplingResolution.getByText("128 / 10,000,000", { exact: true }).waitFor();
  await samplingResolution.getByText("13.33 nm", { exact: true }).waitFor();
  await samplingResolution.getByText("14.29 nm", { exact: true }).waitFor();
  await samplingResolution.getByText("2.9452e+7 rad/m", { exact: true }).waitFor();
  await samplingResolution.getByText("-2.3562e+8 rad/m → 2.0617e+8 rad/m", { exact: true }).waitFor();
  await fftComposer.getByRole("textbox", { name: "Samples u", exact: true }).fill("32");
  await samplingResolution.getByText("256 / 10,000,000", { exact: true }).waitFor();
  await samplingResolution.getByText("6.452 nm", { exact: true }).waitFor();
  await fftComposer.getByRole("textbox", { name: "Samples u", exact: true }).fill("1e-");
  assert.equal(await samplingResolution.getByText("unavailable", { exact: true }).count(), 8);
  assert.equal(await createFFT.isEnabled(), false);
  await fftComposer.getByRole("textbox", { name: "Samples u", exact: true }).fill("16");
  await samplingResolution.scrollIntoViewIfNeeded(); await screenshot("09c-authored-sampling-resolution");
  assert.equal(await createFFT.isEnabled(), true); assert.equal(writes.length, beforeFFTWrites);
  checks.push({ name: "Authored sampling readout shows endpoint-inclusive pitch, exact even FFT k bounds and sample budget; count edits update locally and invalid text is unavailable without API writes", passed: true });
  await selectNode(`model:object:${objectId}:geometry`);
  await dirtyGuard.waitFor(); assert.equal(await dirtyGuard.getByRole("button", { name: "Apply and continue", exact: true }).isEnabled(), true);
  await dirtyGuard.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByTestId("antenna-projection-composer").getByRole("combobox", { name: "Projection target", exact: true }).selectOption(JSON.stringify(["global"]));
  await selectNode(`model:object:${objectId}:geometry`);
  await dirtyGuard.waitFor(); assert.equal(await dirtyGuard.getByRole("button", { name: "Apply and continue", exact: true }).isEnabled(), false);
  await dirtyGuard.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Discard projection draft", exact: true }).click();
  assert.equal(await fftComposer.getByRole("textbox", { name: "Samples u", exact: true }).inputValue(), "16");
  const fftSamples = fftComposer.getByRole("textbox", { name: "Samples v", exact: true });
  await fftSamples.focus();
  await page.evaluate(() => {
    const root = document.querySelector('[data-testid="antenna-spectrum-composer"]'), input = document.activeElement, scroll = root.closest(".fm-inspector__body");
    const controls = [...root.querySelectorAll("input, select")].map(element => ({ element, disabled: element.disabled, opacity: getComputedStyle(element).opacity }));
    const proof = { root, input, scroll, top: scroll.scrollTop, rootChanges: 0, controlChanges: 0, disabledChanges: 0, opacityChanges: 0, opacityAnimations: 0, samples: 0 };
    const sample = () => {
      proof.samples++;
      if (document.querySelector('[data-testid="antenna-spectrum-composer"]') !== root) proof.rootChanges++;
      for (const saved of controls) {
        if (!saved.element.isConnected) proof.controlChanges++;
        if (saved.element.disabled !== saved.disabled) proof.disabledChanges++;
        if (getComputedStyle(saved.element).opacity !== saved.opacity) proof.opacityChanges++;
      }
      proof.opacityAnimations += root.getAnimations({ subtree: true }).filter(animation => (animation.playState === "running" || animation.pending) && animation.effect?.getKeyframes().some(frame => "opacity" in frame)).length;
    };
    const observer = new MutationObserver(sample); observer.observe(root, { attributes: true, childList: true, subtree: true }); sample(); window.__fftProof = { proof, observer, sample };
  });
  await createFFT.evaluate(button => button.click());
  await fftComposer.getByText("Source FFT request committed. No spectrum was computed;", { exact: false }).waitFor();
  const fftScene = await waitScene(s => s.antenna_spectrum_requests?.length === (beforeFFT.antenna_spectrum_requests?.length ?? 0) + 1);
  const fft = fftScene.antenna_spectrum_requests.at(-1);
  assert.equal(fft.solution_ref.stage_id, stage.id); assert.equal(fft.port_mode_id, stage.port_mode_ids[0]); assert.equal(fft.target.object_id, objectId);
  assert.equal(fft.transform, "spatial_fft"); assert.equal(fft.window, "hann"); assert.equal(fft.normalization, "integral_si");
  assert.deepEqual(fft.sampling_plane.origin_m, [0, 0, 0]); assert.deepEqual(fft.sampling_plane.axis_u, [1, 0, 0]); assert.deepEqual(fft.sampling_plane.axis_v, [0, 1, 0]);
  assert.equal(fft.sampling_plane.sample_count_u, 16); assert.equal(fft.sampling_plane.sample_count_v, 8); assert.equal(fft.sampling_plane.extent_u_m, 2e-7);
  for (const collection of ["antenna_field_solve_stages", "antenna_port_modes", "current_transports", "solved_antenna_drives", "study"]) assert.deepEqual(fftScene[collection], beforeFFT[collection]);
  assert.deepEqual(Object.keys(writes.at(-1).body.merge_patch), ["antenna_spectrum_requests"]); assert.equal(writes.length, beforeFFTWrites + 1);
  assert.equal(await createFFT.isEnabled(), false);
  const fftStable = await page.evaluate(() => {
    const { proof: p, observer, sample } = window.__fftProof; sample(); observer.disconnect();
    return { root: document.querySelector('[data-testid="antenna-spectrum-composer"]') === p.root, focus: document.activeElement === p.input, scroll: p.scroll.scrollTop === p.top, rootChanges: p.rootChanges, controlChanges: p.controlChanges, disabledChanges: p.disabledChanges, opacityChanges: p.opacityChanges, opacityAnimations: p.opacityAnimations, samples: p.samples };
  });
  assert.ok(fftStable.samples > 1 && fftStable.samples < 100);
  assert.deepEqual({ ...fftStable, samples: 0 }, { root: true, focus: true, scroll: true, rootChanges: 0, controlChanges: 0, disabledChanges: 0, opacityChanges: 0, opacityAnimations: 0, samples: 0 });
  await screenshot("09-source-fft-request");
  checks.push({ name: "FFT validates axes and native budget before writes, shares the draft guard, and saves one canonical request with stable focus, scroll and controls", passed: true, stability: fftStable });
  await page.getByTitle("Expand All").click();
  await selectNode(`model:object:${objectId}:antenna:spectrum:${encodeURIComponent(fft.id)}`);
  await page.getByRole("combobox", { name: "Window", exact: true }).selectOption("blackman");
  const editedPlane = page.getByTestId("antenna-sampling-plane-fields");
  await editedPlane.getByRole("combobox", { name: "Plane orientation", exact: true }).selectOption("xz");
  const editedOriginZ = editedPlane.getByRole("textbox", { name: "Plane origin Z", exact: true });
  await editedOriginZ.fill("2e-9");
  await page.getByRole("button", { name: "Apply spectrum", exact: true }).evaluate(button => {
    button.click();
    const input = document.querySelector('[data-testid="antenna-sampling-plane-fields"] [aria-label="Plane origin Y"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"1e-");
    input.dispatchEvent(new Event("input",{bubbles:true}));
  });
  const editedFFT = await waitScene(s => s.antenna_spectrum_requests?.find(r => r.id === fft.id)?.window === "blackman");
  assert.deepEqual(editedFFT.antenna_spectrum_requests.find(r => r.id === fft.id).solution_ref, fft.solution_ref);
  await page.getByText("Resource committed.", { exact: false }).waitFor();
  assert.deepEqual(editedFFT.antenna_spectrum_requests.find(r => r.id === fft.id).sampling_plane.axis_v, [0,0,1]);
  assert.deepEqual(editedFFT.antenna_spectrum_requests.find(r => r.id === fft.id).sampling_plane.origin_m, [0,0,2e-9]);
  const editedOriginY = editedPlane.getByRole("textbox", { name: "Plane origin Y", exact: true });
  assert.equal(await editedOriginY.inputValue(), "1e-");
  assert.equal(await page.getByRole("button", { name: "Apply spectrum", exact: true }).isEnabled(), false);
  await editedOriginY.fill("1e-9"); await editedOriginY.focus();
  await editedPlane.evaluate(root => {
    const controls=[...root.querySelectorAll("input,select")].map(element=>({element,value:element.value,disabled:element.disabled,opacity:getComputedStyle(element).opacity})), input=document.activeElement, scroll=root.closest(".fm-inspector__body");
    const proof={root,input,scroll,top:scroll.scrollTop,changes:0,values:0,valueChanges:[],disabled:0,opacity:0,samples:0};
    const sample=()=>{proof.samples++;for(const saved of controls){if(!saved.element.isConnected)proof.changes++;if(saved.element.value!==saved.value){proof.values++;proof.valueChanges.push({name:saved.element.getAttribute("aria-label"),before:saved.value,after:saved.element.value});}if(saved.element.disabled!==saved.disabled)proof.disabled++;if(getComputedStyle(saved.element).opacity!==saved.opacity)proof.opacity++;}};
    const observer=new MutationObserver(sample);observer.observe(root,{attributes:true,childList:true,subtree:true});sample();window.__planeProof={proof,observer,sample};
  });
  await page.getByRole("button", { name: "Apply spectrum", exact: true }).evaluate(button=>button.click());
  await waitScene(s => s.antenna_spectrum_requests.find(r => r.id === fft.id)?.sampling_plane.origin_m[1] === 1e-9);
  await page.getByText("Resource committed.", { exact: false }).waitFor();
  const planeStability=await page.evaluate(()=>{const{proof,observer,sample}=window.__planeProof;sample();observer.disconnect();return{root:proof.root.isConnected,focus:document.activeElement===proof.input,scroll:proof.scroll.scrollTop===proof.top,changes:proof.changes,values:proof.values,valueChanges:proof.valueChanges,disabled:proof.disabled,opacity:proof.opacity,samples:proof.samples};});
  assert.ok(planeStability.samples>0 && planeStability.samples<100);
  assert.deepEqual({...planeStability,samples:0},{root:true,focus:true,scroll:true,changes:0,values:0,valueChanges:[],disabled:0,opacity:0,samples:0});
  await editedPlane.scrollIntoViewIfNeeded(); await screenshot("09b-edited-fft-plane");
  const editedResolution = page.getByTestId("antenna-sampling-resolution");
  await editedResolution.getByRole("button", { name: /Sampling resolution/ }).click();
  await editedResolution.getByText("128 / 10,000,000", { exact: true }).waitFor();
  await editedResolution.getByText("13.33 nm", { exact: true }).waitFor();
  await editedResolution.scrollIntoViewIfNeeded(); await screenshot("09d-edited-sampling-resolution");
  checks.push({name:"Shared XYZ plane controls preserve invalid text, explicit orientation and late edits through real FFT API saves with stable controls/values/focus/scroll",passed:true,stability:planeStability});
  const beforeNonuniform = await scene();
  const nonuniformRequest = { base_revision: beforeNonuniform.revision, kind: "merge_patch", merge_patch: { antenna_spectrum_requests: beforeNonuniform.antenna_spectrum_requests.map(item => item.id === fft.id ? { ...item, transform: "nonuniform_spatial_fft", nonuniform_k_grid: { k_u_rad_per_m: [0,1e6], k_v_rad_per_m: [0,1e6] } } : item) } };
  await json(await context.request.post(`${target.api_base}/v2/sessions/current/model/transactions`, { headers: headers(), data: nonuniformRequest }));
  writes.push({ method: "POST", path: "/v2/sessions/current/model/transactions", body: nonuniformRequest, instance: target.api_instance, scope, source: "public_api_nonuniform_request_setup" });
  await waitScene(s => s.antenna_spectrum_requests.find(item => item.id === fft.id)?.transform === "nonuniform_spatial_fft");
  await editedResolution.getByText("nonuniform grid", { exact: true }).waitFor();
  await editedResolution.getByText("Uniform FFT spacing and k bounds do not describe a nonuniform k-grid.", { exact: false }).waitFor();
  assert.equal(await editedResolution.getByText("FFT Δk u", { exact: true }).count(), 0);
  checks.push({ name: "A nonuniform request authored through the public API replaces uniform-bin readouts with an explicit limitation instead of inventing a regular k-grid", passed: true });
  await page.getByRole("button", { name: "Remove spectrum (no cascade)", exact: true }).click();
  const removedFFT = await waitScene(s => !s.antenna_spectrum_requests?.some(r => r.id === fft.id));
  assert.deepEqual(removedFFT.antenna_field_solve_stages, beforeFFT.antenna_field_solve_stages);
  assert.equal(writes.length, beforeFFTWrites + 5);
  checks.push({ name: "Existing spectrum inspector edits the request without rebinding its source and removes it without cascading or running analysis", passed: true });
  await selectNode(`model:object:${objectId}:antenna:solution:${encodeURIComponent(stage.id)}`);
  const add = page.getByRole("button", { name: "Add Field Solve to Study", exact: true });
  await add.waitFor(); assert.equal(await add.isEnabled(), true); await add.click();
  const open = page.getByRole("button", { name: "Open Study stage", exact: true });
  await open.waitFor(); assert.equal(await open.isEnabled(), true); await open.click();
  await page.getByText("Antenna Definition Reference", { exact: true }).waitFor();
  await screenshot("03-real-study-stage");
  const queued = await scene();
  const flat = queued.study?.stages ?? [];
  const visit = nodes => (nodes ?? []).flatMap(node => [node, ...visit(node.children)]);
  const pipeline = visit(queued.study?.study_pipeline?.nodes);
  const references = [...flat.filter(s => s.kind === "antenna_field_solve" && s.stage_id === stage.id), ...pipeline.filter(n => n.stage_kind === "antenna_field_solve" && n.payload?.stage_id === stage.id)];
  assert.equal(references.length, 1);
  checks.push({ name: "Add and Open Field Solve reaches the actual Study inspector with one canonical definition reference", passed: true });
  const beforeReceiver = await scene();
  async function publicCommand(title) {
    await page.getByRole("button", { name: /command search/i }).first().click();
    await page.getByPlaceholder("Search commands").fill(title);
    await page.getByRole("option").filter({ hasText: title }).first().click();
  }
  await publicCommand("Add Box");
  await page.getByText("Primitive Geometry", { exact: true }).first().waitFor();
  for (const [name, value] of [["Name", "Antenna drive receiver"], ["Region", "antenna-drive-receiver"], ["Size X", "1e-7"], ["Size Y", "2e-7"], ["Size Z", "1e-8"], ["Translation Z", "1e-7"]]) {
    await page.getByRole("textbox", { name, exact: true }).fill(value);
  }
  await page.getByRole("button", { name: "Apply Draft", exact: true }).click();
  const withReceiver = await waitScene(s => s.objects.length === beforeReceiver.objects.length + 1);
  const receiver = withReceiver.objects.find(o => !beforeReceiver.objects.some(old => old.id === o.id));
  assert.ok(receiver?.id && receiver.id !== objectId);
  await page.locator(`[data-node-id="model:object:${receiver.id}"]`).waitFor({ state: "visible" });
  await publicCommand("Add Run Stage");
  const withRun = await waitScene(s => s.study?.stages?.some(item => item.kind === "run"));
  const runInstructions = withRun.study.stages.filter(item => item.kind === "run"); assert.equal(runInstructions.length, 1);
  // The pipeline editor is read-only. Seed its canonical representation through
  // the public transaction API while retaining the real UI-authored payloads.
  const pipelineNodes = withRun.study.stages.map((payload, index) => ({ id: `activation-node-${index + 1}`, label: `${payload.kind} ${index + 1}`, node_kind: "primitive", stage_kind: payload.kind, enabled: true, payload }));
  const runNode = pipelineNodes.find(node => node.stage_kind === "run");
  assert.notEqual(runNode.id, runNode.payload.stage_id);
  const pipelineRequest = { base_revision: withRun.revision, kind: "merge_patch", merge_patch: { study: { study_pipeline: { version: "study_pipeline.v1", nodes: pipelineNodes } } } };
  await json(await context.request.post(`${target.api_base}/v2/sessions/current/model/transactions`, { headers: headers(), data: pipelineRequest }));
  writes.push({ method: "POST", path: "/v2/sessions/current/model/transactions", body: pipelineRequest, instance: target.api_instance, scope, source: "public_api_pipeline_setup" });
  const pipelineScene = await waitScene(s => s.study?.study_pipeline?.nodes?.some(node => node.id === runNode.id));
  assert.deepEqual(pipelineScene.study.stages, withRun.study.stages, "Dormant flat instructions remain intact");
  await page.getByTitle("Expand All").click();
  await selectNode(`model:object:${objectId}:antenna:solution:${encodeURIComponent(stage.id)}`);
  const driveComposer = page.getByTestId("antenna-projection-composer");
  await driveComposer.getByRole("combobox", { name: "Projection composition", exact: true }).selectOption("drive");
  await driveComposer.getByRole("combobox", { name: "Projection target", exact: true }).selectOption(JSON.stringify(["object", receiver.id]));
  const runChoice = driveComposer.getByRole("combobox", { name: "Run stage", exact: true });
  await runChoice.selectOption(runNode.id);
  const runOptions = await runChoice.locator("option").evaluateAll(options => options.map(option => option.value).filter(Boolean));
  assert.deepEqual(runOptions, [runNode.id]); assert.ok(!runOptions.includes(runNode.payload.stage_id));
  await driveComposer.getByRole("textbox", { name: "Peak current", exact: true }).fill("0.01");
  await driveComposer.getByRole("textbox", { name: "Frequency", exact: true }).fill("1e9");
  const beforeDrive = await scene(), beforeDriveWrites = writes.length;
  await driveComposer.getByRole("button", { name: "Create projection and drive", exact: true }).click();
  await driveComposer.getByText("Projection and drive committed.", { exact: false }).waitFor();
  const driven = await waitScene(s => (s.solved_antenna_drives?.length ?? 0) === (beforeDrive.solved_antenna_drives?.length ?? 0) + 1);
  const drive = driven.solved_antenna_drives.at(-1);
  assert.deepEqual(drive.activation, { kind: "stage_ids", stage_ids: [runNode.id] });
  assert.equal(drive.peak_current_a, 0.01); assert.equal(drive.time_origin, "stage_local");
  assert.deepEqual(drive.waveform, { kind: "sinusoidal", frequency_hz: 1e9, phase_rad: 0, offset: 0 });
  assert.equal(driven.antenna_target_projections.find(p => p.id === drive.projection_ref)?.target?.object_id, receiver.id);
  assert.equal(drive.port_mode_id, stage.port_mode_ids[0]);
  assert.deepEqual(driven.study, beforeDrive.study); assert.deepEqual(driven.current_transports, beforeDrive.current_transports);
  assert.equal(writes.length, beforeDriveWrites + 1);
  assert.deepEqual(Object.keys(writes.at(-1).body.merge_patch).sort(), ["antenna_target_projections", "solved_antenna_drives"]);
  await screenshot("10-pipeline-drive-composition");
  await page.getByTitle("Expand All").click();
  await selectNode(`model:object:${objectId}:antenna:drive:${encodeURIComponent(drive.id)}`);
  const activation = page.getByRole("checkbox", { name: runNode.label, exact: true });
  await activation.waitFor(); assert.equal(await activation.isChecked(), true);
  assert.equal(await page.getByRole("textbox", { name: "Stage IDs", exact: true }).count(), 0);
  await page.getByText(`Executable stage ID: ${runNode.id}`, { exact: true }).waitFor();
  await screenshot("11-pipeline-drive-inspector");
  checks.push({ name: "Real UI-authored receiver and Run, represented by the public pipeline API, bind one atomic antenna drive to the executable queue ID and display it in the existing drive editor", passed: true, setup: "receiver and flat Run via UI; pipeline representation via public API; composition and inspection via UI", queueId: runNode.id, definitionId: runNode.payload.stage_id });
  const driveEditor = page.getByTestId("antenna-drive-editor"), currentPreview = page.getByTestId("antenna-drive-preview");
  const drivePeak = driveEditor.getByRole("textbox", { name: "Peak current", exact: true });
  const driveSave = driveEditor.getByRole("button", { name: "Save drive", exact: true });
  assert.equal(await driveSave.isEnabled(), false, "A clean drive must not submit another transaction");
  const beforeDriveEditWrites = writes.length;
  await driveEditor.getByRole("textbox", { name: "Frequency", exact: true }).fill("0");
  assert.equal(await driveSave.isEnabled(), false);
  await selectNode(`model:object:${objectId}:geometry`);
  await dirtyGuard.waitFor();
  assert.equal(await dirtyGuard.getByRole("button", { name: "Apply and continue", exact: true }).isEnabled(), false);
  await dirtyGuard.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await driveEditor.getByRole("textbox", { name: "Frequency", exact: true }).inputValue(), "0");
  await driveEditor.getByRole("textbox", { name: "Frequency", exact: true }).fill("1e9");
  await drivePeak.fill("-0.02");
  await driveEditor.getByRole("textbox", { name: "Phase", exact: true }).fill(String(Math.PI / 2));
  await driveEditor.getByRole("textbox", { name: "Offset", exact: true }).fill("0.5");
  await driveEditor.getByRole("combobox", { name: "Time origin", exact: true }).selectOption("absolute");
  await currentPreview.getByRole("textbox", { name: "Preview to", exact: true }).fill("1e-5");
  await currentPreview.getByRole("alert").filter({ hasText: "Reduce the preview time range" }).last().waitFor();
  await currentPreview.getByRole("textbox", { name: "Preview to", exact: true }).fill("2e-9");
  const previewCursor = currentPreview.getByRole("slider", { name: "Preview sample", exact: true });
  await previewCursor.focus(); await previewCursor.press("Home");
  await currentPreview.getByText("-3.000000e-2 A", { exact: true }).waitFor();
  const previewImage = currentPreview.getByRole("img", { name: /Authored antenna current I/ });
  await previewImage.waitFor();
  const chartCanvas = currentPreview.locator("canvas");
  await chartCanvas.waitFor(); assert.equal(await chartCanvas.isVisible(), true);
  const chartDimensions = await chartCanvas.evaluate(canvas => ({ width: canvas.width, height: canvas.height }));
  assert.ok(chartDimensions.width > 0 && chartDimensions.height > 0);
  await screenshot("12-authored-current-preview");
  await selectNode(`model:object:${objectId}:geometry`);
  await dirtyGuard.waitFor();
  assert.equal(await dirtyGuard.getByRole("button", { name: "Apply and continue", exact: true }).isEnabled(), true);
  await dirtyGuard.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(writes.length, beforeDriveEditWrites, "Preview and cancelled navigation are read-only");
  checks.push({ name: "Drive guard preserves invalid and valid drafts on cancelled navigation; bounded I(t) preview exposes SI units, signed phase/offset current, keyboard cursor and a real chart canvas", passed: true, chartDimensions });
  await drivePeak.focus();
  await page.evaluate(() => {
    const root = document.querySelector('[data-testid="antenna-drive-editor"]'), input = document.activeElement, scroll = root.closest(".fm-inspector__body");
    const controls = [...root.querySelectorAll("input, select")].map(element => ({ element, disabled: element.disabled, opacity: getComputedStyle(element).opacity }));
    const proof = { root, input, scroll, top: scroll.scrollTop, rootChanges: 0, controlChanges: 0, disabledChanges: 0, opacityChanges: 0, opacityAnimations: 0, samples: 0 };
    const sample = () => {
      proof.samples++;
      if (document.querySelector('[data-testid="antenna-drive-editor"]') !== root) proof.rootChanges++;
      for (const saved of controls) {
        if (!saved.element.isConnected) proof.controlChanges++;
        if (saved.element.disabled !== saved.disabled) proof.disabledChanges++;
        if (getComputedStyle(saved.element).opacity !== saved.opacity) proof.opacityChanges++;
      }
      proof.opacityAnimations += root.getAnimations({ subtree: true }).filter(animation => (animation.playState === "running" || animation.pending) && animation.effect?.getKeyframes().some(frame => "opacity" in frame)).length;
    };
    const observer = new MutationObserver(sample); observer.observe(root, { attributes: true, childList: true, subtree: true }); sample(); window.__driveProof = { proof, observer, sample };
  });
  await driveSave.evaluate(button => button.click());
  const editedDriveScene = await waitScene(s => s.solved_antenna_drives.find(item => item.id === drive.id)?.time_origin === "absolute");
  await driveEditor.getByText("Antenna drive committed.", { exact: true }).waitFor();
  const editedDrive = editedDriveScene.solved_antenna_drives.find(item => item.id === drive.id);
  assert.equal(editedDrive.peak_current_a, -0.02); assert.equal(editedDrive.waveform.phase_rad, Math.PI / 2); assert.equal(editedDrive.waveform.offset, 0.5);
  assert.equal(editedDrive.projection_ref, drive.projection_ref); assert.equal(editedDrive.port_mode_id, drive.port_mode_id);
  assert.deepEqual(editedDrive.activation, drive.activation); assert.deepEqual(editedDriveScene.study, driven.study);
  assert.equal(writes.length, beforeDriveEditWrites + 1);
  assert.equal(await driveSave.isEnabled(), false);
  const driveStability = await page.evaluate(() => {
    const { proof, observer, sample } = window.__driveProof; sample(); observer.disconnect();
    return { root: proof.root.isConnected, focus: document.activeElement === proof.input, scroll: proof.scroll.scrollTop === proof.top,
      rootChanges: proof.rootChanges, controlChanges: proof.controlChanges, disabledChanges: proof.disabledChanges, opacityChanges: proof.opacityChanges, opacityAnimations: proof.opacityAnimations, samples: proof.samples };
  });
  assert.ok(driveStability.samples > 1 && driveStability.samples < 200);
  assert.deepEqual({ ...driveStability, samples: 0 }, { root: true, focus: true, scroll: true, rootChanges: 0, controlChanges: 0, disabledChanges: 0, opacityChanges: 0, opacityAnimations: 0, samples: 0 });
  await drivePeak.fill("0.7");
  await driveEditor.getByRole("button", { name: "Reset drive", exact: true }).click();
  assert.equal(await drivePeak.inputValue(), "-0.02"); assert.equal(writes.length, beforeDriveEditWrites + 1);
  await currentPreview.scrollIntoViewIfNeeded(); await screenshot("13-current-preview-committed");
  checks.push({ name: "Drive edits persist signed current and absolute clock through one real API transaction while preserving bindings, root, focus, scroll and unrelated controls; Reset remains local", passed: true, stability: driveStability });
  await driveEditor.getByRole("combobox", { name: "Time origin", exact: true }).selectOption("stage_local");
  await selectNode(`model:object:${objectId}:geometry`);
  await dirtyGuard.waitFor();
  await dirtyGuard.getByRole("button", { name: "Apply and continue", exact: true }).click();
  await geometry.waitFor();
  const appliedDrive = await waitScene(s => s.solved_antenna_drives.find(item => item.id === drive.id)?.time_origin === "stage_local");
  assert.equal(appliedDrive.solved_antenna_drives.find(item => item.id === drive.id).peak_current_a, -0.02);
  assert.equal(writes.length, beforeDriveEditWrites + 2);
  checks.push({ name: "Global Apply and continue awaits the real drive ACK and transitions only after the draft is clean", passed: true });
  await selectNode(`model:object:${objectId}:antenna:drive:${encodeURIComponent(drive.id)}`);
  const waveformChoice = driveEditor.getByRole("combobox", { name: "Waveform", exact: true });
  await waveformChoice.selectOption("piecewise_linear");
  const pointTable = page.getByTestId("antenna-piecewise-points"), addPoint = pointTable.getByRole("button", { name: "Add waveform point", exact: true });
  assert.equal(await driveEditor.getByRole("textbox", { name: "Points [time, amplitude]", exact: true }).count(), 0);
  for (let count = 0; count < 11; count++) await addPoint.click();
  await pointTable.getByText("13–13 of 13 points", { exact: true }).waitFor();
  assert.equal(await pointTable.locator("tbody tr").count(), 1);
  await pointTable.getByRole("button", { name: "Remove point 13", exact: true }).click();
  assert.equal(await pointTable.getByRole("textbox", { name: "Point 12 time", exact: true }).evaluate(input => input === document.activeElement), true);
  await addPoint.click();
  await pointTable.getByText("13–13 of 13 points", { exact: true }).waitFor();
  await pointTable.getByRole("button", { name: "Previous points", exact: true }).click();
  assert.equal(await pointTable.locator("tbody tr").count(), 12);
  await pointTable.getByText("1–12 of 13 points", { exact: true }).waitFor();
  await pointTable.getByRole("button", { name: "Next points", exact: true }).click();
  await pointTable.getByRole("textbox", { name: "Point 13 time", exact: true }).waitFor();
  assert.equal(writes.length, beforeDriveEditWrites + 2, "Point pagination and incomplete drafts must not write");
  await driveEditor.getByRole("button", { name: "Reset drive", exact: true }).click();
  await waveformChoice.selectOption("piecewise_linear");
  await addPoint.click();
  await pointTable.getByRole("textbox", { name: "Point 3 time", exact: true }).fill("2e-9");
  await pointTable.getByRole("textbox", { name: "Point 3 multiplier", exact: true }).fill("-1");
  await addPoint.click();
  await pointTable.getByRole("textbox", { name: "Point 4 time", exact: true }).fill("3e-9");
  await pointTable.getByRole("textbox", { name: "Point 4 multiplier", exact: true }).fill("0.5");
  await page.evaluate(() => {
    const root=document.querySelector('[data-testid="antenna-piecewise-points"]');
    window.__thirdPoint=root.querySelector('[aria-label="Point 3 time"]'); window.__fourthPoint=root.querySelector('[aria-label="Point 4 time"]');
  });
  await pointTable.getByRole("button", { name: "Remove point 1", exact: true }).click();
  assert.equal(await pointTable.getByRole("textbox", { name: "Point 2 time", exact: true }).evaluate(input => input === window.__thirdPoint), true);
  await pointTable.getByRole("button", { name: "Remove point 2", exact: true }).click();
  assert.equal(await pointTable.getByRole("textbox", { name: "Point 2 time", exact: true }).evaluate(input => input === window.__fourthPoint && document.activeElement === input), true);
  assert.equal(await pointTable.getByRole("button", { name: "Remove point 1", exact: true }).isEnabled(), false);
  const secondTime = pointTable.getByRole("textbox", { name: "Point 2 time", exact: true });
  await secondTime.fill("1e-");
  assert.equal(await secondTime.inputValue(), "1e-"); assert.equal(await secondTime.getAttribute("aria-invalid"), "true");
  assert.equal(await driveSave.isEnabled(), false);
  await selectNode(`model:object:${objectId}:geometry`); await dirtyGuard.waitFor();
  assert.equal(await dirtyGuard.getByRole("button", { name: "Apply and continue", exact: true }).isEnabled(), false);
  await dirtyGuard.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await secondTime.inputValue(), "1e-");
  await secondTime.fill("1e-9"); assert.equal(await secondTime.getAttribute("aria-invalid"), "true");
  await pointTable.getByText("Times must be strictly increasing.", { exact: true }).waitFor();
  await secondTime.fill("3e-9");
  const firstMultiplier = pointTable.getByRole("textbox", { name: "Point 1 multiplier", exact: true });
  await firstMultiplier.fill("1."); assert.equal(await firstMultiplier.inputValue(), "1.");
  await pointTable.getByRole("textbox", { name: "Point 2 multiplier", exact: true }).fill("-0.5");
  await driveEditor.getByRole("textbox", { name: "Declared bandwidth", exact: true }).fill("5e9");
  await pointTable.scrollIntoViewIfNeeded(); await screenshot("14-piecewise-point-table");
  checks.push({ name: "Piecewise table replaces JSON, paginates explicitly, preserves incomplete text and cancelled navigation, rejects duplicate times and preserves surviving control identity/focus when removing first and middle knots", passed: true });
  const beforePointsWrites = writes.length;
  // Both real UI handlers run in the same browser task: the new row is authored
  // after fetch starts and before its real HTTP ACK can be handled. No route mocks.
  await driveSave.evaluate(button => {
    button.click();
    [...document.querySelectorAll('[data-testid="antenna-piecewise-points"] button')].find(item => item.textContent === "Add waveform point").click();
  });
  const savedPointsScene = await waitScene(s => s.solved_antenna_drives.find(item => item.id === drive.id)?.waveform?.kind === "piecewise_linear");
  await driveEditor.getByText("Antenna drive committed.", { exact: true }).waitFor();
  assert.deepEqual(savedPointsScene.solved_antenna_drives.find(item => item.id === drive.id).waveform.points, [[1e-9, 1], [3e-9, -0.5]]);
  assert.equal(writes.length, beforePointsWrites + 1);
  const thirdTime = pointTable.getByRole("textbox", { name: "Point 3 time", exact: true });
  await thirdTime.waitFor(); assert.equal(await thirdTime.inputValue(), "");
  assert.equal(await driveSave.isEnabled(), false, "Late ACK must retain the new incomplete row");
  checks.push({ name: "A row added by the real UI after submission remains in the draft after the real API ACK; the canonical waveform contains only the submitted numeric pairs", passed: true });
  await thirdTime.fill("4e-9");
  await pointTable.getByRole("textbox", { name: "Point 3 multiplier", exact: true }).fill("1.25");
  await thirdTime.focus();
  await page.evaluate(() => {
    const root=document.querySelector('[data-testid="antenna-piecewise-points"]'), input=document.activeElement, scroll=root.closest(".fm-inspector__body");
    const controls=[...root.querySelectorAll("input")].map(element=>({element,disabled:element.disabled,opacity:getComputedStyle(element).opacity}));
    const proof={root,input,scroll,top:scroll.scrollTop,controls,rootChanges:0,controlChanges:0,disabledChanges:0,opacityChanges:0,opacityAnimations:0,samples:0};
    const sample=()=>{
      proof.samples++;
      if(document.querySelector('[data-testid="antenna-piecewise-points"]')!==root)proof.rootChanges++;
      for(const saved of controls){if(!saved.element.isConnected)proof.controlChanges++;if(saved.element.disabled!==saved.disabled)proof.disabledChanges++;if(getComputedStyle(saved.element).opacity!==saved.opacity)proof.opacityChanges++;}
      proof.opacityAnimations+=root.getAnimations({subtree:true}).filter(animation=>(animation.playState==="running"||animation.pending)&&animation.effect?.getKeyframes().some(frame=>"opacity" in frame)).length;
    };
    const observer=new MutationObserver(sample);observer.observe(root,{attributes:true,childList:true,subtree:true});sample();window.__pointsProof={proof,observer,sample};
  });
  await driveSave.evaluate(button => button.click());
  const finalPointScene = await waitScene(s => s.solved_antenna_drives.find(item => item.id === drive.id)?.waveform?.points?.length === 3);
  await driveEditor.getByText("Antenna drive committed.", { exact: true }).waitFor();
  const finalPointDrive = finalPointScene.solved_antenna_drives.find(item => item.id === drive.id);
  assert.deepEqual(finalPointDrive.waveform.points, [[1e-9,1],[3e-9,-0.5],[4e-9,1.25]]);
  assert.equal(finalPointDrive.bandwidth_declaration.f_max_hz, 5e9); assert.equal(finalPointDrive.time_origin,"stage_local");
  assert.equal(finalPointDrive.peak_current_a,-0.02); assert.equal(finalPointDrive.projection_ref,drive.projection_ref); assert.equal(finalPointDrive.port_mode_id,drive.port_mode_id); assert.deepEqual(finalPointDrive.activation,drive.activation);
  const pointStability=await page.evaluate(()=>{
    const{proof,observer,sample}=window.__pointsProof;sample();observer.disconnect();return{root:proof.root.isConnected,focus:document.activeElement===proof.input,scroll:proof.scroll.scrollTop===proof.top,rootChanges:proof.rootChanges,controlChanges:proof.controlChanges,disabledChanges:proof.disabledChanges,opacityChanges:proof.opacityChanges,opacityAnimations:proof.opacityAnimations,samples:proof.samples};
  });
  assert.ok(pointStability.samples>1 && pointStability.samples<200);
  assert.deepEqual({...pointStability,samples:0},{root:true,focus:true,scroll:true,rootChanges:0,controlChanges:0,disabledChanges:0,opacityChanges:0,opacityAnimations:0,samples:0});
  assert.equal(writes.length,beforePointsWrites+2); assert.equal(await driveSave.isEnabled(),false);
  await selectNode(`model:object:${objectId}:geometry`);
  await selectNode(`model:object:${objectId}:antenna:drive:${encodeURIComponent(drive.id)}`);
  assert.equal(await pointTable.getByRole("textbox",{name:"Point 3 multiplier",exact:true}).inputValue(),"1.25");
  await pointTable.scrollIntoViewIfNeeded();await screenshot("15-piecewise-points-reopened");
  checks.push({name:"Numeric piecewise knots and declared bandwidth persist through real API and inspector reopen while preserving bindings, focus, scroll and every surviving input during ACK",passed:true,stability:pointStability});
  const driveNodeId = `model:object:${objectId}:antenna:drive:${encodeURIComponent(drive.id)}`;
  const driveNode = page.locator(`[data-node-id="${driveNodeId}"]`);
  const driveName = driveEditor.getByRole("textbox", { name: "Drive name", exact: true });
  assert.equal(finalPointDrive.name, "Current drive 1");
  await driveNode.getByText("Current drive 1", { exact: true }).waitFor();
  const beforeRenameWrites = writes.length;
  await driveName.fill("   ");
  assert.equal(await driveSave.isEnabled(), false);
  await selectNode(`model:object:${objectId}:geometry`); await dirtyGuard.waitFor();
  assert.equal(await dirtyGuard.getByRole("button", { name: "Apply and continue", exact: true }).isEnabled(), false);
  await dirtyGuard.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await driveName.inputValue(), "   "); assert.equal(writes.length, beforeRenameWrites);
  await driveName.fill("  RF to receiver  ");
  await driveName.focus();
  // Start a real request, then change only the local name before its ACK.
  await driveName.evaluate(input => {
    const root = input.closest('[data-testid="antenna-drive-editor"]'), scroll = root.closest(".fm-inspector__body");
    const controls = [...root.querySelectorAll("input, select")].map(element => ({ element, disabled: element.disabled, opacity: getComputedStyle(element).opacity }));
    const proof = { root, input, scroll, top: scroll.scrollTop, rootChanges: 0, controlChanges: 0, disabledChanges: 0, opacityChanges: 0, opacityAnimations: 0, samples: 0 };
    const sample = () => {
      proof.samples++;
      if (document.querySelector('[data-testid="antenna-drive-editor"]') !== root) proof.rootChanges++;
      for (const saved of controls) {
        if (!saved.element.isConnected) proof.controlChanges++;
        if (saved.element.disabled !== saved.disabled) proof.disabledChanges++;
        if (getComputedStyle(saved.element).opacity !== saved.opacity) proof.opacityChanges++;
      }
      proof.opacityAnimations += root.getAnimations({ subtree: true }).filter(animation => (animation.playState === "running" || animation.pending) && animation.effect?.getKeyframes().some(frame => "opacity" in frame)).length;
    };
    const observer = new MutationObserver(sample); observer.observe(root, { attributes: true, childList: true, subtree: true }); sample(); window.__nameProof = { proof, observer, sample };
    [...root.querySelectorAll("button")].find(button => button.textContent === "Save drive").click();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "RF to waveguide");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const renamedScene = await waitScene(s => s.solved_antenna_drives.find(item => item.id === drive.id)?.name === "RF to receiver");
  await driveEditor.getByText("Antenna drive committed.", { exact: true }).waitFor();
  assert.deepEqual(renamedScene.solved_antenna_drives.find(item => item.id === drive.id), { ...finalPointDrive, name: "RF to receiver" });
  await driveNode.getByText("RF to receiver", { exact: true }).waitFor();
  assert.equal(await driveNode.getAttribute("aria-selected"), "true");
  assert.equal(await driveName.inputValue(), "RF to waveguide");
  assert.equal(writes.length, beforeRenameWrites + 1);
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="antenna-drive-editor"] button')].some(button => button.textContent === "Save drive" && !button.disabled));
  await driveSave.evaluate(button => button.click());
  const finalNameScene = await waitScene(s => s.solved_antenna_drives.find(item => item.id === drive.id)?.name === "RF to waveguide");
  await driveEditor.getByText("Antenna drive committed.", { exact: true }).waitFor();
  await driveNode.getByText("RF to waveguide", { exact: true }).waitFor();
  assert.deepEqual(finalNameScene.solved_antenna_drives.find(item => item.id === drive.id), { ...finalPointDrive, name: "RF to waveguide" });
  assert.equal(writes.length, beforeRenameWrites + 2); assert.equal(await driveSave.isEnabled(), false);
  const nameStability = await page.evaluate(() => {
    const { proof, observer, sample } = window.__nameProof; sample(); observer.disconnect();
    return { root: proof.root.isConnected, focus: document.activeElement === proof.input, scroll: proof.scroll.scrollTop === proof.top,
      rootChanges: proof.rootChanges, controlChanges: proof.controlChanges, disabledChanges: proof.disabledChanges, opacityChanges: proof.opacityChanges, opacityAnimations: proof.opacityAnimations, samples: proof.samples };
  });
  assert.ok(nameStability.samples > 1 && nameStability.samples < 200);
  assert.deepEqual({ ...nameStability, samples: 0 }, { root: true, focus: true, scroll: true, rootChanges: 0, controlChanges: 0, disabledChanges: 0, opacityChanges: 0, opacityAnimations: 0, samples: 0 });
  await driveName.scrollIntoViewIfNeeded(); await screenshot("16-readable-drive-name");
  checks.push({ name: "Display-only rename rejects blank names, trims explicit renames, preserves immutable bindings and selection, and retains a newer local name through the real ACK with stable controls/focus/scroll", passed: true, stability: nameStability });
  // Select another node before filtering, so the selected-node pin cannot mask a search regression.
  await selectNode(`model:object:${objectId}:geometry`);
  const explorerSearch = page.getByPlaceholder("Filter nodes...");
  await explorerSearch.fill(drive.id);
  await driveNode.waitFor({ state: "visible" });
  await driveNode.getByText("RF to waveguide", { exact: true }).waitFor();
  await driveNode.click(); await driveName.waitFor();
  assert.equal(await driveName.inputValue(), "RF to waveguide");
  await explorerSearch.fill("");
  assert.equal(writes.length, beforeRenameWrites + 2);
  await screenshot("17-readable-antenna-explorer");
  checks.push({ name: "Explorer resolves full resource ID searches after selecting another node and reopens the same renamed drive without writes", passed: true });
  const readout = page.getByTestId("antenna-composition-readout");
  await readout.getByText("-20 mA", { exact: true }).waitFor();
  await readout.getByRole("heading", { name: "Execution and publication", exact: true }).waitFor();
  const identities = readout.getByRole("button", { name: /Identity and provenance/ });
  assert.equal(await identities.getAttribute("aria-expanded"), "false");
  assert.equal(await readout.getByText(drive.id, { exact: true }).isVisible(), false);
  const beforeReadoutWrites = writes.length;
  await identities.focus(); await identities.press("Enter");
  assert.equal(await identities.getAttribute("aria-expanded"), "true");
  await readout.getByText(drive.id, { exact: true }).waitFor();
  await readout.getByText(drive.projection_ref, { exact: true }).waitFor();
  const exactIdentity = await readout.getByText(drive.id, { exact: true }).evaluate(element => {
    const value = element.closest(".fm-inspector-field-row__value");
    return { text: element.textContent, wrap: getComputedStyle(value).whiteSpace, overflow: value.scrollWidth > value.clientWidth + 1 };
  });
  assert.deepEqual(exactIdentity, { text: drive.id, wrap: "normal", overflow: false });
  await identities.focus(); await identities.press("Enter");
  assert.equal(await identities.getAttribute("aria-expanded"), "false");
  await readout.scrollIntoViewIfNeeded(); await screenshot("18-antenna-parameter-readout");
  // The presentation remains readable in a compact inspector and another theme.
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  await publicCommand("Toggle Theme");
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await page.setViewportSize({ width: 1280, height: 1000 });
  await identities.focus(); await identities.press("Enter");
  const compactIdentity = await readout.getByText(drive.id, { exact: true }).evaluate(element => {
    const value = element.closest(".fm-inspector-field-row__value"), root = element.closest('[data-testid="antenna-composition-readout"]');
    return { valueOverflow: value.scrollWidth > value.clientWidth + 1, panelOverflow: root.scrollWidth > root.clientWidth + 1 };
  });
  assert.deepEqual(compactIdentity, { valueOverflow: false, panelOverflow: false });
  await screenshot("19-antenna-identity-compact");
  assert.equal(writes.length, beforeReadoutWrites, "Readout disclosure and layout must not write or compute");
  await page.setViewportSize({ width: 1600, height: 1100 });
  checks.push({ name: "Parameter readout separates execution from exact identities, preserves signed SI current, supports keyboard disclosure and wraps full IDs without overflow at compact width; disclosure and layout are read-only", passed: true, exactIdentity, compactIdentity });
  await identities.focus(); await identities.press("Enter");
  assert.equal(await identities.getAttribute("aria-expanded"), "false");
  const beforeBindingSetup = await scene();
  const alternatePort = { ...beforeBindingSetup.antenna_port_modes.find(item => item.id === drive.port_mode_id), id: `${drive.port_mode_id}:alternate` };
  const originalStage = beforeBindingSetup.antenna_field_solve_stages.find(item => item.id === stage.id);
  const alternateStage = { ...originalStage, id: `${stage.id}:alternate`, port_mode_ids: [alternatePort.id], outputs: originalStage.outputs.map((output, index) => ({ ...output, id: `${stage.id}:alternate:output:${index + 1}` })) };
  const originalProjection = beforeBindingSetup.antenna_target_projections.find(item => item.id === drive.projection_ref);
  const alternateProjection = { ...originalProjection, id: `${drive.projection_ref}:alternate`, output_id: `${drive.projection_ref}:alternate:field`, solution: { kind: "stage_output", stage_id: alternateStage.id, output_id: alternateStage.outputs.find(output => output.quantity === "H_ant_basis").id } };
  const bindingSetup = { base_revision: beforeBindingSetup.revision, kind: "merge_patch", merge_patch: {
    antenna_port_modes: [...beforeBindingSetup.antenna_port_modes, alternatePort], antenna_field_solve_stages: [...beforeBindingSetup.antenna_field_solve_stages, alternateStage], antenna_target_projections: [...beforeBindingSetup.antenna_target_projections, alternateProjection],
  } };
  await json(await context.request.post(`${target.api_base}/v2/sessions/current/model/transactions`, { headers: headers(), data: bindingSetup }));
  writes.push({ method: "POST", path: "/v2/sessions/current/model/transactions", body: bindingSetup, instance: target.api_instance, scope, source: "public_api_alternate_binding_setup" });
  await waitScene(s => s.antenna_target_projections.some(item => item.id === alternateProjection.id));
  const bindingChoice = driveEditor.getByRole("combobox", { name: "Field projection and port", exact: true });
  const alternativeKey = JSON.stringify([alternateProjection.id, alternatePort.id]);
  await page.waitForFunction(key => [...document.querySelectorAll('[data-testid="antenna-drive-editor"] option')].some(option => option.value === key), alternativeKey);
  const beforeRebindWrites = writes.length;
  await bindingChoice.selectOption(alternativeKey);
  assert.equal(writes.length, beforeRebindWrites);
  await driveEditor.getByRole("button", { name: "Reset drive", exact: true }).click();
  assert.equal(await bindingChoice.inputValue(), JSON.stringify([drive.projection_ref, drive.port_mode_id]));
  await bindingChoice.selectOption(alternativeKey);
  await selectNode(`model:object:${objectId}:geometry`); await dirtyGuard.waitFor();
  await dirtyGuard.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await bindingChoice.inputValue(), alternativeKey);
  await bindingChoice.focus();
  await page.evaluate(() => {
    const root = document.querySelector('[data-testid="antenna-drive-editor"]'), input = document.activeElement, scroll = root.closest(".fm-inspector__body");
    const controls = [...root.querySelectorAll("input, select")].map(element => ({ element, disabled: element.disabled, opacity: getComputedStyle(element).opacity }));
    const proof = { root, input, scroll, top: scroll.scrollTop, rootChanges: 0, controlChanges: 0, disabledChanges: 0, opacityChanges: 0, opacityAnimations: 0, samples: 0 };
    const sample = () => {
      proof.samples++;
      if (document.querySelector('[data-testid="antenna-drive-editor"]') !== root) proof.rootChanges++;
      for (const saved of controls) {
        if (!saved.element.isConnected) proof.controlChanges++;
        if (saved.element.disabled !== saved.disabled) proof.disabledChanges++;
        if (getComputedStyle(saved.element).opacity !== saved.opacity) proof.opacityChanges++;
      }
      proof.opacityAnimations += root.getAnimations({ subtree: true }).filter(animation => (animation.playState === "running" || animation.pending) && animation.effect?.getKeyframes().some(frame => "opacity" in frame)).length;
    };
    const observer = new MutationObserver(sample); observer.observe(root, { attributes: true, childList: true, subtree: true }); sample(); window.__bindingProof = { proof, observer, sample };
  });
  await driveSave.evaluate(button => button.click());
  const reboundDriveScene = await waitScene(s => s.solved_antenna_drives.find(item => item.id === drive.id)?.projection_ref === alternateProjection.id);
  await driveEditor.getByText("Antenna drive committed.", { exact: true }).waitFor();
  const reboundDrive = reboundDriveScene.solved_antenna_drives.find(item => item.id === drive.id);
  assert.deepEqual(reboundDrive, { ...beforeBindingSetup.solved_antenna_drives.find(item => item.id === drive.id), projection_ref: alternateProjection.id, port_mode_id: alternatePort.id });
  assert.deepEqual(reboundDriveScene.antenna_target_projections, bindingSetup.merge_patch.antenna_target_projections);
  assert.equal(writes.length, beforeRebindWrites + 1); assert.deepEqual(Object.keys(writes.at(-1).body.merge_patch), ["solved_antenna_drives"]);
  const bindingStability = await page.evaluate(() => {
    const { proof, observer, sample } = window.__bindingProof; sample(); observer.disconnect();
    return { root: proof.root.isConnected, focus: document.activeElement === proof.input, scroll: proof.scroll.scrollTop === proof.top,
      rootChanges: proof.rootChanges, controlChanges: proof.controlChanges, disabledChanges: proof.disabledChanges, opacityChanges: proof.opacityChanges, opacityAnimations: proof.opacityAnimations, samples: proof.samples };
  });
  assert.ok(bindingStability.samples > 1 && bindingStability.samples < 200);
  assert.deepEqual({ ...bindingStability, samples: 0 }, { root: true, focus: true, scroll: true, rootChanges: 0, controlChanges: 0, disabledChanges: 0, opacityChanges: 0, opacityAnimations: 0, samples: 0 });
  assert.equal(await driveNode.getAttribute("aria-selected"), "true");
  await bindingChoice.scrollIntoViewIfNeeded(); await screenshot("20-explicit-projection-port-binding");
  checks.push({ name: "Existing drive rebinds one explicit projection/port pair through real UI/API, preserves immutable drive and antenna identity, retains cancelled drafts and local Reset, and does not edit projections or execute a solver", passed: true, stability: bindingStability, setup: "alternate compatible definitions via public API; selection, Reset, cancelled navigation and save via real UI" });
  await activation.uncheck();
  assert.equal(await driveSave.isEnabled(), false, "At least one selected Run is required");
  await selectNode(`model:object:${objectId}:geometry`); await dirtyGuard.waitFor();
  assert.equal(await dirtyGuard.getByRole("button", { name: "Apply and continue", exact: true }).isEnabled(), false);
  await dirtyGuard.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await activation.isChecked(), false);
  await activation.check();
  await page.getByText(`Executable stage ID: ${runNode.id}`, { exact: true }).waitFor();
  assert.equal(writes.length, beforeRebindWrites + 1);
  await activation.scrollIntoViewIfNeeded(); await screenshot("21-named-run-activation");
  checks.push({ name: "Named Run checkboxes retain executable IDs, reject an empty selection, preserve cancelled edits and need no raw ID input or extra API transaction", passed: true });
  const beforeTransitionWrites = writes.length;
  await driveName.fill("Draft to discard");
  await selectNode(`model:object:${objectId}:geometry`); await dirtyGuard.waitFor();
  await dirtyGuard.getByRole("button", { name: "Discard", exact: true }).click();
  await geometry.waitFor();
  await selectNode(`model:object:${objectId}:antenna:drive:${encodeURIComponent(drive.id)}`);
  assert.equal(await driveName.inputValue(), "RF to waveguide");
  assert.equal(writes.length, beforeTransitionWrites);
  checks.push({ name: "Discard waits for the real form reset, changes selection and preserves the server model without a write", passed: true });
  await driveName.fill("Acknowledged after Cancel");
  await selectNode(`model:object:${objectId}:geometry`); await dirtyGuard.waitFor();
  // Both handlers run before the real asynchronous API write can acknowledge.
  await dirtyGuard.evaluate(dialog => {
    const buttons = [...dialog.querySelectorAll("button")];
    buttons.find(button => button.textContent === "Apply and continue").click();
    buttons.find(button => button.textContent === "Cancel").click();
  });
  await waitScene(s => s.solved_antenna_drives.find(item => item.id === drive.id)?.name === "Acknowledged after Cancel");
  assert.equal(await driveNode.getAttribute("aria-selected"), "true", "A cancelled transition must not resume after the real API ACK");
  await driveEditor.getByText("Antenna drive committed.", { exact: true }).waitFor();
  assert.equal(await dirtyGuard.isVisible(), false);
  assert.equal(writes.length, beforeTransitionWrites + 1);
  await screenshot("22-cancelled-transition-after-ack");
  checks.push({ name: "Cancel invalidates an in-flight Apply transition: its real write may finish but its late ACK cannot navigate", passed: true });
  await driveName.fill("Committed transition value");
  const guardedNameInput = await driveName.elementHandle();
  await selectNode(`model:object:${objectId}:geometry`); await dirtyGuard.waitFor();
  await guardedNameInput.evaluate(input => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find(element => element.textContent.includes("Unapplied Inspector changes"));
    [...dialog.querySelectorAll("button")].find(button => button.textContent === "Apply and continue").click();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Newer draft during guarded Apply");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await waitScene(s => s.solved_antenna_drives.find(item => item.id === drive.id)?.name === "Committed transition value");
  await dirtyGuard.getByRole("alert").waitFor();
  assert.equal(await driveNode.getAttribute("aria-selected"), "true");
  assert.equal(await guardedNameInput.evaluate(input => input.value), "Newer draft during guarded Apply");
  assert.equal(writes.length, beforeTransitionWrites + 2);
  await screenshot("23-newer-draft-retained");
  await dirtyGuard.getByRole("button", { name: "Cancel", exact: true }).click();
  await driveEditor.getByRole("button", { name: "Reset drive", exact: true }).click();
  assert.equal(await driveName.inputValue(), "Committed transition value");
  checks.push({ name: "Apply does not leave the Inspector when a newer draft was authored before its real ACK; Cancel preserves that draft and Reset remains local", passed: true });
  const related = page.locator('section[data-slot="inspector-group"]').filter({ has: page.getByRole("heading", { name: "Related resources", exact: true }) });
  const relatedProjection = related.getByRole("button", { name: /^Open Projection/ });
  await relatedProjection.waitFor();
  const beforeRelatedWrites = writes.length;
  await driveName.fill("Related navigation draft");
  await relatedProjection.click(); await dirtyGuard.waitFor();
  await dirtyGuard.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await driveName.inputValue(), "Related navigation draft");
  assert.equal(await driveNode.getAttribute("aria-selected"), "true");
  await relatedProjection.click(); await dirtyGuard.waitFor();
  await dirtyGuard.getByRole("button", { name: "Discard", exact: true }).click();
  await page.waitForFunction(id => document.querySelector(`[data-node-id="${id}"]`)?.getAttribute("aria-selected") === "true", `model:object:${objectId}:antenna:projection:${encodeURIComponent(alternateProjection.id)}`);
  assert.equal(writes.length, beforeRelatedWrites);
  await related.getByRole("button", { name: /^Open Field solve/ }).click();
  await page.waitForFunction(id => document.querySelector(`[data-node-id="${id}"]`)?.getAttribute("aria-selected") === "true", `model:object:${objectId}:antenna:solution:${encodeURIComponent(alternateStage.id)}`);
  await screenshot("25-related-antenna-resources");
  await selectNode(`model:object:${objectId}:antenna:drive:${encodeURIComponent(drive.id)}`);
  await related.getByRole("button", { name: /^Open Port/ }).click();
  await page.waitForFunction(id => document.querySelector(`[data-node-id="${id}"]`)?.getAttribute("aria-selected") === "true", `model:object:${objectId}:antenna:port:${encodeURIComponent(alternatePort.id)}`);
  checks.push({ name: "Related-resource links select canonical Projection, Field solve and Port nodes; Cancel retains the draft and Discard navigates without a model write", passed: true });
  await selectNode(`model:object:${objectId}:antenna:drive:${encodeURIComponent(drive.id)}`);
  await bindingChoice.selectOption(JSON.stringify([drive.projection_ref, drive.port_mode_id]));
  await relatedProjection.click(); await dirtyGuard.waitFor();
  await dirtyGuard.getByRole("button", { name: "Apply and continue", exact: true }).click();
  await waitScene(s => s.solved_antenna_drives.find(item => item.id === drive.id)?.projection_ref === drive.projection_ref);
  await dirtyGuard.getByRole("alert").filter({ hasText: "related resource changed" }).waitFor();
  assert.equal(await driveNode.getAttribute("aria-selected"), "true", "A committed rebind must revoke the old related-resource destination");
  assert.equal(writes.length, beforeRelatedWrites + 1);
  await screenshot("26-related-binding-changed-during-apply");
  await dirtyGuard.getByRole("button", { name: "Cancel", exact: true }).click();
  await relatedProjection.click();
  await page.waitForFunction(id => document.querySelector(`[data-node-id="${id}"]`)?.getAttribute("aria-selected") === "true", `model:object:${objectId}:antenna:projection:${encodeURIComponent(drive.projection_ref)}`);
  await selectNode(`model:object:${objectId}:antenna:drive:${encodeURIComponent(drive.id)}`);
  checks.push({ name: "Real Apply changes a drive binding; post-ACK validation keeps selection instead of opening its former Projection, and a fresh click follows the new binding", passed: true });
  await driveName.fill("Applied through related navigation");
  await relatedProjection.click(); await dirtyGuard.waitFor();
  await dirtyGuard.getByRole("button", { name: "Apply and continue", exact: true }).click();
  await page.waitForFunction(id => document.querySelector(`[data-node-id="${id}"]`)?.getAttribute("aria-selected") === "true", `model:object:${objectId}:antenna:projection:${encodeURIComponent(drive.projection_ref)}`);
  assert.equal(writes.length, beforeRelatedWrites + 2);
  await waitScene(s => s.solved_antenna_drives.find(item => item.id === drive.id)?.name === "Applied through related navigation");
  await selectNode(`model:object:${objectId}:antenna:drive:${encodeURIComponent(drive.id)}`);
  checks.push({ name: "Apply with an unchanged related binding commits the draft and continues to the canonical Projection after its real ACK", passed: true });
  const beforeExplorerWrites = writes.length;
  const explorerPanel = page.locator(".fm-explorer");
  const originalExplorerWidth = (await explorerPanel.boundingBox()).width;
  const resizeExplorer = async width => {
    const handle = page.getByRole("separator", { name: "Resize workspace panels", exact: true }).first();
    const bounds = await handle.boundingBox(), current = await explorerPanel.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + Math.min(bounds.height / 2, 100));
    await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width / 2 + width - current.width, bounds.y + Math.min(bounds.height / 2, 100), { steps: 6 }); await page.mouse.up();
    await page.waitForFunction(expected => Math.abs(document.querySelector(".fm-explorer").getBoundingClientRect().width - expected) < 2, width);
  };
  const explorerCases = [];
  for (const theme of ["dark", "light"]) {
    if (await page.locator("html").getAttribute("data-theme") !== theme) { await publicCommand("Toggle Theme"); await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, theme); }
    for (const width of [280, 319, 320, 366, 480, 481]) {
      await resizeExplorer(width);
      const metrics = await explorerPanel.evaluate(root => {
        const tree = root.querySelector('[role="tree"]');
        return { width: root.getBoundingClientRect().width, overflow: tree.scrollWidth > tree.clientWidth + 1,
          rows: [...tree.querySelectorAll('[role="treeitem"]')].map(row => {
            const label = row.querySelector('.fm-explorer-tree-row__label'), meta = row.querySelector('.fm-explorer-tree-row__metadata');
            return { name: label.textContent, labelWidth: label.clientWidth, labelScrollWidth: label.scrollWidth, height: row.getBoundingClientRect().height,
              overlap: label.getBoundingClientRect().right > meta.getBoundingClientRect().left + 1,
              metaInside: meta.getBoundingClientRect().right <= tree.getBoundingClientRect().right + 1,
              statusIcon: row.querySelector('.fm-explorer-tree-row__status-icon')?.getBoundingClientRect().width ?? null };
          }) };
      });
      assert.equal(metrics.overflow, false);
      for (const row of metrics.rows) { assert.equal(row.height, 28); assert.equal(row.overlap, false); assert.ok(row.metaInside); if (row.statusIcon !== null) assert.ok(row.statusIcon > 0); }
      for (const label of ["Field solve 1", "Field solve 2", "Port 1", "Port 2"]) {
        const row = metrics.rows.find(row => row.name === label); assert.ok(row, label); assert.ok(row.labelWidth >= row.labelScrollWidth, `${label} is clipped at ${width}px`);
      }
      explorerCases.push({ theme, width, ...metrics });
      if (width === 366) await screenshot(`27-readable-explorer-${theme}`);
    }
  }
  await resizeExplorer(280);
  const sourceSolveNode = page.locator(`[data-node-id="model:object:${objectId}:antenna:solution:${encodeURIComponent(stage.id)}"]`);
  await page.mouse.move(700, 200);
  await sourceSolveNode.focus();
  const nodeTooltip = page.getByRole("tooltip").filter({ hasText: "Field solve 1" });
  await nodeTooltip.waitFor();
  assert.ok((await nodeTooltip.innerText()).includes(stage.id));
  const accessibleDescription = await sourceSolveNode.evaluate(row => (row.getAttribute("aria-describedby") ?? "").split(/\s+/).map(id => document.getElementById(id)?.textContent ?? "").join(" "));
  assert.ok(accessibleDescription.includes(stage.id));
  assert.equal(await sourceSolveNode.getAttribute("aria-label"), "Field solve 1");
  assert.equal(await driveNode.getAttribute("aria-selected"), "true", "Keyboard focus tooltip cannot change selection");
  await screenshot("28-explorer-keyboard-description");
  await sourceSolveNode.press("Escape"); await nodeTooltip.waitFor({ state: "hidden" });
  const nextNodeId = await sourceSolveNode.evaluate(row => { const rows = [...row.closest('[role="tree"]').querySelectorAll('[role="treeitem"]')]; return rows[rows.indexOf(row) + 1].dataset.nodeId; });
  await sourceSolveNode.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-node-id")), nextNodeId);
  await page.keyboard.press("Enter");
  assert.equal(await page.locator(`[data-node-id="${nextNodeId}"]`).getAttribute("aria-selected"), "true");
  await selectNode(`model:object:${objectId}:antenna:drive:${encodeURIComponent(drive.id)}`);
  // Clicking dismisses Radix tooltips until a genuine pointer leave/re-entry.
  await page.mouse.move(700, 200);
  await driveNode.hover();
  const driveTooltip = page.getByRole("tooltip").filter({ hasText: "Applied through related navigation" });
  await driveTooltip.waitFor(); assert.ok((await driveTooltip.innerText()).includes(drive.id));
  checkpoint("explorer-pointer-description");
  await page.mouse.move(700, 200); await driveNode.press("Escape");
  const antennaRoot = page.locator(`[data-node-id="model:object:${objectId}"]`);
  const branch = antennaRoot.locator(".fm-explorer-tree-row__branch svg");
  await branch.click();
  await page.waitForFunction(id => document.querySelector(`[data-node-id="${id}"]`)?.getAttribute("aria-expanded") === "false", `model:object:${objectId}`);
  for (const theme of ["dark", "light"]) {
    await publicCommand("Toggle Theme");
    await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, theme);
    assert.equal(await antennaRoot.getAttribute("aria-expanded"), "false", "Resource/presentation renders cannot reopen an explicitly collapsed selected path");
  }
  checkpoint("explorer-collapse-preserved-through-renders");
  await branch.click();
  await page.waitForFunction(id => document.querySelector(`[data-node-id="${id}"]`)?.getAttribute("aria-expanded") === "true", `model:object:${objectId}`);
  assert.equal(await driveNode.getAttribute("aria-selected"), "true", "Branch SVG toggling must preserve selection");
  await sourceSolveNode.click({ button: "right" }); await page.getByRole("menu").waitFor();
  assert.equal(await driveNode.getAttribute("aria-selected"), "true");
  await page.keyboard.press("Escape");
  checkpoint("explorer-context-menu");
  await resizeExplorer(originalExplorerWidth);
  await publicCommand("Toggle Theme"); await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  assert.equal(writes.length, beforeExplorerWrites, "Resizing, descriptions, keyboard selection and menus must not write the model");
  checks.push({ name: "Explorer prioritizes resource names in twelve real dock/theme layouts, keeps exact 28px rows and status shapes, exposes full keyboard/mouse descriptions, and preserves selection/branch/context-menu behavior without model writes", passed: true, cases: explorerCases });
  const webgl = await page.locator("canvas").evaluateAll(canvases => canvases.map(canvas => {
    const bounds = canvas.getBoundingClientRect(); if (!bounds.width || !bounds.height) return null;
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    return gl ? { lost: gl.isContextLost(), width: gl.drawingBufferWidth, height: gl.drawingBufferHeight } : null;
  }).filter(Boolean));
  assert.ok(webgl.some(gl => !gl.lost && gl.width > 0 && gl.height > 0)); assert.ok(webgl.every(gl => !gl.lost));
  assert.ok(websockets.some(url => url.startsWith(target.api_base.replace("http:", "ws:"))), "Realtime must use the admitted API");
  assert.ok(writes.length >= 3 && writes.length <= 29);
  for (const write of [...writes, ...visualizationAcks]) { assert.equal(write.instance, target.api_instance); assert.equal(write.scope, scope); assert.ok(!write.path.includes("/simulation/"), "Authoring smoke must not execute a solver"); }
  assert.ok(Date.now() - Date.parse(startedAt) > 5000, "The scenario must outlive the adoption timeout");
  assert.deepEqual(visualizationAcks.filter(ack => ack.body.status === "failed"), [], "No nonexistent-buffer adoption may fail during empty/nonmagnetic authoring");
  checks.push({ name: "Empty and nonmagnetic antenna authoring outlives the adoption timeout without a fabricated failed data ACK", passed: true, visualizationAcks });
  assert.deepEqual(pageErrors, []); assert.deepEqual(consoleErrors, []);
  assert.deepEqual(httpErrors.filter(error => error.status >= 500), []);
  checks.push({ name: "real workspace has healthy WebGL, correctly routed realtime and scoped writes without solver execution", passed: true, webgl });
  {
  // Cross-antenna ownership uses real authored declarations and real API ACKs.
  const beforeSecondAntenna = await scene();
  await publicCommand("Add Microstrip Antenna");
  const twoAntennaScene = await waitScene(s => s.objects.filter(o => o.role === "antenna").length === 2);
  const secondAntenna = twoAntennaScene.objects.find(o => o.role === "antenna" && o.id !== objectId);
  assert.ok(secondAntenna);
  const secondStages = twoAntennaScene.antenna_field_solve_stages.filter(s => s.source_object_id === secondAntenna.id);
  assert.equal(secondStages.length, 1);
  const secondStage = secondStages[0];
  assert.notEqual(secondStage.id, stage.id);
  assert.deepEqual(twoAntennaScene.objects.find(o => o.id === objectId), beforeSecondAntenna.objects.find(o => o.id === objectId));
  const rebindProjection = { ...projection, id: `${projection.id}:cross-owner`, output_id: `${projection.output_id}:cross-owner` };
  const rebindSpectrum = { ...fft, id: `${fft.id}:cross-owner`, output_id: `${fft.output_id}:cross-owner` };
  const setup = { base_revision: twoAntennaScene.revision, kind: "merge_patch", merge_patch: {
    antenna_target_projections: [...twoAntennaScene.antenna_target_projections, rebindProjection],
    antenna_spectrum_requests: [...twoAntennaScene.antenna_spectrum_requests, rebindSpectrum],
  } };
  await json(await context.request.post(`${target.api_base}/v2/sessions/current/model/transactions`, { headers: headers(), data: setup }));
  writes.push({ method: "POST", path: "/v2/sessions/current/model/transactions", body: setup, instance: target.api_instance, scope, source: "public_api_two_antenna_declarations_setup" });
  const setupScene = await waitScene(s => s.antenna_spectrum_requests.some(r => r.id === rebindSpectrum.id) && s.antenna_target_projections.some(p => p.id === rebindProjection.id));
  await page.getByTitle("Expand All").click();
  const payloadReadsDuringRebind = [];
  const recordRebindPayload = request => {
    if (request.method() === "GET" && request.url().startsWith(`${target.api_base}/v2/sessions/current/data/antenna/`) && new URL(request.url()).pathname.includes("/payloads/")) payloadReadsDuringRebind.push(request.url());
  };
  page.on("request", recordRebindPayload);
  const beforeRebindWrites = writes.length;
  const ownerNode = (owner, kind, id) => `model:object:${owner}:antenna:${kind}:${encodeURIComponent(id)}`;
  for (const [kind, collection, declaration, referenceKey] of [
    ["projection", "antenna_target_projections", rebindProjection, "solution"],
    ["spectrum", "antenna_spectrum_requests", rebindSpectrum, "solution_ref"],
  ]) {
    let oldOwner = objectId;
    await selectNode(ownerNode(oldOwner, kind, declaration.id));
    for (const [nextOwner, nextStage] of [[secondAntenna.id, secondStage], [objectId, stage]]) {
      const before = await scene(), previous = before[collection].find(r => r.id === declaration.id);
      const sourceChoice = page.getByRole("combobox", { name: "Source binding", exact: true });
      await sourceChoice.selectOption(nextStage.id);
      const apply = page.getByRole("button", { name: `Apply ${kind}`, exact: true });
      assert.equal(await apply.isEnabled(), true);
      const beforeApplyWrites = writes.length;
      const ack = page.waitForResponse(response => response.url() === `${target.api_base}/v2/sessions/current/model/transactions` && response.request().method() === "POST");
      await apply.click();
      const response = await ack;
      await json(response);
      const after = await waitScene(s => s[collection].find(r => r.id === declaration.id)?.[referenceKey]?.stage_id === nextStage.id);
      const current = after[collection].find(r => r.id === declaration.id);
      const outputs = nextStage.outputs.filter(output => output.quantity === "H_ant_basis");
      assert.equal(outputs.length, 1);
      const expected = { ...previous, [referenceKey]: { kind: "stage_output", stage_id: nextStage.id, output_id: outputs[0].id }, ...(kind === "spectrum" ? { port_mode_id: nextStage.port_mode_ids[0] } : {}) };
      assert.deepEqual(current, expected, "Rebind must preserve target, immutable IDs and scientific request settings");
      assert.deepEqual(after.objects, before.objects);
      assert.deepEqual(after.antenna_field_solve_stages, before.antenna_field_solve_stages);
      assert.deepEqual(after.antenna_port_modes, before.antenna_port_modes);
      assert.deepEqual(after.solved_antenna_drives, before.solved_antenna_drives);
      assert.equal(writes.length, beforeApplyWrites + 1);
      assert.deepEqual(Object.keys(writes.at(-1).body.merge_patch), [collection]);
      const staleNode = ownerNode(oldOwner, kind, declaration.id), currentNode = ownerNode(nextOwner, kind, declaration.id);
      await page.waitForFunction(id => !document.querySelector(`[data-node-id="${id}"]`), staleNode);
      await page.getByTitle("Expand All").click();
      await selectNode(currentNode);
      assert.equal(await page.locator(`[data-node-id="${currentNode}"]`).getAttribute("aria-selected"), "true");
      assert.equal(await page.getByRole("combobox", { name: "Source binding", exact: true }).inputValue(), "");
      assert.equal(await page.getByRole("button", { name: `Apply ${kind}`, exact: true }).isEnabled(), false, "Reselection must use committed resource rather than the old draft");
      await screenshot(`29-${kind}-owner-${nextOwner === objectId ? "restored" : "second"}`);
      oldOwner = nextOwner;
    }
  }
  page.off("request", recordRebindPayload);
  assert.equal(writes.length, beforeRebindWrites + 4);
  assert.deepEqual(payloadReadsDuringRebind, [], "Unpublished declarations cannot authorize binary payload reads");
  const afterRebind = await scene();
  assert.deepEqual(afterRebind.antenna_target_projections, setupScene.antenna_target_projections);
  assert.deepEqual(afterRebind.antenna_spectrum_requests, setupScene.antenna_spectrum_requests);
  for (const write of writes.slice(beforeRebindWrites)) { assert.equal(write.instance, target.api_instance); assert.equal(write.scope, scope); assert.equal(write.path, "/v2/sessions/current/model/transactions"); }
  checks.push({ name: "Projection and source Spectrum rebind A to B to A through real forms and real transaction ACKs, move canonical Explorer ownership, retain immutable settings and reselect clean committed Inspectors", passed: true, secondAntennaId: secondAntenna.id, payloadReadsDuringRebind, qualification: "unpublished authoring declarations only; no published stale-payload or solver qualification" });
  await selectNode(`model:object:${objectId}:antenna:drive:${encodeURIComponent(drive.id)}`);
  }
  const beforeSessionReplacementWrites = writes.length;
  await driveName.fill("Old session draft");
  await selectNode(`model:object:${objectId}:geometry`); await dirtyGuard.waitFor();
  const previousScope = scope;
  const replacementStartedAt = Date.now();
  const replacement = await json(await context.request.post(`${target.api_base}/v2/sessions`, {
    headers: headers(), data: { name: "Managed transition replacement", backend: "fem", device: "cpu", precision: "double", replace_current: true },
  }));
  assert.notEqual(replacement.session_id, sessionId);
  const replacementStatus = await json(await context.request.get(`${target.api_base}/v2/sessions/current/status`, { headers: { "x-fullmag-api-instance": target.api_instance } }));
  const replacementCollection = await json(await context.request.get(`${target.api_base}/v2/sessions`, { headers: { "x-fullmag-api-instance": target.api_instance } }));
  sessionTransition = { replacement, status: replacementStatus.session, collection: replacementCollection };
  assert.equal(replacementCollection.sessions.filter(item => item.current).length, 1);
  assert.equal(replacementCollection.sessions.find(item => item.current).session_id, replacement.session_id);
  const nextOwner = replacementStatus.session;
  scope = `session=${encodeURIComponent(nextOwner.session_id)}&epoch=${encodeURIComponent(nextOwner.session_epoch)}&request_scope_epoch=${encodeURIComponent(nextOwner.request_scope_epoch)}`;
  assert.notEqual(scope, previousScope);
  await page.locator(".fm-header__subtitle:visible").filter({ hasText: /^Managed transition replacement$/ }).waitFor({ timeout: 60_000 });
  checkpoint("session-transition-visible-header");
  await dirtyGuard.waitFor({ state: "hidden" });
  assert.equal(await page.locator(`[data-node-id="model:object:${objectId}"]`).count(), 0);
  assert.equal(await driveEditor.count(), 0);
  const replacementScene = await scene();
  assert.deepEqual(replacementScene.objects ?? [], []);
  const collectionReadCount = sessionReads.filter(record => record.path === "/v2/sessions" && Date.parse(record.at) >= replacementStartedAt).length;
  assert.ok(collectionReadCount >= 1 && collectionReadCount <= 6, `Session recovery must re-read the collection without a request storm: ${collectionReadCount}`);
  await screenshot("24-session-transition-clears-confirmation");
  assert.equal(writes.length, beforeSessionReplacementWrites, "Changing session must not submit the old draft");
  assert.deepEqual(pageErrors, []); assert.deepEqual(consoleErrors, []);
  assert.deepEqual(httpErrors.filter(error => error.status >= 500), []);
  checks.push({ name: "Replacing only the owned disposable API session invalidates the old dirty confirmation and Inspector without reusing any old selection or model", passed: true, previousScope, replacementScope: scope, replacementSessionId: replacement.session_id, collectionReadCount });

} catch (error) {
  failure = error.stack ?? String(error);
  if (page) { try { const path = resolve(reportRoot, "failure.png"); await page.screenshot({ path, fullPage: true }); screenshots.push(path); await writeFile(resolve(reportRoot, "failure-dom.txt"), await page.locator("body").innerText()); } catch { /* Preserve original failure. */ } }
} finally { await Promise.allSettled([...pendingSessionReads]); if (browser) await browser.close(); }
const report = { schema: "fullmag.antenna-workspace-authoring.v1", state: failure ? "failed" : "passed", qualification: "real_api_workspace_authoring_only_not_solve_science_or_durability", startedAt, finishedAt: new Date().toISOString(), target, sessionId, sessionReads, sessionTransition, checks, screenshots, writes, visualizationAcks, websockets, pageErrors, consoleErrors, httpErrors, error: failure };
await writeFile(resolve(reportRoot, "antenna-workspace-authoring.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ state: report.state, checks: checks.length, error: failure }));
process.exitCode = failure ? 1 : 0;