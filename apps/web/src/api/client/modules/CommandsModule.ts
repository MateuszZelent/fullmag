import type {
  CommandRequest,
  CommandResponse,
} from "../../types";
import type { LiveApiClient, RequestOptions } from "../LiveApiClient";

export class CommandsModule {
  constructor(private client: LiveApiClient) {}

  async submit(
    request: CommandRequest,
    options?: RequestOptions,
  ): Promise<CommandResponse>;
  async submit(
    command: string,
    params?: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<CommandResponse>;
  async submit(
    requestOrCommand: CommandRequest | string,
    params?: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<CommandResponse> {
    const requestOptions =
      typeof requestOrCommand === "string"
        ? options
        : (params as RequestOptions | undefined);
    const body =
      typeof requestOrCommand === "string"
        ? {
            command: requestOrCommand,
            params: params ?? {},
          }
        : requestOrCommand;

    return this.client.post<CommandResponse>(
      "/v1/live/current/commands",
      body,
      requestOptions,
    );
  }
}
