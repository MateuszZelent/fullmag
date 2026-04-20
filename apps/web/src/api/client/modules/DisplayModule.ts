import type {
  DisplaySelection,
  DisplayUpdate,
} from "../../generated/openapi-types";
import type { LiveApiClient } from "../LiveApiClient";

export class DisplayModule {
  constructor(private client: LiveApiClient) {}

  async update(update: DisplayUpdate): Promise<DisplaySelection> {
    return this.client.patch<DisplaySelection>(
      "/v1/live/current/display",
      update,
    );
  }
}
