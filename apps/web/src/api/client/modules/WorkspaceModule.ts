import type {
  WorkspaceActiveNodeReplaceRequest,
  WorkspaceActiveNodeResource,
  WorkspaceLayoutReplaceRequest,
  WorkspaceLayoutResource,
  WorkspaceRibbonReplaceRequest,
  WorkspaceRibbonResource,
  WorkspaceSelectionReplaceRequest,
  WorkspaceSelectionResource,
} from "../../types";
import type { LiveApiClient, RequestOptions } from "../LiveApiClient";

export class WorkspaceModule {
  constructor(private client: LiveApiClient) {}

  async getSelection(opts?: RequestOptions): Promise<WorkspaceSelectionResource> {
    return this.client.get<WorkspaceSelectionResource>(
      "/v1/live/current/workspace/selection",
      opts,
    );
  }

  async replaceSelection(
    request: WorkspaceSelectionReplaceRequest,
    opts?: RequestOptions,
  ): Promise<WorkspaceSelectionResource> {
    return this.client.put<WorkspaceSelectionResource>(
      "/v1/live/current/workspace/selection",
      request,
      opts,
    );
  }

  async getActiveNode(opts?: RequestOptions): Promise<WorkspaceActiveNodeResource> {
    return this.client.get<WorkspaceActiveNodeResource>(
      "/v1/live/current/workspace/tree/active-node",
      opts,
    );
  }

  async replaceActiveNode(
    request: WorkspaceActiveNodeReplaceRequest,
    opts?: RequestOptions,
  ): Promise<WorkspaceActiveNodeResource> {
    return this.client.put<WorkspaceActiveNodeResource>(
      "/v1/live/current/workspace/tree/active-node",
      request,
      opts,
    );
  }

  async getRibbon(opts?: RequestOptions): Promise<WorkspaceRibbonResource> {
    return this.client.get<WorkspaceRibbonResource>(
      "/v1/live/current/workspace/ribbon",
      opts,
    );
  }

  async replaceRibbon(
    request: WorkspaceRibbonReplaceRequest,
    opts?: RequestOptions,
  ): Promise<WorkspaceRibbonResource> {
    return this.client.put<WorkspaceRibbonResource>(
      "/v1/live/current/workspace/ribbon",
      request,
      opts,
    );
  }

  async getLayout(opts?: RequestOptions): Promise<WorkspaceLayoutResource> {
    return this.client.get<WorkspaceLayoutResource>(
      "/v1/live/current/workspace/layout",
      opts,
    );
  }

  async replaceLayout(
    request: WorkspaceLayoutReplaceRequest,
    opts?: RequestOptions,
  ): Promise<WorkspaceLayoutResource> {
    return this.client.put<WorkspaceLayoutResource>(
      "/v1/live/current/workspace/layout",
      request,
      opts,
    );
  }
}
