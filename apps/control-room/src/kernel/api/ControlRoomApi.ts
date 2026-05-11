import {
  CONTROL_ROOM_CONTRACT_VERSION,
  SESSION_STATUS_PATH,
} from "./apiPaths";
import type { LiveStatusResource, RequestOptions } from "./apiTypes";

type FetchLike = typeof fetch;

interface ControlRoomApiOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
  requestIdFactory?: () => string;
}

export class ControlRoomApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ControlRoomApiError";
  }
}

function resolveBaseUrl(baseUrl: string | undefined): string {
  if (baseUrl !== undefined) {
    return baseUrl.replace(/\/$/, "");
  }

  if (typeof window !== "undefined") {
    return window.location.origin;
  }

  return "";
}

export class ControlRoomApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly requestIdFactory: () => string;

  readonly sessions = {
    current: {
      status: (options?: RequestOptions) =>
        this.requestJson<LiveStatusResource>(SESSION_STATUS_PATH, options),
    },
  };

  constructor({
    baseUrl,
    fetchImpl = fetch,
    requestIdFactory = () => crypto.randomUUID(),
  }: ControlRoomApiOptions = {}) {
    this.baseUrl = resolveBaseUrl(baseUrl);
    this.fetchImpl = fetchImpl;
    this.requestIdFactory = requestIdFactory;
  }

  private async requestJson<T>(
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: {
        "x-fullmag-contract-version": CONTROL_ROOM_CONTRACT_VERSION,
        "x-request-id": this.requestIdFactory(),
      },
      method: "GET",
      signal: options.signal,
    });

    if (!response.ok) {
      const message = await response.text();
      throw new ControlRoomApiError(
        message || `Request failed with status ${response.status}`,
        response.status,
      );
    }

    return (await response.json()) as T;
  }
}
