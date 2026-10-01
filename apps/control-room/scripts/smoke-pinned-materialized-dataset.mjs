import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const workspaceUrl = process.env.CONTROL_ROOM_URL ?? "http://localhost:3100/workspace";
const apiBase = (
  process.env.CONTROL_ROOM_API_BASE_URL ??
  process.env.NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL ??
  new URL(workspaceUrl).origin
).replace(/\/$/, "");
const timeoutMs = Number(
  process.env.CONTROL_ROOM_PINNED_DATASET_SMOKE_TIMEOUT_MS ?? 30_000,
);
const projectStorageRoot = requireAbsolutePath(
  "FULLMAG_PROJECT_STORAGE_ROOT",
);
const reportDirectory = resolveReportDirectory(
  projectStorageRoot,
  "FULLMAG_PINNED_DATASET_REPORT_DIR",
);

const TARGET_RUN_ID = "run-pinned-materialized-dataset";
const OTHER_RUN_ID = "run-pinned-materialized-dataset-other";
const SOLUTION_SET_ID = "solution:pinned-materialized-dataset";
const SOLUTION_REVISION = "9007199254740993";
const OWNER_REVISION = "9007199254740992";
const MEMBER_ID = "member:pinned-field";
const MANIFEST_OBJECT_REF = "a".repeat(64);
const FORGED_MANIFEST_OBJECT_REF = "9".repeat(64);
const FORGED_ARTIFACT_OBJECT_REF = "d".repeat(64);
const POSITIVE_ARTIFACT_ID = `materialized-dataset-${MANIFEST_OBJECT_REF}`;
const FORGED_ARTIFACT_ID = `materialized-dataset-${FORGED_ARTIFACT_OBJECT_REF}`;
const MATERIALIZED_DATASET_SCHEMA = "fullmag.materialized_dataset.v1";
const MATERIALIZED_DATASET_RESOURCE_SCHEMA =
  "fullmag.analysis.materialized_dataset.v1";

function assertCondition(condition, message) {
  assert.ok(condition, message);
}

async function main() {
  const playwright = await loadPlaywright();
  if (!playwright?.chromium) {
    throw new Error(
      "Pinned materialized dataset smoke requires Playwright or @playwright/test.",
    );
  }

  await mkdir(reportDirectory, { recursive: true });
  const state = createFixtureState();
  const channel = process.env.FULLMAG_PINNED_DATASET_BROWSER_CHANNEL;
  if (channel && !["chrome", "msedge"].includes(channel)) {
    throw new Error("Unsupported pinned dataset browser channel.");
  }
  const browser = await playwright.chromium.launch({
    headless: true,
    ...(channel ? { channel } : {}),
  });
  const page = await browser.newPage({
    acceptDownloads: false,
    viewport: { height: 1100, width: 1440 },
  });
  const errors = [];
  let proof = null;
  let failure = null;

  page.on("console", (message) => {
    // Keep the independently observed shell-startup diagnostic visible in
    // evidence. Repetition or any different React error still fails the gate.
    if (message.type() === "error" && message.text().startsWith("Can't perform a React state update on a component that hasn't mounted yet.")) {
      state.startupWarnings.push(message.text());
      return;
    }
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", async (dialog) => {
    if (dialog.type() === "prompt" && dialog.message() === "Project name") {
      await dialog.accept("Untitled project");
    } else {
      errors.push(`Unexpected dialog: ${dialog.type()} ${dialog.message()}`);
      await dialog.dismiss();
    }
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/v2/")) return;
    const method = request.method();
    state.requests.push({
      method,
      path: url.pathname,
      query: url.search,
      type: "request",
    });
    if (
      url.pathname.startsWith("/v2/sessions/current/") &&
      !["GET", "HEAD", "OPTIONS"].includes(method)
    ) {
      state.forbiddenRuntimeRequests.push({ method, path: url.pathname });
    }
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith("/v2/")) return;
    state.responses.push({
      method: response.request().method(),
      path: url.pathname,
      query: url.search,
      status: response.status(),
      type: "response",
    });
  });

  await page.addInitScript((baseUrl) => {
    window.__FULLMAG_CONFIG__ = {
      ...(window.__FULLMAG_CONFIG__ ?? {}),
      allowMissingSessionSmoke: true,
      controlRoomApiBase: baseUrl,
      disableRealtime: true,
    };
  }, apiBase);
  await installFixtureRoutes(page, state);

  try {
    await page.goto(workspaceUrl, {
      timeout: timeoutMs,
      waitUntil: "domcontentloaded",
    });
    await page.locator("main.fm-workspace-shell").waitFor({ state: "visible", timeout: timeoutMs });

    await createProject(page, state);
    await openSavedResults(page);
    const projectId = state.currentProjectId;
    assertCondition(projectId, "New Project did not return a project id.");

    const positive = await selectPinnedArtifact(page, {
      artifactId: POSITIVE_ARTIFACT_ID,
      projectId,
      runId: TARGET_RUN_ID,
    });
    assertPositivePinnedInspector(positive.inspectorText);
    await captureScreenshot(page, state, "pinned-materialized-dataset-positive.png");

    await selectSavedRun(page, OTHER_RUN_ID);
    const savedRunSwitchInspectorRetained =
      await assertSavedRunSwitchDoesNotRelabelPinnedSelection(page, state, {
        containingRevision: SOLUTION_REVISION,
        ownerRevision: OWNER_REVISION,
        projectId,
        runId: TARGET_RUN_ID,
      });

    state.forgeManifestForArtifact = FORGED_ARTIFACT_ID;
    const forged = await selectPinnedArtifact(page, {
      artifactId: FORGED_ARTIFACT_ID,
      projectId,
      runId: TARGET_RUN_ID,
    });
    assertForgedManifestRejected(forged);
    await captureScreenshot(page, state, "pinned-materialized-dataset-forged.png");

    await createProject(page, state);
    await openSavedResults(page);
    await assertProjectSwitchDoesNotRelabelPinnedSelection(page, {
      oldProjectId: projectId,
      newProjectId: state.currentProjectId,
    });

    assert.equal(
      state.forbiddenRuntimeRequests.length,
      0,
      `Saved pinned dataset smoke invoked runtime/model mutation: ${JSON.stringify(
        state.forbiddenRuntimeRequests,
      )}`,
    );
    assert.equal(errors.length, 0, `Browser errors: ${errors.join(" | ")}`);
    assert.ok(state.startupWarnings.length <= 1, "Repeated shell startup mount warning.");
    assertRequiredRequests(state);

    proof = {
      project_switch_suppresses_readonly_old_payload: true,
      positive_owner_revision: OWNER_REVISION,
      positive_containing_revision: SOLUTION_REVISION,
      positive_integrity: "verified",
      positive_owner_execution_status: "running",
      positive_owner_scientific_assessment: "unassessed",
      forged_manifest_rejected: true,
      binary_field_rendering: "not_attempted; metadata fixture has no field payload",
      runtime_solver_or_model_mutation: "none observed",
      saved_run_switch_preserves_explicit_pinned_selection:
        savedRunSwitchInspectorRetained,
    };
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    try {
      if (failure && !state.screenshots.some((path) => path.endsWith("failed.png"))) {
        await captureScreenshot(page, state, "pinned-materialized-dataset-failed.png");
      }
      await writeReport({
        errors,
        failure,
        projectStorageRoot,
        proof,
        reportDirectory,
        state,
        workspaceUrl,
      });
    } finally {
      await browser.close();
    }
  }

  if (failure) throw failure;
  console.log(
    JSON.stringify(
      {
        fixture: true,
        qualification: "NOT VERIFIED",
        report: resolve(reportDirectory, "pinned-materialized-dataset.json"),
        screenshots: state.screenshots,
        status: "passed",
        ...proof,
      },
      null,
      2,
    ),
  );
}

function createFixtureState() {
  return {
    currentProjectId: null,
    forgeManifestForArtifact: null,
    projectCreateCount: 0,
    requests: [],
    responses: [],
    screenshots: [],
    forbiddenRuntimeRequests: [],
    metadataRequests: [],
    startupWarnings: [],
  };
}

async function createProject(page, state) {
  await page.locator(".fm-ribbon__tab").first().waitFor({ state: "visible", timeout: timeoutMs });
  await page.getByRole("button", { name: "File", exact: true }).click();
  const button = page.getByRole("menuitem", { name: /^New Project/i });
  await button.waitFor({ state: "visible", timeout: timeoutMs });
  await button.click();
  await page.locator('[data-project-document-state]').waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  await page.waitForFunction(
    () => document.querySelector("[data-project-document-state]")?.textContent?.trim()
      === "Untitled project · unsaved",
    { timeout: timeoutMs },
  );
  assertCondition(state.currentProjectId, "Project creation response was not intercepted.");
}

async function openSavedResults(page) {
  const resultsRibbon = page.locator(".fm-ribbon__tab").filter({ hasText: /^Results$/ });
  await resultsRibbon.click();
  await page.locator(".fm-results-navigator-shell").waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  const savedTab = await firstVisible(page, [
    page.getByRole("tab", { name: "Saved", exact: true }),
    page.locator("button").filter({ hasText: /^Saved$/ }),
  ]);
  await savedTab.click();
  await page.locator("section[aria-label='Saved results']").first().waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
}

async function selectPinnedArtifact(page, { artifactId, projectId, runId }) {
  await selectSavedRun(page, runId);
  const runSection = page.locator(`section[aria-label='Saved results for run ${cssEscape(runId)}']`);
  await runSection.waitFor({ state: "visible", timeout: timeoutMs });

  const nextSolutionSets = page.getByRole("button", {
    name: "Next SolutionSets",
    exact: true,
  });
  await nextSolutionSets.waitFor({ state: "visible", timeout: timeoutMs });
  const discoveryStatus = runSection.getByRole("status").filter({
    hasText: "No SolutionSets on this page.",
  });
  await discoveryStatus.waitFor({ state: "visible", timeout: timeoutMs });
  await nextSolutionSets.click();

  const solutionList = page.locator("ul[aria-label='SolutionSet revisions']");
  await solutionList.waitFor({ state: "visible", timeout: timeoutMs });
  const solutionButton = solutionList.locator("button").filter({ hasText: SOLUTION_SET_ID }).filter({
    hasText: SOLUTION_REVISION,
  });
  await solutionButton.first().click();

  const memberSection = page.locator(
    `section[aria-label='Members of ${cssEscape(SOLUTION_SET_ID)} revision ${cssEscape(SOLUTION_REVISION)}']`,
  );
  await memberSection.waitFor({ state: "visible", timeout: timeoutMs });
  const memberList = memberSection.locator("ul[aria-label='SolutionSet members']");
  await memberList.waitFor({ state: "visible", timeout: timeoutMs });
  await memberList.locator("button").filter({ hasText: MEMBER_ID }).first().click();

  const artifactSection = page.locator(
    `section[aria-label='Artifacts for member ${cssEscape(MEMBER_ID)}']`,
  );
  await artifactSection.waitFor({ state: "visible", timeout: timeoutMs });
  const artifactList = artifactSection.locator(
    "ul[aria-label='Materialized dataset artifacts']",
  );
  await artifactList.waitFor({ state: "visible", timeout: timeoutMs });
  const artifactButton = artifactList.locator("button").filter({ hasText: artifactId });
  await artifactButton.first().click();

  const status = artifactSection.locator("[role='status']");
  await page.waitForFunction(
    ({ artifactId: expectedArtifactId, projectId: expectedProjectId, runId: expectedRunId }) => {
      const selected = document.querySelector(
        "[aria-label='Materialized dataset artifacts'] button[aria-current='true']",
      );
      return selected?.textContent?.includes(expectedArtifactId) === true &&
        document.querySelector("section[aria-label='Saved results']")?.textContent?.includes(expectedProjectId) === true &&
        document.querySelector(".fm-results-navigator-shell")?.textContent?.includes(expectedRunId) === true;
    },
    { artifactId, projectId, runId },
    { timeout: timeoutMs },
  );

  if (artifactId === POSITIVE_ARTIFACT_ID) {
    await status.filter({ hasText: "Manifest verified." }).waitFor({
      state: "visible",
      timeout: timeoutMs,
    });
    await artifactSection.getByRole("button", {
      name: "Inspect pinned dataset",
      exact: true,
    }).click();
    await page.locator(
      "[data-slot-id='panel-right'] [data-materialized-dataset-inspector='readonly']",
    ).waitFor({ state: "visible", timeout: timeoutMs });
  } else {
    await status.filter({ hasText: "Manifest unavailable:" }).waitFor({
      state: "visible",
      timeout: timeoutMs,
    });
  }

  const inspector = page.locator(
    "[data-slot-id='panel-right'] [data-materialized-dataset-inspector='readonly']",
  );
  const inspectorCount = await inspector.count();
  const inspectButtonCount = await artifactSection.getByRole("button", {
    name: "Inspect pinned dataset",
    exact: true,
  }).count();
  return {
    artifactId,
    inspectorText: inspectorCount > 0 ? await inspector.first().innerText() : "",
    inspector,
    inspectButtonCount,
    statusText: await artifactSection.innerText(),
  };
}

async function selectSavedRun(page, runId) {
  const runs = page.locator("ul[aria-label='Saved runs']");
  await runs.waitFor({ state: "visible", timeout: timeoutMs });
  const runButton = runs.locator("button").filter({ hasText: runId });
  await runButton.first().click();
  await page.locator(`section[aria-label='Saved results for run ${cssEscape(runId)}']`).waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
}

function assertPositivePinnedInspector(text) {
  assert.match(text, /Containing revision[\s\S]*9007199254740993/);
  assert.match(text, /Owner revision[\s\S]*9007199254740992/);
  assert.match(text, /Integrity verified/);
  assert.match(text, /Execution running/);
  assert.match(text, /Assessment unassessed/);
  assert.match(text, new RegExp(MANIFEST_OBJECT_REF));
  assert.match(text, /Field preview is not available yet/);
  assert.doesNotMatch(text, /Plot field|field values|numeric payload/i);
}

function assertForgedManifestRejected(result) {
  assert.match(result.statusText, /Manifest unavailable:/);
  assert.doesNotMatch(result.statusText, /Manifest verified\./);
  assert.equal(
    result.inspectButtonCount,
    0,
    "Forged manifest left the Inspector action enabled.",
  );
  assertCondition(
    !result.inspectorText.includes(FORGED_MANIFEST_OBJECT_REF),
    "Forged manifest was rendered as a verified inspector payload.",
  );
}

async function assertSavedRunSwitchDoesNotRelabelPinnedSelection(
  page,
  state,
  { containingRevision, ownerRevision, projectId, runId },
) {
  const inspector = page.locator(
    "[data-slot-id='panel-right'] [data-materialized-dataset-inspector='readonly']",
  );
  await page.waitForFunction(
    ({ expectedProjectId, expectedRunId }) => {
      const panel = document.querySelector(
        "[data-slot-id='panel-right'] [data-materialized-dataset-inspector='readonly']",
      );
      if (!panel) return true;
      const text = panel.textContent ?? "";
      return text.includes(expectedProjectId) && text.includes(expectedRunId);
    },
    { expectedProjectId: projectId, expectedRunId: runId },
    { timeout: timeoutMs },
  );
  if (await inspector.count() === 0) return false;
  const text = await inspector.first().innerText();
  assert.match(text, new RegExp(runId));
  assert.match(text, new RegExp(containingRevision));
  assert.match(text, new RegExp(ownerRevision));
  assert.doesNotMatch(text, new RegExp(OTHER_RUN_ID));
  assert.equal(
    state.metadataRequests.filter((entry) => entry.runId === OTHER_RUN_ID).length,
    0,
    "Switching saved runs must not fetch a pinned metadata response for the wrong run.",
  );
  return true;
}

async function assertProjectSwitchDoesNotRelabelPinnedSelection(
  page,
  { oldProjectId, newProjectId },
) {
  await page.waitForFunction(
    () => document.querySelector(
      "[data-slot-id='panel-right'] [data-materialized-dataset-inspector='readonly']",
    ) === null,
    { timeout: timeoutMs },
  );
  const panel = page.locator("[data-slot-id='panel-right']");
  const panelText = await panel.innerText();
  if (panelText.includes(`pinned dataset belongs to project ${oldProjectId}`)) {
    assertCondition(
      panelText.includes(newProjectId),
      "Foreign-project pinned selection did not identify the active project.",
    );
    return;
  }
  assert.doesNotMatch(panelText, new RegExp(OWNER_REVISION));
  assert.doesNotMatch(panelText, new RegExp(SOLUTION_REVISION));
}

async function installFixtureRoutes(page, state) {
  await page.route("**/v2/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;

    if (method === "GET" && path === "/v2/sessions") {
      await fulfillJson(route, {
        schema_version: "2.0.0",
        sessions: [{ current: true, name: "Fixture workspace", session_id: "fixture-unavailable-session", status: "unavailable" }],
      });
      return;
    }
    if (method === "GET" && path === "/v2/sessions/current/status") {
      await fulfillJson(route, {
        error: { code: "session_missing", message: "No session in this saved-results fixture." },
      }, 404);
      return;
    }
    if (method === "POST" && path === "/v2/persistence/projects") {
      const projectId = `project-pinned-materialized-dataset-${++state.projectCreateCount}`;
      state.currentProjectId = projectId;
      await fulfillJson(route, projectResource(projectId), 201);
      return;
    }

    const runListMatch = path.match(/^\/v2\/persistence\/projects\/([^/]+)\/runs$/);
    if (method === "GET" && runListMatch) {
      const projectId = decodeURIComponent(runListMatch[1]);
      await fulfillJson(route, projectRunList(projectId, url.searchParams.get("cursor")));
      return;
    }

    const runResourceMatch = path.match(/^\/v2\/persistence\/projects\/([^/]+)\/runs\/([^/]+)$/);
    if (method === "GET" && runResourceMatch) {
      await fulfillJson(route, projectRunResource(
        decodeURIComponent(runResourceMatch[1]),
        decodeURIComponent(runResourceMatch[2]),
      ));
      return;
    }

    const discoveryMatch = path.match(
      /^\/v2\/persistence\/projects\/([^/]+)\/runs\/([^/]+)\/solution-sets$/,
    );
    if (method === "GET" && discoveryMatch) {
      const projectId = decodeURIComponent(discoveryMatch[1]);
      const runId = decodeURIComponent(discoveryMatch[2]);
      await fulfillJson(route, solutionDiscovery(
        projectId,
        runId,
        url.searchParams.get("cursor"),
      ));
      return;
    }

    const solutionMatch = path.match(
      /^\/v2\/persistence\/projects\/([^/]+)\/runs\/([^/]+)\/solution-sets\/([^/]+)\/revisions\/([^/]+)$/,
    );
    if (method === "GET" && solutionMatch) {
      await fulfillJson(route, solutionSetResource());
      return;
    }

    const membersMatch = path.match(
      /^\/v2\/persistence\/projects\/([^/]+)\/runs\/([^/]+)\/solution-sets\/([^/]+)\/revisions\/([^/]+)\/members$/,
    );
    if (method === "GET" && membersMatch) {
      await fulfillJson(route, solutionSetMembersPage());
      return;
    }

    const artifactsMatch = path.match(
      /^\/v2\/persistence\/projects\/([^/]+)\/runs\/([^/]+)\/solution-sets\/([^/]+)\/revisions\/([^/]+)\/members\/([^/]+)\/artifacts$/,
    );
    if (method === "GET" && artifactsMatch) {
      await fulfillJson(route, solutionSetArtifactsPage());
      return;
    }

    const materializedMatch = path.match(
      /^\/v2\/persistence\/projects\/([^/]+)\/runs\/([^/]+)\/solution-sets\/([^/]+)\/revisions\/([^/]+)\/members\/([^/]+)\/artifacts\/([^/]+)\/materialized-dataset$/,
    );
    if (method === "GET" && materializedMatch) {
      const artifactId = decodeURIComponent(materializedMatch[6]);
      state.metadataRequests.push({
        artifactId,
        forged: artifactId === state.forgeManifestForArtifact,
        projectId: decodeURIComponent(materializedMatch[1]),
        runId: decodeURIComponent(materializedMatch[2]),
      });
      await fulfillJson(route, materializedDatasetResource(artifactId === state.forgeManifestForArtifact));
      return;
    }

    if (path.startsWith("/v2/sessions/current/") && method !== "GET") {
      await fulfillJson(route, { error: { code: "runtime_mutation_forbidden_in_fixture" } }, 409);
      return;
    }

    await fulfillJson(route, {}, 204);
  });
}

function projectResource(projectId) {
  return {
    archive_base64: "UEsDBA==",
    dirty: true,
    durability: "memory_only",
    migration: {
      can_write: true,
      migrated: false,
      preserved_paths: [],
      source_schema: "fullmag.project.v1",
      target_schema: "fullmag.project.v1",
      warnings: [],
    },
    mode: { kind: "read_write" },
    name: "Untitled project",
    persisted_revision: 0,
    project_id: projectId,
    revision: 0,
    schema_version: "fullmag.project.v1",
    source_hash: "sha256:browser-pinned-materialized-dataset",
  };
}

function projectRunList(projectId) {
  const hasSavedRuns = projectId.endsWith("-1");
  return {
    next_cursor: null,
    project_id: projectId,
    runs: hasSavedRuns
      ? [projectRunSummary(TARGET_RUN_ID), projectRunSummary(OTHER_RUN_ID)]
      : [],
  };
}

function projectRunSummary(runId) {
  return {
    accepted_at: "2026-10-01T00:00:00Z",
    catalog_revision: 1,
    catalog_state: "materialized",
    payload_fingerprint: `sha256:${"b".repeat(64)}`,
    requested_execution: {
      backend: "cpu",
      device: "cpu",
      mode: "run",
      precision: "double",
      minimum_resources: null,
    },
    run_id: runId,
    scheduling_priority: 0,
    task_count: 1,
  };
}

function projectRunResource(projectId, runId) {
  return {
    catalog_revision: 1,
    catalog_state: "materialized",
    payload_fingerprint: `sha256:${"b".repeat(64)}`,
    project_id: projectId,
    requested_execution: projectRunSummary(runId).requested_execution,
    run_id: runId,
    scheduling_priority: 0,
    tasks: [],
  };
}

function solutionDiscovery(projectId, runId, cursor) {
  const base = {
    project_id: projectId,
    run_id: runId,
    schema_version: "fullmag.analysis.solution_set_discovery.v1",
  };
  if (runId !== TARGET_RUN_ID || cursor !== "solution-next") {
    return {
      ...base,
      items: [],
      next_cursor: runId === TARGET_RUN_ID ? "solution-next" : null,
    };
  }
  return {
    ...base,
    items: [{
      manifest_digest: `sha256:${"c".repeat(64)}`,
      revision: SOLUTION_REVISION,
      solution_set_id: SOLUTION_SET_ID,
    }],
    next_cursor: null,
  };
}

function solutionSetResource() {
  return {
    artifact_count: 2,
    coverage_count: 1,
    execution_status: "running",
    manifest_digest: `sha256:${"c".repeat(64)}`,
    manifest_state: "open",
    member_count: 1,
    project_id: "project-pinned-materialized-dataset-1",
    provenance: solutionProvenance(),
    revision: SOLUTION_REVISION,
    run_id: TARGET_RUN_ID,
    schema_version: "fullmag.analysis.solution_revision.v1",
    scientific_assessment: {
      evidence_artifact_count: 0,
      reason: null,
      status: "unassessed",
    },
    solution_set_id: SOLUTION_SET_ID,
  };
}

function solutionSetMembersPage() {
  return {
    items: [{
      artifact_count: 2,
      attempt_id: "attempt:pinned",
      case_id: "case:pinned",
      execution_status: "running",
      member_id: MEMBER_ID,
      ownership_epoch: "1",
      scientific_assessment: {
        evidence_artifact_count: 0,
        reason: null,
        status: "unassessed",
      },
      stage_id: "stage:pinned",
      task_id: "task:pinned",
    }],
    manifest_digest: `sha256:${"c".repeat(64)}`,
    next_after_member_id: null,
    project_id: "project-pinned-materialized-dataset-1",
    revision: SOLUTION_REVISION,
    run_id: TARGET_RUN_ID,
    schema_version: "fullmag.analysis.solution_revision.v1",
    solution_set_id: SOLUTION_SET_ID,
  };
}

function solutionSetArtifactsPage() {
  const artifact = (artifactId, objectRef) => ({
    accepted_state: null,
    artifact_id: artifactId,
    byte_length: "4096",
    coverage: {
      committed_samples: "1",
      expected_samples: "1",
      segment_count: 1,
      state: "complete",
    },
    integrity: "not_verified",
    kind: "other",
    object_ref: objectRef,
    schema_id: MATERIALIZED_DATASET_SCHEMA,
    scientific_evidence: false,
  });
  return {
    items: [
      artifact(POSITIVE_ARTIFACT_ID, MANIFEST_OBJECT_REF),
      artifact(FORGED_ARTIFACT_ID, FORGED_ARTIFACT_OBJECT_REF),
    ],
    manifest_digest: `sha256:${"c".repeat(64)}`,
    member_id: MEMBER_ID,
    next_after_artifact_id: null,
    project_id: "project-pinned-materialized-dataset-1",
    revision: SOLUTION_REVISION,
    run_id: TARGET_RUN_ID,
    schema_version: "fullmag.analysis.solution_revision.v1",
    solution_set_id: SOLUTION_SET_ID,
  };
}

function materializedDatasetResource(forged) {
  const source = {
    run_id: TARGET_RUN_ID,
    solution_set_id: SOLUTION_SET_ID,
    solution_revision: OWNER_REVISION,
    member_id: MEMBER_ID,
    artifact_id: "tensor:m",
    tensor_object_ref: "b".repeat(64),
    run_spec_digest: `sha256:${"e".repeat(64)}`,
  };
  const manifestObjectRef = forged ? FORGED_MANIFEST_OBJECT_REF : MANIFEST_OBJECT_REF;
  return {
    schema_version: MATERIALIZED_DATASET_RESOURCE_SCHEMA,
    project_id: "project-pinned-materialized-dataset-1",
    run_id: TARGET_RUN_ID,
    solution_set_id: SOLUTION_SET_ID,
    containing_solution_revision: SOLUTION_REVISION,
    owner_solution_revision: OWNER_REVISION,
    member_id: MEMBER_ID,
    artifact_id: forged ? FORGED_ARTIFACT_ID : POSITIVE_ARTIFACT_ID,
    manifest_object_ref: manifestObjectRef,
    manifest_byte_length: "4096",
    integrity: "verified",
    source,
    owner_execution_status: "running",
    owner_scientific_assessment: {
      status: "unassessed",
      reason: null,
      evidence_artifact_count: 0,
    },
    sample_id: "sample:pinned",
    item_id: "item:pinned",
    field_id: "field:m",
    dataset: {
      schema_version: "1.0.0",
      dataset_id: "dataset:pinned-m",
      revision: "1",
      definition_id: "definition:pinned-m",
      definition_revision: "1",
      source,
      status: { availability: "ready", reason: null, actions: [] },
    },
    definition: {
      schema_version: "1.0.0",
      definition_id: "definition:pinned-m",
      revision: "1",
      source,
      domain_selection: {
        selection_id: `sha256:${"f".repeat(64)}`,
        selection_revision: "1",
      },
      axes: [],
      transforms: [],
      evaluation_policy: {
        precision: "f64",
        approximation: "exact_only",
        unavailable_data: "fail",
      },
    },
    field: {
      sample_id: "sample:pinned",
      item_id: "item:pinned",
      field_id: "field:m",
      group_id: "group:pinned",
      producer_id: "producer:fem-p1",
      producer_version: "1",
      tensor_schema_id: "fullmag.tensor.v1",
      tensor_byte_length: "2048",
      plane: "values",
      accepted_state: null,
      tensor_artifact: {
        artifact_id: source.artifact_id,
        schema_id: "fullmag.tensor.v1",
        object_ref: source.tensor_object_ref,
        byte_length: "2048",
        accepted_state: null,
      },
      coverage: {
        total_elements: "6",
        component_count: "3",
        dtype: "f64",
        endian: "little",
        total_bytes: "48",
        chunk_count: 1,
      },
      descriptor: {
        quantity_id: "m",
        unit: "1",
        tensor_rank: "1",
        frame: { kind: "laboratory", frame_id: "frame:global" },
        sample_location: "node",
        active_support: {
          support_fingerprint: `sha256:${"f".repeat(64)}`,
          selection: null,
        },
        function_space: {
          space_id: "space:h1",
          family: "H1",
          order: "1",
          vector_dimension: "3",
          ordering: "by_node",
          basis_id: "basis:h1",
          constraints_fingerprint: null,
          partition_fingerprint: null,
          orientation_mapping_ref: null,
        },
        topology_id: `sha256:${"1".repeat(64)}`,
        carrier_id: "carrier:mesh",
        layout_digest: `sha256:${"2".repeat(64)}`,
        axes: [
          { axis_id: "node", unit: "1", length: "2" },
          { axis_id: "component", unit: "1", length: "3" },
        ],
        component_axis: "component",
        complex_encoding: "real",
        harmonic_convention: null,
        normalization: "unit_vector",
        value_representation: "physical_field",
        modal_semantics: null,
        resolution: "quantitative",
      },
    },
  };
}

function solutionProvenance() {
  return {
    acquisition_digest: `sha256:${"a".repeat(64)}`,
    discretization_digest: `sha256:${"b".repeat(64)}`,
    model_digest: `sha256:${"c".repeat(64)}`,
    physics_digest: `sha256:${"d".repeat(64)}`,
    resolved_plan_digest: `sha256:${"e".repeat(64)}`,
    run_spec_digest: `sha256:${"e".repeat(64)}`,
    seed_digest: null,
  };
}

async function assertRequiredRequests(state) {
  const paths = state.requests.map((request) => request.path);
  const expected = [
    "/v2/persistence/projects",
    `/v2/persistence/projects/${state.currentProjectId}/runs`,
  ];
  assertCondition(paths.includes(expected[0]), "Project create request was not observed.");
  assert.equal(
    state.projectCreateCount,
    2,
    "The browser fixture must exercise both the initial and project-switch create paths.",
  );
  assertCondition(paths.includes(expected[1]), "Project switch run-list request was not observed.");
  assertCondition(
    paths.filter((path) => path === "/v2/persistence/projects").length >= 2,
    "Both project creation requests were not observed.",
  );
  assertCondition(
    state.responses.some((response) => response.path.includes("/solution-sets") && response.status === 200),
    "No SolutionSet response was observed.",
  );
  assertCondition(
    state.metadataRequests.some((entry) => !entry.forged && entry.artifactId === POSITIVE_ARTIFACT_ID),
    "Positive materialized dataset metadata was not requested.",
  );
  assertCondition(
    state.metadataRequests.some((entry) => entry.forged && entry.artifactId === FORGED_ARTIFACT_ID),
    "Forged materialized dataset metadata was not requested.",
  );
}

async function captureScreenshot(page, state, fileName) {
  const path = resolve(reportDirectory, fileName);
  try {
    await page.screenshot({ path, fullPage: true });
    state.screenshots.push(path);
  } catch (error) {
    state.screenshotError = error instanceof Error ? error.message : String(error);
  }
}

async function writeReport({
  errors,
  failure,
  projectStorageRoot: storageRoot,
  proof,
  reportDirectory: directory,
  state,
  workspaceUrl: url,
}) {
  const report = {
    schema_version: "fullmag.browser.pinned_materialized_dataset_fixture.v1",
    status: failure ? "failed" : "passed",
    fixture_only: true,
    qualification: "NOT VERIFIED",
    http_backend: "NOT VERIFIED; page.route supplied fixture responses",
    managed_runtime: "NOT VERIFIED",
    scientific_qualification: "NOT VERIFIED",
    report_directory: directory,
    storage_root: storageRoot,
    workspace_url: url,
    screenshots: state.screenshots,
    screenshot_error: state.screenshotError ?? null,
    proof,
    requests: state.requests,
    responses: state.responses,
    metadata_requests: state.metadataRequests,
    forbidden_runtime_requests: state.forbiddenRuntimeRequests,
    browser_errors: errors,
    shell_startup_warnings: state.startupWarnings,
    failure: failure?.message ?? null,
  };
  await writeFile(
    resolve(directory, "pinned-materialized-dataset.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
}

async function firstVisible(page, locators) {
  for (const locator of locators) {
    if ((await locator.count()) > 0 && await locator.first().isVisible()) {
      return locator.first();
    }
  }
  throw new Error("None of the expected browser controls is visible.");
}

async function visibleLocator(locator) {
  return (await locator.count()) > 0 && await locator.first().isVisible()
    ? locator.first()
    : null;
}

async function fulfillJson(route, body, status = 200) {
  if (status === 204) {
    await route.fulfill({
      headers: {
        "access-control-allow-origin": "*",
        "access-control-expose-headers": "x-api-contract-version",
        "x-api-contract-version": "1.0.0",
      },
      status,
    });
    return;
  }
  await route.fulfill({
    body: JSON.stringify(body),
    contentType: "application/json",
    headers: {
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "x-api-contract-version",
      "x-api-contract-version": "1.0.0",
    },
    status,
  });
}

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

function requireAbsolutePath(name) {
  const value = process.env[name];
  if (!value || !isAbsolute(value)) {
    throw new Error(`${name} must be configured as an absolute path.`);
  }
  return resolve(value);
}

function resolveReportDirectory(storageRoot, envName) {
  const value = process.env[envName];
  if (!value || !isAbsolute(value)) {
    throw new Error(`${envName} must be configured as an absolute path.`);
  }
  const directory = resolve(value);
  const fromRoot = relative(storageRoot, directory);
  if (
    fromRoot !== "" &&
    (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot))
  ) {
    throw new Error(`${envName} must remain below FULLMAG_PROJECT_STORAGE_ROOT.`);
  }
  return directory;
}

function cssEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

main().catch((error) => {
  console.error(`Pinned materialized dataset smoke failed: ${error.stack ?? error.message}`);
  process.exit(1);
});
