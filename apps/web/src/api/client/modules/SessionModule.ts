import type {
  CheckpointListResponse,
  RecoveryClearResponse,
  RecoveryListResponse,
  SessionExportRequest,
  SessionExportResponse,
  SessionImportCommitRequest,
  SessionImportCommitResponse,
  SessionImportInspectRequest,
  SessionImportInspectResponse,
} from "../../types";
import type { LiveApiClient } from "../LiveApiClient";

const SESSION_PERSISTENCE_TIMEOUT_MS = 120_000;

export class SessionModule {
  constructor(private client: LiveApiClient) {}

  async export(request: SessionExportRequest): Promise<SessionExportResponse> {
    return this.client.post<SessionExportResponse>(
      "/v1/live/current/session/export",
      request,
      { timeout: SESSION_PERSISTENCE_TIMEOUT_MS },
    );
  }

  async inspectImport(
    request: SessionImportInspectRequest,
  ): Promise<SessionImportInspectResponse> {
    return this.client.post<SessionImportInspectResponse>(
      "/v1/live/current/session/import/inspect",
      request,
      { timeout: SESSION_PERSISTENCE_TIMEOUT_MS },
    );
  }

  async commitImport(
    request: SessionImportCommitRequest,
  ): Promise<SessionImportCommitResponse> {
    return this.client.post<SessionImportCommitResponse>(
      "/v1/live/current/session/import/commit",
      request,
      { timeout: SESSION_PERSISTENCE_TIMEOUT_MS },
    );
  }

  async listCheckpoints(): Promise<CheckpointListResponse> {
    return this.client.get<CheckpointListResponse>(
      "/v1/live/current/session/checkpoints",
    );
  }

  async listRecovery(): Promise<RecoveryListResponse> {
    return this.client.get<RecoveryListResponse>(
      "/v1/live/current/session/recovery",
    );
  }

  async clearRecovery(): Promise<RecoveryClearResponse> {
    return this.client.post<RecoveryClearResponse>(
      "/v1/live/current/session/recovery/clear",
      {},
    );
  }
}
