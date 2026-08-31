import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

const workspaceUrl = process.env.CONTROL_ROOM_URL ?? "http://localhost:3100/workspace";
const apiBaseUrl = (
  process.env.CONTROL_ROOM_API_BASE_URL ?? new URL(workspaceUrl).origin
).replace(/\/$/, "");
const outputDir = resolve(
  process.cwd(),
  process.env.CONTROL_ROOM_FROZEN_SPINS_REPORT_DIR ?? ".fullmag/reports/frozen-spins-browser",
);
const runId = `frozen-spins-browser-${randomUUID()}`;
const runAuthoringWorkflow =
  process.env.CONTROL_ROOM_FROZEN_SPINS_AUTHORING_E2E === "1";
const authoringObjectId =
  process.env.CONTROL_ROOM_FROZEN_SPINS_OBJECT_ID ?? null;
const authoringConstraintId =
  process.env.CONTROL_ROOM_FROZEN_SPINS_CONSTRAINT_ID ??
  `browser-${runId.slice("frozen-spins-browser-".length)}`;

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    try {
      return await import("@playwright/test");
    } catch {
      return null;
    }
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function canonicalSha256Identity(value, label) {
  const raw = String(value ?? '').toLowerCase();
  const hex = raw.startsWith('sha256:') ? raw.slice('sha256:'.length) : raw;
  assert(/^[0-9a-f]{64}$/.test(hex), `${label} must be a canonical SHA-256 identity`);
  return `sha256:${hex}`;
}

function viewportHasCompleteFemScalarCarrier(viewportText) {
  return (
    viewportText.includes('scalar-complete') ||
    viewportText.includes('state=derived-global')
  );
}

async function apiJson(path, init) {
  const response = await fetch(`${apiBaseUrl}${path}`, init);
  const body = await response.text();
  let value = null;
  try {
    value = body ? JSON.parse(body) : null;
  } catch {
    // Preserve the raw response in the thrown diagnostic below.
  }
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}: ${body.slice(0, 500)}`);
  }
  return { response, value };
}

async function waitForFrozenSpinsField(page, attempts = 80) {
  let lastCatalog = null;
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const catalog = (await apiJson("/v2/sessions/current/data/fields")).value;
      lastCatalog = catalog;
      const field = catalog?.quantities?.find(
        (entry) => entry.quantity_id === "frozen_spins" && entry.available === true,
      );
      if (field) {
        const meta = (
          await apiJson("/v2/sessions/current/data/fields/frozen_spins/meta?component=full")
        ).value;
        return { field, meta };
      }
    } catch (error) {
      lastError = String(error);
    }
    await page.waitForTimeout(250);
  }
  throw new Error(
    `Current session did not publish an available frozen_spins field: ${JSON.stringify({ lastCatalog, lastError })}`,
  );
}

async function waitForWorkspace(page) {
  await page.waitForSelector('.fm-ribbon', { timeout: 30_000 });
  await page.getByRole('tree', { name: 'Explorer tree' }).waitFor({
    state: 'visible',
    timeout: 30_000,
  });
}

async function runFrozenSpinsAuthoringWorkflow(page) {
  assert(
    typeof authoringObjectId === 'string' && authoringObjectId.length > 0,
    'CONTROL_ROOM_FROZEN_SPINS_OBJECT_ID is required for authoring E2E',
  );

  let collection = (
    await apiJson('/v2/sessions/current/model/frozen-spins')
  ).value;
  for (const definition of collection.definitions ?? []) {
    if (!definition.id?.startsWith('browser-')) continue;
    collection = (
      await apiJson(
        `/v2/sessions/current/model/frozen-spins/${encodeURIComponent(definition.id)}`,
        {
          body: JSON.stringify({ expected_revision: collection.revision }),
          headers: { 'content-type': 'application/json' },
          method: 'DELETE',
        },
      )
    ).value;
  }
  const created = (
    await apiJson('/v2/sessions/current/model/frozen-spins', {
      body: JSON.stringify({
        expected_revision: collection.revision,
        definition: {
          activation: { kind: 'all_stages' },
          empty_selection: 'error',
          enabled: true,
          id: authoringConstraintId,
          inactive_selection: 'warn_and_intersect',
          membership: { kind: 'static' },
          name: `Browser E2E ${authoringConstraintId}`,
          reference: { kind: 'capture_current_at_activation' },
          schema_version: 'frozen_spins.v1',
          selector: { kind: 'in_object', object_id: authoringObjectId },
        },
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
  ).value;
  assert(
    created?.runtime_application?.state === 'pending_runtime_plan',
    'Create must declare pending_runtime_plan',
  );

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
  await waitForWorkspace(page);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.waitForTimeout(2_000);
  const filter = page.getByRole('searchbox', { name: 'Filter explorer' });
  await filter.fill('pin');
  await page
    .getByRole('treeitem', { name: 'Frozen Spins', exact: true })
    .last()
    .click();
  const inspector = page.getByRole('region', { name: 'Inspector' });

  let previewResponse = null;
  let previewFailureBody = '';
  let previewRequestWallTimeNs = null;
  const previewAttemptWallTimeNs = [];
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const previewAttemptStartedNs = process.hrtime.bigint();
    const previewResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname ===
          '/v2/sessions/current/model/frozen-spins/previews',
      { timeout: 60_000 },
    );
    await page.getByRole('button', { name: 'Preview mask', exact: true }).click();
    try {
      previewResponse = await previewResponsePromise;
    } catch (error) {
      throw new Error(
        `Frozen Spins preview request was not observed. Inspector state:\n${await inspector.innerText()}`,
        { cause: error },
      );
    }
    const previewAttemptElapsedNs = Number(
      process.hrtime.bigint() - previewAttemptStartedNs,
    );
    assert(
      Number.isSafeInteger(previewAttemptElapsedNs) && previewAttemptElapsedNs > 0,
      'Preview request wall time must be a positive safe integer',
    );
    previewAttemptWallTimeNs.push(previewAttemptElapsedNs);
    if (previewResponse.ok()) {
      previewRequestWallTimeNs = previewAttemptElapsedNs;
      break;
    }
    previewFailureBody = await previewResponse.text();
    const transientRevisionRace =
      previewResponse.status() === 409 &&
      previewFailureBody.includes('selection_stale_revision');
    if (!transientRevisionRace || attempt === 5) break;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.waitForTimeout(1_000);
  }
  assert(
    previewResponse?.ok(),
    `Frozen Spins preview failed with HTTP ${previewResponse?.status() ?? 'unknown'}: ${previewFailureBody}`,
  );
  assert(
    Number.isSafeInteger(previewRequestWallTimeNs) && previewRequestWallTimeNs > 0,
    'Successful Preview must publish a positive end-to-end wall time',
  );
  const previewResponseBody = await previewResponse.json();
  assert(
    previewResponseBody?.authority === 'speculative_authoring_preview' &&
      previewResponseBody?.solver_binding === 'unbound',
    'Preview receipt must remain explicitly speculative and unbound',
  );
  assert(
    typeof previewResponseBody?.mask_sha256 === 'string' &&
      typeof previewResponseBody?.resolved?.resolved_reference_sha256 === 'string' &&
      typeof previewResponseBody?.resolved?.topology_fingerprint === 'string',
    'Preview receipt must publish mask, reference, and topology identities',
  );
  const commitPreviewButton = page.getByRole('button', {
    name: 'Commit preview',
    exact: true,
  });
  try {
    await commitPreviewButton.waitFor({ state: 'visible', timeout: 30_000 });
    await inspector.getByText('current', { exact: true }).waitFor({ timeout: 30_000 });
  } catch (error) {
    throw new Error(
      `Frozen Spins preview did not expose a current activation candidate. Inspector state:\n${await inspector.innerText()}`,
      { cause: error },
    );
  }
  const previewSnapshot = await inspector.innerText();
  const frozenCountMatch = previewSnapshot.match(/Frozen DOFs\s+(\d+)/);
  const freeCountMatch = previewSnapshot.match(/Free DOFs\s+(\d+)/);
  assert(frozenCountMatch, 'Preview must expose Frozen DOFs');
  assert(freeCountMatch, 'Preview must expose Free DOFs');
  assert(Number(frozenCountMatch[1]) > 0, 'Preview must resolve at least one frozen DOF');
  assert(
    previewResponseBody.frozen_dof_count === Number(frozenCountMatch[1]) &&
      previewResponseBody.free_dof_count === Number(freeCountMatch[1]),
    'Inspector preview counts must match the authoritative preview response',
  );

  const activationResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith('/activate'),
    { timeout: 60_000 },
  );
  await commitPreviewButton.click();
  const activationResponse = await activationResponsePromise;
  const activationResponseBody = await activationResponse.json();
  assert(
    activationResponse.ok(),
    `Frozen Spins activation failed with HTTP ${activationResponse.status()}: ${JSON.stringify(activationResponseBody)}`,
  );
  await inspector.getByText('pending', { exact: true }).first().waitFor({ timeout: 30_000 });
  const solveCommandResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/v2/sessions/current/simulation/commands',
    { timeout: 30_000 },
  );
  await page.getByRole('button', { name: 'Compute Study', exact: true }).click();
  const solveCommandResponse = await solveCommandResponsePromise;
  const solveCommandResponseBody = await solveCommandResponse.json();
  assert(
    solveCommandResponse.ok() && solveCommandResponseBody?.accepted === true,
    `Compute Study command was not accepted: HTTP ${solveCommandResponse.status()} ${JSON.stringify(solveCommandResponseBody)}`,
  );
  assert(
    typeof solveCommandResponseBody?.command_id === 'string' &&
      solveCommandResponseBody.command_id.length > 0,
    'Compute Study response must publish command_id',
  );
  const solveCommand = (
    await apiJson(
      `/v2/sessions/current/simulation/commands/${encodeURIComponent(solveCommandResponseBody.command_id)}`,
    )
  ).value;
  assert(solveCommand?.kind === 'solve', 'Compute Study must enqueue a solve command');
  assert(
    solveCommand?.precondition?.scene_revision === activationResponseBody.revision,
    `Solve command must bind the committed Frozen Spins scene revision: activation=${activationResponseBody.revision} command=${solveCommand?.precondition?.scene_revision}`,
  );
  try {
    await inspector.getByText('confirmed', { exact: true }).waitFor({ timeout: 60_000 });
  } catch (error) {
    const [solverStatusAtTimeout, engineLogAtTimeout] = await Promise.all([
      apiJson('/v2/sessions/current/simulation/solver/status').then((response) => response.value),
      apiJson('/v2/sessions/current/diagnostics/engine-log').then((response) => response.value),
    ]);
    throw new Error(
      `Frozen Spins solver certificate was not confirmed. Inspector state:\n${await inspector.innerText()}\nActivation receipt:\n${JSON.stringify(activationResponseBody, null, 2)}\nSolve command:\n${JSON.stringify(solveCommand, null, 2)}\nSolver status:\n${JSON.stringify(solverStatusAtTimeout, null, 2)}\nEngine log:\n${JSON.stringify(engineLogAtTimeout, null, 2)}`,
      { cause: error },
    );
  }
  await inspector
    .getByText('Solver certificate matches the committed preview identity.', {
      exact: true,
    })
    .waitFor({ timeout: 30_000 });

  await page
    .getByRole('button', { name: 'Show solver frozen_spins in 3D', exact: true })
    .click();
  const renderFieldMeta = (
    await apiJson('/v2/sessions/current/data/fields/frozen_spins/meta?component=full')
  ).value;
  const fdmRenderPath = String(renderFieldMeta?.resolved_capability?.lane ?? '').startsWith(
    'fdm_',
  );
  try {
    await page.waitForFunction(
      (fdmPath) => {
        const text = document.querySelector('.fm-viewport-3d')?.textContent ?? '';
        const femScalarCarrierAdopted =
          (text.includes('scalar-complete') || text.includes('state=derived-global')) &&
          !text.includes('surface-colors-unavailable');
        return (
          text.includes('q:frozen_spins') &&
          (fdmPath
            ? text.includes('field:"fmvp:frozen_spins') && text.includes('fdm-cuboid{')
            : femScalarCarrierAdopted && text.includes('surface-vertex-colors:ready'))
        );
      },
      fdmRenderPath,
      { timeout: 30_000 },
    );
  } catch (error) {
    const fieldAtTimeout = (
      await apiJson('/v2/sessions/current/data/fields/frozen_spins/meta?component=full')
    ).value;
    const visualizationAtTimeout = (
      await apiJson('/v2/sessions/current/visualization/state')
    ).value;
    throw new Error(
      `Frozen Spins 3D quantity was not render-ready. Viewport state:\n${await page.locator('.fm-viewport-3d').innerText()}\nField meta:\n${JSON.stringify(fieldAtTimeout, null, 2)}\nVisualization state:\n${JSON.stringify(visualizationAtTimeout, null, 2)}\nFrozen Spins data-plane responses:\n${JSON.stringify(networkLog.filter((entry) => entry.url.includes('/data/fields/frozen_spins')), null, 2)}`,
      { cause: error },
    );
  }

  const solverStatus = (
    await apiJson('/v2/sessions/current/simulation/solver/status')
  ).value?.frozen_spins;
  const field = (
    await apiJson('/v2/sessions/current/data/fields/frozen_spins/meta?component=full')
  ).value;
  const viewportText = await page.locator('.fm-viewport-3d').innerText();
  const visualizationState = (
    await apiJson('/v2/sessions/current/visualization/state')
  ).value;
  let renderedAck = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const ackResource = (
      await apiJson('/v2/sessions/current/visualization/client-acks')
    ).value;
    renderedAck = ackResource?.entries?.find(
      (entry) =>
        entry.revision >= visualizationState.revision && entry.status === 'rendered',
    );
    if (renderedAck) break;
    await page.waitForTimeout(250);
  }
  assert(
    solverStatus?.active_constraint_ids?.includes(authoringConstraintId),
    'Solver certificate must include the committed constraint id',
  );
  assert(
    solverStatus?.frozen_site_count === Number(frozenCountMatch[1]) &&
      solverStatus?.free_site_count === Number(freeCountMatch[1]),
    'Solver certificate counts must match the committed preview',
  );
  assert(
    typeof solverStatus?.mask_sha256 === 'string' &&
      typeof solverStatus?.reference_sha256 === 'string' &&
      typeof solverStatus?.topology_fingerprint === 'string',
    'Solver certificate must publish mask, reference, and topology identities',
  );
  const previewSourceStateRevision = previewResponseBody?.resolved?.source_state_revision;
  const solverSourceStateRevision = solverStatus?.source_state_revision;
  assert(
    Number.isSafeInteger(previewSourceStateRevision) && previewSourceStateRevision > 0,
    'Committed preview must publish a positive source_state_revision',
  );
  assert(
    Number.isSafeInteger(solverSourceStateRevision) && solverSourceStateRevision > 0,
    'Solver certificate must publish a positive source_state_revision',
  );
  assert(
    solverSourceStateRevision === previewSourceStateRevision,
    `Solver certificate source_state_revision must match the committed preview: preview=${previewSourceStateRevision} solver=${solverSourceStateRevision}`,
  );
  const previewMaskIdentity = canonicalSha256Identity(
    previewResponseBody.mask_sha256,
    'Preview mask identity',
  );
  const solverMaskIdentity = canonicalSha256Identity(
    solverStatus.mask_sha256,
    'Solver mask identity',
  );
  const previewReferenceIdentity = canonicalSha256Identity(
    previewResponseBody.resolved.resolved_reference_sha256,
    'Preview reference identity',
  );
  const solverReferenceIdentity = canonicalSha256Identity(
    solverStatus.reference_sha256,
    'Solver reference identity',
  );
  const previewTopologyIdentity = canonicalSha256Identity(
    previewResponseBody.resolved.topology_fingerprint,
    'Preview topology identity',
  );
  const solverTopologyIdentity = canonicalSha256Identity(
    solverStatus.topology_fingerprint,
    'Solver topology identity',
  );
  assert(
    solverMaskIdentity === previewMaskIdentity,
    `Solver certificate mask identity must match the committed preview: preview=${previewMaskIdentity} solver=${solverMaskIdentity}`,
  );
  assert(
    solverReferenceIdentity === previewReferenceIdentity,
    `Solver certificate reference identity must match the committed preview: preview=${previewReferenceIdentity} solver=${solverReferenceIdentity}`,
  );
  assert(
    solverTopologyIdentity === previewTopologyIdentity,
    `Solver certificate topology identity must match the committed preview: preview=${previewTopologyIdentity} solver=${solverTopologyIdentity}`,
  );
  assert(field?.state === 'complete', 'Solver-owned frozen_spins field must be complete');
  assert(field?.kind === 'spatial_scalar', 'Solver-owned frozen_spins field must be scalar');
  assert(renderedAck, 'Authoring workflow must end with a rendered visualization ACK');
  const fdmObjectTarget = visualizationState?.targets?.objects?.find(
    (target) => target.scope_id === authoringObjectId,
  );
  if (fdmRenderPath) {
    assert(
      viewportText.includes('field:"fmvp:frozen_spins') &&
        viewportText.includes('fdm-cuboid{'),
      'FDM rendering must bind the frozen_spins scalar buffer to the cuboid pipeline',
    );
    assert(
      fdmObjectTarget?.settings?.surface_color_source === 'colormap',
      'FDM object target must render frozen_spins through the scalar colormap',
    );
  } else {
    assert(viewportText.includes('surface:magnitude'), 'Scalar surface demand must use magnitude');
    assert(
      viewportHasCompleteFemScalarCarrier(viewportText),
      `Viewport must adopt a complete scalar carrier, either as a target buffer or a full-domain FEM carrier. Viewport state:\n${viewportText}`,
    );
    assert(
      viewportText.includes('surface-vertex-colors:ready'),
      'FEM rendering must publish ready surface vertex colors',
    );
  }
  assert(
    (visualizationState?.diagnostics?.degraded_reasons?.length ?? 0) === 0,
    'Frozen Spins 3D rendering must not degrade',
  );

  return {
    constraint_id: authoringConstraintId,
    create_revision: created.revision,
    field_meta: field,
    preview: {
      preview_id: previewResponseBody.preview_id,
      authority: previewResponseBody.authority,
      solver_binding: previewResponseBody.solver_binding,
      free_site_count: Number(freeCountMatch[1]),
      frozen_site_count: Number(frozenCountMatch[1]),
      mask_sha256: previewMaskIdentity,
      reference_sha256: previewReferenceIdentity,
      topology_fingerprint: previewTopologyIdentity,
      source_state_revision: previewSourceStateRevision,
      request_wall_time_ns: previewRequestWallTimeNs,
      attempt_wall_time_ns: previewAttemptWallTimeNs,
      attempt_count: previewAttemptWallTimeNs.length,
    },
    solve_command: {
      command_id: solveCommand.command_id,
      kind: solveCommand.kind,
      status: solveCommand.status,
      scene_revision: solveCommand.precondition?.scene_revision,
    },
    solver_certificate: solverStatus,
    rendered_ack: renderedAck,
    visualization_state: visualizationState,
    viewport: {
      degradation_none:
        (visualizationState?.diagnostics?.degraded_reasons?.length ?? 0) === 0,
      quantity_selected: viewportText.includes('q:frozen_spins'),
      render_path: fdmRenderPath ? 'fdm-cuboid-instance-colors' : 'fem-surface-vertex-colors',
      scalar_complete: field?.state === 'complete',
      scalar_carrier_adopted: fdmRenderPath
        ? viewportText.includes('field:"fmvp:frozen_spins')
        : viewportHasCompleteFemScalarCarrier(viewportText),
      surface_ready: fdmRenderPath
        ? viewportText.includes('field:"fmvp:frozen_spins') &&
          viewportText.includes('fdm-cuboid{') &&
          fdmObjectTarget?.settings?.surface_color_source === 'colormap'
        : viewportText.includes('surface-vertex-colors:ready'),
    },
  };
}

const playwright = await loadPlaywright();
if (!playwright?.chromium) {
  console.error("Frozen spins smoke requires Playwright or @playwright/test.");
  process.exit(2);
}

await mkdir(outputDir, { recursive: true });
let browser;
try {
  browser = await playwright.chromium.launch({ headless: true });
} catch (error) {
  if (!String(error).includes("Executable doesn't exist")) throw error;
  browser = await playwright.chromium.launch({ channel: "chrome", headless: true });
}
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const consoleErrors = [];
const consoleWarnings = [];
const networkLog = [];
let previousVisualizationState = null;
let fieldMeta = null;
let authoringEvidence = null;

page.on("console", (message) => {
  if (message.type() === "error") {
    consoleErrors.push(message.text());
  }
  if (message.type() === "warning") {
    consoleWarnings.push(message.text());
  }
});
page.on("pageerror", (error) => {
  consoleErrors.push(error.stack ?? error.message);
});
page.on("response", (response) => {
  const url = response.url();
  if (url.includes("/v2/")) {
    const request = response.request();
    networkLog.push({
      method: request.method(),
      status: response.status(),
      url,
      ...(url.includes("/visualization/client-acks")
        ? { request_body: request.postData() }
        : {}),
    });
  }
});

try {
  const quantityCatalog = (await apiJson("/v2/sessions/current/data/quantities")).value;
  const quantity = quantityCatalog?.quantities?.find((entry) => entry.id === "frozen_spins");
  assert(quantity, "Quantity catalog must advertise frozen_spins");
  assert(quantity.shape === "spatial_scalar", "frozen_spins must be a spatial scalar");
  assert(quantity.unit === "1", "frozen_spins must be dimensionless");
  assert(quantity.location === "node", "frozen_spins must use canonical node location");
  assert(quantity.supports_preview_3d === true, "frozen_spins must support 3D preview");

  previousVisualizationState = (
    await apiJson("/v2/sessions/current/visualization/state")
  ).value;
  const objectQuantityOverrides = (
  previousVisualizationState?.targets?.objects ?? []
  ).map((target) => ({
    display: {
      surface: { opacity: 1, visible: true },
      visible: true,
    },
    quantity: { active_quantity_id: "frozen_spins" },
    scope: "object",
    scope_id: target.scope_id,
    style: {
      surface_color_source: "colormap",
      viewport_colorbar_visible: true,
    },
  }));
  assert(
    objectQuantityOverrides.length > 0,
    "Frozen Spins smoke requires at least one magnetic object render target",
  );

  console.log(`Navigating to workspace at ${workspaceUrl}...`);
  await page.goto(workspaceUrl, { waitUntil: "networkidle", timeout: 30_000 });

  // 1. Check Explorer and Ribbon
  await waitForWorkspace(page);
  const ribbon = await page.$(".fm-ribbon");
  assert(ribbon !== null, "Ribbon bar must be visible");

  // 2. Check 3D Viewport canvas and WebGL context
  const canvas = await page.waitForSelector(".fm-viewport-3d canvas", { timeout: 15_000 });
  assert(canvas !== null, "Viewport 3D canvas must be rendered");

  const webglStatus = await page.evaluate(() => {
    const el = document.querySelector(".fm-viewport-3d canvas");
    if (!el) return { found: false };
    const gl = el.getContext("webgl2") || el.getContext("webgl");
    if (!gl) return { found: true, hasContext: false };
    return {
      found: true,
      hasContext: true,
      isContextLost: gl.isContextLost(),
      width: gl.drawingBufferWidth,
      height: gl.drawingBufferHeight,
    };
  });

  assert(webglStatus.found, "Canvas element must be found in DOM");
  assert(webglStatus.hasContext, "Canvas must have an active WebGL context");
  assert(!webglStatus.isContextLost, "WebGL context must not be lost");
  assert(webglStatus.width > 0 && webglStatus.height > 0, "WebGL drawing buffer must be > 0");

  console.log("WebGL context verified successfully:", webglStatus);

  if (runAuthoringWorkflow) {
    authoringEvidence = await runFrozenSpinsAuthoringWorkflow(page);
  }

  const materializationVisualizationState = authoringEvidence
    ? authoringEvidence.visualization_state
    : (
        await apiJson("/v2/sessions/current/visualization/state", {
          body: JSON.stringify({
            active_quantity_id: "frozen_spins",
            overrides: objectQuantityOverrides,
            quantity: { active_quantity_id: "frozen_spins" },
            view_mode: "3d",
          }),
          headers: { "content-type": "application/json" },
          method: "PATCH",
        })
      ).value;
  assert(
    materializationVisualizationState?.active_quantity_id === "frozen_spins" &&
      materializationVisualizationState?.quantity?.active_quantity_id === "frozen_spins",
    "Visualization state must resolve frozen_spins as the active standard quantity",
  );

  const publishedField = await waitForFrozenSpinsField(page);
  fieldMeta = publishedField.meta;
  assert(fieldMeta?.quantity_id === "frozen_spins", "Field meta must preserve quantity id");
  assert(fieldMeta?.components === 1, "Frozen Spins field payload must have one component");
  assert(
    typeof fieldMeta?.publication_bundle?.field?.carrier_fingerprint === "string" ||
      fieldMeta?.resolved_capability?.carriers?.some(
        (carrier) => typeof carrier.carrier_fingerprint === "string",
      ),
    "Frozen Spins field meta must publish a carrier fingerprint",
  );

  // The materialization revision is the authoritative data change: it moves
  // the viewport from the previous quantity to frozen_spins and may complete
  // only after the browser demand has materialized the FEM field.  Do not
  // manufacture a second, semantically identical PATCH merely to obtain a new
  // revision; clients intentionally coalesce such no-op registry updates.
  const visualizationState = materializationVisualizationState;
  const renderRevision = materializationVisualizationState.revision;
  let renderedAck = authoringEvidence?.rendered_ack ?? null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const ackResource = (
      await apiJson("/v2/sessions/current/visualization/client-acks")
    ).value;
    renderedAck = ackResource?.entries?.find(
      (entry) => entry.revision >= renderRevision && entry.status === "rendered",
    );
    if (renderedAck) break;
    await page.waitForTimeout(250);
  }
  if (!renderedAck) {
    const ackResource = (
      await apiJson("/v2/sessions/current/visualization/client-acks")
    ).value;
    const viewportDiagnostics = await page.evaluate(() => {
      const viewport = document.querySelector(".fm-viewport-3d");
      return viewport
        ? {
            attributes: Object.fromEntries(
              [...viewport.attributes].map((attribute) => [
                attribute.name,
                attribute.value,
              ]),
            ),
            text: viewport.textContent?.slice(0, 2_000) ?? "",
          }
        : null;
    });
    console.error(
      "Frozen Spins render adoption diagnostics:",
      JSON.stringify(
        {
          ackResource,
          consoleErrors,
          consoleWarnings,
          networkLog: networkLog.filter(
            (entry) =>
              entry.url.includes("/visualization/client-acks") ||
              entry.url.includes("/data/fields/frozen_spins/"),
          ),
          viewportDiagnostics,
          visualizationState: {
            active_quantity_id: visualizationState?.active_quantity_id,
            quantity: visualizationState?.quantity,
            revision: visualizationState?.revision,
            view_mode: visualizationState?.view_mode,
          },
        },
        null,
        2,
      ),
    );
  }
  assert(renderedAck, `Viewport must acknowledge rendered revision ${renderRevision}`);

  const frozenFieldRequests = networkLog.filter(
    (entry) =>
      entry.url.includes("/data/fields/frozen_spins/") &&
      entry.status >= 200 &&
      entry.status < 300,
  );
  assert(
    frozenFieldRequests.some((entry) => entry.url.includes("/samples/vector")),
    "Viewport must fetch the frozen_spins field through the HTTP v2 vector data plane",
  );

  // Filter out non-fatal errors if any, but ensure no WebGL context loss errors
  const criticalErrors = consoleErrors.filter(
    (err) =>
      err.includes("WebGLRenderer: Context Lost") ||
      err.includes("frozen_spins") ||
      err.includes("Uncaught Error"),
  );
  assert(criticalErrors.length === 0, `Encountered critical errors: ${criticalErrors.join("; ")}`);

  const screenshotPath = resolve(outputDir, `${runId}.png`);
  const evidencePath = resolve(outputDir, `${runId}.json`);
  await page.screenshot({ path: screenshotPath, fullPage: false });
  await writeFile(
    evidencePath,
    `${JSON.stringify(
      {
        schema_version: "fullmag.frozen_spins.browser.quantity.evidence.v1",
        run_id: runId,
        workspace_url: workspaceUrl,
        api_base_url: apiBaseUrl,
        quantity: {
          id: quantity.id,
          shape: quantity.shape,
          unit: quantity.unit,
          location: quantity.location,
        },
        field_meta: fieldMeta,
        authoring_workflow: authoringEvidence,
        visualization_revision: renderRevision,
        rendered_ack: renderedAck,
        webgl: webglStatus,
        network: networkLog,
        console_errors: consoleErrors,
        screenshot: screenshotPath,
        status: "PASS",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`PASS: Frozen spins standard quantity browser/WebGL smoke verified: ${evidencePath}`);
} catch (error) {
  console.error("FAIL: Frozen spins browser smoke failed:", error);
  process.exitCode = 1;
} finally {
  if (previousVisualizationState?.active_quantity_id) {
    await apiJson("/v2/sessions/current/visualization/state", {
      body: JSON.stringify({
        active_quantity_id: previousVisualizationState.active_quantity_id,
        quantity: {
          active_quantity_id:
            previousVisualizationState.quantity?.active_quantity_id ??
            previousVisualizationState.active_quantity_id,
        },
      }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    }).catch(() => {});
  }
  await browser.close();
}
