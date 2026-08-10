import { spawn } from "node:child_process";
import { accessSync, constants, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  connectCdpSocket,
  removeProfileDirectory,
  runTransportAuthoringSmoke,
  startChromium,
} from "./smoke-transport-authoring-ui-runtime.mjs";

const workspaceUrl =
  process.env.CONTROL_ROOM_URL ?? "http://localhost:3100/workspace";
const timeoutMs = Number(
  process.env.CONTROL_ROOM_TRANSPORT_SMOKE_TIMEOUT_MS ?? 60_000,
);
const fixtureLane = process.env.CONTROL_ROOM_TRANSPORT_FIXTURE_LANE === "fem"
  ? "fem"
  : "fdm";
const browserErrors = [];

export function browserLogError(entry) {
  if (entry?.level !== "error") return null;
  const text = entry.text ?? "";
  return entry.url ? `${text} (${entry.url})` : text;
}

export function transportAuthoringSmokeFailure(errors, unhandledRequests) {
  const uniqueBrowserErrors = [...new Set(errors)];
  const uniqueUnhandledRequests = [
    ...new Map(
      unhandledRequests.map((request) => [
        `${request.method} ${request.path}`,
        request,
      ]),
    ).values(),
  ];
  if (uniqueBrowserErrors.length === 0 && uniqueUnhandledRequests.length === 0) {
    return null;
  }
  return (
    `Browser errors (${errors.length}):\n${uniqueBrowserErrors.join("\n")}\n` +
    `unhandledRequests=${JSON.stringify(uniqueUnhandledRequests)}`
  );
}

const currentTransports = [
  {
    coupling: "one_way",
    current_density: [1, 0, 0],
    kind: "current_transport",
    model: "prescribed_density",
    name: "known-current",
  },
  {
    future_key: { preserve: true },
    kind: "current_transport",
    model: "prescribed_density",
    name: "future-current",
  },
];
const spinSolver = {
  default_external_boundary: "spin_insulating",
  engine: "gmres",
  linear: {
    absolute_tolerance: 1e-12,
    max_iterations: 100,
    relative_tolerance: 1e-8,
  },
  operator_version: "fv_spin_upwind_v1",
  physical_residual_version: "transport_balance_integrated_l2.v1",
};
const requestedExecution = {
  device: "cpu",
  discretization: fixtureLane,
  execution_mode: "strict",
  precision: "double",
};
const spinTransports = [
  {
    boundaries: [],
    constitutive_version: "transport_constitutive.one_way.fullmag.v1",
    current_source_id: "known-current",
    domain: [],
    id: "known-spin",
    interfaces: [{
      id: "transparent",
      kind: "transparent",
      side_a: { object_id: "left", region_id: "normal" },
      side_b: { object_id: "right", region_id: "ferromagnet" },
      normal_a_to_b: [1, 0, 0],
    }],
    materials: [],
    mode: "steady",
    requested_execution: requestedExecution,
    schema_version: "spin_transport.v1",
    solver: spinSolver,
  },
  {
    boundaries: [],
    constitutive_version: "transport_constitutive.one_way.fullmag.v1",
    current_source_id: "known-current",
    domain: [],
    id: "future-mixing",
    interfaces: [{
      absorption: "partial_absorption.v2",
      ferromagnet_side: { object_id: "stack", region_id: "free" },
      formula_version: "magnetoelectronic.fullmag.v2",
      g_down_Spm2: 2,
      g_i_Spm2: 3,
      g_r_Spm2: 4,
      spin_memory_loss: { formula_version: "sml_reservoir.fullmag.v2", g_n_Spm2: 1, g_f_Spm2: 2, g_lattice_Spm2: 3 },
      g_up_Spm2: 6,
      id: "nf",
      kind: "mixing_conductance",
      normal_side: { object_id: "stack", region_id: "normal" },
      normal_to_ferromagnet: [1, 0, 0],
    }],
    materials: [],
    mode: "steady",
    requested_execution: requestedExecution,
    schema_version: "spin_transport.v1",
    solver: spinSolver,
  },
];
const spinTorques = [{ kind: "zhang_li", id: "torque", current_density: [1, 0, 0], current_source: " torque-source ", degree: 0.4, beta: 0 }];
const oerstedFields = [{ kind: "oersted_cylinder", id: "oersted", center: [0, 0, 0], axis: [0, 0, 1], radius: 1e-9, current: 1 }];
const fieldDrives = [];

let cdp = null;
let sessionId = null;
let sceneRevision = 1;
let physicsGraphEnabled = false;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runTransportAuthoringSmoke({
  connectCdp,
  removeProfile: removeProfileDirectory,
  run: async ({ cdp: acquiredCdp, fixtureServer }) => {
    cdp = acquiredCdp;
    const target = await cdp.send("Target.createTarget", { url: "about:blank" });
    const attached = await cdp.send("Target.attachToTarget", {
      flatten: true,
      targetId: target.targetId,
    });
    sessionId = attached.sessionId;
    cdp.on("Runtime.exceptionThrown", (event) => {
      const details = event.exceptionDetails;
      const frames = details?.stackTrace?.callFrames?.map((frame) =>
        `${frame.functionName || "<anonymous>"} (${frame.url}:${frame.lineNumber + 1}:${frame.columnNumber + 1})`
      ) ?? [];
      browserErrors.push([
        details?.text ?? "Runtime exception",
        details?.exception?.description,
        ...frames,
      ].filter(Boolean).join("\n"));
    });
    cdp.on("Log.entryAdded", (event) => {
      const error = browserLogError(event.entry);
      if (error !== null) browserErrors.push(error);
    });
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Log.enable", {}, sessionId);
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send(
      "Page.addScriptToEvaluateOnNewDocument",
      {
        source: `window.__FULLMAG_CONFIG__ = { ...(window.__FULLMAG_CONFIG__ || {}), allowMissingSessionSmoke: true, controlRoomApiBase: ${JSON.stringify(fixtureServer.baseUrl)}, disableRealtime: true };`,
      },
      sessionId,
    );
    await cdp.send("Page.navigate", { url: workspaceUrl }, sessionId);
    await waitForVisible(".fm-explorer");
    await clickTabByText("Model");
    await clickVisibleButton("Expand All");

    const emptyGraphLeaks = await evaluate(`() => Array.from(
      document.querySelectorAll('.fm-explorer [data-node-id]'),
    ).map((node) => node.getAttribute("data-node-id")).filter((nodeId) =>
      (nodeId.includes("physics") && nodeId.includes("module"))
      || nodeId === "model:physics:spin-transports"
      || nodeId === "model:physics:spin-interfaces"
    )`);
    if (emptyGraphLeaks.length > 0) {
      throw new Error(`An empty physics graph exposed authored modules or legacy roots: ${JSON.stringify(emptyGraphLeaks)}`);
    }
    fixtureServer.activatePhysicsGraph();
    await cdp.send("Page.reload", { ignoreCache: true }, sessionId);
    await waitForVisible(".fm-explorer");
    await clickTabByText("Model");
    await clickVisibleButton("Expand All");
    await waitForVisible('[data-node-id="model:object:film:physics"]');

    const addedCurrentNodeId = "model:object:film:physics:module:added-current";
    if (await evaluate(`() => Boolean(document.querySelector('[data-node-id="${addedCurrentNodeId}"]'))`)) {
      throw new Error("The current module exists before the user adds it.");
    }
    await clickSelector('[data-node-id="model:object:film"]');
    await clickTabByText("Physics");
    await openVisibleMenuButton("Add Physics");
    await clickVisibleMenuItem("Electric current");
    try {
      await waitForText(".fm-inspector", "Charge transport");
    } catch (error) {
      const diagnostic = await evaluate(`() => ({
        body: (document.body?.innerText || "").slice(0, 5000),
        inspector: document.querySelector(".fm-inspector")?.innerText || "",
      })`);
      throw new Error(`${error.message} objectCurrentDiagnostic=${JSON.stringify(diagnostic)}`);
    }
    await setControl("Name", "added-current");
    await clickEnabledButton("Create");
    await waitForText(".fm-inspector", "Transport resource committed.");
    await clickVisibleButton("Reset");
    await clickTabByText("Model");
    await clickVisibleButton("Expand All");
    await waitForVisible(`[data-node-id="${addedCurrentNodeId}"]`);

    const addedSpinNodeId = "model:object:film:physics:module:added-spin";
    const revisionBeforeSpinCreate = fixtureServer.sceneRevision();
    await clickSelector('[data-node-id="model:object:film"]');
    await clickTabByText("Physics");
    await openVisibleMenuButton("Add Physics");
    await clickVisibleMenuItem("Spin Transport / SHE");
    await waitForText(".fm-inspector", "Spin transport");
    await setControl("Id", "added-spin");
    await setControl("Current source id", "added-current");
    await clickEnabledButton("Create");
    await waitForText(".fm-inspector", "Transport resource committed.");
    if (fixtureServer.sceneRevision() <= revisionBeforeSpinCreate) {
      throw new Error("Spin transport creation did not advance the scene revision.");
    }
    await clickVisibleButton("Reset");
    await clickTabByText("Model");
    await clickVisibleButton("Expand All");
    await waitForVisible(`[data-node-id="${addedSpinNodeId}"]`);
    const spinPlacement = await evaluate(`() => {
      const scope = document.querySelector('[data-node-id="model:object:film:physics"]');
      const module = document.querySelector('[data-node-id="${addedSpinNodeId}"]');
      return { modulePresent: Boolean(module), scopeText: scope?.textContent || "" };
    }`);
    if (!spinPlacement.modulePresent || !spinPlacement.scopeText.includes("Physics · Film")) {
      throw new Error(`Added spin transport is not placed under Physics · Film: ${JSON.stringify(spinPlacement)}`);
    }

    const revisionBeforeInterfaceCreate = fixtureServer.sceneRevision();
    const addedInterfaceNodeId = "model:physics:cross-object:module:added-interface";
    await clickSelector('[data-node-id="model:object:film"]');
    await clickTabByText("Physics");
    await openVisibleMenuButton("Add Physics");
    await clickVisibleMenuItem("Spin Interface");
    await waitForText(".fm-inspector", "Spin interface");
    await setControl("Owning spin transport", "added-spin");
    await waitForEvaluate(`() => document.querySelector('.fm-inspector [aria-label="Owning spin transport"]')?.value === "added-spin"`);
    await setControl("Interface id", "added-interface");
    await setControl("Source object", "film");
    await setControl("Source region", "free");
    await setControl("Target object", "lead");
    await setControl("Source-to-target orientation", "1, 0, 0");
    await clickEnabledButton("Create");
    try {
      await waitForText(".fm-inspector", "Interface committed through its owning spin transport.");
    } catch (error) {
      const diagnostic = await evaluate(`() => ({
        body: (document.body?.innerText || "").slice(0, 5000),
        inspector: document.querySelector(".fm-inspector")?.innerText || "",
      })`);
      const recentRequests = fixtureServer.requests.slice(-20);
      throw new Error(`${error.message} interfaceCreateDiagnostic=${JSON.stringify(diagnostic)} recentRequests=${JSON.stringify(recentRequests)}`);
    }
    if (fixtureServer.sceneRevision() <= revisionBeforeInterfaceCreate) {
      throw new Error("Spin interface creation did not advance the scene revision.");
    }
    await clickVisibleButton("Reset");
    await clickTabByText("Model");
    await clickVisibleButton("Expand All");
    await waitForVisible(`[data-node-id="${addedInterfaceNodeId}"]`);
    const interfacePlacement = await evaluate(`() => {
      const scope = document.querySelector('[data-node-id="model:physics:cross-object"]');
      const module = document.querySelector('[data-node-id="${addedInterfaceNodeId}"]');
      return {
        modulePresent: Boolean(module),
        scopePresent: Boolean(scope),
        legacyRoots: [
          "model:physics:spin-transports",
          "model:physics:spin-interfaces",
        ].filter((id) => document.querySelector('[data-node-id="' + id + '"]')),
      };
    }`);
    if (!interfacePlacement.modulePresent || !interfacePlacement.scopePresent || interfacePlacement.legacyRoots.length > 0) {
      throw new Error(`Added spin interface has non-canonical placement: ${JSON.stringify(interfacePlacement)}`);
    }

    await clickSelector('[data-node-id="model:object:film:regions:free"]');
    await clickTabByText("Physics");
    await openVisibleMenuButton("Add Physics");
    await clickVisibleMenuItem("Electric current");
    try {
      await waitForText(".fm-inspector", "Charge transport");
    } catch (error) {
      const diagnostic = await evaluate(`() => ({
        body: (document.body?.innerText || "").slice(0, 5000),
        inspector: document.querySelector(".fm-inspector")?.innerText || "",
      })`);
      const recentRequests = fixtureServer.requests.slice(-40).map(({ method, path }) => ({ method, path }));
      throw new Error(`${error.message} regionCurrentDiagnostic=${JSON.stringify(diagnostic)} browserErrors=${JSON.stringify(browserErrors)} recentRequests=${JSON.stringify(recentRequests)}`);
    }
    await setControl("Name", "region-current");
    await clickEnabledButton("Create");
    await waitForText(".fm-inspector", "Transport resource committed.");
    await clickVisibleButton("Reset");
    await clickTabByText("Model");
    await clickVisibleButton("Expand All");
    await waitForVisible('[data-node-id="model:object:film:physics:module:region-current"]');

    await clickSelector('[data-node-id="model:object:film"]');
    await clickTabByText("Physics");
    await openVisibleMenuButton("Add Physics");
    await clickVisibleMenuItem("Spin torque");
    await waitForText(".fm-inspector", "Spin torque");
    await setControl("Torque id", "added-torque");
    await setControl("Current binding", "current_transport");
    await setControl("Current source", "added-current");
    await clickEnabledButton("Create");
    await waitForText(".fm-inspector", "Authoring resource committed.");
    await clickVisibleButton("Reset");

    await clickSelector('[data-node-id="model:object:film"]');
    await openVisibleMenuButton("Add Physics");
    await clickVisibleMenuItem("Oersted field");
    await waitForText(".fm-inspector", "Oersted field");
    await setControl("Oersted field id", "added-oersted");
    await setControl("Oersted model", "oersted_field");
    await setControl("Current solution source", "added-current");
    await clickEnabledButton("Create");
    await waitForText(".fm-inspector", "Authoring resource committed.");
    await clickVisibleButton("Reset");

    await openVisibleMenuButton("Global Physics");
    await clickVisibleMenuItem("Field Drive");
    await waitForText(".fm-inspector", "Regional field drive");
    await setControl("ID", "added-field-drive");
    await setControl("Name", "Added global drive");
    await clickEnabledButton("Apply");
    await waitForText(".fm-inspector", "Field drive created.");
    await waitForVisible('[data-node-id="model:physics:global:module:added-field-drive"]');

    await cdp.send("Page.reload", { ignoreCache: true }, sessionId);
    await waitForVisible(".fm-explorer");
    await clickTabByText("Model");
    await clickVisibleButton("Expand All");
    await waitForVisible('[data-node-id="model:object:film:physics:module:added-torque"]');
    await waitForVisible('[data-node-id="model:physics:global:module:added-oersted"]');
    await waitForVisible('[data-node-id="model:physics:global:module:added-field-drive"]');

    await verifyKnownRoute(
      "model:object:film:physics:module:known-current",
      "Charge transport",
      "Name",
    );
    await verifyInspectorResponsive([320, 390, 420]);
    await verifyUnsupportedRoute(
      "model:object:film:physics:module:future-current",
    );
    await verifyUnsupportedRoute(
      "model:object:film:physics:module:future-mixing",
    );
    await verifyKnownRoute(
      "model:object:film:physics:module:known-spin",
      "Spin transport",
      "Current source id",
    );
    await replaceField("Current source id", "future-current");
    const revisionBeforeRejectedDelete = fixtureServer.sceneRevision();
    await clickSelector('[data-node-id="model:object:film:physics:module:known-current"]');
    await clickEnabledButton("Delete");
    await waitForText(".fm-inspector", "referenced");
    if (fixtureServer.sceneRevision() !== revisionBeforeRejectedDelete) {
      throw new Error("Rejected deletion changed the scene revision.");
    }
    for (let index = browserErrors.length - 1; index >= 0; index -= 1) {
      if (browserErrors[index].includes("status of 422")) browserErrors.splice(index, 1);
    }

    await replaceFieldForGraphModule("model:object:film:physics:module:torque", "Polarization degree", "0.61", "Authoring resource committed.");
    await replaceFieldForGraphModule("model:physics:global:module:oersted", "Current", "7", "Authoring resource committed.");
    await clickSelector('[data-node-id="model:physics:cross-object:module:transparent"]');
    await replaceField("Source-to-target orientation", "0, 1, 0", "Interface committed through its owning spin transport.");

    await clickTabByText("Study");
    await clickVisibleButton("Export State");
    await clickTabByText("Results");
    await clickExplorerTabByText("Results");
    const resultsSnapshot = await evaluate(`() => ({
      explorer: document.querySelector(".fm-explorer")?.innerText || "",
      nodes: Array.from(document.querySelectorAll(".fm-explorer [data-node-id]")).map((node) => node.getAttribute("data-node-id")),
      tabs: Array.from(document.querySelectorAll(".fm-explorer-tabs [role=tab]")).map((node) => ({ selected: node.getAttribute("aria-selected"), text: (node.textContent || "").trim() })),
    })`);
    if (!resultsSnapshot.nodes.includes("results:root")) {
      throw new Error(`Explorer did not navigate to Results: ${JSON.stringify(resultsSnapshot)}`);
    }
    const writes = fixtureServer.requests.filter((request) => request.method !== "GET" && request.method !== "OPTIONS");
    if (writes.some((request) => request.method === "PATCH" && request.path === "/v2/sessions/current/model/current-transports/known-current")) throw new Error("Replace must not rename current transport path identity.");
    assertRequest(writes, "POST", "/v2/sessions/current/model/current-transports", (body) => body.resource.name === "added-current" && body.resource.solve_region === "film");
    assertRequest(writes, "POST", "/v2/sessions/current/model/spin-transports", (body) => body.base_revision === revisionBeforeSpinCreate && body.resource.id === "added-spin" && body.resource.current_source_id === "added-current" && body.resource.domain?.length === 1 && body.resource.domain[0]?.object_id === "film" && body.resource.domain[0]?.region_id === undefined);
    assertRequest(writes, "PATCH", "/v2/sessions/current/model/spin-transports/added-spin", (body) => body.base_revision === revisionBeforeInterfaceCreate && body.resource.id === "added-spin" && body.resource.interfaces?.some((item) => item.id === "added-interface" && item.kind === "transparent" && item.side_a?.object_id === "film" && item.side_a?.region_id === "free" && item.side_b?.object_id === "lead" && item.side_b?.region_id === undefined && item.normal_a_to_b?.join(",") === "1,0,0"));
    if (writes.some((request) => request.path.startsWith("/v2/sessions/current/model/spin-interfaces"))) {
      throw new Error(`Spin interfaces must be committed through their owning spin transport: ${JSON.stringify(writes)}`);
    }
    assertRequest(writes, "POST", "/v2/sessions/current/model/current-transports", (body) => body.resource.name === "region-current" && body.resource.model === "ohmic_poisson" && body.resource.solve_region === undefined && body.resource.domain?.length === 1 && body.resource.domain[0]?.object_id === "film" && body.resource.domain[0]?.region_id === "free");
    assertRequest(writes, "POST", "/v2/sessions/current/model/spin-torques", (body) => body.resource.id === "added-torque" && body.resource.current_source === "added-current");
    assertRequest(writes, "POST", "/v2/sessions/current/model/oersted-fields", (body) => body.resource.id === "added-oersted" && body.resource.kind === "oersted_field" && body.resource.source === "added-current");
    assertRequest(writes, "POST", "/v2/sessions/current/model/field-drives", (body) => body.drive.id === "added-field-drive" && body.drive.name === "Added global drive" && body.drive.target?.kind === "global");
    assertRequest(writes, "PATCH", "/v2/sessions/current/model/spin-transports/known-spin", (body) => body.resource.current_source_id === "future-current");
    assertRequest(writes, "DELETE", "/v2/sessions/current/model/current-transports/known-current", (body) => body.base_revision === revisionBeforeRejectedDelete);
    assertRequest(writes, "PATCH", "/v2/sessions/current/model/spin-torques/torque", (body) => body.resource.degree === 0.61 && body.resource.current_source === " torque-source ");
    assertRequest(writes, "PATCH", "/v2/sessions/current/model/oersted-fields/oersted", (body) => body.resource.current === 7);
    assertRequest(writes, "PATCH", "/v2/sessions/current/model/spin-transports/known-spin", (body) => body.resource.interfaces.some((item) => item.normal_a_to_b?.[1] === 1));
    assertRequest(writes, "POST", "/v2/sessions/current/persistence/exports", (body) => body.profile === "resume");
    const smokeFailure = transportAuthoringSmokeFailure(
      browserErrors,
      fixtureServer.unhandledRequests,
    );
    if (smokeFailure !== null) throw new Error(smokeFailure);
    console.log(`Transport authoring UI smoke passed at ${workspaceUrl}; driver=cdp; lane=${fixtureLane}.`);
  },
  startChromium: startChromiumForSmoke,
  startFixtureServer,
  stopChromium,
});

async function verifyKnownRoute(nodeId, title, fieldLabel) {
  await clickSelector(`[data-node-id="${nodeId}"]`);
  try {
    await waitForText(".fm-inspector", title);
  } catch (error) {
    const diagnostic = await evaluate(`() => ({
      inspector: document.querySelector(".fm-inspector")?.innerText || "",
      selected: document.querySelector('[data-node-id="${nodeId}"]')?.getAttribute("aria-selected"),
    })`);
    throw new Error(`${error.message} route=${nodeId} expected=${title} diagnostic=${JSON.stringify(diagnostic)}`);
  }
  await waitForVisible(`.fm-inspector [aria-label="${fieldLabel}"]`);
}

async function verifyInspectorResponsive(widths) {
  for (const width of widths) {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      deviceScaleFactor: 1,
      height: 900,
      mobile: false,
      width,
    }, sessionId);
    await waitForEvaluate(`() => {
      const inspector = document.querySelector(".fm-inspector");
      return Boolean(inspector && inspector.getBoundingClientRect().width > 0);
    }`);
    const metrics = await evaluate(`() => {
      const inspector = document.querySelector(".fm-inspector");
      return {
        clientWidth: inspector?.clientWidth ?? 0,
        scrollWidth: inspector?.scrollWidth ?? 0,
      };
    }`);
    if (metrics.scrollWidth > metrics.clientWidth + 1) {
      throw new Error(`Inspector overflows horizontally at ${width}px: ${JSON.stringify(metrics)}`);
    }
  }
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height: 900,
    mobile: false,
    width: 1440,
  }, sessionId);
}

async function replaceField(label, value, successText = "Transport resource committed.") {
  await setControl(label, value);
  await waitForEvaluate(`() => Array.from(document.querySelectorAll('.fm-inspector button')).some((button) => button.textContent.trim() === "Replace" && !button.disabled)`);
  await evaluate(`() => {
    const button = Array.from(document.querySelectorAll('.fm-inspector button')).find((entry) => entry.textContent.trim() === "Replace");
    button.click();
    return true;
  }`);
  await waitForText(".fm-inspector", successText);
}

async function visibleCrud(memberNodeId, fieldLabel, replacement, rootNodeId) {
  await clickSelector(`[data-node-id="${memberNodeId}"]`);
  await replaceField(fieldLabel, replacement, "Authoring resource committed.");
  await clickSelector(`[data-node-id="${rootNodeId}"]`);
  await clickEnabledButton("Create");
  await waitForText(".fm-inspector", "Authoring resource committed.");
  await clickSelector(`[data-node-id="${memberNodeId}"]`);
  await clickEnabledButton("Delete");
  await waitForText(".fm-inspector", "Authoring resource deleted.");
}

async function replaceFieldForGraphModule(nodeId, fieldLabel, replacement, successText) {
  await clickSelector(`[data-node-id="${nodeId}"]`);
  await replaceField(fieldLabel, replacement, successText);
}

async function setControl(label, value) {
  await waitForVisible(`.fm-inspector [aria-label="${label}"]`);
  const isSelect = await evaluate(`() => document.querySelector('.fm-inspector [aria-label=${JSON.stringify(label)}]') instanceof HTMLSelectElement`);
  if (isSelect) {
    await waitForEvaluate(`() => Array.from(document.querySelector('.fm-inspector [aria-label=${JSON.stringify(label)}]')?.options ?? []).some((option) => option.value === ${JSON.stringify(value)})`);
  }
  const selectState = await evaluate(`() => {
    const control = document.querySelector('.fm-inspector [aria-label=${JSON.stringify(label)}]');
    if (!(control instanceof HTMLSelectElement)) return null;
    control.focus();
    return {
      currentValue: control.value,
      optionValues: Array.from(control.options).map((option) => option.value),
    };
  }`);
  if (selectState !== null) {
    const keyPlan = keyboardSelectPlan(selectState.currentValue, selectState.optionValues, value);
    for (const key of keyPlan) {
      await cdp.send("Input.dispatchKeyEvent", { code: key, key, type: "keyDown" }, sessionId);
      await cdp.send("Input.dispatchKeyEvent", { code: key, key, type: "keyUp" }, sessionId);
    }
    await waitForEvaluate(`() => document.querySelector('.fm-inspector [aria-label=${JSON.stringify(label)}]')?.value === ${JSON.stringify(value)}`);
    return;
  }
  await evaluate(`() => {
    const control = document.querySelector('.fm-inspector [aria-label=${JSON.stringify(label)}]');
    const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(control, ${JSON.stringify(value)});
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }`);
}

export function keyboardSelectPlan(currentValue, optionValues, targetValue) {
  const targetIndex = optionValues.indexOf(targetValue);
  if (targetIndex < 0) {
    throw new Error(`Select has no option ${JSON.stringify(targetValue)}.`);
  }
  if (currentValue === targetValue) return [];
  return ["Home", ...Array.from({ length: targetIndex }, () => "ArrowDown")];
}

async function clickVisibleButton(text) {
  await waitForEvaluate(`() => Array.from(document.querySelectorAll('button')).some((button) => button.textContent.trim() === ${JSON.stringify(text)} && !button.disabled && button.getBoundingClientRect().width > 0)`);
  await evaluate(`() => {
    const button = Array.from(document.querySelectorAll('button')).find((entry) => entry.textContent.trim() === ${JSON.stringify(text)} && !entry.disabled && entry.getBoundingClientRect().width > 0);
    button.click(); return true;
  }`);
}

async function openVisibleMenuButton(text) {
  await waitForEvaluate(`() => Array.from(document.querySelectorAll('button')).some((button) => button.textContent.trim() === ${JSON.stringify(text)} && !button.disabled && button.getBoundingClientRect().width > 0)`);
  await evaluate(`() => {
    const button = Array.from(document.querySelectorAll('button')).find((entry) => entry.textContent.trim() === ${JSON.stringify(text)} && !entry.disabled && entry.getBoundingClientRect().width > 0);
    button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    button.click();
    return true;
  }`);
}

async function clickVisibleMenuItem(text) {
  try {
    await waitForEvaluate(`() => Array.from(document.querySelectorAll('[role="menuitem"]')).some((node) => (node.textContent || "").trim().includes(${JSON.stringify(text)}) && node.getAttribute("aria-disabled") !== "true")`);
  } catch (error) {
    const items = await evaluate(`() => Array.from(document.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')).map((node) => ({ disabled: node.getAttribute("aria-disabled"), text: (node.textContent || "").trim() }))`);
    throw new Error(`${error.message} menuItems=${JSON.stringify(items)}`);
  }
  await evaluate(`() => {
    const node = Array.from(document.querySelectorAll('[role="menuitem"]'))
      .find((entry) => (entry.textContent || "").trim().includes(${JSON.stringify(text)}) && entry.getAttribute("aria-disabled") !== "true");
    node.click();
    return true;
  }`);
}

async function clickEnabledButton(text) {
  try {
    await waitForEvaluate(`() => Array.from(document.querySelectorAll('.fm-inspector button')).some((button) => button.textContent.trim() === ${JSON.stringify(text)} && !button.disabled)`);
  } catch (error) {
    const diagnostic = await evaluate(`() => ({
      buttons: Array.from(document.querySelectorAll('.fm-inspector button')).map((button) => ({
        disabled: button.disabled,
        text: button.textContent.trim(),
      })),
      inspector: document.querySelector('.fm-inspector')?.innerText || '',
    })`);
    throw new Error(`${error.message} enabledButton=${JSON.stringify(text)} diagnostic=${JSON.stringify(diagnostic)}`);
  }
  await evaluate(`() => {
    const button = Array.from(document.querySelectorAll('.fm-inspector button')).find((entry) => entry.textContent.trim() === ${JSON.stringify(text)} && !entry.disabled);
    button.click();
    return true;
  }`);
}

function assertRequest(requests, method, path, predicate) {
  if (!requests.some((request) => request.method === method && request.path === path && predicate(request.body))) {
    throw new Error(`Missing exact ${method} ${path} request in ${JSON.stringify(requests)}`);
  }
}

async function verifyUnsupportedRoute(nodeId) {
  const selector = `[data-node-id="${nodeId}"]`;
  await waitForEvaluate(
    `() => (document.querySelector(${JSON.stringify(selector)})?.textContent || "").includes("unsupported")`,
  );
  await clickSelector(selector);
  try {
    await waitForText(
      ".fm-inspector",
      "Unknown transport variant is preserved losslessly and is read-only.",
    );
  } catch (error) {
    const inspector = await evaluate(`() => document.querySelector(".fm-inspector")?.innerText || ""`);
    throw new Error(`${error.message} unsupportedRoute=${nodeId} inspector=${JSON.stringify(inspector)}`);
  }
  await waitForVisible('.fm-inspector [aria-label="Opaque payload"]');
  const exposed = await evaluate(`() => {
    const inspector = document.querySelector(".fm-inspector");
    if (!inspector) return ["missing inspector"];
    const buttons = Array.from(inspector.querySelectorAll("button"))
      .map((node) => (node.textContent || "").trim())
      .filter((text) => text === "Replace" || text === "Delete");
    const editable = ["Name", "Interfaces", "Current source id"].filter(
      (label) => inspector.querySelector('[aria-label="' + label + '"]'),
    );
    return [...buttons, ...editable];
  }`);
  if (exposed.length > 0) {
    throw new Error(`Unsupported transport exposes mutations: ${exposed.join(", ")}`);
  }
}

export async function startFixtureServer() {
  const requests = [];
  const unhandledRequests = [];
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method === "OPTIONS") {
      writeEmpty(response, 204);
      return;
    }
    const body = request.method === "GET" ? null : await readJson(request);
    requests.push({ body, method: request.method, path });
    if (path === "/v2/sessions/current/model/transport-validation" && request.method === "POST") {
      const candidate = body?.candidate ?? {};
      const identity = candidate.kind === "current_transport" ? candidate.resource?.name : candidate.resource?.id;
      const pathIdentityValid = candidate.operation !== "replace" || candidate.path_id == null || identity === candidate.path_id;
      const currentNames = [...currentTransports.map((item) => item.name), ...requests.filter((item) => item.method === "POST" && item.path === "/v2/sessions/current/model/current-transports").map((item) => item.body?.resource?.name)];
      const bindingValid = candidate.kind !== "spin_transport" || currentNames.includes(candidate.resource?.current_source_id);
      const valid = pathIdentityValid && bindingValid;
      writeJson(response, {
        execution: { authoring_allowed: valid, qualification: valid ? "semantic_only" : "unsupported", reason: valid ? "Fixture validates path identity and resulting-scene bindings." : "Fixture rejected path identity or current binding.", requested_lane: null, resolved_lane: null, status: valid ? "semantic_only" : "unsupported" },
        scene_revision: sceneRevision,
        semantic: { issues: valid ? [] : [{ code: "fixture_invalid_candidate", message: "Path identity or current binding is invalid.", path: "candidate" }], valid },
        validation_version: "transport-authoring-validation.v1",
      });
      return;
    }
    if (path === "/v2/sessions/current/persistence/exports" && request.method === "POST") {
      writeJson(response, { fms_base64: "Zml4dHVyZQ==", profile: body.profile, session_id: "transport-authoring-smoke", size_bytes: 7 });
      return;
    }
    if (path === "/v2/sessions/current/simulation/commands" && request.method === "POST") {
      writeJson(response, { accepted: true, command_id: "fixture-command", error: null });
      return;
    }
    if (path === "/v2/sessions/current/visualization/client-acks" && request.method === "POST") {
      writeJson(response, {
        client_id: body.client_id,
        revision: body.revision,
        status: body.status,
      });
      return;
    }
    if (
      path === "/v2/sessions/current/model/current-transports/known-current" &&
      request.method === "DELETE"
    ) {
      writeJson(response, {
        code: "resource_in_use",
        message: "Current transport 'known-current' is referenced by spin transport 'known-spin'.",
      }, 422);
      return;
    }
    if (path === "/v2/sessions/current/model/current-transports" && request.method === "POST") {
      currentTransports.push(structuredClone(body.resource));
      sceneRevision += 1;
      writeJson(response, { resource: body.resource, scene_revision: sceneRevision });
      return;
    }
    if (path === "/v2/sessions/current/model/spin-transports" && request.method === "POST") {
      spinTransports.push(structuredClone(body.resource));
      sceneRevision += 1;
      writeJson(response, { resource: body.resource, scene_revision: sceneRevision });
      return;
    }
    if (path === "/v2/sessions/current/model/spin-torques" && request.method === "POST") {
      spinTorques.push(structuredClone(body.resource));
      sceneRevision += 1;
      writeJson(response, { resource: body.resource, scene_revision: sceneRevision });
      return;
    }
    if (path === "/v2/sessions/current/model/oersted-fields" && request.method === "POST") {
      oerstedFields.push(structuredClone(body.resource));
      sceneRevision += 1;
      writeJson(response, { resource: body.resource, scene_revision: sceneRevision });
      return;
    }
    if (path === "/v2/sessions/current/model/field-drives" && request.method === "POST") {
      fieldDrives.push(structuredClone(body.drive));
      sceneRevision += 1;
      writeJson(response, { drive: body.drive, scene_revision: sceneRevision });
      return;
    }
    if (path.startsWith("/v2/sessions/current/model/spin-transports/") && request.method === "PATCH") {
      const id = decodeURIComponent(path.split("/").at(-1));
      const index = spinTransports.findIndex((item) => item.id === id);
      if (index >= 0) spinTransports[index] = structuredClone(body.resource);
      sceneRevision += 1;
      writeJson(response, { resource: body.resource, scene_revision: sceneRevision });
      return;
    }
    if (path.startsWith("/v2/sessions/current/model/spin-torques/") && request.method === "PATCH") {
      const id = decodeURIComponent(path.split("/").at(-1));
      const index = spinTorques.findIndex((item) => item.id === id);
      if (index >= 0) spinTorques[index] = structuredClone(body.resource);
      sceneRevision += 1;
      writeJson(response, { resource: body.resource, scene_revision: sceneRevision });
      return;
    }
    if (path.startsWith("/v2/sessions/current/model/oersted-fields/") && request.method === "PATCH") {
      const id = decodeURIComponent(path.split("/").at(-1));
      const index = oerstedFields.findIndex((item) => item.id === id);
      if (index >= 0) oerstedFields[index] = structuredClone(body.resource);
      sceneRevision += 1;
      writeJson(response, { resource: body.resource, scene_revision: sceneRevision });
      return;
    }
    if (request.method === "PATCH" || request.method === "POST" || request.method === "DELETE") {
      writeJson(response, {
        code: "unsupported_fixture_mutation",
        message: `Transport authoring smoke fixture does not implement ${request.method} ${path}.`,
      }, 404);
      return;
    }
    if (path === "/v2/sessions/current/status") {
      writeJson(response, statusFixture());
      return;
    }
    if (path === "/v2/sessions/current/simulation/preparation") {
      writeJson(response, preparationFixture());
      return;
    }
    if (path === "/v2/sessions/current/model/scene") {
      writeJson(response, sceneFixture());
      return;
    }
    if (path === "/v2/sessions/current/model/physics-graph") {
      writeJson(response, physicsGraphFixture());
      return;
    }
    if (path === "/v2/sessions/current/model/regions") {
      writeJson(response, regionListFixture());
      return;
    }
    if (path === "/v2/sessions/current/model/material-fields") {
      writeJson(response, { fields: [], scene_revision: sceneRevision });
      return;
    }
    if (path === "/v2/sessions/current/model/region-diagnostics") {
      writeJson(response, { diagnostics: [], scene_revision: sceneRevision });
      return;
    }
    if (path === "/v2/sessions/current/model/couplings") {
      writeJson(response, { couplings: [], scene_revision: sceneRevision });
      return;
    }
    if (path === "/v2/sessions/current/data/domain/meta") {
      writeJson(response, domainMetaFixture());
      return;
    }
    if (path === "/v2/sessions/current/data/domain/fdm-multilayer-layout") {
      if (fixtureLane === "fem") {
        writeEmpty(response, 204);
        return;
      }
      writeJson(response, {
        airbox: null,
        available: false,
        backend: "fdm",
        common_transform_layout: null,
        domain_generation_id: "fixture-domain-1",
        execution_revision: 1,
        layers: [],
        layout_fingerprint: null,
        layout_revision: 1,
        observation_revision: 1,
        requested_mode: "single_grid",
        resolved_mode: "single_grid",
        schema_version: "fdm-multilayer-layout.v1",
        strategy: "single_grid",
        unavailable_reason: "single_grid_session",
      });
      return;
    }
    if (path === "/v2/sessions/current/data/fdm-region-memberships") {
      if (fixtureLane === "fem") {
        writeEmpty(response, 204);
        return;
      }
      writeJson(response, fdmMembershipFixture());
      return;
    }
    if (path === "/v2/sessions/current/data/fields") {
      writeJson(response, {
        domain_generation_id: "fixture-domain-1",
        quantities: [],
        revision: sceneRevision,
      });
      return;
    }
    if (path === "/v2/sessions/current/model/geometry/validation") {
      writeJson(response, {
        backend_target: fixtureLane,
        diagnostics: [],
        dirty: false,
        scene_revision: sceneRevision,
        status: "valid",
      });
      return;
    }
    if (path === "/v2/sessions/current/visualization/state") {
      writeJson(response, visualizationStateFixture());
      return;
    }
    if (path === "/v2/sessions/current/model/geometry/capabilities") {
      writeJson(response, {
        csg_capabilities: [],
        primitive_capabilities: [],
        revision: sceneRevision,
      });
      return;
    }
    if (path === "/v2/sessions/current/meshing/capabilities") {
      writeJson(response, {
        mesh_adaptivity_state: null,
        mesh_capabilities: null,
        revision: sceneRevision,
      });
      return;
    }
    if (path === "/v2/sessions/current/meshing/semantics") {
      writeJson(response, {
        mesh_build_diagnostics: null,
        object_configs: [],
        render_only_controls_do_not_change_solver_domain: true,
        revision: sceneRevision,
        shared_domain_config: {},
        solver_mesh: null,
        universe_config: null,
      });
      return;
    }
    if (path === "/v2/sessions/current/meshing/policies/universe") {
      writeJson(response, {
        config: null,
        effective_config: null,
        revision: sceneRevision,
      });
      return;
    }
    if (path === "/v2/sessions/current/model/planar-monitors") {
      writeJson(response, { count: 0, monitors: [], scene_revision: sceneRevision });
      return;
    }
    if (path === "/v2/sessions/current/model/universe") {
      writeJson(response, {
        mesh_dirty: false,
        object_bounds_max: [16e-9, 8e-9, 2e-9],
        object_bounds_min: [0, 0, 0],
        scene_revision: sceneRevision,
        study_universe_mesh: null,
        universe: null,
      });
      return;
    }
    if (path === "/v2/sessions/current/data/mesh-region-membership/free") {
      writeJson(response, {
        boundary_face_indices: [],
        element_indices: [],
        freshness: "current",
        mesh_generation_id: "fixture-domain-1",
        mesh_id: "fixture-domain",
        mesh_part_ids: [],
        mesh_revision: 1,
        node_indices: [],
        owner_object_id: "film",
        realization: "certified",
        realization_method: "fixture",
        realization_warnings: [],
        region_id: "free",
        region_membership_revision: 1,
        source: "fixture",
        topology_fingerprint: "fixture-topology-1",
      });
      return;
    }
    if (path === "/v2/sessions/current/meshing/builds/current") {
      writeJson(response, {
        active_build: null,
        effective_airbox_target: null,
        effective_per_object_targets: null,
        last_build_error: null,
        last_build_summary: null,
        mesh_pipeline_status: [],
        policy_diff: [],
        provenance: null,
        published_resources: null,
        resolved_policy: null,
        revision: sceneRevision,
        shared_domain_build_report: null,
      });
      return;
    }
    if (path === "/v2/sessions/current/simulation/runs/current") {
      writeJson(response, {
        active_stage_index: null,
        active_stage_kind: null,
        artifact_dir: "/tmp/fullmag-transport-authoring-smoke/artifacts",
        requested_backend: fixtureLane,
        requested_device: "cpu",
        requested_mode: "strict",
        requested_precision: "double",
        resolved_backend: fixtureLane,
        resolved_device: "cpu",
        resolved_engine_id: fixtureLane === "fem" ? "fem_cpu_reference" : "fdm_cpu_reference",
        resolved_fallback: null,
        resolved_mode: "strict",
        resolved_precision: "double",
        resolved_runtime_family: "fixture",
        resolved_worker: null,
        revision: sceneRevision,
        run_id: "transport-authoring-smoke-run",
        session_id: "transport-authoring-smoke",
        solver_time_seconds: 0,
        started_at: "2026-08-09T00:00:00.000Z",
        status: "idle",
        status_reason: null,
        total_stages: 1,
        total_steps: 0,
      });
      return;
    }
    if (path === "/v2/sessions/current/persistence/checkpoints") {
      writeJson(response, { checkpoints: [], revision: sceneRevision });
      return;
    }
    if (
      path === "/v2/sessions/current/meshing/meshes/shared-domain/manifest" ||
      path === "/v2/sessions/current/data/domain/topology" ||
      path === "/v2/sessions/current/data/fdm-region-membership" ||
      path === "/v2/sessions/current/analysis/frequency-domain/manifest.v1" ||
      path === "/v2/sessions/current/analysis/frequency-domain/eigen/spectrum.v2" ||
      path === "/v2/sessions/current/analysis/frequency-domain/eigen/branches.v2" ||
      path === "/v2/sessions/current/analysis/frequency-domain/eigen/dispersion" ||
      path === "/v2/sessions/current/analysis/frequency-domain/response/magnetic-sweep" ||
      path === "/v2/sessions/current/analysis/frequency-domain/response/progress.v1"
    ) {
      writeEmpty(response, 204);
      return;
    }
    if (path === "/v2/sessions/current/model/current-transports") {
      writeJson(response, { items: currentTransports, scene_revision: sceneRevision });
      return;
    }
    if (path === "/v2/sessions/current/model/spin-transports") {
      writeJson(response, { items: spinTransports, scene_revision: sceneRevision });
      return;
    }
    if (path === "/v2/sessions/current/model/spin-interfaces") {
      writeJson(response, { items: spinInterfaceProjections(), scene_revision: sceneRevision });
      return;
    }
    if (path === "/v2/sessions/current/model/spin-torques") {
      writeJson(response, { items: spinTorques, scene_revision: sceneRevision });
      return;
    }
    if (path === "/v2/sessions/current/model/oersted-fields") {
      writeJson(response, { items: oerstedFields, scene_revision: sceneRevision });
      return;
    }
    if (path === "/v2/sessions/current/model/field-drives") {
      writeJson(response, { drives: fieldDrives, scene_revision: sceneRevision });
      return;
    }
    if (path === "/v2/sessions/current/simulation/commands") {
      writeJson(response, { commands: [], revision: 1, runtime_controls: [{ enabled: true, kind: "solve", reason: null }] });
      return;
    }
    if (path === "/v2/sessions/current/simulation/solver/status") {
      writeJson(response, { revision: 1, runtime_state: "idle" });
      return;
    }
    if (path === "/v2/sessions/current/simulation/stages/execution") {
      writeJson(response, { active_stage_index: null, completed_stage_indexes: [0], revision: 1, runtime_state: "idle", stages: [{ artifact_refs: ["fixture://m"], id: "fixture-stage", result: { quantity: "m" }, status: "completed" }], total_stages: 1 });
      return;
    }
    if (path === "/v2/sessions/current/simulation/objects/film/metrics") {
      writeJson(response, objectMetricsFixture("film"));
      return;
    }
    unhandledRequests.push({ method: request.method, path });
    writeJson(response, {
      code: "unsupported_fixture_request",
      message: `Transport authoring smoke fixture does not implement ${request.method} ${path}.`,
    }, 404);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Transport fixture server did not bind to a TCP port.");
  }
  return {
    activatePhysicsGraph: () => {
      physicsGraphEnabled = true;
      sceneRevision += 1;
    },
    sceneRevision: () => sceneRevision,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
    requests,
    unhandledRequests,
  };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeJson(response, body, status = 200) {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(status, fixtureHeaders({
    "content-length": String(payload.byteLength),
    "content-type": "application/json",
  }));
  response.end(payload);
}

function writeEmpty(response, status) {
  response.writeHead(status, fixtureHeaders());
  response.end();
}

function fixtureHeaders(extra = {}) {
  return {
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "x-api-contract-version,etag,x-request-id",
    "x-api-contract-version": "1.0.0",
    ...extra,
  };
}

async function startChromiumForSmoke() {
  return startChromium({
    createProfile: () => mkdtempSync(join(tmpdir(), "fullmag-transport-smoke-")),
    findExecutable: findChromiumExecutable,
    removeProfile: removeProfileDirectory,
    spawnBrowser: (executable, userDataDir) => spawn(executable, [
      "--headless=new",
      "--disable-dev-shm-usage",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
      "--no-sandbox",
      "--remote-debugging-port=0",
      "--use-angle=swiftshader-webgl",
      "--use-gl=angle",
      `--user-data-dir=${userDataDir}`,
      "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe"] }),
    stopChromium,
    waitForDevTools,
  });
}

async function waitForDevTools(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for Chromium DevTools endpoint.")),
      timeoutMs,
    );
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Chromium exited before DevTools was ready: code=${code} signal=${signal}`));
    });
    child.stderr.on("data", (chunk) => {
      const match = String(chunk).match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
  });
}

function findChromiumExecutable() {
  const explicit = process.env.CHROME_BIN
    ?? process.env.CHROMIUM_BIN
    ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (explicit) return explicit;
  const candidates = [
    "/home/kkingstoun/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome",
    "/home/kkingstoun/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ];
  return candidates.find((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }) ?? candidates[0];
}

async function stopChromium(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 2_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGTERM");
  });
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function connectCdp(wsUrl) {
  return connectCdpSocket({
    createWebSocket: (url) => new WebSocket(url),
    timeoutMs: 5_000,
    url: wsUrl,
  });
}

async function evaluate(expression) {
  const source = expression.trim();
  const wrapped = source.startsWith("() =>") || source.startsWith("async () =>")
    ? `(${source})()`
    : expression;
  const result = await cdp.send("Runtime.evaluate", {
    awaitPromise: true,
    expression: wrapped,
    returnByValue: true,
  }, sessionId);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? "Runtime.evaluate failed");
  }
  return result.result?.value;
}

async function waitForEvaluate(functionSource) {
  await waitForCondition(async () => evaluate(`(${functionSource})()`));
}

async function waitForVisible(selector) {
  try {
    await waitForEvaluate(`() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return false;
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none"
        && rect.width > 0 && rect.height > 0;
    }`);
  } catch (error) {
    const diagnostics = await evaluate(`() => ({
      url: location.href,
      title: document.title,
      bodyText: (document.body?.innerText || "").slice(0, 4000),
      explorerNodes: Array.from(document.querySelectorAll(".fm-explorer [data-node-id]"))
        .map((node) => node.getAttribute("data-node-id")),
      apiErrors: Array.from(document.querySelectorAll("[role=alert], .fm-feedback-banner"))
        .map((node) => (node.textContent || "").trim())
        .filter(Boolean),
      resources: performance.getEntriesByType("resource")
        .map((entry) => entry.name)
        .slice(-40),
    })`);
    throw new Error(`${error.message} selector=${selector} browserErrors=${JSON.stringify(browserErrors)} diagnostics=${JSON.stringify(diagnostics)}`);
  }
}

async function waitForText(selector, text) {
  await waitForEvaluate(
    `() => (document.querySelector(${JSON.stringify(selector)})?.textContent || "").includes(${JSON.stringify(text)})`,
  );
}

async function clickSelector(selector) {
  await waitForVisible(selector);
  await evaluate(`() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    node.scrollIntoView({ block: "center", inline: "center" });
    node.click();
    return true;
  }`);
}

async function clickTabByText(text) {
  await waitForEvaluate(
    `() => Array.from(document.querySelectorAll('[role="tab"]')).some((node) => (node.textContent || "").trim() === ${JSON.stringify(text)})`,
  );
  await evaluate(`() => {
    const node = Array.from(document.querySelectorAll('[role="tab"]'))
      .find((entry) => (entry.textContent || "").trim() === ${JSON.stringify(text)});
    node.click();
    return true;
  }`);
}

async function clickExplorerTabByText(text) {
  const selector = ".fm-explorer-tabs [role=\"tab\"]";
  await waitForEvaluate(
    `() => Array.from(document.querySelectorAll(${JSON.stringify(selector)})).some((node) => (node.textContent || "").trim() === ${JSON.stringify(text)})`,
  );
  await evaluate(`() => {
    const node = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
      .find((entry) => (entry.textContent || "").trim() === ${JSON.stringify(text)});
    node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, ctrlKey: false }));
    return true;
  }`);
  await waitForEvaluate(
    `() => Array.from(document.querySelectorAll(${JSON.stringify(selector)})).some((node) => (node.textContent || "").trim() === ${JSON.stringify(text)} && node.getAttribute("aria-selected") === "true")`,
  );
}

async function waitForCondition(predicate) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() <= deadline) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Browser condition timed out.${lastError ? ` ${lastError.message}` : ""}`);
}

function sceneFixture() {
  return {
    current_modules: { excitation_analysis: null, modules: [] },
    editor: {},
    magnetization_assets: [],
    materials: [],
    metadata: {
      authoring_schema: "scene-document.v1",
      id: "transport-authoring-smoke",
      name: "Transport authoring smoke",
      source_of_truth: "fixture",
    },
    objects: [
      {
        allocated_region_ids: [],
        geometry: {
          geometry_kind: "Box",
          geometry_params: { size: [16e-9, 8e-9, 2e-9] },
        },
        id: "film",
        material_ref: null,
        name: "Film",
        region_name: "film",
        regions: [{
          enabled: true,
          frame: "object",
          name: "Free region",
          region_id: "free",
          shape: { center: [0, 0, 0], kind: "box", size: [8e-9, 8e-9, 2e-9] },
        }],
        transform: {
          pivot: [0, 0, 0],
          rotation_quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
          translation: [0, 0, 0],
        },
      },
      {
        allocated_region_ids: [],
        geometry: {
          geometry_kind: "Box",
          geometry_params: { size: [4e-9, 8e-9, 2e-9] },
        },
        id: "lead",
        material_ref: null,
        name: "Lead",
        region_name: "lead",
        regions: [],
        transform: {
          pivot: [0, 0, 0],
          rotation_quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
          translation: [16e-9, 0, 0],
        },
      },
    ],
    outputs: { items: [] },
    revision: sceneRevision,
    study: { stages: [] },
    universe: null,
  };
}

function regionListFixture() {
  return {
    geometry_realization_revision: sceneRevision,
    regions: [{
      bounds_max: [4e-9, 4e-9, 1e-9],
      bounds_min: [-4e-9, -4e-9, -1e-9],
      enabled: true,
      frame: "object",
      interaction_refs: [],
      material_ref: "",
      mesh_part_ids: [],
      name: "Free region",
      owner_object_id: "film",
      region_id: "free",
      source: "authored_object_region",
      source_body_ids: [],
      source_object_ids: ["film"],
    }],
    scene_revision: sceneRevision,
  };
}

function objectMetricsFixture(objectId) {
  return {
    energies: {
      anisotropy: 0,
      demag: 0,
      dmi: 0,
      exchange: 0,
      total: 0,
      zeeman: 0,
    },
    has_solver_sample: false,
    magnetization_average: { mx: 1, my: 0, mz: 0 },
    object_id: objectId,
    revision: sceneRevision,
    source: "fixture",
    step: 0,
    time_seconds: 0,
  };
}

function domainMetaFixture() {
  if (fixtureLane === "fem") {
    return {
      bounds: { max: [16e-9, 8e-9, 2e-9], min: [0, 0, 0] },
      coordinate_system: "cartesian",
      counts: { boundary_faces: 12, elements: 24, nodes: 18 },
      dimension: 3,
      discretization: "fem",
      domain_id: "fixture-domain",
      element_type: "tet4",
      generation_id: "fixture-domain-1",
      grid: null,
      units: { length: "m" },
    };
  }
  return {
    bounds: { max: [16e-9, 8e-9, 2e-9], min: [0, 0, 0] },
    coordinate_system: "cartesian",
    counts: { cells: 256 },
    dimension: 3,
    discretization: "fdm",
    domain_id: "fixture-domain",
    generation_id: "fixture-domain-1",
    grid: {
      origin: [0, 0, 0],
      shape: [16, 8, 2],
      spacing: [1e-9, 1e-9, 1e-9],
    },
    units: { length: "m" },
  };
}

function fdmMembershipFixture() {
  return {
    binary_path: "fixture-membership.bin",
    cell_count: 256,
    cell_m: [1e-9, 1e-9, 1e-9],
    counts: [16, 8, 2],
    domain_generation_id: "fixture-domain-1",
    encoding: "u32le",
    freshness: "current",
    grid_fingerprint: "fixture-grid-1",
    mesh_revision: 1,
    origin_m: [0, 0, 0],
    region_legend: [],
    region_membership_revision: 1,
    schema_version: "fdm_region_membership.v1",
  };
}

function spinInterfaceProjections() {
  return spinTransports.flatMap((spin) => spin.interfaces.map((spinInterface) => ({
    interface: spinInterface,
    interface_id: spinInterface.id,
    known: spin.id !== "future-mixing",
    owner_spin_transport_id: spin.id,
  })));
}

function physicsGraphFixture() {
  const module = (id, kind, family, label, appliesTo, dependsOn = [], activation = "active") => ({
    activation,
    applies_to: appliesTo,
    authored_state: "authored",
    capability: "semantic_only",
    depends_on: dependsOn,
    id,
    kind,
    presentation: { family, label },
    solve_domain: [],
    source_path: `/fixture/${kind}/${id}`,
  });
  return {
    edges: [],
    modules: physicsGraphEnabled ? [
      module("known-current", "current_transport", "prescribed_density", "Known current", [{ kind: "object", object_id: "film" }]),
      module("future-current", "current_transport", "unsupported", "Future current", [{ kind: "object", object_id: "film" }], [], "unsupported"),
      module("known-spin", "spin_transport", "steady", "Known spin transport", [{ kind: "object", object_id: "film" }], ["known-current"]),
      module("future-mixing", "spin_transport", "unsupported", "Future mixing transport", [{ kind: "object", object_id: "film" }], ["known-current"], "unsupported"),
      module("transparent", "spin_interface", "transparent", "Transparent interface", [{ kind: "cross_object", object_ids: ["film", "lead"] }], ["known-spin"]),
      module("torque", "spin_torque", "zhang_li", "Zhang-Li torque", [{ kind: "object", object_id: "film" }]),
      module("oersted", "oersted_field", "oersted_cylinder", "Oersted field", [{ kind: "global" }]),
      ...currentTransports
        .filter((current) => current.name === "added-current" || current.name === "region-current")
        .map((current) => module(
          current.name,
          "current_transport",
          current.model,
          current.name === "region-current" ? "Region current" : "Added current",
          current.name === "region-current"
            ? [{ kind: "region", object_id: "film", region_id: "free" }]
            : [{ kind: "object", object_id: "film" }],
        )),
      ...spinTransports
        .filter((spin) => spin.id === "added-spin")
        .map((spin) => module(
          spin.id,
          "spin_transport",
          spin.mode,
          "Added spin transport",
          spin.domain.map((scope) => ({
            kind: scope.region_id ? "region" : "object",
            object_id: scope.object_id,
            ...(scope.region_id ? { region_id: scope.region_id } : {}),
          })),
          [spin.current_source_id],
        )),
      ...spinTransports
        .filter((spin) => spin.id === "added-spin")
        .flatMap((spin) => spin.interfaces.map((spinInterface) => {
          const sideA = spinInterface.kind === "transparent"
            ? spinInterface.side_a
            : spinInterface.normal_side;
          const sideB = spinInterface.kind === "transparent"
            ? spinInterface.side_b
            : spinInterface.ferromagnet_side;
          return module(
            spinInterface.id,
            "spin_interface",
            spinInterface.kind,
            "Added spin interface",
            [{
              kind: "cross_object",
              object_ids: [sideA.object_id, sideB.object_id],
            }],
            [spin.id],
          );
        })),
      ...spinTorques
        .filter((torque) => torque.id === "added-torque")
        .map((torque) => module(
          torque.id,
          "spin_torque",
          torque.kind,
          "Added torque",
          [{ kind: "object", object_id: "film" }],
          [torque.current_source],
        )),
      ...oerstedFields
        .filter((field) => field.id === "added-oersted")
        .map((field) => module(
          field.id,
          "oersted_field",
          field.kind,
          "Added Oersted field",
          [{ kind: "global" }],
          [field.source],
        )),
      ...fieldDrives
        .filter((drive) => drive.id === "added-field-drive")
        .map((drive) => module(
          drive.id,
          "regional_field_drive",
          drive.waveform.kind,
          drive.name,
          [{ kind: "global" }],
        )),
    ] : [],
    provenance: { normalizer: "physics_graph.v1" },
    scene_revision: sceneRevision,
    schema_version: "physics_graph.v1",
  };
}

function visualizationStateFixture() {
  return {
    active_quantity_id: "m",
    auto_contrast: true,
    camera: {
      position: [3, 2, 2],
      projection: "perspective",
      target: [0, 0, 0],
      up: [0, 0, 1],
    },
    clip: { enabled: false, normal_axis: "z", offset: 0 },
    colormap: "viridis",
    contrast_max: null,
    contrast_min: null,
    diagnostics: { warnings: [] },
    domains: { active_scope_id: null, active_scope_kind: "domain" },
    fdm: { x_chosen_size: 1, y_chosen_size: 1 },
    fem: { topology_mode: "surface", volume_edges_budget: 0 },
    field_component: "magnitude",
    layers: {
      bounds: { visible: true },
      points: { visible: false },
      quantity_overlay: { visible: true },
      surface: { opacity: 0.94, visible: true },
      vectors: { density: 2, domain: "full_domain", visible: false },
      wireframe: { visible: true },
    },
    max_points: 120_000,
    overrides: [],
    quantity: {
      active_quantity_id: "m",
      auto_contrast: true,
      colormap: "viridis",
      contrast_max: null,
      contrast_min: null,
      field_component: "magnitude",
    },
    revision: sceneRevision,
    sampling: { max_glyphs: 192, max_points: 120_000 },
    schema_version: 1,
    slice: { layer: 0, mode: "xy" },
    slice_layer: 0,
    slice_mode: "xy",
    trim: { enabled: false, max: [1, 1, 1], min: [0, 0, 0] },
    vector_density: 2,
    vector_glyphs: false,
    view_mode: "3d",
    x_chosen_size: 1,
    y_chosen_size: 1,
  };
}

function statusFixture() {
  return {
    api_contract_version: "1.0.0",
    capabilities: {
      algorithms_available: [], binary_fields: true, cell_fields: true, eigen_modes: false,
      explicit_topology: fixtureLane === "fem", gpu_telemetry: false, node_fields: fixtureLane === "fem",
      preview_2d: true, preview_3d: true, scalar_history: true, structured_grid: fixtureLane === "fdm",
      transport_authoring: {
        contract_version: "spin-transport-capabilities.v1",
        m1_one_way_steady: { authoring_allowed: true, reason: "M1 semantic authoring available.", status: "semantic_only" },
        m2_reciprocal: { authoring_allowed: false, reason: "M2 unavailable.", status: "unsupported" },
        m3_transient: { authoring_allowed: false, reason: "M3 unavailable.", status: "unsupported" },
        gpu: { authoring_allowed: false, reason: "GPU unavailable.", status: "unsupported" },
        single_precision: { authoring_allowed: false, reason: "Single unavailable.", status: "unsupported" },
        hybrid: { authoring_allowed: false, reason: "Hybrid unavailable.", status: "unsupported" },
      },
      active_lane: {
        schema_version: "active-lane-capabilities.v2",
        authored: { backend: fixtureLane, discretization: fixtureLane, device: "auto", precision: "double", mode: "strict" },
        requested: { backend: fixtureLane, discretization: fixtureLane, device: "auto", precision: "double", mode: "strict" },
        resolved: { backend: fixtureLane, discretization: fixtureLane, device: "cpu", precision: "double", mode: "strict" },
        source: { kind: "planner", capability_profile_version: "fixture", engine_id: fixtureLane === "fem" ? "fem_cpu_reference" : "fdm_cpu_reference", authored_intent: "fixture", effective_request: "fixture" },
        qualification: { status: "not_asserted", reason: "UI authoring fixture." },
        operations: {
          "interaction.current_transport": { state: "supported", reason_code: "capability_supported", reason: "Current authoring supported.", requires: [] },
          "interaction.spin_torque": { state: "supported", reason_code: "capability_supported", reason: "Torque authoring supported.", requires: [] },
          "interaction.oersted_field": { state: "supported", reason_code: "capability_supported", reason: "Oersted authoring supported.", requires: [] },
        },
      },
    },
    display: {},
    domain: { cell_count: 0, discretization: fixtureLane, generation_id: 0 },
    energies: {},
    metrics: {
      steps_per_second: null,
      total: { steps: 0, time_seconds: 0 },
      total_steps: 0,
      uptime_seconds: 0,
    },
    resources: { command_completion_revision: 1, commands_revision: 1, mesh_revision: 0, scene_revision: sceneRevision, stages_revision: 1, workspace_revision: 0 },
    run: null,
    runtime_bundle_version: "transport-authoring-smoke",
    session: {
      created_at: "2026-07-16T00:00:00.000Z",
      name: "Transport authoring smoke",
      session_id: "transport-authoring-smoke",
      workspace_root: "/tmp/fullmag-transport-authoring-smoke",
    },
    solver: { state: "idle" },
  };
}

function preparationFixture() {
  const stageIds = [
    "runtime_startup",
    "script_materialization",
    "validation",
    "planning",
    "domain_preparation",
    "meshing",
    "mesh_postprocessing",
    "solver_initialization",
    "ready",
  ];
  return {
    preparation_id: "transport-authoring-smoke-preparation",
    revision: 1,
    status: "ready",
    started_at_unix_ms: 0,
    completed_at_unix_ms: 1,
    active_stage_id: null,
    requested_execution: {
      backend: fixtureLane,
      device: "cpu",
      engine_id: fixtureLane === "fem" ? "fem_cpu_reference" : "fdm_cpu_reference",
      mode: "strict",
      precision: "double",
      runtime_family: "fixture",
      worker: "fixture",
    },
    resolved_execution: {
      backend: fixtureLane,
      device: "cpu",
      engine_id: fixtureLane === "fem" ? "fem_cpu_reference" : "fdm_cpu_reference",
      mode: "strict",
      precision: "double",
      runtime_family: "fixture",
      worker: "fixture",
    },
    stages: stageIds.map((id) => ({
      id,
      label: id.replaceAll("_", " "),
      detail: "Fixture stage completed.",
      status: "completed",
      progress_percent: 100,
      progress_label: "Complete",
      started_at_unix_ms: 0,
      completed_at_unix_ms: 1,
      duration_ms: 1,
      clock_adjustment: null,
    })),
    log_tail: [],
    failure: null,
  };
}
