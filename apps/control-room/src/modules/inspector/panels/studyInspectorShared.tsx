"use client";

import type { StageExecutionResource } from "@/kernel/api/apiTypes";
import type { ResourceResult } from "@/kernel/resources/resourceTypes";
import { type StudyStageDraft } from "./StudyStageAuthoringModel";
import { readStudyStageSource } from "@/shared/domain/study/studyStageSource";

export function clampIndex(index: number, drafts: readonly StudyStageDraft[]): number {
  if (drafts.length === 0) return 0;
  return Math.max(0, Math.min(index, drafts.length - 1));
}

export function rawStudyStages(scene: unknown): unknown[] {
  const sceneRecord = asRecord(scene);
  const study = asRecord(sceneRecord?.study);
  return readStudyStageSource(study).entries.map((entry) => entry.payload);
}

export function magneticObjectCount(scene: unknown): number {
  const objects = asRecord(scene)?.objects;
  if (!Array.isArray(objects)) return 0;
  return objects.filter((object) => asRecord(object)?.role === "magnet").length;
}

export function magneticObjectIds(scene: unknown): string[] {
  const objects = asRecord(scene)?.objects;
  if (!Array.isArray(objects)) return [];
  return objects
    .map((object) => asRecord(object))
    .filter((object) => object?.role === "magnet")
    .map((object) => (typeof object?.id === "string" ? object.id.trim() : ""))
    .filter(Boolean);
}

export function numericSceneRevision(value: number | string | null): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatGridVector(values: readonly number[]): string {
  return values.map((value) => value.toExponential(3)).join(" × ");
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export type StudyCommandRunner = (commandId: string, input?: unknown) => void;
export type StudyCommandDisabledReason = (commandId: string) => string | null;
export type StageExecutionResourceState = Pick<
  ResourceResult<StageExecutionResource | null>,
  "data" | "error" | "refreshError" | "status"
>;
