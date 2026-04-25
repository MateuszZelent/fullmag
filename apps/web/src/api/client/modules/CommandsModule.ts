import type {
  CommandDetail,
  CommandRequest,
  CommandResponse,
  CommandQueueStatus,
} from "../../types";
import type { LiveSessionClient, RequestOptions } from "../LiveSessionClient";
import { sessionApiPaths } from "../sessionPaths";

export class CommandsModule {
  constructor(private client: LiveSessionClient) {}

  async submit(
    request: CommandRequest,
    options?: RequestOptions,
  ): Promise<CommandResponse> {
    return this.client.post<CommandResponse>(
      sessionApiPaths.simulation.commands,
      request,
      options,
    );
  }

  async status(options?: RequestOptions): Promise<CommandQueueStatus> {
    return this.client.get<CommandQueueStatus>(sessionApiPaths.simulation.commands, options);
  }

  async get(commandId: string, options?: RequestOptions): Promise<CommandDetail> {
    return this.client.get<CommandDetail>(sessionApiPaths.simulation.command(commandId), options);
  }
}
