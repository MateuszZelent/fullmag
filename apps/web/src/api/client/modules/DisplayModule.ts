import type { DisplaySelection, DisplayUpdate } from "../../types";
import type { LiveApiClient } from "../LiveApiClient";

export class DisplayModule {
  constructor(private client: LiveApiClient) {}

  async update(update: DisplayUpdate): Promise<DisplaySelection> {
    return this.client.put<DisplaySelection>(
      "/v1/live/current/preview/selection",
      update,
    );
  }
}
