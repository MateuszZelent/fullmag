import type { CommandResponse } from "../../types";
import type { LiveApiClient } from "../LiveApiClient";

export class CommandsModule {
  constructor(private client: LiveApiClient) {}

  async submit(
    command: string,
    params?: Record<string, unknown>,
  ): Promise<CommandResponse> {
    return this.client.post<CommandResponse>("/v1/live/current/commands", {
      command,
      params: params ?? {},
    });
  }
}
