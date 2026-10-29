import { useState } from "react";

export const ANTENNA_ETA_WINDOW_SIZE = 32;

export type AntennaEtaObservation = {
  identity: string;
  completed: number;
  total: number;
  elapsedSeconds: number;
};

type CompletionRecord = Pick<AntennaEtaObservation, "completed" | "elapsedSeconds">;

export type AntennaEtaHistory = Readonly<{
  identity: string | null;
  total: number;
  lastCompleted: number;
  lastElapsed: number;
  records: readonly CompletionRecord[];
}>;

const EMPTY_HISTORY: AntennaEtaHistory = Object.freeze({
  identity: null, total: 0, lastCompleted: 0, lastElapsed: 0, records: Object.freeze([]),
});

export type AntennaFieldEta =
  | { state: "inactive" | "estimating" | "complete"; seconds: null }
  | { state: "ready"; seconds: number };

function validObservation(value: AntennaEtaObservation | null): value is AntennaEtaObservation {
  return Boolean(value && value.identity.trim() &&
    Number.isSafeInteger(value.completed) && value.completed >= 0 &&
    Number.isSafeInteger(value.total) && value.total > 0 && value.completed <= value.total &&
    Number.isFinite(value.elapsedSeconds) && value.elapsedSeconds >= 0);
}

export function observeAntennaEta(
  history: AntennaEtaHistory,
  observation: AntennaEtaObservation | null,
): AntennaEtaHistory {
  if (!validObservation(observation)) return EMPTY_HISTORY;
  const record = { completed: observation.completed, elapsedSeconds: observation.elapsedSeconds };
  if (history.identity !== observation.identity || history.total !== observation.total ||
    observation.completed < history.lastCompleted || observation.elapsedSeconds < history.lastElapsed) {
    return {
      identity: observation.identity, total: observation.total,
      lastCompleted: observation.completed, lastElapsed: observation.elapsedSeconds,
      records: [record],
    };
  }
  if (observation.completed === history.lastCompleted && observation.elapsedSeconds === history.lastElapsed) return history;
  // Pulses update the elapsed denominator without filling the completion window.
  const records = observation.completed > history.lastCompleted
    ? [...history.records, record].slice(-ANTENNA_ETA_WINDOW_SIZE) : history.records;
  return { ...history, lastCompleted: observation.completed, lastElapsed: observation.elapsedSeconds, records };
}

export function estimateAntennaFieldEta(
  history: AntennaEtaHistory,
  observation: AntennaEtaObservation | null,
): AntennaFieldEta {
  if (!validObservation(observation) || history.identity !== observation.identity ||
    history.total !== observation.total) return { state: "inactive", seconds: null };
  if (observation.completed === observation.total) return { state: "complete", seconds: null };
  const baseline = history.records[0];
  if (!baseline) return { state: "estimating", seconds: null };
  const completed = observation.completed - baseline.completed;
  const elapsed = observation.elapsedSeconds - baseline.elapsedSeconds;
  if (completed < 3 || elapsed < 10) return { state: "estimating", seconds: null };
  const seconds = (observation.total - observation.completed) * elapsed / completed;
  return Number.isFinite(seconds) && seconds > 0 && seconds <= Number.MAX_SAFE_INTEGER
    ? { state: "ready", seconds } : { state: "estimating", seconds: null };
}

export function formatAntennaFieldEta(seconds: number): string {
  if (seconds < 60) return "~" + Math.ceil(seconds) + " s";
  const minutes = Math.ceil(seconds / 60);
  if (seconds < 3_600) return "~" + minutes + " min";
  const hours = Math.floor(minutes / 60);
  return "~" + hours + " h" + (minutes % 60 ? " " + minutes % 60 + " min" : "");
}

export function useAntennaFieldEta(observation: AntennaEtaObservation | null): AntennaFieldEta {
  const [history, setHistory] = useState<AntennaEtaHistory>(EMPTY_HISTORY);
  const nextHistory = observeAntennaEta(history, observation);
  // This bounded render-time adjustment records a new observation before commit.
  // Identical observations return the same immutable history and cannot loop.
  if (nextHistory !== history) setHistory(nextHistory);
  return estimateAntennaFieldEta(nextHistory, observation);
}
