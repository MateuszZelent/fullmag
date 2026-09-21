/**
 * Analiza przebiegu live-refresh viewportu 3D (Faza 0 planu remediacji).
 *
 * Moduł jest czysty: nie dotyka przeglądarki, sieci ani zegara. Driver
 * (`smoke-viewport-3d-live-refresh.mjs`) zbiera próbki liczników z
 * `window.__FULLMAG_VISUALIZATION_DEBUG_PERFORMANCE__`, a te funkcje liczą
 * delty, składają podsumowanie i rozstrzygają bramki.
 *
 * Bramka, której licznika brakuje, kończy się statusem "unknown" — nigdy
 * "pass". To celowe: zielona bramka bez dowodu jest gorsza niż jej brak.
 */

export const LIVE_REFRESH_TRACE_SCHEMA_VERSION = 1;

const NUMERIC_COUNTER_KEYS = Object.freeze([
  "fieldDecodes",
  "fieldSwaps",
  "geometriesCreated",
  "geometriesDisposed",
  "gpuUploadBytes",
  "gpuUploads",
  "materialsCreated",
  "materialsDisposed",
  "topologyBuilds",
  "topologyUploads",
  "typedArrayCopiedBytes",
  "uploadTicketsAborted",
  "viewportFrames",
  "workerJobs",
]);

const REVISION_KEYS = Object.freeze([
  "requested",
  "received",
  "prepared",
  "displayed",
]);

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function reasonMap(value) {
  if (!value || typeof value !== "object") return {};
  const out = {};
  for (const [key, count] of Object.entries(value)) {
    if (typeof key === "string" && key.length > 0 && finite(count) > 0) {
      out[key] = finite(count);
    }
  }
  return out;
}

function diffReasonMaps(before, after) {
  const out = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const delta = finite(after[key]) - finite(before[key]);
    if (delta > 0) out[key] = delta;
  }
  return out;
}

function mergeReasonMaps(target, source) {
  for (const [key, count] of Object.entries(source)) {
    target[key] = finite(target[key]) + finite(count);
  }
  return target;
}

/** Normalizuje surową próbkę z przeglądarki do kształtu używanego dalej. */
export function normalizeLiveRefreshSample(sample) {
  const counters = sample?.counters ?? {};
  const numeric = {};
  for (const key of NUMERIC_COUNTER_KEYS) {
    numeric[key] = Object.hasOwn(counters, key) ? finite(counters[key]) : null;
  }
  const revisions = {};
  for (const key of REVISION_KEYS) {
    const raw = sample?.revisions?.[key];
    revisions[key] = raw === undefined || raw === null ? null : String(raw);
  }
  return {
    atMs: finite(sample?.atMs),
    counters: numeric,
    label: typeof sample?.label === "string" ? sample.label : null,
    retentionRejections: Object.hasOwn(counters, "retentionRejections")
      ? reasonMap(counters.retentionRejections)
      : null,
    revisions,
    viewportFrameReasons: reasonMap(counters.viewportFrameReasons),
  };
}

/** Różnica dwóch kolejnych znormalizowanych próbek. */
export function diffLiveRefreshSamples(previous, next) {
  const counters = {};
  for (const key of NUMERIC_COUNTER_KEYS) {
    const before = previous.counters[key];
    const after = next.counters[key];
    counters[key] = before === null || after === null ? null : after - before;
  }
  return {
    counters,
    durationMs: next.atMs - previous.atMs,
    retentionRejections:
      previous.retentionRejections === null || next.retentionRejections === null
        ? null
        : diffReasonMaps(previous.retentionRejections, next.retentionRejections),
    revisionChanged:
      previous.revisions.displayed !== next.revisions.displayed ||
      previous.revisions.prepared !== next.revisions.prepared,
    viewportFrameReasons: diffReasonMaps(
      previous.viewportFrameReasons,
      next.viewportFrameReasons,
    ),
  };
}

function revisionOrder(value) {
  if (value === null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * Składa podsumowanie całego przebiegu.
 * `warmupTicks` pomija początkowe próbki, w których pierwsza budowa sceny
 * legalnie tworzy materiały i geometrie.
 */
export function summarizeLiveRefreshTrace(rawSamples, options = {}) {
  const warmupTicks = Math.max(0, Math.floor(options.warmupTicks ?? 1));
  const samples = (rawSamples ?? []).map(normalizeLiveRefreshSample);
  const missingCounters = new Set();

  if (samples.length < 2) {
    return {
      durationMs: 0,
      missingCounters: [],
      revisionRegressions: [],
      blankAfterFirstDisplayTicks: [],
      retentionRejections: {},
      schemaVersion: LIVE_REFRESH_TRACE_SCHEMA_VERSION,
      stageResets: 0,
      ticks: Math.max(0, samples.length - 1),
      totals: {},
      uniqueDisplayedRevisions: 0,
      viewportFrameReasons: {},
      warmupTicks,
    };
  }

  const totals = {};
  for (const key of NUMERIC_COUNTER_KEYS) totals[key] = 0;
  const viewportFrameReasons = {};
  const retentionRejections = {};
  const revisionRegressions = [];
  const blankAfterFirstDisplayTicks = [];
  const displayedRevisions = new Set();

  // Stan startowy bierzemy z próbki 0 — inaczej pierwszy tick po już
  // wyświetlonej klatce nie zostałby rozpoznany jako zanik warstwy.
  const firstDisplayed = samples[0].revisions.displayed;
  let sawDisplayed = firstDisplayed !== null;
  let lastDisplayedOrder = revisionOrder(firstDisplayed);
  if (firstDisplayed !== null) displayedRevisions.add(firstDisplayed);

  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const next = samples[index];
    const delta = diffLiveRefreshSamples(previous, next);
    const counted = index > warmupTicks;

    for (const key of NUMERIC_COUNTER_KEYS) {
      if (delta.counters[key] === null) {
        missingCounters.add(key);
        continue;
      }
      if (counted) totals[key] += delta.counters[key];
    }
    if (delta.retentionRejections === null) {
      missingCounters.add("retentionRejections");
    } else if (counted) {
      mergeReasonMaps(retentionRejections, delta.retentionRejections);
    }
    if (counted) mergeReasonMaps(viewportFrameReasons, delta.viewportFrameReasons);

    const displayed = next.revisions.displayed;
    if (displayed !== null) {
      sawDisplayed = true;
      displayedRevisions.add(displayed);
      const order = revisionOrder(displayed);
      if (order !== null && lastDisplayedOrder !== null && order < lastDisplayedOrder) {
        revisionRegressions.push({
          from: previous.revisions.displayed,
          index,
          to: displayed,
        });
      }
      if (order !== null) lastDisplayedOrder = order;
    } else if (sawDisplayed && counted) {
      blankAfterFirstDisplayTicks.push({
        index,
        prepared: next.revisions.prepared,
        requested: next.revisions.requested,
      });
    }
  }

  return {
    blankAfterFirstDisplayTicks,
    durationMs: samples[samples.length - 1].atMs - samples[0].atMs,
    missingCounters: [...missingCounters].sort(),
    retentionRejections,
    revisionRegressions,
    schemaVersion: LIVE_REFRESH_TRACE_SCHEMA_VERSION,
    stageResets: finite(viewportFrameReasons["model-layer-stage-reset"]),
    ticks: samples.length - 1,
    totals,
    uniqueDisplayedRevisions: displayedRevisions.size,
    viewportFrameReasons,
    warmupTicks,
  };
}

export const DEFAULT_LIVE_REFRESH_GATES = Object.freeze({
  maxGeometriesCreated: 0,
  maxMaterialsCreated: 0,
  maxStageResets: 0,
  maxTopologyBuilds: 0,
  maxUploadTicketsAborted: 0,
});

/**
 * Twarde bramki poprawności z §7 masterplanu. Scenariusz zakłada stałą
 * topologię i stałą domenę — zmienia się wyłącznie wartość pola.
 */
export function evaluateLiveRefreshGates(summary, overrides = {}) {
  const limits = { ...DEFAULT_LIVE_REFRESH_GATES, ...overrides };
  const missing = new Set(summary.missingCounters ?? []);

  const counterGate = (id, name, counterKey, limit) => {
    if (missing.has(counterKey)) {
      return {
        actual: null,
        id,
        limit,
        name,
        reason: `brak licznika "${counterKey}" w probe — instrumentacja niekompletna`,
        status: "unknown",
      };
    }
    const actual = finite(summary.totals?.[counterKey]);
    return {
      actual,
      id,
      limit,
      name,
      reason: actual <= limit ? null : `${actual} > ${limit}`,
      status: actual <= limit ? "pass" : "fail",
    };
  };

  const gates = [
    {
      actual: summary.stageResets,
      id: "G1",
      limit: limits.maxStageResets,
      name: "brak resetu etapu przy samej zmianie wartości pola (LR-01)",
      reason:
        summary.stageResets <= limits.maxStageResets
          ? null
          : `${summary.stageResets} resetów etapu`,
      status:
        summary.stageResets <= limits.maxStageResets ? "pass" : "fail",
    },
    counterGate(
      "G2",
      "brak tworzenia materiałów przy zmianie wartości pola",
      "materialsCreated",
      limits.maxMaterialsCreated,
    ),
    counterGate(
      "G3",
      "brak tworzenia geometrii przy zmianie wartości pola",
      "geometriesCreated",
      limits.maxGeometriesCreated,
    ),
    counterGate(
      "G4",
      "brak przebudowy topologii przy zmianie wartości pola",
      "topologyBuilds",
      limits.maxTopologyBuilds,
    ),
    counterGate(
      "G5",
      "brak anulowanych ticketów uploadu (LR-05)",
      "uploadTicketsAborted",
      limits.maxUploadTicketsAborted,
    ),
    {
      actual: summary.revisionRegressions.length,
      id: "G6",
      limit: 0,
      name: "displayedRevision nigdy się nie cofa",
      reason:
        summary.revisionRegressions.length === 0
          ? null
          : `${summary.revisionRegressions.length} cofnięć`,
      status: summary.revisionRegressions.length === 0 ? "pass" : "fail",
    },
    {
      actual: summary.blankAfterFirstDisplayTicks.length,
      id: "G7",
      limit: 0,
      name: "zero klatek bez zgodnej warstwy po pierwszym wyświetleniu (LR-02/LR-03)",
      reason:
        summary.blankAfterFirstDisplayTicks.length === 0
          ? null
          : `${summary.blankAfterFirstDisplayTicks.length} pustych ticków`,
      status:
        summary.blankAfterFirstDisplayTicks.length === 0 ? "pass" : "fail",
    },
  ];

  const domainRejections =
    finite(summary.retentionRejections?.generation) +
    finite(summary.retentionRejections?.carrier);
  gates.push(
    missing.has("retentionRejections")
      ? {
          actual: null,
          id: "G8",
          limit: 0,
          name: "brak odrzuceń retencji z powodu domeny/nośnika (LR-04)",
          reason:
            'brak licznika "retentionRejections" w probe — instrumentacja niekompletna',
          status: "unknown",
        }
      : {
          actual: domainRejections,
          id: "G8",
          limit: 0,
          name: "brak odrzuceń retencji z powodu domeny/nośnika (LR-04)",
          reason: domainRejections === 0 ? null : `${domainRejections} odrzuceń`,
          status: domainRejections === 0 ? "pass" : "fail",
        },
  );

  return gates;
}

export function liveRefreshGatesOutcome(gates) {
  if (gates.some((gate) => gate.status === "fail")) return "fail";
  if (gates.some((gate) => gate.status === "unknown")) return "unknown";
  return "pass";
}

export function formatLiveRefreshReport(summary, gates) {
  const lines = [];
  lines.push(
    `Przebieg: ${summary.ticks} ticków, ${Math.round(summary.durationMs)} ms, ` +
      `${summary.uniqueDisplayedRevisions} odrębnych wyświetlonych rewizji ` +
      `(warmup: ${summary.warmupTicks} ticków pominięte).`,
  );
  for (const gate of gates) {
    const mark =
      gate.status === "pass" ? "PASS" : gate.status === "fail" ? "FAIL" : "UNKNOWN";
    const actual = gate.actual === null ? "n/d" : String(gate.actual);
    lines.push(
      `  [${mark}] ${gate.id} ${gate.name} — zmierzono ${actual}, limit ${gate.limit}` +
        (gate.reason ? ` (${gate.reason})` : ""),
    );
  }
  const reasons = Object.entries(summary.viewportFrameReasons).sort(
    ([left], [right]) => left.localeCompare(right),
  );
  if (reasons.length > 0) {
    lines.push("  Powody klatek:");
    for (const [reason, count] of reasons) lines.push(`    ${reason}: ${count}`);
  }
  if (summary.missingCounters.length > 0) {
    lines.push(`  Brakujące liczniki: ${summary.missingCounters.join(", ")}`);
  }
  return lines.join("\n");
}
