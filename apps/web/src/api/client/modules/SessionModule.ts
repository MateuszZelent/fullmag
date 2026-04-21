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
} from "../../generated/openapi-types";
import type { LiveApiClient, RequestOptions } from "../LiveApiClient";

const SESSION_PERSISTENCE_TIMEOUT_MS = 120_000;

export class SessionModule {
  constructor(private client: LiveApiClient) {}

  async export(
    request: SessionExportRequest,
    opts?: RequestOptions,
  ): Promise<SessionExportResponse> {
    return this.client.post<SessionExportResponse>(
      "/v1/live/current/session/export",
      request,
      {
        ...opts,
        timeout: opts?.timeout ?? SESSION_PERSISTENCE_TIMEOUT_MS,
      },
    );
  }

  async inspectImport(
    request: SessionImportInspectRequest,
    opts?: RequestOptions,
  ): Promise<SessionImportInspectResponse> {
    return this.client.post<SessionImportInspectResponse>(
      "/v1/live/current/session/import/inspect",
      request,
      {
        ...opts,
        timeout: opts?.timeout ?? SESSION_PERSISTENCE_TIMEOUT_MS,
      },
    );
  }

  async commitImport(
    request: SessionImportCommitRequest,
    opts?: RequestOptions,
  ): Promise<SessionImportCommitResponse> {
    return this.client.post<SessionImportCommitResponse>(
      "/v1/live/current/session/import/commit",
      request,
      {
        ...opts,
        timeout: opts?.timeout ?? SESSION_PERSISTENCE_TIMEOUT_MS,
      },
    );
  }

  async listCheckpoints(opts?: RequestOptions): Promise<CheckpointListResponse> {
    return this.client.get<CheckpointListResponse>(
      "/v1/live/current/session/checkpoints",
      opts,
    );
  }

  async listRecovery(opts?: RequestOptions): Promise<RecoveryListResponse> {
    return this.client.get<RecoveryListResponse>(
      "/v1/live/current/session/recovery",
      opts,
    );
  }

  async clearRecovery(opts?: RequestOptions): Promise<RecoveryClearResponse> {
    return this.client.post<RecoveryClearResponse>(
      "/v1/live/current/session/recovery/clear",
      {},
      opts,
    );
  }
}
