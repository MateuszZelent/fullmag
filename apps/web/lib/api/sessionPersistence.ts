/**
 * Session persistence API — save, load, inspect .fms files.
 *
 * Uses the newer api layer (apiGet / apiPost) and currentLiveUrl base.
 */

import { apiGet, apiPost } from './client';
import { currentLiveUrl } from './base';

// ── Types ────────────────────────────────────────────────────────────

export type SaveProfile = 'compact' | 'solved' | 'resume' | 'archive';
export type RestoreClass =
  | 'exact_resume'
  | 'logical_resume'
  | 'initial_condition_import'
  | 'config_only';

export interface SessionExportRequest {
  profile: SaveProfile;
  name?: string;
  compression?: 'speed' | 'balanced' | 'smallest';
  ui_state?: unknown;
}

export interface SessionExportResponse {
  session_id: string;
  profile: SaveProfile;
  fms_base64: string;
  size_bytes: number;
}

export interface SessionImportInspectRequest {
  fms_base64: string;
}

export interface CheckpointSummary {
  checkpoint_id: string;
  step: number;
  time_s: number;
  study_kind: string;
}

export interface SessionInspection {
  format_version: string;
  session_id: string;
  name: string;
  profile: SaveProfile;
  created_by_version: string;
  created_at: string;
  saved_at: string;
  run_count: number;
  latest_checkpoint: CheckpointSummary | null;
  restore_class: RestoreClass;
  warnings: string[];
  total_size_bytes: number;
}

export interface SessionImportInspectResponse {
  inspection: SessionInspection;
}

export interface SessionImportCommitRequest {
  fms_base64: string;
  restore_mode?: string;
}

export interface SessionImportCommitResponse {
  session_id: string;
  restore_class: RestoreClass;
  warnings: string[];
  ui_state?: unknown;
}

export interface CheckpointEntry {
  checkpoint_id: string;
  step: number;
  time_s: number;
  created_at: string;
}

export interface CheckpointListResponse {
  checkpoints: CheckpointEntry[];
}

export interface RecoveryEntry {
  session_id: string;
  name: string;
  saved_at: string;
  profile: SaveProfile;
}

export interface RecoveryListResponse {
  snapshots: RecoveryEntry[];
}

export interface RecoveryClearResponse {
  cleared: number;
}

// ── API calls ────────────────────────────────────────────────────────

const EXPORT_TIMEOUT_MS = 120_000; // large sessions may take time

export async function exportSession(
  req: SessionExportRequest,
): Promise<SessionExportResponse> {
  return apiPost<SessionExportResponse>(
    currentLiveUrl('/session/export'),
    req,
    EXPORT_TIMEOUT_MS,
  );
}

export async function inspectSession(
  req: SessionImportInspectRequest,
): Promise<SessionImportInspectResponse> {
  return apiPost<SessionImportInspectResponse>(
    currentLiveUrl('/session/import/inspect'),
    req,
    EXPORT_TIMEOUT_MS,
  );
}

export async function commitSessionImport(
  req: SessionImportCommitRequest,
): Promise<SessionImportCommitResponse> {
  return apiPost<SessionImportCommitResponse>(
    currentLiveUrl('/session/import/commit'),
    req,
    EXPORT_TIMEOUT_MS,
  );
}

export async function listCheckpoints(): Promise<CheckpointListResponse> {
  return apiGet<CheckpointListResponse>(currentLiveUrl('/checkpoints'));
}

export async function listRecovery(): Promise<RecoveryListResponse> {
  return apiGet<RecoveryListResponse>(currentLiveUrl('/recovery'));
}

export async function clearRecovery(): Promise<RecoveryClearResponse> {
  return apiPost<RecoveryClearResponse>(currentLiveUrl('/recovery/clear'), {});
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Convert a File object to base64 string for upload. */
export function fileToBase64(file: File): Promise<string> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("FileReader unavailable in this environment"));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip data URL prefix: "data:application/octet-stream;base64,..."
      const base64 = result.includes(',') ? result.split(',')[1] : result;
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Decode base64 and trigger browser download of an .fms file. */
export function downloadFmsFile(
  base64: string,
  filename: string,
): void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return;
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
