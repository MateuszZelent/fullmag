import type { DisplaySelection } from "../../generated/openapi-types";
import type { DisplayPatchRequest, DisplayReplaceRequest } from "../../types";
import type { LiveApiClient, RequestOptions } from "../LiveApiClient";

export class DisplayModule {
  constructor(private client: LiveApiClient) {}

  async get(opts?: RequestOptions): Promise<DisplaySelection> {
    return this.client.get<DisplaySelection>(
      "/v1/live/current/display",
      opts,
    );
  }

  async replace(
    selection: DisplayReplaceRequest,
    opts?: RequestOptions,
  ): Promise<DisplaySelection> {
    return this.client.put<DisplaySelection>(
      "/v1/live/current/display",
      selection,
      opts,
    );
  }

  async patch(
    update: DisplayPatchRequest,
    opts?: RequestOptions,
  ): Promise<DisplaySelection> {
    return this.client.patch<DisplaySelection>(
      "/v1/live/current/display",
      update,
      opts,
    );
  }
}
