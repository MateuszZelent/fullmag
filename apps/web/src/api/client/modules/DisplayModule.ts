import type { DisplaySelection } from "../../contracts";
import type { DisplayPatchRequest, DisplayReplaceRequest } from "../../types";
import type { LiveSessionClient, RequestOptions } from "../LiveSessionClient";
import { sessionApiPaths } from "../sessionPaths";

export class DisplayModule {
  constructor(private client: LiveSessionClient) {}

  async get(opts?: RequestOptions): Promise<DisplaySelection> {
    return this.client.get<DisplaySelection>(
      sessionApiPaths.visualization.display,
      opts,
    );
  }

  async replace(
    selection: DisplayReplaceRequest,
    opts?: RequestOptions,
  ): Promise<DisplaySelection> {
    return this.client.put<DisplaySelection>(
      sessionApiPaths.visualization.display,
      selection,
      opts,
    );
  }

  async patch(
    update: DisplayPatchRequest,
    opts?: RequestOptions,
  ): Promise<DisplaySelection> {
    return this.client.patch<DisplaySelection>(
      sessionApiPaths.visualization.display,
      update,
      opts,
    );
  }
}
