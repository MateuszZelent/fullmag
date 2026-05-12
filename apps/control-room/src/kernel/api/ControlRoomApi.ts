import {
  API_CONTRACT_VERSION_HEADER,
  DATA_DOMAIN_META_PATH,
  DATA_DOMAIN_TOPOLOGY_PATH,
  DATA_FIELD_VECTOR_PATH,
  EXPECTED_API_CONTRACT_VERSION,
  MESHING_BUILDS_PATH,
  MESHING_BUILDS_CURRENT_PATH,
  MESHING_BUILDS_LATEST_SUCCESSFUL_PATH,
  MESHING_OBJECT_POLICY_PATH,
  MESHING_OBJECT_TOPOLOGY_PATH,
  MESHING_OBJECT_QUALITY_PATH,
  MESHING_OBJECT_REPORT_PATH,
  MESHING_OBJECT_SIZE_FIELD_PATH,
  MESHING_PART_TOPOLOGY_PATH,
  MESHING_SHARED_DOMAIN_MANIFEST_PATH,
  MESHING_SHARED_DOMAIN_TOPOLOGY_PATH,
  MESHING_UNIVERSE_POLICY_PATH,
  MODEL_GEOMETRY_CAPABILITIES_PATH,
  MODEL_GEOMETRY_DIAGNOSTIC_PATH,
  MODEL_GEOMETRY_DIAGNOSTICS_PATH,
  MODEL_GEOMETRY_REALIZATION_CURRENT_PATH,
  MODEL_GEOMETRY_REALIZATIONS_PATH,
  MODEL_GEOMETRY_VALIDATION_PATH,
  MODEL_MATERIAL_PATH,
  MODEL_OBJECT_GEOMETRY_PATH,
  MODEL_OBJECT_INTERACTION_PATH,
  MODEL_OBJECT_PATH,
  MODEL_OBJECTS_PATH,
  MODEL_REGION_PATH,
  MODEL_REGIONS_PATH,
  MODEL_SCENE_PATH,
  MODEL_TRANSACTIONS_PATH,
  MODEL_UNIVERSE_PATH,
  SESSION_STATUS_PATH,
  SIMULATION_COMMAND_DETAIL_PATH,
  SIMULATION_COMMANDS_PATH,
  VISUALIZATION_STATE_PATH,
} from "./apiPaths";
import type {
  BinaryRequestOptions,
  BinaryResourceResult,
  AuthoringTransactionRequest,
  AuthoringTransactionResponse,
  CommandDetailResource,
  CommandQueueStatusResource,
  CommandResponse,
  DomainMetaResource,
  FieldVectorQuery,
  GeometryCapabilitiesResource,
  GeometryDiagnosticsResource,
  GeometryRealizationRequest,
  GeometryRealizationResource,
  GeometryValidationResource,
  LiveStatusResource,
  MaterialPatchRequest,
  MaterialResource,
  MeshActiveBuildResource,
  MeshBuildHistoryResource,
  MeshLastSuccessfulBuildResource,
  MeshObjectConfigReplaceRequest,
  MeshObjectConfigResource,
  MeshObjectQualityResource,
  MeshObjectReportResource,
  MeshObjectSizeFieldResource,
  MeshSharedDomainManifestResource,
  MeshUniverseConfigReplaceRequest,
  MeshUniverseConfigResource,
  ObjectCreateRequest,
  ObjectGeometryPatchRequest,
  ObjectInteractionKind,
  ObjectInteractionPatchRequest,
  ObjectInteractionResource,
  ObjectPatchRequest,
  RegionListResource,
  RegionPatchRequest,
  RequestOptions,
  SceneResource,
  StructuredCommandRequest,
  UniversePatchRequest,
  UniverseResource,
  VisualizationStatePatch,
  VisualizationStateResource,
} from "./apiTypes";
import {
  decodeFieldVector,
  decodeTopology,
  type DecodedFieldVector,
  type DecodedTopology,
} from "./codecs";
import {
  createOpenApiV2Transport,
  type OpenApiV2Transport,
} from "./generated/openapi-v2-client";
import type { OpenApiV2Path } from "./generated/openapi-v2-paths";
import type { RequestDiagnosticsController } from "./RequestDiagnosticsController";

type FetchLike = typeof fetch;
type PathParams = Record<string, string | number>;
type QueryParams = Record<string, unknown>;

interface ControlRoomApiOptions {
  baseUrl?: string;
  diagnostics?: RequestDiagnosticsController;
  fetchImpl?: FetchLike;
  maxGetRetries?: number;
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

export class ControlRoomApi {
  private readonly baseUrl: string;
  private readonly diagnostics: RequestDiagnosticsController | null;
  private readonly fetchImpl: FetchLike;
  private readonly maxGetRetries: number;
  private readonly requestIdFactory: () => string;
  private readonly transport: OpenApiV2Transport;

  readonly sessions = {
    current: {
      status: (options?: RequestOptions) =>
        this.requestJson<LiveStatusResource>(SESSION_STATUS_PATH, options),
    },
  };

  readonly commands = {
    detail: (commandId: string, options?: RequestOptions) =>
      this.requestJson<CommandDetailResource>(
        SIMULATION_COMMAND_DETAIL_PATH,
        options,
        { path: { command_id: commandId } },
      ),
    list: (options?: RequestOptions) =>
      this.requestJson<CommandQueueStatusResource>(
        SIMULATION_COMMANDS_PATH,
        options,
      ),
    submit: (command: StructuredCommandRequest, options?: RequestOptions) =>
      this.postJson<CommandResponse, StructuredCommandRequest>(
        SIMULATION_COMMANDS_PATH,
        command,
        options,
      ),
  };

  readonly data = {
    domain: {
      meta: (options?: RequestOptions) =>
        this.requestJson<DomainMetaResource>(DATA_DOMAIN_META_PATH, options),
      topology: (options?: BinaryRequestOptions) =>
        this.requestTopology(DATA_DOMAIN_TOPOLOGY_PATH, options),
    },
    fields: {
      vector: (
        quantityId: string,
        query: FieldVectorQuery = {},
        options?: BinaryRequestOptions,
      ) =>
        this.requestFieldVector(
          DATA_FIELD_VECTOR_PATH,
          { quantity_id: quantityId },
          query,
          options,
        ),
    },
  };

  readonly meshing = {
    builds: {
      history: (options?: RequestOptions) =>
        this.requestJson<MeshBuildHistoryResource>(MESHING_BUILDS_PATH, options),
      current: (options?: RequestOptions) =>
        this.requestJson<MeshActiveBuildResource>(
          MESHING_BUILDS_CURRENT_PATH,
          options,
        ),
      latestSuccessful: (options?: RequestOptions) =>
        this.requestJson<MeshLastSuccessfulBuildResource>(
          MESHING_BUILDS_LATEST_SUCCESSFUL_PATH,
          options,
        ),
    },
    objectPolicy: (objectId: string, options?: RequestOptions) =>
      this.requestJson<MeshObjectConfigResource>(
        MESHING_OBJECT_POLICY_PATH,
        options,
        {
          path: { object_id: objectId },
        },
      ),
    objectQuality: (objectId: string, options?: RequestOptions) =>
      this.requestJson<MeshObjectQualityResource>(
        MESHING_OBJECT_QUALITY_PATH,
        options,
        {
          path: { object_id: objectId },
        },
      ),
    objectReport: (objectId: string, options?: RequestOptions) =>
      this.requestJson<MeshObjectReportResource>(
        MESHING_OBJECT_REPORT_PATH,
        options,
        {
          path: { object_id: objectId },
        },
      ),
    objectSizeField: (objectId: string, options?: RequestOptions) =>
      this.requestJson<MeshObjectSizeFieldResource>(
        MESHING_OBJECT_SIZE_FIELD_PATH,
        options,
        {
          path: { object_id: objectId },
        },
      ),
    objectTopology: (objectId: string, options?: BinaryRequestOptions) =>
      this.requestTopology(
        MESHING_OBJECT_TOPOLOGY_PATH,
        options,
        { object_id: objectId },
      ),
    partTopology: (partId: string, options?: BinaryRequestOptions) =>
      this.requestTopology(
        MESHING_PART_TOPOLOGY_PATH,
        options,
        { part_id: partId },
      ),
    replaceObjectPolicy: (
      objectId: string,
      request: MeshObjectConfigReplaceRequest,
      options?: RequestOptions,
    ) =>
      this.putJson<MeshObjectConfigResource, MeshObjectConfigReplaceRequest>(
        MESHING_OBJECT_POLICY_PATH,
        request,
        options,
        {
          path: { object_id: objectId },
        },
      ),
    sharedDomain: {
      manifest: (options?: RequestOptions) =>
        this.requestOptionalJson<MeshSharedDomainManifestResource>(
          MESHING_SHARED_DOMAIN_MANIFEST_PATH,
          options,
        ),
      topology: (options?: BinaryRequestOptions) =>
        this.requestTopology(MESHING_SHARED_DOMAIN_TOPOLOGY_PATH, options),
    },
    sharedDomainManifest: (options?: RequestOptions) =>
      this.requestOptionalJson<MeshSharedDomainManifestResource>(
        MESHING_SHARED_DOMAIN_MANIFEST_PATH,
        options,
      ),
    sharedDomainTopology: (options?: BinaryRequestOptions) =>
      this.requestTopology(MESHING_SHARED_DOMAIN_TOPOLOGY_PATH, options),
    universePolicy: (options?: RequestOptions) =>
      this.requestJson<MeshUniverseConfigResource>(
        MESHING_UNIVERSE_POLICY_PATH,
        options,
      ),
    replaceUniversePolicy: (
      request: MeshUniverseConfigReplaceRequest,
      options?: RequestOptions,
    ) =>
      this.putJson<MeshUniverseConfigResource, MeshUniverseConfigReplaceRequest>(
        MESHING_UNIVERSE_POLICY_PATH,
        request,
        options,
      ),
  };

  readonly model = {
    commitTransaction: (
      transaction: AuthoringTransactionRequest,
      options?: RequestOptions,
    ) =>
      this.postJson<AuthoringTransactionResponse, AuthoringTransactionRequest>(
        MODEL_TRANSACTIONS_PATH,
        transaction,
        options,
      ),
    createObject: (request: ObjectCreateRequest, options?: RequestOptions) =>
      this.postJson<SceneResource, ObjectCreateRequest>(
        MODEL_OBJECTS_PATH,
        request,
        options,
      ),
    deleteObject: (objectId: string, options?: RequestOptions) =>
      this.deleteJson<SceneResource>(MODEL_OBJECT_PATH, options, {
        path: { object_id: objectId },
      }),
    geometry: {
      capabilities: (options?: RequestOptions) =>
        this.requestJson<GeometryCapabilitiesResource>(
          MODEL_GEOMETRY_CAPABILITIES_PATH,
          options,
        ),
      diagnostic: (diagnosticId: string, options?: RequestOptions) =>
        this.requestJson<GeometryDiagnosticsResource>(
          MODEL_GEOMETRY_DIAGNOSTIC_PATH,
          options,
          { path: { diagnostic_id: diagnosticId } },
        ),
      diagnostics: (options?: RequestOptions) =>
        this.requestJson<GeometryDiagnosticsResource>(
          MODEL_GEOMETRY_DIAGNOSTICS_PATH,
          options,
        ),
      realization: (options?: RequestOptions) =>
        this.requestJson<GeometryRealizationResource>(
          MODEL_GEOMETRY_REALIZATION_CURRENT_PATH,
          options,
        ),
      realize: (request: GeometryRealizationRequest, options?: RequestOptions) =>
        this.postJson<GeometryRealizationResource, GeometryRealizationRequest>(
          MODEL_GEOMETRY_REALIZATIONS_PATH,
          request,
          options,
        ),
      validation: (options?: RequestOptions) =>
        this.requestJson<GeometryValidationResource>(
          MODEL_GEOMETRY_VALIDATION_PATH,
          options,
        ),
    },
    patchObject: (
      objectId: string,
      patch: ObjectPatchRequest,
      options?: RequestOptions,
    ) =>
      this.patchJson<SceneResource, ObjectPatchRequest>(
        MODEL_OBJECT_PATH,
        patch,
        options,
        { path: { object_id: objectId } },
      ),
    patchObjectGeometry: (
      objectId: string,
      patch: ObjectGeometryPatchRequest,
      options?: RequestOptions,
    ) =>
      this.patchJson<SceneResource, ObjectGeometryPatchRequest>(
        MODEL_OBJECT_GEOMETRY_PATH,
        patch,
        options,
        { path: { object_id: objectId } },
      ),
    objectInteraction: (
      objectId: string,
      interactionKind: ObjectInteractionKind,
      options?: RequestOptions,
    ) =>
      this.requestJson<ObjectInteractionResource>(
        MODEL_OBJECT_INTERACTION_PATH,
        options,
        { path: { object_id: objectId, interaction_kind: interactionKind } },
      ),
    patchObjectInteraction: (
      objectId: string,
      interactionKind: ObjectInteractionKind,
      patch: ObjectInteractionPatchRequest,
      options?: RequestOptions,
    ) =>
      this.patchJson<ObjectInteractionResource, ObjectInteractionPatchRequest>(
        MODEL_OBJECT_INTERACTION_PATH,
        patch,
        options,
        { path: { object_id: objectId, interaction_kind: interactionKind } },
      ),
    material: (materialId: string, options?: RequestOptions) =>
      this.requestJson<MaterialResource>(MODEL_MATERIAL_PATH, options, {
        path: { material_id: materialId },
      }),
    patchMaterial: (
      materialId: string,
      patch: MaterialPatchRequest,
      options?: RequestOptions,
    ) =>
      this.patchJson<MaterialResource, MaterialPatchRequest>(
        MODEL_MATERIAL_PATH,
        patch,
        options,
        { path: { material_id: materialId } },
      ),
    regions: (options?: RequestOptions) =>
      this.requestJson<RegionListResource>(MODEL_REGIONS_PATH, options),
    patchRegion: (
      regionId: string,
      patch: RegionPatchRequest,
      options?: RequestOptions,
    ) =>
      this.patchJson<SceneResource, RegionPatchRequest>(
        MODEL_REGION_PATH,
        patch,
        options,
        { path: { region_id: regionId } },
      ),
    scene: (options?: RequestOptions) =>
      this.requestJson<SceneResource>(MODEL_SCENE_PATH, options),
    universe: (options?: RequestOptions) =>
      this.requestJson<UniverseResource>(MODEL_UNIVERSE_PATH, options),
    updateUniverse: (patch: UniversePatchRequest, options?: RequestOptions) =>
      this.patchJson<UniverseResource, UniversePatchRequest>(
        MODEL_UNIVERSE_PATH,
        patch,
        options,
      ),
  };

  readonly visualization = {
    patch: (patch: VisualizationStatePatch, options?: RequestOptions) =>
      this.patchJson<VisualizationStateResource, VisualizationStatePatch>(
        VISUALIZATION_STATE_PATH,
        patch,
        options,
      ),
    state: (options?: RequestOptions) =>
      this.requestJson<VisualizationStateResource>(
        VISUALIZATION_STATE_PATH,
        options,
      ),
  };

  constructor({
    baseUrl,
    diagnostics,
    fetchImpl,
    maxGetRetries = 1,
    requestIdFactory = () => crypto.randomUUID(),
  }: ControlRoomApiOptions = {}) {
    this.baseUrl = resolveBaseUrl(baseUrl);
    this.diagnostics = diagnostics ?? null;
    this.fetchImpl = fetchImpl ?? resolveDefaultFetch();
    this.maxGetRetries = maxGetRetries;
    this.requestIdFactory = requestIdFactory;
    this.transport = createOpenApiV2Transport({
      baseUrl: this.baseUrl,
      fetch: (input) => this.executeOpenApiFetch(input, undefined),
    });
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  private async requestJson<T>(
    path: OpenApiV2Path,
    options: RequestOptions = {},
    params?: Record<string, unknown>,
  ): Promise<T> {
    const result = await this.transport.GET(path as never, {
      cache: "no-store",
      params,
      signal: options.signal,
    } as never);
    return readOpenApiResult<T>(result);
  }

  private async requestOptionalJson<T>(
    path: OpenApiV2Path,
    options: RequestOptions = {},
    params?: Record<string, unknown>,
  ): Promise<T | null> {
    const result = await this.transport.GET(path as never, {
      cache: "no-store",
      params,
      signal: options.signal,
    } as never);

    if (result.response?.status === 204) {
      return null;
    }

    return readOpenApiResult<T>(result);
  }

  private async postJson<TResponse, TBody>(
    path: OpenApiV2Path,
    body: TBody,
    options: RequestOptions = {},
    params?: Record<string, unknown>,
  ): Promise<TResponse> {
    const result = await this.transport.POST(path as never, {
      body,
      cache: "no-store",
      params,
      signal: options.signal,
    } as never);
    return readOpenApiResult<TResponse>(result);
  }

  private async patchJson<TResponse, TBody>(
    path: OpenApiV2Path,
    body: TBody,
    options: RequestOptions = {},
    params?: Record<string, unknown>,
  ): Promise<TResponse> {
    const result = await this.transport.PATCH(path as never, {
      body,
      cache: "no-store",
      params,
      signal: options.signal,
    } as never);
    return readOpenApiResult<TResponse>(result);
  }

  private async putJson<TResponse, TBody>(
    path: OpenApiV2Path,
    body: TBody,
    options: RequestOptions = {},
    params?: Record<string, unknown>,
  ): Promise<TResponse> {
    const result = await this.transport.PUT(path as never, {
      body,
      cache: "no-store",
      params,
      signal: options.signal,
    } as never);
    return readOpenApiResult<TResponse>(result);
  }

  private async deleteJson<TResponse>(
    path: OpenApiV2Path,
    options: RequestOptions = {},
    params?: Record<string, unknown>,
  ): Promise<TResponse> {
    const result = await this.transport.DELETE(path as never, {
      cache: "no-store",
      params,
      signal: options.signal,
    } as never);
    return readOpenApiResult<TResponse>(result);
  }

  private requestTopology(
    path: OpenApiV2Path,
    options: BinaryRequestOptions = {},
    pathParams?: PathParams,
  ): Promise<BinaryResourceResult<DecodedTopology>> {
    return this.requestBinaryResource(path, decodeTopology, options, pathParams);
  }

  private requestFieldVector(
    path: OpenApiV2Path,
    pathParams: PathParams,
    query: FieldVectorQuery,
    options: BinaryRequestOptions = {},
  ): Promise<BinaryResourceResult<DecodedFieldVector>> {
    return this.requestBinaryResource(
      path,
      decodeFieldVector,
      options,
      pathParams,
      query,
    );
  }

  private async requestBinaryResource<TData>(
    path: OpenApiV2Path,
    decode: (buffer: ArrayBuffer) => TData,
    options: BinaryRequestOptions = {},
    pathParams?: PathParams,
    query?: QueryParams,
  ): Promise<BinaryResourceResult<TData>> {
    const headers = new Headers();
    if (options.etag) {
      headers.set("if-none-match", options.etag);
    }

    const response = await this.executeFetchRequest(
      buildApiUrl(this.baseUrl, path, pathParams, query),
      "GET",
      {
        headers,
        signal: options.signal,
      },
      new Set([204, 304]),
    );
    const etag = response.headers.get("etag");

    if (response.status === 304) {
      return { etag, status: "not-modified" };
    }

    if (response.status === 204) {
      return { etag, status: "not-applicable" };
    }

    if (!response.ok) {
      throw new ControlRoomApiError(
        await formatResponseError(response),
        response.status,
      );
    }

    const buffer = await response.arrayBuffer();
    return {
      byteLength: buffer.byteLength,
      data: decode(buffer),
      etag,
      status: "ready",
    };
  }

  private async executeOpenApiFetch(
    input: RequestInfo | URL,
    init: RequestInit | undefined,
  ): Promise<Response> {
    const request = await normalizeFetchInput(input, init);
    return this.executeFetchRequest(request.url, request.method, request.init);
  }

  private async executeFetchRequest(
    url: string,
    method: string,
    init: RequestInit,
    acceptedStatuses = new Set<number>(),
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    const requestId = this.requestIdFactory();
    headers.set("x-request-id", requestId);

    const started = Date.now();
    const path = pathFromUrl(url);
    const maxAttempts = method === "GET" ? this.maxGetRetries + 1 : 1;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const fetchImpl = this.fetchImpl;
        const response = await fetchImpl(url, {
          ...init,
          cache: init.cache ?? "no-store",
          headers,
          method,
        });

        if (attempt < maxAttempts && response.status >= 500) {
          continue;
        }

        const contractVersionError = resolveContractVersionError(response);
        const accepted =
          (response.ok || acceptedStatuses.has(response.status)) &&
          !contractVersionError;
        this.diagnostics?.record({
          durationMs: Date.now() - started,
          method,
          outcome: accepted ? "ok" : "error",
          path,
          requestId,
          status: response.status,
        });

        if (contractVersionError) {
          throw contractVersionError;
        }

        return response;
      } catch (error) {
        if (error instanceof ControlRoomApiError) {
          throw error;
        }

        lastError = error;
        if (
          attempt < maxAttempts &&
          !(error instanceof DOMException && error.name === "AbortError")
        ) {
          continue;
        }
      }
    }

    this.diagnostics?.record({
      durationMs: Date.now() - started,
      method,
      outcome:
        lastError instanceof DOMException && lastError.name === "AbortError"
          ? "aborted"
          : "network-error",
      path,
      requestId,
      status: null,
    });

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

function resolveBaseUrl(baseUrl: string | undefined): string {
  if (baseUrl !== undefined) {
    return baseUrl.replace(/\/$/, "");
  }

  if (typeof window !== "undefined") {
    return window.location.origin;
  }

  return "http://localhost";
}

function resolveDefaultFetch(): FetchLike {
  if (typeof globalThis.fetch !== "function") {
    throw new ControlRoomApiError("Fetch API is not available", 0);
  }

  return globalThis.fetch.bind(globalThis);
}

async function normalizeFetchInput(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<{ init: RequestInit; method: string; url: string }> {
  if (typeof Request !== "undefined" && input instanceof Request) {
    const method = init?.method ?? input.method;
    let body = init?.body;

    if (
      body === undefined &&
      method !== "GET" &&
      method !== "HEAD" &&
      input.body != null
    ) {
      body = await input.clone().arrayBuffer();
    }

    return {
      init: {
        ...init,
        body,
        cache: init?.cache ?? input.cache,
        headers: init?.headers ?? input.headers,
        signal: init?.signal ?? input.signal,
      },
      method,
      url: input.url,
    };
  }

  return {
    init: init ?? {},
    method: init?.method ?? "GET",
    url: String(input),
  };
}

function pathFromUrl(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function buildApiUrl(
  baseUrl: string,
  path: OpenApiV2Path,
  pathParams: PathParams = {},
  query: QueryParams = {},
): string {
  let resolvedPath = path as string;
  for (const [name, value] of Object.entries(pathParams)) {
    resolvedPath = resolvedPath.replace(
      `{${name}}`,
      encodeURIComponent(String(value)),
    );
  }

  if (resolvedPath.includes("{")) {
    throw new ControlRoomApiError(
      `Missing path parameter for ${resolvedPath}`,
      0,
    );
  }

  const url = new URL(resolvedPath, `${baseUrl}/`);
  for (const [name, value] of Object.entries(query)) {
    if (value === null || value === undefined) continue;
    url.searchParams.set(name, String(value));
  }

  return url.toString();
}

function resolveContractVersionError(response: Response): ControlRoomApiError | null {
  const actual = response.headers.get(API_CONTRACT_VERSION_HEADER);
  if (actual === EXPECTED_API_CONTRACT_VERSION) {
    return null;
  }

  return new ControlRoomApiError(
    `API contract version mismatch: expected ${EXPECTED_API_CONTRACT_VERSION}, got ${actual ?? "missing"}`,
    0,
  );
}

function readOpenApiResult<T>(result: {
  data?: unknown;
  error?: unknown;
  response?: Response;
}): T {
  const response = result.response;

  if (!response) {
    throw new ControlRoomApiError("OpenAPI transport returned no response", 0);
  }

  if (!response.ok) {
    throw new ControlRoomApiError(
      formatOpenApiError(result.error),
      response.status,
    );
  }

  return result.data as T;
}

function formatOpenApiError(error: unknown): string {
  if (error == null) {
    return "Request failed";
  }

  if (typeof error === "string") {
    return error;
  }

  if (typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string") {
      return record.message;
    }
    if (typeof record.error === "string") {
      return record.error;
    }
  }

  return "Request failed";
}

async function formatResponseError(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) {
    return "Request failed";
  }

  try {
    return formatOpenApiError(JSON.parse(text));
  } catch {
    return text;
  }
}
