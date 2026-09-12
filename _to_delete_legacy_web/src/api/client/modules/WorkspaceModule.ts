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
import type { LiveSessionClient, RequestOptions } from "../LiveSessionClient";
import { sessionApiPaths } from "../sessionPaths";

export class WorkspaceModule {
  constructor(private client: LiveSessionClient) {}

  async getSelection(opts?: RequestOptions): Promise<WorkspaceSelectionResource> {
    return this.client.get<WorkspaceSelectionResource>(
      sessionApiPaths.workspace.selection,
      opts,
    );
  }

  async replaceSelection(
    request: WorkspaceSelectionReplaceRequest,
    opts?: RequestOptions,
  ): Promise<WorkspaceSelectionResource> {
    return this.client.put<WorkspaceSelectionResource>(
      sessionApiPaths.workspace.selection,
      request,
      opts,
    );
  }

  async getActiveNode(opts?: RequestOptions): Promise<WorkspaceActiveNodeResource> {
    return this.client.get<WorkspaceActiveNodeResource>(
      sessionApiPaths.workspace.activeNode,
      opts,
    );
  }

  async replaceActiveNode(
    request: WorkspaceActiveNodeReplaceRequest,
    opts?: RequestOptions,
  ): Promise<WorkspaceActiveNodeResource> {
    return this.client.put<WorkspaceActiveNodeResource>(
      sessionApiPaths.workspace.activeNode,
      request,
      opts,
    );
  }

  async getRibbon(opts?: RequestOptions): Promise<WorkspaceRibbonResource> {
    return this.client.get<WorkspaceRibbonResource>(
      sessionApiPaths.workspace.ribbon,
      opts,
    );
  }

  async replaceRibbon(
    request: WorkspaceRibbonReplaceRequest,
    opts?: RequestOptions,
  ): Promise<WorkspaceRibbonResource> {
    return this.client.put<WorkspaceRibbonResource>(
      sessionApiPaths.workspace.ribbon,
      request,
      opts,
    );
  }

  async getLayout(opts?: RequestOptions): Promise<WorkspaceLayoutResource> {
    return this.client.get<WorkspaceLayoutResource>(
      sessionApiPaths.workspace.layout,
      opts,
    );
  }

  async replaceLayout(
    request: WorkspaceLayoutReplaceRequest,
    opts?: RequestOptions,
  ): Promise<WorkspaceLayoutResource> {
    return this.client.put<WorkspaceLayoutResource>(
      sessionApiPaths.workspace.layout,
      request,
      opts,
    );
  }
}
