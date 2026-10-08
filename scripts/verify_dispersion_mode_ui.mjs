import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Browser proof for the already-imported, live frequency-domain result.
 *
 * This script never uploads a file, seeds browser storage, or substitutes a
 * fixture. A passing run requires: a ready modal-eigen result resource; a
 * visible Results spectrum or dispersion view; a selectable mode row that
 * opens the eigen-mode Inspector with plot-ready field metadata; and a
 * phase-rotated-real mode active in the 3D viewport with a live WebGL context
 * and nonzero drawing buffer. It also exercises available complex views,
 * component and phase changes, and phase-animation play/pause. Missing
 * stage/run ownership or any unclassified Results contract gap blocks the run.
 * A missing geometry identity is reported as NOT_VERIFIED and may allow
 * read-only mode inspection only when all other provenance owners are valid.
 * The script saves its browser log and reached screenshots before a blocker.
 *
 * Required environment variables are kept stable for the managed runner:
 *   FULLMAG_BROWSER_DEPENDENCY_WORKSPACE
 *   FULLMAG_DISPERSION_BROWSER_OUTPUT
 *   FULLMAG_DISPERSION_BROWSER_URL
 * Optional explicit camera setup uses target_m, distance_m, projection,
 * fov_degrees, yaw_degrees, and pitch_degrees fields; coordinates and distance
 * use the viewport's meter-based world coordinates. No defaults are applied.
 */

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const dependencyWorkspace = resolve(required('FULLMAG_BROWSER_DEPENDENCY_WORKSPACE'));
const output = resolve(required('FULLMAG_DISPERSION_BROWSER_OUTPUT'));
const url = required('FULLMAG_DISPERSION_BROWSER_URL');
const timeoutMs = 60_000;
const requestedSampleIndex = process.env.FULLMAG_DISPERSION_BROWSER_SAMPLE_INDEX == null
  ? null : Number(process.env.FULLMAG_DISPERSION_BROWSER_SAMPLE_INDEX);
if (requestedSampleIndex !== null && (!Number.isSafeInteger(requestedSampleIndex) || requestedSampleIndex < 0)) {
  throw new Error('FULLMAG_DISPERSION_BROWSER_SAMPLE_INDEX must be a nonnegative integer.');
}
const exerciseFocus = process.env.FULLMAG_DISPERSION_BROWSER_FOCUS === '1';
const manifestPath = '/v2/sessions/current/analysis/frequency-domain/manifest.v1';
const spectrumPath = '/v2/sessions/current/analysis/frequency-domain/eigen/spectrum.v2';
const branchesPath = '/v2/sessions/current/analysis/frequency-domain/eigen/branches.v2';
const dispersionPath = '/v2/sessions/current/analysis/frequency-domain/eigen/dispersion';
const currentRunPath = '/v2/sessions/current/simulation/runs/current';

await mkdir(output, { recursive: true });

const report = {
  schema: 'fullmag_dispersion_mode_ui_browser_v1',
  qualification: 'real_imported_session_browser_only',
  source: 'current live workspace; no fixture, upload, storage seeding, or API substitution',
  url,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  state: 'running',
  dataQualification: { status: 'NOT_VERIFIED', reasons: ['frequency-domain provenance not evaluated'] },
  expectedConditions: [
    'The active session publishes a ready modal_eigen frequency-domain result and a nonempty spectrum.',
    'The Analysis viewport shows the view selected from explicit k sampling: single-k modal spectrum or path/grid dispersion.',
    'Results exposes a sample/mode row with stable run and stage identity; only a separately reported geometry-identity advisory may remain.',
    'Selecting that row opens the eigen-mode Inspector and publishes plot-ready field metadata for the exact raw sample/mode indices.',
    'The active overlay owner and visible Inspector identity match the selected run, stage, sample, mode, and field resource.',
    'The Inspector can switch to each available imag/abs view and another component, change phase, and restore phase-rotated real at zero degrees.',
    'If phase animation controls are exposed, Play advances the displayed phase and Pause holds it steady.',
    'The selected mode field query and a visible, non-lost WebGL 3D canvas with a nonzero drawing buffer match the same field identity.',
  ],
  checks: [],
  blockers: [],
  notes: [],
  screenshots: [],
  pageErrors: [],
  consoleErrors: [],
  failedRequests: [],
  apiRequests: [],
  apiResponses: [],
  resultContext: null,
  ui: {},
};

const logLines = [];
const responseBodies = new Map();
const pendingResponseCaptures = new Set();
let browser = null;
let page = null;
let phase = 'startup';

function log(message, details = undefined) {
  const line = `${new Date().toISOString()} [${phase}] ${message}${details === undefined ? '' : ` ${JSON.stringify(details)}`}`;
  logLines.push(line);
  console.log(line);
}

function addCheck(id, passed, message, details = undefined) {
  report.checks.push({ id, passed: Boolean(passed), message, ...(details === undefined ? {} : { details }) });
  if (!passed) {
    report.blockers.push({ id, message, ...(details === undefined ? {} : { details }) });
    log(`BLOCKED: ${message}`, details);
  } else {
    log(`PASS: ${message}`, details);
  }
}

function addNote(message, details = undefined) {
  report.notes.push({ message, ...(details === undefined ? {} : { details }) });
  log(`NOTE: ${message}`, details);
}

function errorText(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function pathnameOf(value) {
  try {
    return new URL(value).pathname;
  } catch {
    return value;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseCameraConfiguration(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`FULLMAG_DISPERSION_CAMERA_JSON is not valid JSON: ${errorText(error)}`);
  }
  if (!isRecord(parsed)) throw new Error('FULLMAG_DISPERSION_CAMERA_JSON must be a JSON object.');

  const finiteNumber = (value, name) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`Camera configuration ${name} must be a finite number.`);
    }
    return value;
  };
  const target = parsed.target_m;
  if (!Array.isArray(target) || target.length !== 3) {
    throw new Error('Camera configuration target_m must contain exactly three world-coordinate meters.');
  }
  const projection = parsed.projection;
  if (projection !== 'perspective' && projection !== 'orthographic') {
    throw new Error('Camera configuration projection must be perspective or orthographic.');
  }
  const config = {
    targetM: target.map((value, index) => finiteNumber(value, `target_m[${index}]`)),
    distanceM: finiteNumber(parsed.distance_m, 'distance_m'),
    projection,
    yawDegrees: finiteNumber(parsed.yaw_degrees, 'yaw_degrees'),
    pitchDegrees: finiteNumber(parsed.pitch_degrees, 'pitch_degrees'),
    ...(parsed.roll_degrees === undefined ? {} : { rollDegrees: finiteNumber(parsed.roll_degrees, 'roll_degrees') }),
    ...(parsed.fov_degrees === undefined ? {} : { fovDegrees: finiteNumber(parsed.fov_degrees, 'fov_degrees') }),
    ...(parsed.orthographic_scale_m === undefined
      ? {}
      : { orthographicScaleM: finiteNumber(parsed.orthographic_scale_m, 'orthographic_scale_m') }),
  };
  if (config.distanceM <= 0) throw new Error('Camera configuration distance_m must be greater than zero.');
  if (projection === 'perspective' &&
      (config.fovDegrees === undefined || config.fovDegrees <= 0 || config.fovDegrees >= 180)) {
    throw new Error('Perspective camera configuration requires fov_degrees strictly between 0 and 180.');
  }
  if (projection === 'orthographic' &&
      (config.orthographicScaleM === undefined || config.orthographicScaleM <= 0)) {
    throw new Error('Orthographic camera configuration requires positive orthographic_scale_m.');
  }
  return config;
}

function stringValue(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function summarizeSpectrum(json) {
  const payload = isRecord(json?.payload) ? json.payload : null;
  const samples = Array.isArray(payload?.samples) ? payload.samples : [];
  const modes = samples.flatMap((sample) => Array.isArray(sample?.modes) ? sample.modes : []);
  const legacyModes = Array.isArray(payload?.modes) ? payload.modes : [];
  const allModes = modes.length > 0 ? modes : legacyModes;
  return {
    status: json?.status ?? null,
    artifactPath: json?.artifact_path ?? null,
    runId: json?.run_id ?? null,
    stageId: json?.stage_id ?? null,
    meshGenerationId: json?.mesh_generation_id ?? null,
    sampleCount: samples.length,
    modeCount: allModes.length,
    modeFieldCount: allModes.filter((mode) =>
      stringValue(mode?.mode_field_id) || stringValue(mode?.mode_field_resource_key),
    ).length,
  };
}

function summarizeJson(path, json) {
  if (path === currentRunPath) {
    return {
      runId: stringValue(json?.run_id),
      sessionId: stringValue(json?.session_id),
      status: stringValue(json?.status),
      revision: json?.revision ?? null,
    };
  }
  if (path === manifestPath) {
    const result = isRecord(json?.result_manifest) ? json.result_manifest : null;
    const payload = isRecord(result?.payload) ? result.payload : null;
    const requested = isRecord(payload?.requested_execution) ? payload.requested_execution : {};
    return {
      resultManifestStatus: result?.status ?? null,
      runId: result?.run_id ?? null,
      stageId: result?.stage_id ?? null,
      meshGenerationId: result?.mesh_generation_id ?? null,
      artifactPath: result?.artifact_path ?? null,
      payload: payload ? {
        runId: payload.run_id ?? null,
        stageId: payload.stage_id ?? null,
        studyProduct: payload.study_product ?? null,
        equilibriumIdentity: payload.equilibrium_identity ?? payload.equilibrium_artifact_sha256 ?? null,
        nativeProvenanceBySample: payload.native_provenance_by_sample ?? null,
        geometryIdentity: payload.geometry_identity ?? null,
        meshIdentity: payload.mesh_identity ?? null,
        boundaryContext: payload.boundary_context ?? requested.boundary_context ?? null,
        kSampling: payload.k_sampling ?? requested.k_sampling ?? null,
        calculationMode: requested.calculation_mode ?? null,
      } : null,
    };
  }
  if (path === spectrumPath) return summarizeSpectrum(json);
  if (path === dispersionPath) {
    const csv = typeof json?.text === 'string' ? json.text : '';
    const lines = csv.split(/\r?\n/).filter(Boolean);
    return {
      status: json?.status ?? null,
      artifactPath: json?.artifact_path ?? null,
      runId: json?.run_id ?? null,
      stageId: json?.stage_id ?? null,
      pathMetadata: json?.path_metadata ?? null,
      csvBytes: Buffer.byteLength(csv),
      csvRows: Math.max(0, lines.length - 1),
      csvHeader: lines[0] ?? null,
    };
  }
  if (isRecord(json)) {
    const payload = isRecord(json.payload) ? json.payload : null;
    const summary = {
      status: json.status ?? null,
      artifactPath: json.artifact_path ?? null,
      runId: json.run_id ?? null,
      stageId: json.stage_id ?? null,
      resourceKey: json.resource_key ?? null,
    };
    const modePathMatch = path.match(/\/analysis\/frequency-domain\/eigen\/modes\/(\d+)\/(\d+)$/);
    if (modePathMatch) {
      const candidateIdentity = isRecord(json.candidate_identity)
        ? json.candidate_identity
        : isRecord(payload?.candidate_identity)
          ? payload.candidate_identity
          : null;
      return {
        ...summary,
        equilibriumArtifactSha256: stringValue(json.equilibrium_artifact_sha256) ??
          stringValue(payload?.equilibrium_artifact_sha256),
        candidateIdentityEquilibriumArtifactSha256: stringValue(candidateIdentity?.equilibrium_artifact_sha256),
        sampleIndex: payload?.sample_index ?? null,
        rawModeIndex: payload?.raw_mode_index ?? null,
        sampleId: stringValue(payload?.sample_id),
        modeId: stringValue(payload?.mode_id),
        fieldId: stringValue(payload?.mode_field_id),
        requestedSampleIndex: Number(modePathMatch[1]),
        requestedRawModeIndex: Number(modePathMatch[2]),
      };
    }
    if (/\/analysis\/frequency-domain\/eigen\/mode-field\/\d+\/\d+\/meta$/.test(path)) {
      return {
        ...summary,
        fieldId: stringValue(json.field_id),
      };
    }
    return summary;
  }
  return null;
}

function isSupportedKSampling(sampling) {
  if (!isRecord(sampling)) return false;
  if (sampling.kind === 'single') {
    const vector = sampling.vector_rad_per_m ?? sampling.k_vector;
    if (!Array.isArray(vector) || vector.length !== 3 ||
        !vector.every((value) => typeof value === 'number' && Number.isFinite(value))) return false;
    if (sampling.vector_rad_per_m !== undefined && sampling.k_vector !== undefined &&
        (!Array.isArray(sampling.k_vector) || sampling.k_vector.length !== 3 ||
         sampling.k_vector.some((value, index) => value !== vector[index]))) return false;
    return true;
  }
  return (sampling.kind === 'path' || sampling.kind === 'grid') &&
    typeof sampling.sample_count === 'number' && Number.isSafeInteger(sampling.sample_count) &&
    sampling.sample_count > 0;
}

function classifyAnalysisSurface(boundaryContext, sampling) {
  if (boundaryContext === 'finite_open') {
    return {
      surface: 'resonance-fmr',
      subviewId: 'resonance.eigenmodes',
      subviewLabel: 'Eigenmodes',
      chartShape: 'modal-spectrum',
      expectedChartKind: 'Eigenmode spectrum',
      supported: true,
      reason: 'finite_open modal results use Resonance & FMR → Eigenmodes',
    };
  }
  if (boundaryContext !== 'floquet_periodic' || !isSupportedKSampling(sampling)) {
    return { surface: 'unsupported', subviewId: null, subviewLabel: null, chartShape: null, expectedChartKind: null, supported: false, reason: 'a valid boundary context and supported k sampling resource are required' };
  }
  if (sampling.kind === 'single') {
    return {
      surface: 'dispersion',
      subviewId: 'dispersion.modal',
      subviewLabel: 'Modes at fixed k',
      chartShape: 'modal-spectrum',
      expectedChartKind: 'Eigenmode spectrum',
      supported: true,
      reason: 'Floquet single-k results use Dispersion → Modes at fixed k with a modal-spectrum chart',
    };
  }
  return {
    surface: 'dispersion',
    subviewId: 'dispersion.modal',
    subviewLabel: 'Modal fₙ(k)',
    chartShape: 'dispersion',
    expectedChartKind: 'Eigenmode dispersion',
    supported: true,
    reason: `Floquet ${sampling.kind} k sampling uses Dispersion → Modal fₙ(k) with a dispersion chart`,
  };
}

function parseSampleEquilibriumIdentityMap(payload, sampling, commonEquilibriumIdentity, boundaryContext) {
  if (!isRecord(payload)) return { status: 'absent', bySample: {} };

  let sampleCount = sampling?.kind === 'single'
    ? 1
    : (sampling?.kind === 'path' || sampling?.kind === 'grid') &&
        Number.isSafeInteger(sampling.sample_count) && sampling.sample_count > 0
      ? sampling.sample_count
      : null;
  let publishedSampleCount = null;
  if (Object.prototype.hasOwnProperty.call(payload, 'sample_count')) {
    publishedSampleCount = payload.sample_count;
    if (!Number.isSafeInteger(publishedSampleCount) || publishedSampleCount <= 0 ||
        (sampleCount !== null && publishedSampleCount !== sampleCount)) {
      return { status: 'invalid', bySample: {} };
    }
  }
  if (sampleCount === null && boundaryContext === 'finite_open' && publishedSampleCount !== null) {
    sampleCount = publishedSampleCount;
  }
  if (!Object.prototype.hasOwnProperty.call(payload, 'native_provenance_by_sample')) {
    return { status: 'absent', bySample: {} };
  }

  const nativeProvenanceBySample = payload.native_provenance_by_sample;
  if (sampleCount === null || !isRecord(nativeProvenanceBySample) ||
      Object.keys(nativeProvenanceBySample).length !== sampleCount) {
    return { status: 'invalid', bySample: {} };
  }

  const bySample = {};
  for (const [sampleIndex, provenance] of Object.entries(nativeProvenanceBySample)) {
    if (!/^(0|[1-9][0-9]*)$/.test(sampleIndex)) {
      return { status: 'invalid', bySample: {} };
    }
    const numericIndex = Number(sampleIndex);
    const equilibriumIdentity = isRecord(provenance)
      ? stringValue(provenance.equilibrium_artifact_sha256)
      : null;
    if (!Number.isSafeInteger(numericIndex) || numericIndex < 0 ||
        numericIndex >= sampleCount || !equilibriumIdentity ||
        (commonEquilibriumIdentity && equilibriumIdentity !== commonEquilibriumIdentity)) {
      return { status: 'invalid', bySample: {} };
    }
    bySample[sampleIndex] = equilibriumIdentity;
  }

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    if (!Object.prototype.hasOwnProperty.call(bySample, String(sampleIndex))) {
      return { status: 'invalid', bySample: {} };
    }
  }
  return { status: 'valid', bySample };
}

function equilibriumIdentityForSample(commonEquilibriumIdentity, sampleEquilibriumIdentityMap, sampleIndex) {
  if (sampleEquilibriumIdentityMap.status === 'invalid') return null;
  if (sampleEquilibriumIdentityMap.status === 'valid') {
    return Number.isSafeInteger(sampleIndex) && sampleIndex >= 0
      ? sampleEquilibriumIdentityMap.bySample[String(sampleIndex)] ?? null
      : null;
  }
  return commonEquilibriumIdentity;
}

function frequencyDomainProvenanceGaps({
  runId,
  stageId,
  payloadRunId,
  envelopeRunId,
  payloadStageId,
  envelopeStageId,
  currentRunId,
  equilibriumIdentity,
  sampleEquilibriumIdentityMap,
  studyProduct,
  boundaryContext,
  kSampling,
  geometryIdentity,
  meshIdentity,
}) {
  const gaps = [];
  if (!runId) gaps.push('run identity unavailable');
  if (!stageId) gaps.push('stage identity unavailable');
  if (payloadRunId && envelopeRunId && payloadRunId !== envelopeRunId) gaps.push('run identity mismatch');
  if (payloadStageId && envelopeStageId && payloadStageId !== envelopeStageId) gaps.push('stage identity mismatch');
  if (!currentRunId || currentRunId !== runId) gaps.push('current run identity mismatch');
  if (sampleEquilibriumIdentityMap.status === 'invalid') {
    gaps.push('per-sample equilibrium identity map incomplete or invalid');
  } else if (!equilibriumIdentity && sampleEquilibriumIdentityMap.status !== 'valid') {
    gaps.push('equilibrium identity unavailable');
  }
  if (studyProduct !== 'modal_eigen' && studyProduct !== 'driven_response') gaps.push('study product unavailable');
  if (boundaryContext !== 'finite_open' && boundaryContext !== 'floquet_periodic') gaps.push('boundary context unavailable');
  if (boundaryContext === 'floquet_periodic' && !isSupportedKSampling(kSampling)) {
    gaps.push('Periodic/Floquet artifact does not publish a supported k sampling resource');
  }
  if (!geometryIdentity) gaps.push('geometry identity unavailable');
  if (!meshIdentity) gaps.push('mesh identity unavailable');
  return gaps;
}


function visibleRootGapDetailsAreCompatible(title, description, text = '') {
  const detail = [title, description, text].filter(Boolean).join(' ').toLowerCase();
  const hasSpecificGapDetail = /(?:identity unavailable|does not publish|mismatch|unsupported|missing)/i.test(detail);
  if (!hasSpecificGapDetail) return true;
  const onlyGeometryPhrase = detail
    .replaceAll('geometry identity unavailable', '')
    .replaceAll('contract gap', '')
    .replaceAll('results', '')
    .replaceAll('[ready]', '')
    .replace(/[\s—–:;,.()-]+/g, ' ')
    .trim();
  return onlyGeometryPhrase === '' && detail.includes('geometry identity unavailable');
}

function shouldCaptureBody(path, status) {
  return status >= 400 || path === manifestPath || path === spectrumPath ||
    path === branchesPath || path === dispersionPath || path === currentRunPath ||
    path.includes('/analysis/frequency-domain/eigen/modes/') ||
    path.includes('/analysis/frequency-domain/eigen/mode-field/');
}

async function captureResponse(response, entry) {
  if (!shouldCaptureBody(entry.path, entry.status)) return;
  try {
    const text = await response.text();
    if (entry.status >= 400) entry.errorBody = text.slice(0, 4000);
    try {
      const json = JSON.parse(text);
      responseBodies.set(entry, json);
      entry.bodySummary = summarizeJson(entry.path, json);
    } catch {
      if (entry.status < 400) {
        entry.bodySummary = { responseBytes: Buffer.byteLength(text), preview: text.slice(0, 800) };
      }
    }
  } catch (error) {
    entry.bodyCaptureError = errorText(error);
  }
}

async function flushResponseCaptures() {
  await Promise.allSettled([...pendingResponseCaptures]);
}

async function saveScreenshot(name) {
  if (!page) return;
  try {
    await page.screenshot({
      path: join(output, name),
      fullPage: true,
      animations: 'disabled',
      timeout: 30_000,
    });
    if (!report.screenshots.includes(name)) report.screenshots.push(name);
    log(`Saved screenshot ${name}`);
  } catch (error) {
    addNote(`Could not save screenshot ${name}`, errorText(error));
  }
}

function latestApiResponse(path) {
  return report.apiResponses.filter((entry) => entry.path === path).at(-1) ?? null;
}

function modeFieldVectorIdentity(rawUrl) {
  try {
    const parsed = new URL(rawUrl, url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    return {
      fieldId: decodeURIComponent(segments.at(-3) ?? ''),
      component: parsed.searchParams.get('component'),
      scopeKind: parsed.searchParams.get('scope_kind'),
      view: parsed.searchParams.get('view'),
      stageId: parsed.searchParams.get('stage_id'),
      phaseRad: parsed.searchParams.get('phase_rad'),
    };
  } catch {
    return null;
  }
}

function vectorBinaryEvidenceFromHeaders(headers) {
  const encoding = headers['x-fullmag-encoding'] ?? null;
  const versionMatch = typeof encoding === 'string'
    ? encoding.match(/^FMVP;version=(2|3|4)$/i)
    : null;
  const componentsPerPoint = Number(headers['x-fullmag-n-comp']);
  return {
    encoding,
    formatVersion: versionMatch ? Number(versionMatch[1]) : null,
    componentsPerPoint: Number.isInteger(componentsPerPoint) ? componentsPerPoint : null,
    payloadState: headers['x-fullmag-payload-state'] ?? null,
    domainGenerationId: headers['x-fullmag-domain-generation-id'] ?? null,
    fieldRevision: headers['x-fullmag-field-revision'] ?? null,
  };
}

function complexModeFieldBinaryEvidenceMatches(entry, fieldId) {
  const identity = modeFieldVectorIdentity(entry?.url);
  const binary = entry?.binaryEvidence;
  return Boolean(
    entry?.status === 200 &&
    entry.contentType === 'application/octet-stream' &&
    identity?.fieldId === fieldId &&
    identity.view === 'complex' &&
    identity.component === 'full' &&
    identity.scopeKind === 'full' &&
    identity.phaseRad === null &&
    binary && [2, 3, 4].includes(binary.formatVersion) &&
    binary.componentsPerPoint === 6,
  );
}

function successfulModeFieldVector(entry, fieldId, view) {
  const identity = modeFieldVectorIdentity(entry?.url);
  if (view === 'complex') return complexModeFieldBinaryEvidenceMatches(entry, fieldId);
  return Boolean(
    entry && entry.status >= 200 && entry.status < 300 && entry.status !== 202 &&
    identity?.fieldId === fieldId && identity.view === view,
  );
}

async function waitForModeFieldVector(fieldId, view, startedAt) {
  const findResponse = () => report.apiResponses.find((entry) =>
    entry.time >= startedAt && successfulModeFieldVector(entry, fieldId, view),
  );
  const existing = findResponse();
  if (existing) return existing;
  await page.waitForResponse((response) => {
    if (!/\/v2\/sessions\/current\/data\/fields\/[^/]+\/samples\/vector$/.test(pathnameOf(response.url()))) {
      return false;
    }
    return successfulModeFieldVector({
      status: response.status(),
      url: response.url(),
      contentType: response.headers()['content-type'] ?? null,
      binaryEvidence: vectorBinaryEvidenceFromHeaders(response.headers()),
    }, fieldId, view);
  }, { timeout: timeoutMs });
  await flushResponseCaptures();
  return findResponse() ?? null;
}

async function readInspectorField(inspector, label) {
  return inspector.locator('.fm-inspector-field-row').evaluateAll((rows, targetLabel) => {
    const row = rows.find((candidate) =>
      candidate.querySelector('.fm-inspector-field-row__label')?.textContent?.trim() === targetLabel,
    );
    return row?.querySelector('.fm-inspector-field-row__value')?.textContent?.trim() ?? null;
  }, label);
}

async function applyCameraConfigurationThroughUi(configuration) {
  const ribbonTabs = page.getByRole('tablist', { name: 'Ribbon tabs', exact: true });
  const viewTab = ribbonTabs.getByRole('tab', { name: 'View', exact: true });
  await viewTab.waitFor({ state: 'visible', timeout: timeoutMs });
  if (await viewTab.getAttribute('aria-selected') !== 'true') await viewTab.click();

  const cameraButton = page.locator('button[data-action-id="view-camera"]');
  await cameraButton.waitFor({ state: 'visible', timeout: timeoutMs });
  await cameraButton.click();
  await page.getByRole('menuitem', { name: 'Camera parameters', exact: true }).click();

  const dialog = page.locator('[aria-label="3D camera parameters"]');
  await dialog.waitFor({ state: 'visible', timeout: timeoutMs });
  const targetGroup = dialog.getByRole('group', { name: 'Target', exact: true });
  const targetInputs = targetGroup.locator('input[type="number"]');
  await targetInputs.first().waitFor({ state: 'visible', timeout: timeoutMs });
  if (await targetInputs.count() !== 3) throw new Error('Camera dialog Target group did not expose three coordinate inputs.');
  for (let axis = 0; axis < 3; axis += 1) {
    await targetInputs.nth(axis).fill(String(configuration.targetM[axis]));
  }

  async function scalarInput(label) {
    const fields = dialog.locator('.fm-viewport-camera-dialog__form label.fm-viewport-camera-dialog__field');
    const matchingIndices = await fields.evaluateAll((elements, expectedLabel) =>
      elements.flatMap((element, index) =>
        element.querySelector(':scope > span')?.textContent?.trim() === expectedLabel ? [index] : [],
      ), label);
    if (matchingIndices.length !== 1) {
      throw new Error(`Camera dialog did not expose exactly one ${label} field (found ${matchingIndices.length}).`);
    }
    const input = fields.nth(matchingIndices[0]).locator('input[type="number"]');
    if (await input.count() !== 1) throw new Error(`Camera dialog ${label} field did not expose exactly one numeric input.`);
    return input;
  }

  await (await scalarInput('Distance')).fill(String(configuration.distanceM));
  await (await scalarInput('Yaw')).fill(String(configuration.yawDegrees));
  await (await scalarInput('Pitch')).fill(String(configuration.pitchDegrees));
  if (configuration.rollDegrees !== undefined) {
    await (await scalarInput('Roll')).fill(String(configuration.rollDegrees));
  }
  if (configuration.fovDegrees !== undefined) {
    await (await scalarInput('FOV')).fill(String(configuration.fovDegrees));
  }
  if (configuration.orthographicScaleM !== undefined) {
    await (await scalarInput('Ortho scale')).fill(String(configuration.orthographicScaleM));
  }
  await dialog.locator('.fm-viewport-camera-dialog__form select').selectOption(configuration.projection);
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();

  await page.waitForFunction((expected) => {
    const dialog = document.querySelector('[aria-label="3D camera parameters"]');
    if (!dialog) return false;
    const entries = [...dialog.querySelectorAll('.fm-viewport-camera-dialog__live-item')];
    const live = Object.fromEntries(entries.map((entry) => [
      entry.querySelector('span')?.textContent?.trim() ?? '',
      entry.querySelector('strong')?.textContent?.trim() ?? '',
    ]));
    const numberFromText = (value) => {
      const match = String(value ?? '').match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i);
      return match ? Number(match[0]) : Number.NaN;
    };
    const closeEnough = (observed, target) => Number.isFinite(observed) &&
      Math.abs(observed - target) <= Math.max(1e-15, Math.abs(target) * 1e-6);
    const targetGroup = [...dialog.querySelectorAll('fieldset')].find(
      (group) => group.querySelector('legend')?.textContent?.trim() === 'Target',
    );
    const targetValues = [...(targetGroup?.querySelectorAll('input[type="number"]') ?? [])]
      .map((input) => Number(input.value));
    const scalarFields = [...dialog.querySelectorAll('.fm-viewport-camera-dialog__form label.fm-viewport-camera-dialog__field')];
    const scalarValue = (label) => {
      const field = scalarFields.find((candidate) => candidate.querySelector(':scope > span')?.textContent?.trim() === label);
      return Number(field?.querySelector('input[type="number"]')?.value);
    };
    const projection = dialog.querySelector('.fm-viewport-camera-dialog__form select')?.value;
    const targetMatches = targetValues.length === 3 && targetValues.every((value, index) =>
      closeEnough(value, expected.targetM[index]),
    );
    const normalizedYaw = ((expected.yawDegrees % 360) + 360) % 360;
    const normalizedRoll = expected.rollDegrees === undefined
      ? null
      : ((expected.rollDegrees + 180) % 360 + 360) % 360 - 180;
    const fieldsMatch = projection === expected.projection &&
      closeEnough(scalarValue('Distance'), expected.distanceM) &&
      closeEnough(scalarValue('Yaw'), normalizedYaw) &&
      closeEnough(scalarValue('Pitch'), expected.pitchDegrees) &&
      (normalizedRoll === null || closeEnough(scalarValue('Roll'), normalizedRoll)) &&
      (expected.fovDegrees === undefined || closeEnough(scalarValue('FOV'), expected.fovDegrees)) &&
      (expected.orthographicScaleM === undefined || closeEnough(scalarValue('Ortho scale'), expected.orthographicScaleM));
    return targetMatches && fieldsMatch &&
      String(live.Projection ?? '').toLowerCase() === expected.projection &&
      closeEnough(numberFromText(live.Distance), expected.distanceM) &&
      closeEnough(numberFromText(live.Yaw), normalizedYaw) &&
      closeEnough(numberFromText(live.Pitch), expected.pitchDegrees) &&
      (normalizedRoll === null || closeEnough(numberFromText(live.Roll), normalizedRoll));
  }, configuration, { timeout: timeoutMs });

  const yawRad = (configuration.yawDegrees * Math.PI) / 180;
  const pitchRad = (configuration.pitchDegrees * Math.PI) / 180;
  const expectedPositionM = [
    configuration.targetM[0] + configuration.distanceM * Math.cos(pitchRad) * Math.cos(yawRad),
    configuration.targetM[1] + configuration.distanceM * Math.cos(pitchRad) * Math.sin(yawRad),
    configuration.targetM[2] + configuration.distanceM * Math.sin(pitchRad),
  ];
  await page.waitForFunction(({ targetM, expectedPositionM, projection }) => {
    const viewport = document.querySelector('.fm-viewport-3d');
    if (!viewport || viewport.getAttribute('data-camera-projection') !== projection) return false;
    const parseTuple = (value) => {
      const tuple = String(value ?? '').trim().split(/\s+/).map(Number);
      return tuple.length === 3 && tuple.every(Number.isFinite) ? tuple : null;
    };
    const closeEnough = (observed, expected) => Math.abs(observed - expected) <= Math.max(1e-15, Math.abs(expected) * 1e-6);
    const target = parseTuple(viewport.getAttribute('data-camera-target'));
    const position = parseTuple(viewport.getAttribute('data-camera-position'));
    return Boolean(target && position &&
      target.every((value, index) => closeEnough(value, targetM[index])) &&
      position.every((value, index) => closeEnough(value, expectedPositionM[index])));
  }, { targetM: configuration.targetM, expectedPositionM, projection: configuration.projection }, { timeout: timeoutMs });

  const liveValues = await dialog.locator('.fm-viewport-camera-dialog__live-item').evaluateAll((entries) =>
    Object.fromEntries(entries.map((entry) => [
      entry.querySelector('span')?.textContent?.trim() ?? '',
      entry.querySelector('strong')?.textContent?.trim() ?? '',
    ])),
  );
  const viewport = page.locator('.fm-viewport-3d');
  await viewport.waitFor({ state: 'visible', timeout: timeoutMs });
  const viewportCameraState = await viewport.evaluate((element) => ({
    position: element.getAttribute('data-camera-position'),
    projection: element.getAttribute('data-camera-projection'),
    target: element.getAttribute('data-camera-target'),
  }));
  await dialog.getByRole('button', { name: 'Close camera parameters', exact: true }).click();
  await dialog.waitFor({ state: 'hidden', timeout: timeoutMs });
  return { configured: true, applied: true, values: configuration, liveValues, viewportCameraState };
}

async function waitForApiPath(path, deadlineAtMs = Date.now() + timeoutMs) {
  const existing = latestApiResponse(path);
  if (existing) {
    await flushResponseCaptures();
    return latestApiResponse(path);
  }
  if (!page) return null;
  const remainingMs = Math.max(0, deadlineAtMs - Date.now());
  const timeoutMessage = () => {
    const attempts = report.apiRequests.filter((entry) => entry.path === path);
    const failures = report.failedRequests
      .filter((entry) => entry.path === path)
      .map((entry) => entry.failure);
    const failureSummary = failures.length > 0 ? ` Observed failures: ${failures.join('; ')}.` : '';
    return `No browser response arrived for ${path} before the shared resource deadline after ${attempts.length} request attempt(s).${failureSummary}`;
  };
  if (remainingMs === 0) throw new Error(timeoutMessage());
  await new Promise((resolveResponse, rejectFailure) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      page.off('response', onResponse);
    };
    const finish = (action) => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const onResponse = (response) => {
      if (pathnameOf(response.url()) === path) finish(() => resolveResponse());
    };
    const timer = setTimeout(() => finish(() => rejectFailure(new Error(timeoutMessage()))), remainingMs);
    page.on('response', onResponse);

    const responseAfterSubscription = latestApiResponse(path);
    if (responseAfterSubscription) {
      finish(() => resolveResponse());
    }
  });
  await flushResponseCaptures();
  return latestApiResponse(path);
}

async function inspectCanvas(canvas) {
  return canvas.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    let gl = null;
    let contextType = null;
    try {
      gl = element.getContext('webgl2');
      if (gl) contextType = 'webgl2';
      if (!gl) {
        gl = element.getContext('webgl');
        if (gl) contextType = 'webgl';
      }
    } catch {
      gl = null;
    }
    return {
      connected: element.isConnected,
      visibleBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      cssVisibility: getComputedStyle(element).visibility,
      cssDisplay: getComputedStyle(element).display,
      canvasWidth: element.width,
      canvasHeight: element.height,
      contextType,
      contextLost: gl ? gl.isContextLost() : null,
      drawingBufferWidth: gl?.drawingBufferWidth ?? 0,
      drawingBufferHeight: gl?.drawingBufferHeight ?? 0,
    };
  });
}

async function inspectFrequencyChartPaint(canvas, expectedColor, connectedLine = false) {
  return canvas.evaluate((element, { color, connectedLine }) => {
    if (!(element instanceof HTMLCanvasElement)) {
      return { ready: false, reason: "The frequency chart canvas is unavailable." };
    }
    const host = element.closest('.fm-analysis-plots__echarts');
    const body = element.closest('.fm-chart-section__body');
    const rect = element.getBoundingClientRect();
    const bodyRect = body?.getBoundingClientRect();
    const context = element.getContext('2d');
    const colorValues = color.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number) ?? [];
    const expectedRgb = colorValues.length === 3 && colorValues.every((value) => value <= 1)
      ? colorValues.map((value) => Math.round(value * 255))
      : colorValues;
    let opaquePixelCount = 0;
    let markerPixelCount = 0;
    const markers = [];

    if (context && expectedRgb.length === 3 && element.width > 0 && element.height > 0) {
      const pixels = context.getImageData(0, 0, element.width, element.height).data;
      const matches = new Uint8Array(element.width * element.height);
      for (let pixelIndex = 0; pixelIndex < matches.length; pixelIndex += 1) {
        const offset = pixelIndex * 4;
        const alpha = pixels[offset + 3];
        if (alpha > 0) opaquePixelCount += 1;
        if (
          alpha >= 120 &&
          Math.abs(pixels[offset] - expectedRgb[0]) <= 40 &&
          Math.abs(pixels[offset + 1] - expectedRgb[1]) <= 40 &&
          Math.abs(pixels[offset + 2] - expectedRgb[2]) <= 40
        ) {
          matches[pixelIndex] = 1;
          markerPixelCount += 1;
        }
      }

      // Filled point symbols have a 3x3 interior; the connecting 2px stroke
      // does not. Erode only connected line charts so a branch remains seven
      // separate click targets rather than one connected color component.
      const markerMatches = connectedLine ? new Uint8Array(matches.length) : matches;
      if (connectedLine) {
        for (let y = 1; y < element.height - 1; y += 1) {
          for (let x = 1; x < element.width - 1; x += 1) {
            let interior = true;
            for (let dy = -1; dy <= 1 && interior; dy += 1) {
              for (let dx = -1; dx <= 1; dx += 1) {
                if (!matches[(y + dy) * element.width + x + dx]) { interior = false; break; }
              }
            }
            if (interior) markerMatches[y * element.width + x] = 1;
          }
        }
      }
      const visited = new Uint8Array(matches.length);
      for (let seed = 0; seed < matches.length; seed += 1) {
        if (!markerMatches[seed] || visited[seed]) continue;
        const stack = [seed];
        visited[seed] = 1;
        let count = 0;
        let sumX = 0;
        let sumY = 0;
        let minX = element.width;
        let minY = element.height;
        let maxX = -1;
        let maxY = -1;
        while (stack.length > 0) {
          const current = stack.pop();
          const x = current % element.width;
          const y = Math.floor(current / element.width);
          count += 1;
          sumX += x;
          sumY += y;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
          for (let neighborY = Math.max(0, y - 1); neighborY <= Math.min(element.height - 1, y + 1); neighborY += 1) {
            for (let neighborX = Math.max(0, x - 1); neighborX <= Math.min(element.width - 1, x + 1); neighborX += 1) {
              const neighbor = neighborY * element.width + neighborX;
              if (markerMatches[neighbor] && !visited[neighbor]) {
                visited[neighbor] = 1;
                stack.push(neighbor);
              }
            }
          }
        }
        if (count < (connectedLine ? 1 : 2)) continue;
        markers.push({
          centerX: ((sumX / count) + 0.5) * rect.width / element.width,
          centerY: ((sumY / count) + 0.5) * rect.height / element.height,
          pixelCount: count,
          bounds: { minX, minY, maxX, maxY },
        });
      }
    }

    markers.sort((a, b) => a.centerX - b.centerX || a.centerY - b.centerY);
    const ariaLabel = host?.getAttribute('aria-label') ?? '';
    const unclippedByBody = Boolean(
      body && bodyRect && body.scrollHeight <= body.clientHeight + 1 &&
      rect.top >= bodyRect.top - 1 && rect.bottom <= bodyRect.bottom + 1,
    );
    const visibleInViewport = rect.width > 0 && rect.height > 0 &&
      rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight;
    return {
      ready: unclippedByBody && visibleInViewport && /data (?:is|are) as follows/i.test(ariaLabel) && markers.length > 0,
      ariaLabel,
      backingSize: { width: element.width, height: element.height },
      body: body ? { clientHeight: body.clientHeight, scrollHeight: body.scrollHeight } : null,
      canvasRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      expectedColor: color,
      markerPixelCount,
      markers,
      opaquePixelCount,
      unclippedByBody,
      visibleInViewport,
    };
  }, { color: expectedColor, connectedLine });
}

let selectedMode = null;
let chartPointSelectionMatches = false;
let chartPointClickEvidence = null;
let chosenSurface = null;
let chosenChartShape = null;

try {
  const cameraConfiguration = parseCameraConfiguration(process.env.FULLMAG_DISPERSION_CAMERA_JSON);
  report.ui.cameraConfiguration = cameraConfiguration
    ? { configured: true, applied: false, values: cameraConfiguration }
    : { configured: false, applied: false };
  if (cameraConfiguration) {
    report.expectedConditions.push('An explicitly supplied camera JSON is applied through the Camera Controls dialog before the final WebGL capture.');
  } else {
    addNote(exerciseFocus ? 'Camera framing will be exercised through Frame All and Inspector Focus.' : 'No explicit camera JSON was supplied; the verifier will preserve the current camera and will not run Fit.');
  }

  const playwrightEntry = pathToFileURL(
    join(dependencyWorkspace, 'apps/control-room/node_modules/playwright/index.mjs'),
  ).href;
  const { chromium } = await import(playwrightEntry);
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });

  page.on('pageerror', (error) => {
    const message = errorText(error);
    report.pageErrors.push(message);
    log('Page error', message);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') {
      const text = message.text();
      report.consoleErrors.push(text);
      log('Console error', text);
    }
  });
  page.on('request', (request) => {
    const path = pathnameOf(request.url());
    if (!path.startsWith('/v2/sessions/current/analysis/frequency-domain/') && path !== currentRunPath) return;
    const entry = {
      method: request.method(),
      url: request.url(),
      path,
      phase,
      time: Date.now(),
    };
    report.apiRequests.push(entry);
    log(`API request ${entry.method} ${path}`);
  });
  page.on('requestfailed', (request) => {
    const entry = {
      method: request.method(),
      url: request.url(),
      path: pathnameOf(request.url()),
      failure: request.failure()?.errorText ?? 'request failed',
      phase,
      time: Date.now(),
    };
    report.failedRequests.push(entry);
    log('Request failed', entry);
  });
  page.on('response', (response) => {
    const path = pathnameOf(response.url());
    if (!path.startsWith('/v2/')) return;
    const headers = response.headers();
    const isFieldVectorResponse = /\/data\/fields\/[^/]+\/samples\/vector$/.test(path);
    const entry = {
      method: response.request().method(),
      url: response.url(),
      path,
      status: response.status(),
      contentType: headers['content-type'] ?? null,
      ...(isFieldVectorResponse ? { binaryEvidence: vectorBinaryEvidenceFromHeaders(headers) } : {}),
      phase,
      optional: path.includes('/data/observation-frames'),
      time: Date.now(),
    };
    report.apiResponses.push(entry);
    log(`API ${entry.method} ${path} -> ${entry.status}${entry.optional ? ' (optional)' : ''}`);
    let task;
    task = captureResponse(response, entry).finally(() => pendingResponseCaptures.delete(task));
    pendingResponseCaptures.add(task);
  });

  phase = 'open-live-workspace';
  log('Opening the supplied live workspace URL; no file upload or fixture setup will be performed');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await page.locator('.fm-workspace-shell').waitFor({ state: 'visible', timeout: timeoutMs });
  await page.locator('[data-slot-id="panel-left"]').waitFor({ state: 'visible', timeout: timeoutMs });
  await saveScreenshot('00-initial.png');

  if (report.pageErrors.length > 0) {
    addCheck('workspace-startup-no-page-errors', false,
      'The live workspace raised uncaught page errors before Results could be verified.', report.pageErrors);
    addNote('Result owner/stage metadata and mode selection remain unverified because the product UI failed during startup.');
    throw new Error('Live workspace JavaScript failure blocked the Results and mode-verification path.');
  }

  phase = 'results-resources';
  const explorer = page.locator('[aria-label="Explorer"]');
  const resultsTab = explorer.getByRole('tab', { name: 'Results', exact: true });
  let resultsTabWaitError = null;
  try {
    await resultsTab.waitFor({ state: 'visible', timeout: timeoutMs });
  } catch (error) {
    resultsTabWaitError = errorText(error);
  }
  const hasExplorer = resultsTabWaitError === null && await explorer.count() > 0;
  report.ui.resultsHost = hasExplorer ? 'explorer' : 'unavailable-or-project-scoped';
  if (hasExplorer) {
    await resultsTab.click();
  } else {
    const savedPreviewVisible = await page.locator('[data-project-results-preview="unavailable"]').count() > 0;
    addCheck(
      'results-explorer-mounted',
      false,
      'The session Results tab did not become visible within the bounded hydration deadline; the verifier will not substitute a saved-project fixture.',
      { resultsTabWaitError, savedPreviewVisible },
    );
    addNote('Frequency-domain endpoints were not requested directly because the live Results tab did not hydrate; any saved-project preview remains diagnostic only.');
    throw new Error('The live workspace did not expose a hydrated session Results explorer.');
  }

  let manifestEvent = null;
  let spectrumEvent = null;
  let dispersionEvent = null;
  let currentRunEvent = null;
  const resultResourcesDeadlineAtMs = Date.now() + timeoutMs;
  const [manifestWait, spectrumWait, currentRunWait] = await Promise.allSettled([
    waitForApiPath(manifestPath, resultResourcesDeadlineAtMs),
    waitForApiPath(spectrumPath, resultResourcesDeadlineAtMs),
    waitForApiPath(currentRunPath, resultResourcesDeadlineAtMs),
  ]);
  if (manifestWait.status === 'fulfilled') {
    manifestEvent = manifestWait.value;
  } else {
    addCheck('manifest-response', false, 'The live frequency-domain manifest did not respond.', errorText(manifestWait.reason));
  }
  if (spectrumWait.status === 'fulfilled') {
    spectrumEvent = spectrumWait.value;
  } else {
    addCheck('spectrum-response', false, 'The live eigen spectrum resource did not respond.', errorText(spectrumWait.reason));
  }
  if (currentRunWait.status === 'fulfilled') {
    currentRunEvent = currentRunWait.value;
  } else {
    addCheck('current-run-response', false, 'The current-run owner resource did not respond.', errorText(currentRunWait.reason));
  }
  await flushResponseCaptures();

  const manifestJson = manifestEvent ? responseBodies.get(manifestEvent) : null;
  const resultManifest = isRecord(manifestJson?.result_manifest) ? manifestJson.result_manifest : null;
  const payload = isRecord(resultManifest?.payload) ? resultManifest.payload : null;
  const requested = isRecord(payload?.requested_execution) ? payload.requested_execution : {};
  const boundaryContext = stringValue(payload?.boundary_context) ?? stringValue(requested.boundary_context);
  const kSampling = payload?.k_sampling ?? requested.k_sampling ?? null;
  const payloadRunId = stringValue(payload?.run_id);
  const envelopeRunId = stringValue(resultManifest?.run_id);
  const payloadStageId = stringValue(payload?.stage_id);
  const envelopeStageId = stringValue(resultManifest?.stage_id);
  const currentRunSummary = currentRunEvent?.bodySummary ?? null;
  const currentRunId = stringValue(currentRunSummary?.runId);
  const runOwnerConsistent = !payloadRunId || !envelopeRunId || payloadRunId === envelopeRunId;
  const stageOwnerConsistent = !payloadStageId || !envelopeStageId || payloadStageId === envelopeStageId;
  const runId = payloadRunId ?? envelopeRunId;
  const stageId = payloadStageId ?? envelopeStageId;
  const currentRunOwnerConsistent = Boolean(currentRunEvent?.status === 200 && currentRunId && currentRunId === runId);
  const studyProduct = stringValue(payload?.study_product);
  const equilibriumIdentity = stringValue(payload?.equilibrium_identity ?? payload?.equilibrium_artifact_sha256);
  const sampleEquilibriumIdentityMap = parseSampleEquilibriumIdentityMap(
    payload, kSampling, equilibriumIdentity, boundaryContext,
  );
  const geometryIdentity = stringValue(payload?.geometry_identity);
  const meshIdentity = stringValue(payload?.mesh_identity) ?? stringValue(resultManifest?.mesh_generation_id);
  const surfaceSelection = classifyAnalysisSurface(boundaryContext, kSampling);
  chosenSurface = surfaceSelection.surface;
  chosenChartShape = surfaceSelection.chartShape;
  if (chosenChartShape === 'dispersion') {
    try {
      dispersionEvent = await waitForApiPath(dispersionPath, resultResourcesDeadlineAtMs);
    } catch (error) {
      addNote('The selected dispersion chart resource did not respond before the shared Results-resource deadline.', errorText(error));
    }
  } else {
    dispersionEvent = latestApiResponse(dispersionPath);
    if (chosenChartShape === 'modal-spectrum' && !dispersionEvent) {
      addNote('The fixed-k modal-spectrum view does not wait for the optional dispersion CSV; exact selected-mode and overlay identity checks remain required.');
    }
  }
  const manifestIdentityGaps = frequencyDomainProvenanceGaps({
    runId,
    stageId,
    payloadRunId,
    envelopeRunId,
    payloadStageId,
    envelopeStageId,
    currentRunId,
    equilibriumIdentity,
    sampleEquilibriumIdentityMap,
    studyProduct,
    boundaryContext,
    kSampling,
    geometryIdentity,
    meshIdentity,
  });
  const spectrumJson = spectrumEvent ? responseBodies.get(spectrumEvent) : null;
  const spectrumSummary = spectrumEvent?.bodySummary ?? summarizeSpectrum(spectrumJson);
  const spectrumOwnerConsistent = Boolean(runId && stageId &&
    spectrumSummary?.runId === runId && spectrumSummary?.stageId === stageId);
  const dispersionSummary = dispersionEvent?.bodySummary ?? null;
  const dispersionReady = dispersionEvent?.status === 200 && dispersionSummary?.status === 'ready' &&
    Number(dispersionSummary?.csvRows ?? 0) > 0;
  const spectrumReady = spectrumEvent?.status === 200 && spectrumSummary?.status === 'ready' &&
    Number(spectrumSummary?.modeCount ?? 0) > 0;
  report.dataQualification = {
    status: manifestIdentityGaps.length > 0 ? 'NOT_VERIFIED' : 'IDENTITY_PRESENT',
    reasons: manifestIdentityGaps,
    evidence: {
      runId,
      currentRunId,
      stageId,
      equilibriumIdentity,
      sampleEquilibriumIdentityStatus: sampleEquilibriumIdentityMap.status,
      sampleEquilibriumIds: sampleEquilibriumIdentityMap.bySample,
      geometryIdentity,
      meshIdentity,
    },
  };
  report.resultContext = {
    resultManifestStatus: resultManifest?.status ?? null,
    runId,
    stageId,
      payloadRunId,
      envelopeRunId,
      payloadStageId,
      envelopeStageId,
      runOwnerConsistent,
      stageOwnerConsistent,
    currentRun: currentRunSummary,
    currentRunOwnerConsistent,
    studyProduct,
    equilibriumIdentity,
    sampleEquilibriumIdentityStatus: sampleEquilibriumIdentityMap.status,
    sampleEquilibriumIds: sampleEquilibriumIdentityMap.bySample,
    geometryIdentity,
    meshIdentity,
    boundaryContext,
    kSampling,
    surfaceSelection,
    chosenChartShape,
    spectrum: spectrumSummary,
    dispersion: dispersionSummary,
    chosenSurface,
    actualImportOnly: true,
  };

  addCheck('manifest-ready', resultManifest?.status === 'ready',
    'The live frequency-domain result manifest is ready.', report.resultContext);
  addCheck('modal-eigen-study', studyProduct === 'modal_eigen',
    'The imported result publishes a modal eigen study.', { studyProduct });
  addCheck('run-owner-present', Boolean(runId),
    'The imported frequency artifact has a run owner.', { runId });
  addCheck('run-owner-consistent', runOwnerConsistent,
    'Payload and artifact envelope run identities agree when both are present.', { payloadRunId, envelopeRunId });
  addCheck('current-run-owner-consistent', currentRunOwnerConsistent,
    'The current session run matches the frequency artifact run owner.', { currentRunId, runId, currentRunEvent });
  addCheck('stage-owner-present', Boolean(stageId),
    'The imported frequency artifact has an explicit payload or envelope stage owner; no stage is inferred.', { stageId });
  addCheck('stage-owner-consistent', stageOwnerConsistent,
    'Payload and artifact envelope stage identities agree when both are present.', { payloadStageId, envelopeStageId });
  addCheck('k-sampling-surface-classified', surfaceSelection.supported,
    'The view was selected from a supported boundary and k-sampling contract; a single-k CSV does not imply a dispersion path.',
    surfaceSelection);
  if (manifestIdentityGaps.length === 1 && manifestIdentityGaps[0] === 'geometry identity unavailable') {
    addNote('Result data qualification is NOT_VERIFIED because geometry_identity is absent; run, stage, equilibrium, mesh, boundary, and k-sampling evidence are retained for the UI-only mode inspection.', report.dataQualification);
  }
  addCheck('spectrum-ready', spectrumReady,
    'The live eigen spectrum is ready and contains at least one mode.', spectrumSummary);
  addCheck('spectrum-owner-consistent', spectrumOwnerConsistent,
    'The spectrum resource run/stage owner matches the manifest owner.', {
      expectedRunId: runId,
      expectedStageId: stageId,
      actualRunId: spectrumSummary?.runId ?? null,
      actualStageId: spectrumSummary?.stageId ?? null,
    });
  if (chosenChartShape === 'dispersion') {
    addCheck('dispersion-resource-ready', dispersionReady,
      'The live dispersion resource is ready and contains CSV rows.', dispersionSummary);
  } else if (chosenChartShape === 'modal-spectrum' && dispersionEvent && !dispersionReady) {
    addNote('The optional dispersion CSV is unavailable; this route uses the independently ready modal spectrum.', dispersionSummary);
  }

  if (manifestEvent && manifestEvent.status >= 400) {
    addCheck('manifest-http-status', false, 'The required manifest endpoint returned an error.', manifestEvent);
  }
  if (spectrumEvent && spectrumEvent.status >= 400) {
    addCheck('spectrum-http-status', false, 'The required spectrum endpoint returned an error.', spectrumEvent);
  }
  if (chosenChartShape === 'dispersion' && dispersionEvent && dispersionEvent.status >= 400) {
    addCheck('dispersion-http-status', false, 'The chosen dispersion chart resource returned an error.', dispersionEvent);
  }

  const requiredOwnerContractReady = Boolean(
    resultManifest?.status === 'ready' &&
    manifestEvent?.status === 200 &&
    studyProduct === 'modal_eigen' &&
    runId && stageId &&
    runOwnerConsistent && stageOwnerConsistent && currentRunOwnerConsistent && surfaceSelection.supported &&
    spectrumEvent?.status === 200 && spectrumReady && spectrumOwnerConsistent &&
    (chosenChartShape !== 'dispersion' || dispersionReady),
  );
  if (!requiredOwnerContractReady) {
    phase = 'required-owner-contract-blocked';
    if (hasExplorer) {
      const rootRow = explorer.locator('[role="treeitem"][data-node-id^="results:run:"]').first();
      if (await rootRow.count() > 0) {
        const rootStatus = await rootRow.getAttribute('data-status');
        const rootText = await rootRow.innerText();
        const rootBadgeLocator = rootRow.locator('.fm-explorer-tree-row__badge');
        const rootBadge = await rootBadgeLocator.count() > 0
          ? await rootBadgeLocator.first().textContent({ timeout: 1_000 }).catch(() => null)
          : null;
        const rootTitle = await rootRow.getAttribute('title');
        const rootDescription = await rootRow.getAttribute('aria-description') ??
          await rootRow.getAttribute('data-description');
        const rootDetailText = `${rootText} ${rootBadge ?? ''} ${rootTitle ?? ''} ${rootDescription ?? ''}`;
        report.ui.resultsRoot = {
          status: rootStatus,
          text: rootText,
          badge: rootBadge,
          title: rootTitle,
          description: rootDescription,
          hasContractGap: rootStatus === 'failed' || /contract gap/i.test(rootDetailText),
          rootGapDetailsCompatible: visibleRootGapDetailsAreCompatible(rootTitle, rootDescription, rootText),
          manifestIdentityGaps,
        };
        if (report.ui.resultsRoot.hasContractGap) {
          addCheck('results-root-ready', false, 'The Results root reports a contract gap.', report.ui.resultsRoot);
        }
      }
    }
    addNote('Stopped before Analysis chart, mode row, and 3D waits because required manifest/spectrum owner identity failed. Optional observation-frame errors remain diagnostic only.');
    await saveScreenshot('01-required-owner-blocked.png');
    throw new Error('Required manifest/spectrum owner contract failed; downstream UI checks were not attempted.');
  }

  phase = 'analysis-view';
  let analysisMounted = false;
  const viewportTabs = page.getByRole('tablist', { name: 'Viewport surfaces' });
  if (await viewportTabs.count() > 0) {
    const analysisTab = viewportTabs.getByRole('tab', { name: 'Analysis', exact: true });
    if (await analysisTab.count() > 0) {
      await analysisTab.click();
      try {
        await page.locator('[data-slot-id="viewport-main"][data-active-module-id="analysis-plots"]')
          .waitFor({ state: 'visible', timeout: timeoutMs });
        analysisMounted = true;
      } catch (error) {
        addCheck('analysis-viewport-mounted', false, 'Selecting Analysis did not mount its viewport module.', errorText(error));
      }
    }
  }
  report.ui.analysisMounted = analysisMounted;
  if (!analysisMounted) {
    addCheck('analysis-viewport-mounted', false,
      'The current workspace does not expose the Analysis viewport; no alternate fixture route was used.');
  } else {
    const surfaceLabel = chosenSurface === 'dispersion' ? 'Dispersion' : 'Resonance & FMR';
    const subviewLabel = surfaceSelection.subviewLabel;
    const subviewId = surfaceSelection.subviewId;
    const surfaceTabs = page.getByRole('tablist', { name: 'Analysis workbench surfaces' });
    const surfaceTab = surfaceTabs.getByRole('tab', { name: surfaceLabel, exact: true });
    try {
      await surfaceTab.waitFor({ state: 'visible', timeout: timeoutMs });
      await surfaceTab.click();
      const subview = page.getByRole('combobox', { name: `${surfaceLabel} subview` });
      if (await subview.count() > 0) {
        await subview.waitFor({ state: 'visible', timeout: timeoutMs });
        const currentSubviewId = await subview.getAttribute('data-analysis-subview');
        if (currentSubviewId !== subviewId || !(await subview.innerText()).includes(subviewLabel)) {
          await subview.click();
          await page.getByRole('option', { name: subviewLabel, exact: true }).click();
        }
        await page.waitForFunction(({ expectedId, expectedLabel }) => {
          const trigger = document.querySelector('.fm-analysis-plots__subview');
          return trigger?.getAttribute('data-analysis-subview') === expectedId &&
            trigger.textContent?.trim() === expectedLabel;
        }, { expectedId: subviewId, expectedLabel: subviewLabel }, { timeout: timeoutMs });
      }
      const analysisSurface = chosenSurface;
      await page.locator(`[data-analysis-surface="${analysisSurface}"]`).waitFor({
        state: 'visible', timeout: timeoutMs,
      });
      const frequencyWorkbench = page.locator('[aria-label="Frequency-domain workbench"]');
      await frequencyWorkbench.waitFor({ state: 'visible', timeout: timeoutMs });
      const observedChartKind = (await frequencyWorkbench.locator('span').first().innerText()).trim();
      const chartShapeMatches = observedChartKind === surfaceSelection.expectedChartKind;
      addCheck('analysis-primary-chart-shape', chartShapeMatches,
        'The primary frequency chart matches the classification independently of its main Analysis surface.', {
          surface: chosenSurface,
          subviewId,
          subviewLabel,
          expectedChartShape: chosenChartShape,
          expectedChartKind: surfaceSelection.expectedChartKind,
          observedChartKind,
        });
      const observedSubviewId = await page.locator('.fm-analysis-plots__subview').getAttribute('data-analysis-subview');
      const observedSubviewLabel = (await page.locator('.fm-analysis-plots__subview').innerText()).trim();
      const routeMatches = observedSubviewId === subviewId && observedSubviewLabel === subviewLabel;
      addCheck('analysis-surface-subview-route', routeMatches,
        'The Analysis surface and persisted subview ID match the k-sampling route.', {
          surface: chosenSurface,
          subviewId,
          subviewLabel,
          observedSubviewId,
          observedSubviewLabel,
        });
      const chartCanvas = page.locator('.fm-analysis-plots__chart-frame canvas').first();
      await chartCanvas.waitFor({ state: 'visible', timeout: timeoutMs });
      await chartCanvas.scrollIntoViewIfNeeded();
      const legendItems = page.locator('.fm-chart-legend__item');
      const legendItem = chosenChartShape === 'dispersion'
        ? legendItems.filter({ hasText: /^(?:Branch|Raw modes)\b/ }).filter({ hasNotText: /analytic/i }).first()
        : legendItems.filter({ hasText: 'Eigen frequency' }).first();
      await legendItem.waitFor({ state: 'visible', timeout: timeoutMs });
      const legendColor = await legendItem.locator('.fm-chart-legend__swatch').evaluate((element) =>
        getComputedStyle(element).backgroundColor,
      );
      await page.waitForFunction((expectedColor) => {
        const canvas = document.querySelector('.fm-analysis-plots__chart-frame canvas');
        const body = canvas?.closest('.fm-chart-section__body');
        const host = canvas?.closest('.fm-analysis-plots__echarts');
        if (!(canvas instanceof HTMLCanvasElement) || !body || !host) return false;
        const rect = canvas.getBoundingClientRect();
        const bodyRect = body.getBoundingClientRect();
        const ariaLabel = host.getAttribute('aria-label') ?? '';
        if (
          body.scrollHeight > body.clientHeight + 1 ||
          rect.top < bodyRect.top - 1 || rect.bottom > bodyRect.bottom + 1 ||
          rect.left < 0 || rect.top < 0 || rect.right > innerWidth || rect.bottom > innerHeight ||
          !/data (?:is|are) as follows/i.test(ariaLabel)
        ) return false;
        const rgb = expectedColor.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number) ?? [];
        const expectedRgb = rgb.length === 3 && rgb.every((value) => value <= 1)
          ? rgb.map((value) => Math.round(value * 255))
          : rgb;
        const context = canvas.getContext('2d');
        if (!context || expectedRgb.length !== 3) return false;
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let pixelIndex = 0; pixelIndex < canvas.width * canvas.height; pixelIndex += 1) {
          const offset = pixelIndex * 4;
          if (
            pixels[offset + 3] >= 120 &&
            Math.abs(pixels[offset] - expectedRgb[0]) <= 40 &&
            Math.abs(pixels[offset + 1] - expectedRgb[1]) <= 40 &&
            Math.abs(pixels[offset + 2] - expectedRgb[2]) <= 40
          ) return true;
        }
        return false;
      }, legendColor, { timeout: timeoutMs });
      const chartPaintEvidence = await inspectFrequencyChartPaint(chartCanvas, legendColor, chosenChartShape === 'dispersion');
      const chartRect = await chartCanvas.boundingBox();
      const pointCountMatch = (await frequencyWorkbench.innerText()).match(/\b(\d+)\s+points?\b/i);
      const chartPointCount = pointCountMatch ? Number(pointCountMatch[1]) : null;
      report.ui.chartPointCount = chartPointCount;
      report.ui.chartPaintEvidence = chartPaintEvidence;
      addCheck('frequency-chart-rendered-and-unclipped', Boolean(
        chartRect && chartRect.width > 0 && chartRect.height > 0 &&
        chartPaintEvidence.ready && chartPointCount !== null && chartPointCount > 0,
      ),
        `The live ${chosenChartShape} chart is painted, contains an accessible point mark, and is not clipped inside its fixed-height plot body.`, {
          chartRect,
          chartPointCount,
          chartPaintEvidence,
          surface: chosenSurface,
          subviewId,
          subviewLabel,
          chartShape: chosenChartShape,
          workbenchText: await frequencyWorkbench.innerText(),
        });
      report.ui.analysisSurface = analysisSurface;
      report.ui.analysisSubview = { id: subviewId, label: subviewLabel };
      report.ui.chartShape = chosenChartShape;
      await saveScreenshot('01-analysis-view.png');
    } catch (error) {
      try {
        await page.keyboard.press('Escape');
        addNote('Sent Escape after the Analysis chart check failed to dismiss any lingering subview menu before Results diagnostics continue.');
      } catch (dismissError) {
        addNote('Could not dismiss a lingering Analysis subview menu; the chart failure remains recorded and Results diagnostics will continue.', errorText(dismissError));
      }
      addCheck('frequency-chart-rendered-and-unclipped', false,
        `The expected ${chosenSurface}/${subviewId} surface and ${chosenChartShape} chart did not become visible.`, errorText(error));
      await saveScreenshot('01-analysis-view-blocked.png');
    }
  }

  phase = 'results-mode-selection';
  if (hasExplorer) {
    const resultsTab = explorer.getByRole('tab', { name: 'Results', exact: true });
    await resultsTab.click();
    const expandAll = explorer.getByRole('button', { name: 'Expand all explorer nodes' });
    if (await expandAll.count() > 0) await expandAll.click();
    const rootRow = explorer.locator('[role="treeitem"][data-node-id^="results:run:"]').first();
    try {
      await rootRow.waitFor({ state: 'visible', timeout: timeoutMs });
      const rootStatus = await rootRow.getAttribute('data-status');
      const rootText = await rootRow.innerText();
      const rootBadge = await rootRow.locator('.fm-explorer-tree-row__badge').textContent().catch(() => null);
      const rootTitle = await rootRow.getAttribute('title');
      const rootDescription = await rootRow.getAttribute('aria-description') ??
        await rootRow.getAttribute('data-description');
      const rootDetailText = `${rootText} ${rootBadge ?? ''} ${rootTitle ?? ''} ${rootDescription ?? ''}`;
      const hasContractGap = rootStatus === 'failed' || /contract gap/i.test(rootDetailText);
      const geometryGapOnly = manifestIdentityGaps.length === 1 &&
        manifestIdentityGaps[0] === 'geometry identity unavailable';
      const geometryAdvisoryAllowed = geometryGapOnly && rootStatus === 'ready' &&
        resultManifest?.status === 'ready' && runOwnerConsistent && stageOwnerConsistent &&
        currentRunOwnerConsistent &&
        (equilibriumIdentity !== null || sampleEquilibriumIdentityMap.status === 'valid') &&
        meshIdentity !== null && studyProduct === 'modal_eigen' && surfaceSelection.supported &&
        spectrumReady && spectrumOwnerConsistent;
      const rootGapDetailsCompatible = visibleRootGapDetailsAreCompatible(rootTitle, rootDescription, rootText);
      const rootReady = rootStatus === 'ready' && rootGapDetailsCompatible &&
        (manifestIdentityGaps.length === 0 || geometryAdvisoryAllowed) &&
        (!hasContractGap || geometryAdvisoryAllowed);
      report.ui.resultsRoot = {
        status: rootStatus,
        text: rootText,
        badge: rootBadge,
        title: rootTitle,
        description: rootDescription,
        hasContractGap,
        rootGapDetailsCompatible,
        manifestIdentityGaps,
        geometryAdvisoryAllowed,
        ready: rootReady,
        advisory: geometryAdvisoryAllowed ? 'geometry identity unavailable; data qualification NOT_VERIFIED' : null,
      };
      addCheck('results-root-ready', rootReady,
        geometryAdvisoryAllowed
          ? 'The Results root is ready; the only remaining contract gap is the explicitly evidenced geometry identity advisory.'
          : 'The Results root is ready and any non-geometry contract gap is absent.',
        report.ui.resultsRoot);
      if (geometryAdvisoryAllowed) {
        addNote('Results entries remain inspectable with the geometry identity advisory; data qualification remains NOT_VERIFIED and no geometry identity was fabricated.', report.dataQualification);
      }
      await saveScreenshot('02-results-tree.png');

      if (rootReady && stageId) {
        const modeRows = explorer.locator('[role="treeitem"]').filter({ hasText: /Sample\s+\d+\s+·\s+Mode\s+\d+/ });
        const modeRow = requestedSampleIndex === null ? modeRows.first() : modeRows.filter({
          hasText: new RegExp(`Sample\\s+${requestedSampleIndex}\\s+·\\s+Mode\\s+\\d+`),
        }).first();
        await modeRow.waitFor({ state: 'visible', timeout: timeoutMs });
        selectedMode = (await modeRow.innerText()).trim();
        const selectedNodeId = await modeRow.getAttribute('data-node-id');
        const selectedModeMatch = selectedMode.match(/Sample\s+(\d+)\s+·\s+Mode\s+(\d+)/);
        if (!selectedModeMatch) {
          addCheck('mode-identity-parsed', false, 'The selected tree row did not expose sample and mode indices.', { selectedMode });
          throw new Error('The first real Results mode row did not expose sample and raw mode indices.');
        } else {
          const sampleIndex = Number(selectedModeMatch[1]);
          const modeIndex = Number(selectedModeMatch[2]);
          const selectedSampleEquilibriumIdentity = equilibriumIdentityForSample(
            equilibriumIdentity, sampleEquilibriumIdentityMap, sampleIndex,
          );
          report.ui.modeIndices = { sampleIndex, modeIndex, equilibriumIdentity: selectedSampleEquilibriumIdentity };
          const chartCanvas = page.locator('.fm-analysis-plots__chart-frame canvas').first();
          await chartCanvas.waitFor({ state: 'visible', timeout: timeoutMs });
          await chartCanvas.scrollIntoViewIfNeeded();
          const markers = report.ui.chartPaintEvidence?.markers ?? [];
          const modeRowOrdinal = await modeRows.evaluateAll((rows, nodeId) =>
            rows.findIndex((row) => row.getAttribute('data-node-id') === nodeId), selectedNodeId);
          const targetMarker = markers[modeRowOrdinal] ?? null;
          const chartRect = await chartCanvas.boundingBox();
          if (!targetMarker || !chartRect || report.ui.chartPointCount !== markers.length) {
            chartPointClickEvidence = {
              chartPointCount: report.ui.chartPointCount ?? null,
              markerCount: markers.length,
              modeIndex,
              targetMarker,
              chartRect,
            };
            report.ui.chartPointClick = chartPointClickEvidence;
            addCheck('chart-point-selects-exact-mode', false,
              'The visible chart did not expose a rendered marker for the selected Results mode index.',
              chartPointClickEvidence);
            await saveScreenshot('03-mode-chart-click-blocked.png');
            throw new Error('The visible frequency chart did not expose an unambiguous painted marker for the selected mode.');
          }
          const clickPoint = {
            x: chartRect.x + targetMarker.centerX,
            y: chartRect.y + targetMarker.centerY,
          };
          const inspector = page.locator('[data-inspector-surface="eigen-mode"]');
          try {
            phase = 'analysis-chart-point-selection';
            await page.mouse.click(clickPoint.x, clickPoint.y);
            await inspector.waitFor({ state: 'visible', timeout: timeoutMs });
            await page.waitForFunction(({ expectedSample, expectedMode }) => {
              const panel = document.querySelector('[data-inspector-surface="eigen-mode"]');
              const rows = [...(panel?.querySelectorAll('.fm-inspector-field-row') ?? [])];
              const row = rows.find((candidate) =>
                candidate.querySelector('.fm-inspector-field-row__label')?.textContent?.trim() === 'Mode identity',
              );
              const value = row?.querySelector('.fm-inspector-field-row__value')?.textContent?.trim() ?? '';
              return new RegExp(`sample\\s+${expectedSample}\\s*,\\s*mode\\s+${expectedMode}`, 'i').test(value);
            }, { expectedSample: sampleIndex, expectedMode: modeIndex }, { timeout: timeoutMs });
            const modeIdentityLabel = await readInspectorField(inspector, 'Mode identity');
            chartPointSelectionMatches = new RegExp(
              `sample\\s+${sampleIndex}\\s*,\\s*mode\\s+${modeIndex}`, 'i',
            ).test(modeIdentityLabel ?? '');
            chartPointClickEvidence = {
              chartPointCount: report.ui.chartPointCount,
              markerCount: markers.length,
              markerIndex: modeIndex,
              marker: targetMarker,
              clickPoint,
              canvasRect: chartRect,
              expected: { sampleIndex, modeIndex },
              observedModeIdentity: modeIdentityLabel,
              selected: chartPointSelectionMatches,
            };
            report.ui.chartPointClick = chartPointClickEvidence;
            if (!chartPointSelectionMatches) throw new Error('The chart marker selected a different mode than its corresponding Results row.');
            addCheck('chart-point-selects-exact-mode', true,
              'Clicking the painted Analysis chart marker selected the exact same sample and raw mode shown by the real Results row.',
              chartPointClickEvidence);
            report.ui.selectedModeRow = {
              text: selectedMode,
              nodeId: selectedNodeId,
              selectionSource: 'analysis-chart-point-click',
              equilibriumIdentity: selectedSampleEquilibriumIdentity,
            };
            addCheck('mode-inspector-open', true,
              'Clicking the real Analysis chart marker opened the eigen-mode Inspector.', report.ui.selectedModeRow);
            await saveScreenshot('03-mode-inspector.png');
          } catch (error) {
            chartPointSelectionMatches = false;
            addCheck('chart-point-selects-exact-mode', false,
              'The painted Analysis chart marker did not open the Inspector on the matching real mode.', {
                error: errorText(error),
                expected: { sampleIndex, modeIndex },
                observed: chartPointClickEvidence,
              });
            await saveScreenshot('03-mode-chart-click-blocked.png');
            throw error;
          }
          const modePath = `/v2/sessions/current/analysis/frequency-domain/eigen/modes/${sampleIndex}/${modeIndex}`;
          const modeFieldMetaPath = `/v2/sessions/current/analysis/frequency-domain/eigen/mode-field/${sampleIndex}/${modeIndex}/meta`;
          const expectedFieldId = `analysis:eigen:sample-${String(sampleIndex).padStart(4, '0')}:mode-${String(modeIndex).padStart(4, '0')}`;
          let modeEvent = null;
          let fieldMetaEvent = null;
          try {
            modeEvent = await waitForApiPath(modePath);
            addCheck('selected-mode-resource-ready', modeEvent?.status === 200 && modeEvent?.bodySummary?.status === 'ready',
              'The selected mode metadata resource is ready.', modeEvent?.bodySummary ?? modeEvent);
          } catch (error) {
            addCheck('selected-mode-resource-ready', false, 'The selected mode metadata resource did not respond.', errorText(error));
          }
          try {
            fieldMetaEvent = await waitForApiPath(modeFieldMetaPath);
            addCheck('selected-mode-field-meta-ready', fieldMetaEvent?.status === 200 &&
              (fieldMetaEvent?.bodySummary?.status === 'ready' || fieldMetaEvent?.bodySummary?.status == null),
              'The selected mode field metadata resource is ready.', fieldMetaEvent?.bodySummary ?? fieldMetaEvent);
          } catch (error) {
            addCheck('selected-mode-field-meta-ready', false, 'The selected mode field metadata resource did not respond.', errorText(error));
          }
          const modeResource = modeEvent?.bodySummary ?? null;
          const fieldMetadata = fieldMetaEvent?.bodySummary ?? null;
          const fieldMetadataVectorIdentity = modeFieldVectorIdentity(fieldMetadata?.resourceKey);
          const fieldMetadataComplexArtifactMatches = /(?:^|\/)vector_xyz_complex(?:\/|$)/
            .test(fieldMetadata?.artifactPath ?? '');
          const modeFieldIdMatches = modeResource?.fieldId === expectedFieldId;
          const modeResourceEquilibriumIdentityMatches = Boolean(
            selectedSampleEquilibriumIdentity &&
            modeResource?.equilibriumArtifactSha256 === selectedSampleEquilibriumIdentity &&
            modeResource?.candidateIdentityEquilibriumArtifactSha256 === selectedSampleEquilibriumIdentity,
          );
          addCheck('selected-mode-equilibrium-identity-matches', modeResourceEquilibriumIdentityMatches,
            'The selected mode top-level and candidate equilibrium identities match the exact selected sample.', {
              expected: selectedSampleEquilibriumIdentity,
              observedTopLevel: modeResource?.equilibriumArtifactSha256 ?? null,
              observedCandidateIdentity: modeResource?.candidateIdentityEquilibriumArtifactSha256 ?? null,
              sampleIndex,
            });
          const modeResourceIdentityMatches = Boolean(
            modeEvent?.status === 200 && modeResource?.status === 'ready' &&
            modeResource?.runId === runId && modeResource?.stageId === stageId &&
            modeResource?.sampleIndex === sampleIndex && modeResource?.rawModeIndex === modeIndex &&
            modeResource?.requestedSampleIndex === sampleIndex && modeResource?.requestedRawModeIndex === modeIndex &&
            modeFieldIdMatches && modeResourceEquilibriumIdentityMatches,
          );
          addCheck('selected-mode-owner-identity-matches', modeResourceIdentityMatches,
            'The selected raw mode resource matches manifest run/stage ownership and the exact selected sample/mode indices.', {
              expected: { runId, stageId, sampleIndex, rawModeIndex: modeIndex, equilibriumArtifactSha256: selectedSampleEquilibriumIdentity },
              observed: modeResource,
              modeFieldIdMatches,
              modeResourceEquilibriumIdentityMatches,
              requestPath: modeEvent?.path ?? modePath,
            });
          const fieldMetadataIdentityMatches = Boolean(
            fieldMetaEvent?.status === 200 && fieldMetadata?.fieldId === expectedFieldId &&
            fieldMetadataVectorIdentity?.fieldId === expectedFieldId &&
            fieldMetadataVectorIdentity.view === 'phase_rotated_real' &&
            Number(fieldMetadataVectorIdentity.phaseRad) === 0 &&
            fieldMetadataComplexArtifactMatches,
          );
          addCheck('selected-mode-field-identity-matches', fieldMetadataIdentityMatches,
            'Mode-field metadata binds the selected field ID to a complex XYZ artifact and its phase-rotated-real default view.', {
              expected: { fieldId: expectedFieldId, artifactPath: 'vector_xyz_complex', view: 'phase_rotated_real', phaseRad: 0 },
              observed: fieldMetadata,
              vectorIdentity: fieldMetadataVectorIdentity,
              complexArtifactMatches: fieldMetadataComplexArtifactMatches,
              requestPath: fieldMetaEvent?.path ?? modeFieldMetaPath,
            });

          const plotButton = inspector.getByRole('button', {
            name: 'Plot selected eigen mode with phase-rotated real display', exact: true,
          });
          try {
            await plotButton.waitFor({ state: 'visible', timeout: timeoutMs });
            addCheck('mode-field-plot-enabled', await plotButton.isEnabled(),
              'The selected mode has complete identity and plot-ready field metadata.', {
                disabled: !(await plotButton.isEnabled()),
                title: await plotButton.getAttribute('title'),
              });
            if (await plotButton.isEnabled()) {
              phase = 'mode-3d-plot';
              const fieldRequestStartedAt = Date.now();
              await plotButton.click();
              await page.waitForFunction(() => {
                const button = document.querySelector('[data-inspector-surface="eigen-mode"] button[aria-label="Plot selected eigen mode with phase-rotated real display"]');
                return button?.getAttribute('aria-pressed') === 'true';
              }, null, { timeout: timeoutMs });
              const viewSelect = inspector.getByRole('combobox', { name: 'Eigen mode 3D view', exact: true });
              const componentSelect = inspector.getByRole('combobox', { name: 'Eigen mode field component', exact: true });
              await viewSelect.waitFor({ state: 'visible', timeout: timeoutMs });
              await componentSelect.waitFor({ state: 'visible', timeout: timeoutMs });
              const viewOptions = await viewSelect.locator('option').evaluateAll((options) =>
                options.map((option) => ({ value: option.value, label: option.textContent?.trim() ?? '' })),
              );
              const viewLabels = new Map(viewOptions.map(({ value, label }) => [value, label]));
              const actionLabelByView = {
                phase_rotated_real: 'Plot selected eigen mode with phase-rotated real display',
                real: 'Plot selected eigen mode real component',
                imag: 'Plot selected eigen mode imaginary component',
                abs: 'Plot selected eigen mode complex magnitude',
                phase: 'Plot selected eigen mode phase',
              };
              const modeActionGroup = inspector.locator('[aria-label="Selected eigen mode 3D visualization controls"]');
              async function switchModeView(viewValue, checkId) {
                const expectedLabel = viewLabels.get(viewValue);
                if (!expectedLabel) return false;
                await viewSelect.selectOption(viewValue);
                await page.waitForFunction(({ value, label, buttonLabel }) => {
                  const panel = document.querySelector('[data-inspector-surface="eigen-mode"]');
                  const select = panel?.querySelector('select[aria-label="Eigen mode 3D view"]');
                  const rows = [...(panel?.querySelectorAll('.fm-inspector-field-row') ?? [])];
                  const row = rows.find((candidate) =>
                    candidate.querySelector('.fm-inspector-field-row__label')?.textContent?.trim() === 'Current view',
                  );
                  const activeButton = [...(panel?.querySelectorAll('button') ?? [])].find(
                    (button) => button.getAttribute('aria-label') === buttonLabel,
                  );
                  return select?.value === value &&
                    row?.querySelector('.fm-inspector-field-row__value')?.textContent?.trim() === label &&
                    activeButton?.getAttribute('aria-pressed') === 'true';
                }, { value: viewValue, label: expectedLabel, buttonLabel: actionLabelByView[viewValue] }, { timeout: timeoutMs });
                const observedLabel = await readInspectorField(inspector, 'Current view');
                const button = modeActionGroup.getByRole('button', { name: actionLabelByView[viewValue], exact: true });
                const pressed = await button.getAttribute('aria-pressed');
                addCheck(checkId, observedLabel === expectedLabel && pressed === 'true',
                  `The Inspector activated the ${expectedLabel} view for the selected eigen mode.`,
                  { value: viewValue, expectedLabel, observedLabel, pressed });
                return observedLabel === expectedLabel && pressed === 'true';
              }

              const initialViewLabel = viewLabels.get('phase_rotated_real') ?? null;
              const initialViewButtonPressed = await plotButton.getAttribute('aria-pressed');
              const initialCurrentView = await readInspectorField(inspector, 'Current view');
              const phaseControls = inspector.locator('[aria-label="Eigen mode phase controls"]');
              const phaseOutput = phaseControls.locator('output[aria-label="Current eigen mode display phase"]');
              const phaseSlider = phaseControls.getByRole('slider', { name: 'Eigen mode display phase in degrees', exact: true });
              await phaseSlider.waitFor({ state: 'visible', timeout: timeoutMs });
              const phaseSliderEnabled = await phaseSlider.getAttribute('aria-disabled') !== 'true';
              const modeIdentityLabel = await readInspectorField(inspector, 'Mode identity');
              const visibleSampleId = await readInspectorField(inspector, 'Sample ID');
              const visibleModeId = await readInspectorField(inspector, 'Mode ID');
              const visibleFieldId = await readInspectorField(inspector, 'Field ID');
              const modeIdentityMatchesIndices = new RegExp(
                `sample\\s+${sampleIndex}\\s*,\\s*mode\\s+${modeIndex}`, 'i',
              ).test(modeIdentityLabel ?? '');
              const modeStableIdUnavailable = /^(not available|not selected|n\/a|—|-)?$/i.test(visibleModeId ?? '');
              const sampleStableIdUnavailable = /^(not available|not selected|n\/a|—|-)?$/i.test(visibleSampleId ?? '');
              const modeStableIdMatches = !modeResource?.modeId || modeStableIdUnavailable || visibleModeId === modeResource.modeId;
              const sampleStableIdMatches = !modeResource?.sampleId || sampleStableIdUnavailable || visibleSampleId === modeResource.sampleId;
              const selectedRowActive = await modeRow.getAttribute('aria-selected') === 'true';
              const activeOverlayIdentityMatches = Boolean(
                chartPointSelectionMatches && modeResourceIdentityMatches && fieldMetadataIdentityMatches &&
                modeIdentityMatchesIndices && modeStableIdMatches && sampleStableIdMatches &&
                visibleFieldId === expectedFieldId && initialCurrentView === initialViewLabel &&
                initialViewButtonPressed === 'true' && phaseSliderEnabled,
              );
              report.ui.activeOverlayIdentity = {
                expected: { runId, stageId, sampleIndex, rawModeIndex: modeIndex, fieldId: expectedFieldId },
                observed: {
                  selectedRow: report.ui.selectedModeRow,
                  selectedRowActive,
                  chartPointSelectionMatches,
                  modeResource,
                  fieldMetadata,
                  modeIdentityLabel,
                  visibleSampleId,
                  visibleModeId,
                  visibleFieldId,
                  currentView: initialCurrentView,
                  plotButtonPressed: initialViewButtonPressed,
                  phaseSliderEnabled,
                },
              };
              addCheck('active-overlay-identity-matches-selected-mode', activeOverlayIdentityMatches,
                'The active Inspector overlay is bound to the selected run/stage/sample/raw mode and matching field resource.',
                report.ui.activeOverlayIdentity);

              let modeFieldVectorResponse = null;
              let complexFieldVectorMatches = false;
              try {
                modeFieldVectorResponse = await waitForModeFieldVector(expectedFieldId, 'complex', fieldRequestStartedAt);
                const vectorIdentity = modeFieldVectorIdentity(modeFieldVectorResponse?.url);
                const vectorStageMatches = !vectorIdentity?.stageId || vectorIdentity.stageId === stageId;
                complexFieldVectorMatches = Boolean(
                  modeFieldVectorResponse &&
                  complexModeFieldBinaryEvidenceMatches(modeFieldVectorResponse, expectedFieldId) &&
                  fieldMetadataIdentityMatches && vectorStageMatches,
                );
                report.ui.complexPhasorEvidence = {
                  selectedFieldId: expectedFieldId,
                  metadataArtifactPath: fieldMetadata?.artifactPath ?? null,
                  metadataDefaultResourceKey: fieldMetadata?.resourceKey ?? null,
                  request: modeFieldVectorResponse ? {
                    path: modeFieldVectorResponse.path,
                    url: modeFieldVectorResponse.url,
                    status: modeFieldVectorResponse.status,
                    contentType: modeFieldVectorResponse.contentType,
                    binary: modeFieldVectorResponse.binaryEvidence ?? null,
                  } : null,
                  observedVectorIdentity: vectorIdentity,
                  rendererDefaultView: initialCurrentView,
                };
                addCheck('mode-field-vector-matches-selected-mode', Boolean(
                  complexFieldVectorMatches && vectorIdentity?.fieldId === expectedFieldId &&
                  vectorIdentity.view === 'complex' && vectorIdentity.component === 'full' &&
                  vectorIdentity.phaseRad === null && initialCurrentView === initialViewLabel,
                ),
                'The viewport receives the selected field as a full complex FMVP vector while the Inspector shows its phase-rotated-real projection.', {
                  expected: {
                    fieldId: expectedFieldId,
                    resourceView: 'complex',
                    rendererView: 'phase_rotated_real',
                    phaseRadInResourceQuery: null,
                    component: 'full',
                    scopeKind: 'full',
                    componentsPerPoint: 6,
                    stageId,
                  },
                  observed: vectorIdentity,
                  metadataArtifactPath: fieldMetadata?.artifactPath ?? null,
                  binaryEvidence: modeFieldVectorResponse?.binaryEvidence ?? null,
                  rendererView: initialCurrentView,
                  vectorStageMatches,
                  response: modeFieldVectorResponse ? {
                    path: modeFieldVectorResponse.path,
                    url: modeFieldVectorResponse.url,
                    status: modeFieldVectorResponse.status,
                    contentType: modeFieldVectorResponse.contentType,
                  } : null,
                });
              } catch (error) {
                addCheck('mode-field-vector-matches-selected-mode', false,
                  'No successful FMVP complex-vector query with matching mode metadata was observed for the selected raw field.',
                  { error: errorText(error), expectedFieldId, view: 'complex', requiredComponentsPerPoint: 6 });
              }

              const complexViews = ['imag', 'abs'].filter((view) => viewLabels.has(view));
              report.ui.complexViewsAvailable = complexViews;
              if (complexViews.length === 0) {
                addNote('The selected field does not publish an imag or abs view; no unavailable complex view was fabricated.',
                  { availableViews: viewOptions.map(({ value }) => value) });
              }
              for (const view of complexViews) {
                await switchModeView(view, `mode-view-${view}`);
              }
              if (viewLabels.has('phase')) await switchModeView('phase', 'mode-view-phase');
              if (viewLabels.has('real')) await switchModeView('real', 'mode-view-real');
              const restoredRotatedView = viewLabels.has('phase_rotated_real')
                ? await switchModeView('phase_rotated_real', 'mode-view-phase-rotated-real-restored')
                : false;

              const componentOptions = await componentSelect.locator('option').evaluateAll((options) =>
                options.map((option) => ({ value: option.value, label: option.textContent?.trim() ?? '', disabled: option.disabled })),
              );
              const initialComponentValue = await componentSelect.inputValue();
              const initialComponentLabel = await readInspectorField(inspector, 'Current component');
              const alternateComponent = componentOptions.find((option) => !option.disabled && option.value !== initialComponentValue);
              if (alternateComponent) {
                await componentSelect.selectOption(alternateComponent.value);
                await page.waitForFunction(({ value, label }) => {
                  const panel = document.querySelector('[data-inspector-surface="eigen-mode"]');
                  const select = panel?.querySelector('select[aria-label="Eigen mode field component"]');
                  const rows = [...(panel?.querySelectorAll('.fm-inspector-field-row') ?? [])];
                  const row = rows.find((candidate) =>
                    candidate.querySelector('.fm-inspector-field-row__label')?.textContent?.trim() === 'Current component',
                  );
                  return select?.value === value &&
                    row?.querySelector('.fm-inspector-field-row__value')?.textContent?.trim() === label;
                }, { value: alternateComponent.value, label: alternateComponent.label }, { timeout: timeoutMs });
                const changedComponentLabel = await readInspectorField(inspector, 'Current component');
                addCheck('mode-component-changed', changedComponentLabel === alternateComponent.label &&
                  alternateComponent.value !== initialComponentValue,
                'The active mode field switched to a different available component.', {
                  initial: { value: initialComponentValue, label: initialComponentLabel },
                  selected: alternateComponent,
                  observedLabel: changedComponentLabel,
                });
                await componentSelect.selectOption(initialComponentValue);
                await page.waitForFunction(({ value, label }) => {
                  const panel = document.querySelector('[data-inspector-surface="eigen-mode"]');
                  const select = panel?.querySelector('select[aria-label="Eigen mode field component"]');
                  const rows = [...(panel?.querySelectorAll('.fm-inspector-field-row') ?? [])];
                  const row = rows.find((candidate) =>
                    candidate.querySelector('.fm-inspector-field-row__label')?.textContent?.trim() === 'Current component',
                  );
                  return select?.value === value &&
                    row?.querySelector('.fm-inspector-field-row__value')?.textContent?.trim() === label;
                }, { value: initialComponentValue, label: initialComponentLabel }, { timeout: timeoutMs });
                addCheck('mode-component-restored', await readInspectorField(inspector, 'Current component') === initialComponentLabel,
                  'The original mode field component was restored.', { value: initialComponentValue, label: initialComponentLabel });
              } else {
                addCheck('mode-component-changed', false,
                  'The selected mode field exposes no alternative component to exercise.', { componentOptions });
              }

              const phaseBeforeInput = Number((await phaseOutput.innerText()).trim());
              await phaseSlider.focus();
              await phaseSlider.press(phaseBeforeInput >= 360 ? 'ArrowLeft' : 'ArrowRight');
              await page.waitForFunction((previousPhase) => {
                const value = Number(document.querySelector('[data-inspector-surface="eigen-mode"] output[aria-label="Current eigen mode display phase"]')?.textContent?.trim());
                return Number.isFinite(value) && value !== previousPhase;
              }, phaseBeforeInput, { timeout: timeoutMs });
              const phaseAfterInput = Number((await phaseOutput.innerText()).trim());
              addCheck('mode-phase-changed', Number.isFinite(phaseAfterInput) && phaseAfterInput !== phaseBeforeInput,
                'The visible eigen-mode phase changed through its Inspector slider.', { before: phaseBeforeInput, after: phaseAfterInput });
              const resetPhaseButton = phaseControls.getByRole('button', { name: 'Reset eigen mode display phase to zero degrees', exact: true });
              await resetPhaseButton.click();
              await page.waitForFunction(() =>
                Number(document.querySelector('[data-inspector-surface="eigen-mode"] output[aria-label="Current eigen mode display phase"]')?.textContent?.trim()) === 0,
              null, { timeout: timeoutMs });

              const playButton = phaseControls.getByRole('button', { name: 'Play eigen mode phase animation', exact: true });
              const phaseBeforePlay = Number((await phaseOutput.innerText()).trim());
              addCheck('phase-animation-enabled', await playButton.count() > 0 && await playButton.isEnabled(),
                'The selected mode exposes an enabled phase-animation Play control.');
              if (await playButton.count() > 0 && await playButton.isEnabled()) {
                await playButton.click();
                await page.waitForFunction((previousPhase) => {
                  const panel = document.querySelector('[data-inspector-surface="eigen-mode"]');
                  const pause = panel?.querySelector('button[aria-label="Pause eigen mode phase animation"]');
                  const value = Number(panel?.querySelector('output[aria-label="Current eigen mode display phase"]')?.textContent?.trim());
                  return pause?.getAttribute('aria-pressed') === 'true' && Number.isFinite(value) && value !== previousPhase;
                }, phaseBeforePlay, { timeout: timeoutMs });
                const phaseWhilePlaying = Number((await phaseOutput.innerText()).trim());
                const pauseButton = phaseControls.getByRole('button', { name: 'Pause eigen mode phase animation', exact: true });
                await pauseButton.click();
                await page.waitForFunction(() => {
                  const button = document.querySelector('[data-inspector-surface="eigen-mode"] button[aria-label="Play eigen mode phase animation"]');
                  return button?.getAttribute('aria-pressed') === 'false';
                }, null, { timeout: timeoutMs });
                const phaseAtPause = Number((await phaseOutput.innerText()).trim());
                const animationRateHz = Number((await phaseControls.locator('output[aria-label="Visual phase cycle rate"]').innerText()).trim());
                const stableWindowMs = Number.isFinite(animationRateHz) && animationRateHz > 0
                  ? Math.max(300, Math.min(5_000, Math.ceil(1_500 / animationRateHz)))
                  : 500;
                await page.evaluate(() => {
                  globalThis.__fullmagPhasePauseProbe = null;
                });
                await page.waitForFunction((requiredStableWindowMs) => {
                  const panel = document.querySelector('[data-inspector-surface="eigen-mode"]');
                  const button = panel?.querySelector('button[aria-label="Play eigen mode phase animation"]');
                  const value = panel?.querySelector('output[aria-label="Current eigen mode display phase"]')?.textContent?.trim() ?? '';
                  const probe = globalThis.__fullmagPhasePauseProbe;
                  if (button?.getAttribute('aria-pressed') !== 'false') return false;
                  if (!probe || probe.value !== value) {
                    globalThis.__fullmagPhasePauseProbe = { value, unchangedSince: performance.now() };
                    return false;
                  }
                  return performance.now() - probe.unchangedSince >= requiredStableWindowMs;
                }, stableWindowMs, { timeout: Math.max(10_000, stableWindowMs + 5_000) });
                const stablePhaseAfterPause = Number((await phaseOutput.innerText()).trim());
                const pausedButtonPressed = await phaseControls.getByRole('button', { name: 'Play eigen mode phase animation', exact: true }).getAttribute('aria-pressed');
                addCheck('phase-animation-play-pause', phaseWhilePlaying !== phaseBeforePlay &&
                  Number.isFinite(stablePhaseAfterPause) && pausedButtonPressed === 'false',
                  'Play advanced the displayed phase and Pause held its visible value steady.', {
                    phaseBeforePlay,
                    phaseWhilePlaying,
                    phaseAtPause,
                    animationRateHz,
                    stablePhaseAfterPause,
                    pausedButtonPressed,
                    stableWindowMs,
                  });
              } else {
                addCheck('phase-animation-play-pause', false,
                  'The eigen-mode phase animation transport was missing or disabled.');
              }
              await resetPhaseButton.click();
              await page.waitForFunction(() =>
                Number(document.querySelector('[data-inspector-surface="eigen-mode"] output[aria-label="Current eigen mode display phase"]')?.textContent?.trim()) === 0,
              null, { timeout: timeoutMs });
              const finalCurrentView = await readInspectorField(inspector, 'Current view');
              const finalComponentValue = await componentSelect.inputValue();
              const finalPhase = Number((await phaseOutput.innerText()).trim());
              const finalViewButtonPressed = await plotButton.getAttribute('aria-pressed');
              addCheck('mode-real-phase-state-restored', restoredRotatedView && finalCurrentView === initialViewLabel &&
                finalComponentValue === initialComponentValue && finalPhase === 0 && finalViewButtonPressed === 'true',
              'The selected mode returned to phase-rotated real with its original component and zero phase.', {
                expectedView: initialViewLabel,
                finalCurrentView,
                initialComponentValue,
                finalComponentValue,
                finalPhase,
                phaseRotatedRealButtonPressed: finalViewButtonPressed,
              });
              const finalModeIdentityLabel = await readInspectorField(inspector, 'Mode identity');
              const stillSelected = chartPointSelectionMatches && new RegExp(
                `sample\\s+${sampleIndex}\\s*,\\s*mode\\s+${modeIndex}`, 'i',
              ).test(finalModeIdentityLabel ?? '');
              addCheck('active-overlay-identity-preserved', stillSelected && finalCurrentView === initialViewLabel &&
                finalComponentValue === initialComponentValue && finalPhase === 0,
              'The same selected sample/mode remains the active overlay after its view, component, and phase controls are exercised.', {
                selectedModeRow: report.ui.selectedModeRow,
                selectedRowActive: await modeRow.getAttribute('aria-selected') === 'true',
                chartPointSelectionMatches: stillSelected,
                finalModeIdentityLabel,
                expectedOwner: { runId, stageId, sampleIndex, rawModeIndex: modeIndex, fieldId: expectedFieldId },
                finalCurrentView,
                finalComponentValue,
                finalPhase,
              });
              report.ui.modeFieldVectorQueries = report.apiResponses
                .filter((entry) => entry.time >= fieldRequestStartedAt && /\/data\/fields\/[^/]+\/samples\/vector$/.test(entry.path))
                .map((entry) => ({
                  status: entry.status,
                  contentType: entry.contentType,
                  binaryEvidence: entry.binaryEvidence ?? null,
                  ...modeFieldVectorIdentity(entry.url),
                }));
              await saveScreenshot('04-mode-controls-restored.png');

              const viewport3d = page.locator('[data-slot-id="viewport-main"][data-active-module-id="viewport-3d"]');
              await viewport3d.waitFor({ state: 'visible', timeout: timeoutMs });
              if (exerciseFocus) {
                phase = 'camera-focus';
                const geometryTab = page.getByRole('tablist', { name: 'Ribbon tabs', exact: true })
                  .getByRole('tab', { name: 'Geometry', exact: true });
                await geometryTab.click();
                const frameAll = page.locator('button[data-action-id="builder-frame-all"]');
                await frameAll.waitFor({ state: 'visible', timeout: timeoutMs });
                await frameAll.click();
                const readDistance = async () => page.locator('.fm-viewport-3d').evaluate((element) => {
                  const tuple = (key) => String(element.getAttribute(key) ?? '').trim().split(/\s+/).map(Number);
                  const position = tuple('data-camera-position');
                  const target = tuple('data-camera-target');
                  return position.length === 3 && target.length === 3 && [...position, ...target].every(Number.isFinite)
                    ? Math.hypot(...position.map((value, i) => value - target[i])) : null;
                });
                await page.waitForTimeout(250);
                const sceneDistance = await readDistance();
                await page.locator('.fm-inspector__action-bar').getByRole('button', { name: 'Focus', exact: true }).click();
                await page.waitForFunction((before) => {
                  const element = document.querySelector('.fm-viewport-3d');
                  const tuple = (key) => String(element?.getAttribute(key) ?? '').trim().split(/\s+/).map(Number);
                  const p = tuple('data-camera-position'), t = tuple('data-camera-target');
                  const d = p.length === 3 && t.length === 3 ? Math.hypot(...p.map((v, i) => v - t[i])) : NaN;
                  return Number.isFinite(d) && d > 0 && Number.isFinite(before) && d < before / 2;
                }, sceneDistance, { timeout: timeoutMs });
                const focusDistance = await readDistance();
                report.ui.cameraFocus = { sceneDistanceM: sceneDistance, focusDistanceM: focusDistance };
                addCheck('inspector-focus-frames-magnetic-model', Boolean(sceneDistance && focusDistance && focusDistance < sceneDistance / 2),
                  'Frame All retains the full scene while explicit Inspector Focus frames the magnetic mode support without a hardcoded camera distance.', report.ui.cameraFocus);
              }
              if (cameraConfiguration) {
                phase = 'camera-controls';
                try {
                  report.ui.cameraConfiguration = await applyCameraConfigurationThroughUi(cameraConfiguration);
                  addCheck('camera-config-applied', true,
                    'The explicit meter-based camera configuration was applied through View > Camera > Camera parameters and matches the active viewport.',
                    report.ui.cameraConfiguration);
                } catch (error) {
                  report.ui.cameraConfiguration = {
                    configured: true,
                    applied: false,
                    values: cameraConfiguration,
                    error: errorText(error),
                  };
                  addCheck('camera-config-applied', false,
                    'The supplied camera configuration could not be applied or verified through Camera Controls.',
                    report.ui.cameraConfiguration);
                  await saveScreenshot('04-camera-controls-blocked.png');
                  throw error;
                }
              }
              const canvas = viewport3d.locator('canvas').first();
              await canvas.waitFor({ state: 'visible', timeout: timeoutMs });
              await page.waitForFunction(() => {
                const canvas = document.querySelector('[data-slot-id="viewport-main"][data-active-module-id="viewport-3d"] canvas');
                if (!(canvas instanceof HTMLCanvasElement)) return false;
                const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
                return Boolean(gl && !gl.isContextLost() && gl.drawingBufferWidth > 0 && gl.drawingBufferHeight > 0);
              }, null, { timeout: timeoutMs });
              const canvasMetrics = await inspectCanvas(canvas);
              report.ui.modeCanvas = canvasMetrics;
              const canvasReady = canvasMetrics.connected && canvasMetrics.visibleBox.width > 0 &&
                canvasMetrics.visibleBox.height > 0 && canvasMetrics.cssVisibility !== 'hidden' &&
                canvasMetrics.cssDisplay !== 'none' && Boolean(canvasMetrics.contextType) &&
                canvasMetrics.contextLost === false && canvasMetrics.drawingBufferWidth > 0 &&
                canvasMetrics.drawingBufferHeight > 0;
              addCheck('mode-webgl-canvas-ready', canvasReady,
                'The selected real mode is shown in a visible WebGL canvas with a live nonzero drawing buffer.', canvasMetrics);
              const complexPhasorRenderReady = Boolean(
                complexFieldVectorMatches && fieldMetadataIdentityMatches && activeOverlayIdentityMatches &&
                stillSelected && finalCurrentView === initialViewLabel && finalComponentValue === initialComponentValue &&
                finalPhase === 0 && canvasReady,
              );
              if (report.ui.complexPhasorEvidence) {
                report.ui.complexPhasorEvidence.renderedState = {
                  selectedRowActive: await modeRow.getAttribute('aria-selected') === 'true',
                  chartPointSelectionMatches: stillSelected,
                  currentView: finalCurrentView,
                  component: finalComponentValue,
                  phaseDegrees: finalPhase,
                  canvas: canvasMetrics,
                };
              }
              addCheck('complex-phasor-render-ready', complexPhasorRenderReady,
                'The selected complex XYZ FMVP field remains the active phase-rotated-real mode in a live WebGL viewport after view and phase controls are restored.', {
                  selectedFieldId: expectedFieldId,
                  binaryEvidence: modeFieldVectorResponse?.binaryEvidence ?? null,
                  metadataArtifactPath: fieldMetadata?.artifactPath ?? null,
                  currentView: finalCurrentView,
                  component: finalComponentValue,
                  phaseDegrees: finalPhase,
                  canvas: canvasMetrics,
                });
              await saveScreenshot('05-mode-webgl.png');
              await saveScreenshot('04-mode-3d.png');
            }
          } catch (error) {
            addCheck('mode-3d-plot', false, 'The selected mode did not activate in the 3D viewport.', errorText(error));
            await saveScreenshot('04-mode-3d-blocked.png');
          }
        }
      } else if (!stageId) {
        addCheck('mode-row-selectable', false,
          'Mode selection is blocked because both payload and artifact envelope omit stage_id; the verifier will not invent a stage.');
      } else {
        addCheck('mode-row-selectable', false,
          'Mode selection was not attempted because the Results root has a failed status, an unclassified contract gap, or an unsupported provenance gap.',
          report.ui.resultsRoot);
      }
    } catch (error) {
      addCheck('results-tree-ready', false,
        'The real Results tree did not expose a run-scoped result root or selectable mode row.', errorText(error));
      await saveScreenshot('02-results-tree-blocked.png');
    }
  }

  if (report.pageErrors.length > 0) {
    addCheck('page-errors', false, 'The browser reported uncaught page errors.', report.pageErrors);
  } else {
    addCheck('page-errors', true, 'The browser reported no uncaught page errors.');
  }

  if (report.blockers.length > 0) await saveScreenshot('99-failure.png');
} catch (error) {
  addCheck('verifier-execution', false, 'The browser verifier could not complete its planned steps.', errorText(error));
  await saveScreenshot('99-failure.png');
} finally {
  await flushResponseCaptures();
  if (browser) {
    try {
      await browser.close();
    } catch (error) {
      addCheck('browser-close', false, 'The browser did not close cleanly.', errorText(error));
    }
  }
  report.finishedAt = new Date().toISOString();
  report.state = report.blockers.length === 0 ? 'passed' : 'blocked';
  report.exitCode = report.blockers.length === 0 ? 0 : 1;
  try {
    await writeFile(join(output, 'verification.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await writeFile(join(output, 'browser.log'), `${logLines.join('\n')}\n`, 'utf8');
  } catch (error) {
    console.error(`Could not write browser evidence to ${output}: ${errorText(error)}`);
    report.state = 'failed-to-save-evidence';
    report.exitCode = 1;
  }
}

console.log(JSON.stringify({
  state: report.state,
  exitCode: report.exitCode,
  output,
  selectedMode,
  chosenSurface,
  chosenChartShape,
  dataQualification: report.dataQualification,
  blockers: report.blockers,
  screenshots: report.screenshots,
}, null, 2));
process.exitCode = report.exitCode;
