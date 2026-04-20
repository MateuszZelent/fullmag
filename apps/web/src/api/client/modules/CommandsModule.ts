import type {
  CommandRequest,
  CommandResponse,
} from "../../types";
import type { LiveApiClient } from "../LiveApiClient";

export class CommandsModule {
  constructor(private client: LiveApiClient) {}

  async submit(request: CommandRequest): Promise<CommandResponse>;
  async submit(
    command: string,
    params?: Record<string, unknown>,
  ): Promise<CommandResponse>;
  async submit(
    requestOrCommand: CommandRequest | string,
    params?: Record<string, unknown>,
  ): Promise<CommandResponse> {
    const body =
      typeof requestOrCommand === "string"
        ? {
            command: requestOrCommand,
            params: params ?? {},
          }
        : requestOrCommand;

    return this.client.post<CommandResponse>("/v1/live/current/commands", body);
  }
}
