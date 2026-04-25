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
} from "../../contracts";
import type { LiveSessionClient, RequestOptions } from "../LiveSessionClient";
import { sessionApiPaths } from "../sessionPaths";

const SESSION_PERSISTENCE_TIMEOUT_MS = 120_000;

export class SessionModule {
  constructor(private client: LiveSessionClient) {}

  async export(
    request: SessionExportRequest,
    opts?: RequestOptions,
  ): Promise<SessionExportResponse> {
    return this.client.post<SessionExportResponse>(
      sessionApiPaths.persistence.exports,
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
      sessionApiPaths.persistence.importInspections,
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
      sessionApiPaths.persistence.imports,
      request,
      {
        ...opts,
        timeout: opts?.timeout ?? SESSION_PERSISTENCE_TIMEOUT_MS,
      },
    );
  }

  async listCheckpoints(opts?: RequestOptions): Promise<CheckpointListResponse> {
    return this.client.get<CheckpointListResponse>(
      sessionApiPaths.persistence.checkpoints,
      opts,
    );
  }

  async listRecovery(opts?: RequestOptions): Promise<RecoveryListResponse> {
    return this.client.get<RecoveryListResponse>(
      sessionApiPaths.persistence.recovery,
      opts,
    );
  }

  async clearRecovery(opts?: RequestOptions): Promise<RecoveryClearResponse> {
    return this.client.delete<RecoveryClearResponse>(sessionApiPaths.persistence.recovery, opts);
  }
}
