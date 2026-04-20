/**
 * Facade providing the legacy liveApiClient interface backed by the new API.
 * Used during migration so components that still call old methods work
 * transparently through the new LiveApiClient.
 */
import {
  getLiveApiClient,
  type LiveApiClient,
} from "../src/api/client/LiveApiClient";
import { legacyPreviewToDisplayUpdate } from "../src/api/client/modules/DisplayConsolidation";
import { adaptLegacyCommand } from "../src/api/client/modules/CommandAdapter";

export class LegacyApiFacade {
  private client: LiveApiClient;

  constructor() {
    this.client = getLiveApiClient();
  }

  /** Maps to GET /status (thin status, not full bootstrap) */
  async fetchBootstrap() {
    const status = await this.client.status.get();
    return this.statusToLegacyBootstrap(status);
  }

  /** Maps to GET /status (delta via revision comparison) */
  async fetchPoll(_opts: {
    sinceVersion?: number;
    scalarRowsTotal?: number;
  }) {
    const status = await this.client.status.get();
    return this.statusToLegacyBootstrap(status);
  }

  /** Maps to POST /commands */
  async queueCommand(payload: Record<string, unknown>) {
    const cmd = adaptLegacyCommand(payload);
    return this.client.commands.submit(
      cmd.kind,
      cmd.params as Record<string, unknown> | undefined,
    );
  }

  /** Maps to PUT /display */
  async updatePreview(path: string, payload?: Record<string, unknown>) {
    const update = legacyPreviewToDisplayUpdate(path, payload);
    return this.client.display.update(update);
  }

  /** Maps to PUT /display */
  async updateDisplaySelection(payload: Record<string, unknown>) {
    return this.client.display.update(payload as Parameters<typeof this.client.display.update>[0]);
  }

  /** Maps to GET /fields/catalog */
  async getFieldCatalog() {
    return this.client.fields.getCatalog();
  }

  /** Maps to GET /fields/{id}/vector */
  async getFieldVector(quantityId: string) {
    return this.client.fields.getVector(quantityId);
  }

  /** Maps to GET /fields/{id}/vector (binary) */
  async getFieldVectorBinary(quantityId: string) {
    return this.client.fields.getVector(quantityId);
  }

  /** Maps to GET /domain/topology */
  async getFemMeshTopologyBinary(_generationId?: number) {
    return this.client.domain.getTopology();
  }

  /** Maps to GET /fields/{id}/meta */
  async getFieldMeta(quantityId: string) {
    return this.client.fields.getMeta(quantityId);
  }

  /** Maps to GET /scalars */
  async fetchScalarsHistory() {
    return this.client.scalars.getWindow();
  }

  /** Maps to GET /gpu/telemetry */
  async fetchGpuTelemetry() {
    return this.client.gpu.getTelemetry();
  }

  /** Maps to GET /artifacts */
  async fetchArtifacts() {
    return this.client.artifacts.list();
  }

  /** Eigen endpoints */
  async fetchEigenSpectrum() {
    return this.client.eigen.getSpectrum();
  }
  async fetchEigenDispersion() {
    return this.client.eigen.getDispersion();
  }
  async fetchEigenBranches() {
    return this.client.eigen.getBranches();
  }
  async fetchEigenMode(index: number, sampleIndex: number) {
    return this.client.eigen.getMode({ index, sampleIndex });
  }

  /** Session operations */
  async exportState(format: string) {
    return this.client.session.export(format);
  }
  async syncScript() {
    return this.client.session.commit({});
  }

  /** Maps LiveStatus to the shape the old normalize pipeline expects. */
  private statusToLegacyBootstrap(status: import("../src/api/types").LiveStatus) {
    return {
      snapshot_version: status.field_revision ?? 0,
      session: {
        session_id: status.session_id,
      },
      run: status.run_id
        ? {
            run_id: status.run_id,
            stage_label: status.stage_label,
          }
        : null,
      live_state: {
        solver_steps: status.iteration ?? 0,
        solver_time: status.sim_time ?? 0,
        state: status.solver_state ?? "idle",
      },
      display_selection: status.display_selection,
      energies: status.energy_summary,
    };
  }
}

let _facade: LegacyApiFacade | null = null;
export function getLegacyApiFacade(): LegacyApiFacade {
  if (!_facade) _facade = new LegacyApiFacade();
  return _facade;
}
