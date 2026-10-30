const STATUS_PATH = "/v2/sessions/current/status";
const CURRENT_RUN_PATH = "/v2/sessions/current/simulation/runs/current";
const SCALARS_PATH = "/v2/sessions/current/data/scalars?columns=step,e_total&limit=1&tail=true";
const API_INSTANCE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FOOTER_STEP_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const FOOTER_ENERGY_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });

const requireText = (value, label) => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Terminal telemetry API omitted ${label}`);
  }
  return value;
};

const requireSafeInteger = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Terminal telemetry API returned an invalid ${label}`);
  }
  return value;
};

const requireFinite = (value, label) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Terminal telemetry API returned a non-finite ${label}`);
  }
  return value;
};

const sessionScopeHeader = (session) =>
  `session=${encodeURIComponent(session.session_id)}&epoch=${encodeURIComponent(session.session_epoch)}` +
  `&request_scope_epoch=${encodeURIComponent(session.request_scope_epoch)}`;

const requestJson = async (page, path, { timeout, apiInstanceId, sessionScope }) => {
  const headers = {};
  if (apiInstanceId) headers["x-fullmag-api-instance"] = apiInstanceId;
  if (sessionScope) headers["x-fullmag-session-scope"] = sessionScope;
  const response = await page.request.get(new URL(path, page.url()).toString(), { timeout, headers });
  if (response.status() !== 200) {
    throw new Error(`GET ${path} returned ${response.status()}`);
  }
  const responseApiInstance = response.headers()["x-fullmag-api-instance"] ?? "";
  if (!API_INSTANCE_PATTERN.test(responseApiInstance)) {
    throw new Error(`GET ${path} omitted a valid x-fullmag-api-instance identity`);
  }
  if (apiInstanceId && responseApiInstance !== apiInstanceId) {
    throw new Error(`GET ${path} changed the pinned API instance`);
  }
  const body = await response.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(`GET ${path} returned a non-object JSON resource`);
  }
  return {
    api_instance_id: responseApiInstance,
    body,
    request: {
      method: "GET",
      path,
      status: response.status(),
      api_instance_header_sent: apiInstanceId ?? null,
      session_scope_header_sent: sessionScope ?? null,
    },
  };
};

const readTerminalApiSnapshot = async (page, expectedSession, expectedApiInstanceId, timeout) => {
  const scopeHeader = sessionScopeHeader(expectedSession);
  const statusResult = await requestJson(page, STATUS_PATH, {
    timeout,
    apiInstanceId: expectedApiInstanceId,
    sessionScope: scopeHeader,
  });
  const status = statusResult.body;
  const session = status.session;
  for (const key of ["session_id", "session_epoch", "request_scope_epoch"]) {
    requireText(session?.[key], `session.${key}`);
  }
  if (status.lifecycle?.session_resource !== "active") {
    throw new Error("Terminal telemetry requires the same active session resource");
  }
  if (session.session_id !== expectedSession.session_id ||
      session.session_epoch !== expectedSession.session_epoch ||
      session.request_scope_epoch !== expectedSession.request_scope_epoch) {
    throw new Error("Terminal telemetry changed the API session identity or request scope");
  }
  const runId = requireText(status.run?.run_id, "status.run.run_id");
  const sourceStepFromStatus = requireSafeInteger(status.run?.solver_steps, "status.run.solver_steps");
  const apiInstanceId = statusResult.api_instance_id;
  if (expectedApiInstanceId && apiInstanceId !== expectedApiInstanceId) {
    throw new Error("Terminal telemetry changed the API process instance");
  }

  const scopedOptions = {
    timeout,
    apiInstanceId,
    sessionScope: scopeHeader,
  };
  const [runResult, scalarResult] = await Promise.all([
    requestJson(page, CURRENT_RUN_PATH, scopedOptions),
    requestJson(page, SCALARS_PATH, scopedOptions),
  ]);
  if (runResult.api_instance_id !== apiInstanceId || scalarResult.api_instance_id !== apiInstanceId) {
    throw new Error("Terminal telemetry endpoints did not preserve the API process instance");
  }
  const currentRun = runResult.body;
  const scalarWindow = scalarResult.body;
  const currentRunId = requireText(currentRun.run_id, "current run run_id");
  if (currentRunId !== runId || currentRun.session_id !== session.session_id) {
    throw new Error("Current run does not match the status session/run identity");
  }
  if (currentRun.status !== "completed") {
    throw new Error(`Terminal telemetry requires a completed current run, got ${String(currentRun.status)}`);
  }
  if (!Array.isArray(scalarWindow.columns) ||
      JSON.stringify(scalarWindow.columns) !== JSON.stringify(["step", "e_total"]) ||
      !Array.isArray(scalarWindow.rows) || scalarWindow.rows.length !== 1 ||
      scalarWindow.returned_rows !== 1 || scalarWindow.rows[0].length !== 2) {
    throw new Error("Terminal scalar GET did not return one step/e_total row");
  }
  const observation = scalarWindow.current_observation;
  if (!observation || typeof observation !== "object" || Array.isArray(observation)) {
    throw new Error("Terminal scalar GET omitted current_observation provenance");
  }
  const sourceStep = requireSafeInteger(observation.source_step, "current_observation.source_step");
  const scalarRevision = requireSafeInteger(observation.scalar_revision, "current_observation.scalar_revision");
  const scalarWindowRevision = requireSafeInteger(scalarWindow.revision, "scalar window revision");
  const scalarEnergy = requireFinite(scalarWindow.rows[0][1], "scalar e_total");
  const rowStep = requireSafeInteger(scalarWindow.rows[0][0], "scalar row step");
  const currentRunEnergy = requireFinite(currentRun.final_total_energy, "current run final_total_energy");
  const sessionEnergy = requireFinite(status.energies?.total, "session summary total energy");
  if (observation.session_id !== session.session_id || observation.run_id !== runId ||
      observation.request_scope_epoch !== session.request_scope_epoch ||
      observation.scalar_revision !== scalarWindowRevision || sourceStep !== rowStep ||
      sourceStep !== sourceStepFromStatus || !Object.is(scalarEnergy, currentRunEnergy) ||
      !Object.is(scalarEnergy, sessionEnergy)) {
    throw new Error("Terminal scalar provenance, current run, and session energy do not match exactly");
  }
  return {
    api: {
      api_instance_id: apiInstanceId,
      session_id: session.session_id,
      session_epoch: session.session_epoch,
      request_scope_epoch: session.request_scope_epoch,
      run_id: runId,
      run_status: currentRun.status,
      status_solver_steps: sourceStepFromStatus,
      current_run_id: currentRunId,
      current_run_session_id: currentRun.session_id,
      observation_session_id: observation.session_id,
      observation_run_id: observation.run_id,
      observation_request_scope_epoch: observation.request_scope_epoch,
      source_step: sourceStep,
      scalar_row_step: rowStep,
      scalar_revision: scalarRevision,
      scalar_window_revision: scalarWindowRevision,
      scalar_energy_j: scalarEnergy,
      current_run_energy_j: currentRunEnergy,
      session_summary_energy_j: sessionEnergy,
    },
    api_requests: [statusResult.request, runResult.request, scalarResult.request],
  };
};

const formatFooterStep = (step) =>
  FOOTER_STEP_FORMAT.format(step);

const formatFooterEnergy = (energy) => {
  if (Math.abs(energy) >= 1e-2 && Math.abs(energy) < 1e4) {
    return FOOTER_ENERGY_FORMAT.format(energy);
  }
  return energy.toExponential(6);
};

const revealTelemetry = async (page, timeout) => {
  const region = page.locator('[aria-label="Simulation telemetry"]');
  if (!(await region.isVisible().catch(() => false))) {
    const telemetryTab = page.getByRole("tab", { name: "Telemetry", exact: true });
    await telemetryTab.waitFor({ state: "visible", timeout });
    await telemetryTab.click();
  }
  const overviewTab = page.getByRole("tab", { name: "Overview", exact: true });
  await overviewTab.waitFor({ state: "visible", timeout });
  if (await overviewTab.getAttribute("aria-selected") !== "true") await overviewTab.click();
  await region.waitFor({ state: "visible", timeout });
};

const readFooterMetrics = async (page, expectedStep, expectedEnergy, timeout) => {
  const expected = {
    step: formatFooterStep(expectedStep),
    energy: formatFooterEnergy(expectedEnergy),
  };
  await page.waitForFunction((value) => {
    const region = document.querySelector('[aria-label="Simulation telemetry"]');
    if (!region) return false;
    const cards = [...region.querySelectorAll(".fm-footer-telemetry__metric")];
    const detail = (card) => [...card.querySelectorAll(".fm-footer-telemetry__metric-detail > span")]
      .map((span) => span.textContent?.trim() ?? "");
    const label = (card) => card.querySelector(".fm-footer-telemetry__metric-label > span")
      ?.textContent?.trim() ?? "";
    const renderedValue = (card) => card.querySelector(".fm-footer-telemetry__metric-value > span")
      ?.textContent?.trim() ?? "";
    const step = cards.find((card) => label(card) === "Step" && detail(card)[0] === "Latest step");
    const energy = cards.find((card) => label(card) === "Energy" && detail(card)[0] === "Total");
    return Boolean(step && energy && renderedValue(step) === value.step &&
      renderedValue(energy) === value.energy && detail(energy)[1] === "Session summary");
  }, expected, { timeout });

  return page.locator('[aria-label="Simulation telemetry"]').evaluate((region) => {
    const cards = [...region.querySelectorAll(".fm-footer-telemetry__metric")];
    const details = (card) => [...card.querySelectorAll(".fm-footer-telemetry__metric-detail > span")]
      .map((span) => span.textContent?.trim() ?? "");
    const label = (card) => card.querySelector(".fm-footer-telemetry__metric-label > span")
      ?.textContent?.trim() ?? "";
    const renderedValue = (card) => card.querySelector(".fm-footer-telemetry__metric-value > span")
      ?.textContent?.trim() ?? "";
    const unit = (card) => card.querySelector(".fm-footer-telemetry__metric-unit")
      ?.textContent?.trim() ?? "";
    const visible = (card) => {
      const style = getComputedStyle(card);
      const rect = card.getBoundingClientRect();
      const grid = card.closest(".fm-footer-telemetry__metrics-grid");
      const gridRect = grid?.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = document.documentElement.clientHeight;
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(centerX, centerY);
      return Boolean(style.display !== "none" && style.visibility !== "hidden" &&
        Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0 && gridRect &&
        rect.bottom > gridRect.top && rect.top < gridRect.bottom &&
        rect.right > gridRect.left && rect.left < gridRect.right && rect.bottom > 0 &&
        rect.top < viewportHeight && rect.right > 0 && rect.left < viewportWidth &&
        hit && card.contains(hit));
    };
    const step = cards.find((card) => label(card) === "Step" && details(card)[0] === "Latest step");
    const energy = cards.find((card) => label(card) === "Energy" && details(card)[0] === "Total");
    if (!step || !energy) throw new Error("Footer Step or Total energy metric is missing");
    step.scrollIntoView({ block: "nearest", inline: "nearest" });
    const stepObservation = {
      visible: visible(step), label: label(step), detail: details(step)[0],
      value: renderedValue(step), unit: unit(step), title: step.getAttribute("title"),
    };
    energy.scrollIntoView({ block: "nearest", inline: "nearest" });
    const energyObservation = {
      visible: visible(energy), label: label(energy), detail: details(energy)[0],
      subdetail: details(energy)[1] ?? "", value: renderedValue(energy),
      unit: unit(energy), title: energy.getAttribute("title"),
    };
    return { step: stepObservation, energy: energyObservation };
  });
};

const fieldEvidence = (value) => ({
  quantity_id: value?.quantity_id ?? null,
  label_visible: value?.label_visible === true,
  field_state: value?.field_state ?? null,
  solver_family: value?.solver_family ?? null,
});

const canvasEvidence = (value) => ({
  visible: true,
  context_type: value.context_type,
  context_lost: value.context_lost,
  drawing_buffer_width: value.drawing_buffer_width,
  drawing_buffer_height: value.drawing_buffer_height,
  css_width: value.rect.width,
  css_height: value.rect.height,
});

export async function runTerminalFooterTelemetryBrowserQa({
  page,
  expectedSession,
  timeout,
  assertCanvas,
  waitForLiveField,
}) {
  const forbiddenMutations = [];
  let clientAckRequests = 0;
  const routeHandler = async (route) => {
    const request = route.request();
    const method = request.method();
    if (["GET", "HEAD", "OPTIONS"].includes(method)) return route.continue();
    const url = new URL(request.url());
    if (method === "POST" && url.origin === new URL(page.url()).origin &&
        url.pathname === "/v2/sessions/current/visualization/client-acks") {
      clientAckRequests += 1;
      return route.continue();
    }
    if (forbiddenMutations.length < 16) forbiddenMutations.push({ method, path: url.pathname });
    return route.abort("blockedbyclient");
  };
  await page.route("**/v2/**", routeHandler);
  let beforeReload = null;
  let afterReload = null;
  let reloadStatus = null;
  let reloadPath = null;
  try {
    const beforeCanvas = await assertCanvas(page, "before terminal telemetry reload");
    const beforeField = await waitForLiveField("m", false);
    const beforeApi = await readTerminalApiSnapshot(page, expectedSession, null, timeout);
    await revealTelemetry(page, timeout);
    const beforeFooter = await readFooterMetrics(
      page, beforeApi.api.source_step, beforeApi.api.scalar_energy_j, timeout,
    );
    beforeReload = {
      api: beforeApi.api,
      api_requests: beforeApi.api_requests,
      canvas: canvasEvidence(beforeCanvas),
      field: fieldEvidence(beforeField),
      footer: beforeFooter,
    };

    const pagePathBeforeReload = new URL(page.url()).pathname;
    const reloadResponse = await page.reload({ waitUntil: "domcontentloaded", timeout });
    reloadStatus = reloadResponse?.status() ?? null;
    reloadPath = new URL(page.url()).pathname;
    if (!reloadResponse || reloadStatus !== 200 || reloadPath !== pagePathBeforeReload) {
      throw new Error("Terminal telemetry did not complete a same-page HTTP 200 reload");
    }
    const homeAfterReload = page.locator('.fm-home-overlay[data-state="home-overlay"]');
    if (await homeAfterReload.isVisible().catch(() => false)) {
      const homeText = await homeAfterReload.innerText();
      if (!homeText.includes("Simulation open:")) {
        throw new Error("Reloaded Home view did not identify the active simulation");
      }
      const backToSimulation = page.getByRole("button", { name: "Back to simulation", exact: true });
      await backToSimulation.click();
      await homeAfterReload.waitFor({ state: "hidden", timeout });
    }
    await page.locator("#fm-main-content.fm-workspace-body").waitFor({ state: "visible", timeout });
    const afterCanvas = await assertCanvas(page, "after terminal telemetry reload");
    const afterField = await waitForLiveField("m", false);
    const afterApi = await readTerminalApiSnapshot(
      page, expectedSession, beforeApi.api.api_instance_id, timeout,
    );
    await revealTelemetry(page, timeout);
    const afterFooter = await readFooterMetrics(
      page, afterApi.api.source_step, afterApi.api.scalar_energy_j, timeout,
    );
    afterReload = {
      api: afterApi.api,
      api_requests: afterApi.api_requests,
      canvas: canvasEvidence(afterCanvas),
      field: fieldEvidence(afterField),
      footer: afterFooter,
    };
    const stableKeys = [
      "api_instance_id", "session_id", "session_epoch", "request_scope_epoch", "run_id",
      "run_status", "source_step", "scalar_revision", "scalar_energy_j",
      "current_run_energy_j", "session_summary_energy_j",
    ];
    if (stableKeys.some((key) => !Object.is(beforeApi.api[key], afterApi.api[key]))) {
      throw new Error("API instance, session, run, terminal step, or scalar source changed across reload");
    }
    if (forbiddenMutations.length > 0) {
      throw new Error(`Terminal telemetry attempted blocked state mutations: ${JSON.stringify(forbiddenMutations)}`);
    }
    return {
      schema: "fullmag.docker-dev-terminal-telemetry.v1",
      state: "passed",
      reload: { method: "page.reload", response_status: reloadStatus, path: reloadPath, count: 1 },
      before_reload: beforeReload,
      after_reload: afterReload,
      api_identity_preserved: true,
      prohibited_mutations: forbiddenMutations,
      non_mutating_client_ack_requests: clientAckRequests,
      api_observation_methods: ["GET", "GET", "GET", "GET", "GET", "GET"],
      energy_format: "en-US:maxFractionDigits=6;scientific:toExponential(6)",
    };
  } catch (error) {
    error.partialProof = {
      schema: "fullmag.docker-dev-terminal-telemetry.v1",
      state: "incomplete",
      reload: { method: "page.reload", response_status: reloadStatus, path: reloadPath, count: reloadStatus === null ? 0 : 1 },
      before_reload: beforeReload,
      after_reload: afterReload,
      prohibited_mutations: forbiddenMutations,
      non_mutating_client_ack_requests: clientAckRequests,
      error: String(error?.message ?? error).slice(0, 2048),
    };
    throw error;
  } finally {
    await page.unroute("**/v2/**", routeHandler);
  }
}
