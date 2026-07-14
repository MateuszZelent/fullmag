import type {
  AuthoringTransactionRequest,
  AuthoringTransactionResponse,
  CommandDetailResource,
  CommandResponse,
  ObjectGeometryPatchRequest,
  ObjectPatchRequest,
  RequestOptions,
  SceneResource,
  StructuredCommandRequest,
} from "../api/apiTypes";

type CreateObjectTransaction = Extract<
  AuthoringTransactionRequest,
  { kind: "create_object" }
>;
type CommitObjectTransformTransaction = Extract<
  AuthoringTransactionRequest,
  { kind: "commit_object_transform" }
>;
type DeleteObjectTransaction = Extract<
  AuthoringTransactionRequest,
  { kind: "delete_object" }
>;
type MeshBuildCommand = Extract<StructuredCommandRequest, { kind: "mesh_build" }>;

interface GeometryTransactionApi {
  model: {
    commitTransaction: (
      request: AuthoringTransactionRequest,
      options?: RequestOptions,
    ) => Promise<AuthoringTransactionResponse>;
  };
}

interface SimulationCommandApi {
  commands: {
    submit: (
      request: StructuredCommandRequest,
      options?: RequestOptions,
    ) => Promise<CommandResponse>;
  };
}

export interface MeshCommandTerminalOptions {
  baseMeshRevision?: number | null;
  pollDelaysMs?: readonly number[];
}

export interface MeshCommandTerminalResult {
  detail: CommandDetailResource;
  message?: string;
  status: "completed" | "failed" | "cancelled";
}

const DEFAULT_MESH_COMMAND_POLL_DELAYS_MS: readonly number[] = [
  0,
  100,
  250,
  500,
  750,
  1000,
  1500,
  2000,
  2500,
  3000,
  4000,
  5000,
  ...Array.from({ length: 48 }, () => 5000),
];

function commandStatus(detail: CommandDetailResource): string {
  return (detail.status || detail.completion_status || "").toLowerCase();
}

function publishedMeshRevision(
  detail: CommandDetailResource,
): number | null {
  const invalidation = detail.resource_invalidations?.find((entry) => {
    const key = entry.resource_key;
    return (
      key === "meshing/shared-domain/manifest" ||
      key === "data/domain/topology" ||
      (key.startsWith("meshing/objects/") && key.endsWith("/topology"))
    );
  });
  return invalidation?.revision ?? null;
}

/**
 * Await the authoritative HTTP command resource. A 202/accepted response is
 * only submission acknowledgement and can never be reported as completion.
 */
export async function awaitMeshCommandTerminal(
  api: {
    detail: (
      commandId: string,
      options?: RequestOptions,
    ) => Promise<CommandDetailResource>;
  },
  commandId: string,
  options: MeshCommandTerminalOptions = {},
): Promise<MeshCommandTerminalResult> {
  const delays = options.pollDelaysMs ?? DEFAULT_MESH_COMMAND_POLL_DELAYS_MS;
  let lastDetail: CommandDetailResource | null = null;

  for (const delay of delays) {
    if (delay > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delay);
      });
    }

    const detail = await api.detail(commandId);
    lastDetail = detail;
    const status = commandStatus(detail);
    if (status === "failed" || status === "rejected") {
      return {
        detail,
        message: detail.error ?? detail.reason ?? "Mesh build failed.",
        status: "failed",
      };
    }
    if (status === "cancelled") {
      return {
        detail,
        message: detail.error ?? detail.reason ?? "Mesh build was cancelled.",
        status: "cancelled",
      };
    }
    if (status !== "completed") continue;

    const meshRevision = publishedMeshRevision(detail);
    const baseMeshRevision = options.baseMeshRevision ?? null;
    if (
      meshRevision == null ||
      (baseMeshRevision != null && meshRevision <= baseMeshRevision)
    ) {
      return {
        detail,
        message:
          "Mesh command reached completed status without publishing a new mesh revision.",
        status: "failed",
      };
    }
    return { detail, status: "completed" };
  }

  const detail = lastDetail ?? (await api.detail(commandId));
  return {
    detail,
    message: "Timed out waiting for the mesh command terminal resource.",
    status: "failed",
  };
}

function commitTransaction(
  api: GeometryTransactionApi,
  request: AuthoringTransactionRequest,
  options?: RequestOptions,
): Promise<AuthoringTransactionResponse> {
  return options === undefined
    ? api.model.commitTransaction(request)
    : api.model.commitTransaction(request, options);
}

export function createObjectTransaction(
  api: GeometryTransactionApi,
  request: Omit<CreateObjectTransaction, "kind">,
  options?: RequestOptions,
): Promise<AuthoringTransactionResponse> {
  return commitTransaction(
    api,
    {
      ...request,
      kind: "create_object",
    },
    options,
  );
}

export function patchObjectGeometryTransaction(
  api: GeometryTransactionApi,
  objectId: string,
  request: ObjectGeometryPatchRequest,
  options?: RequestOptions,
): Promise<AuthoringTransactionResponse> {
  return commitTransaction(
    api,
    {
      ...request,
      kind: "patch_object_geometry",
      object_id: objectId,
    },
    options,
  );
}

export function patchObjectTransaction(
  api: {
    model: {
      patchObject: (
        objectId: string,
        request: ObjectPatchRequest,
        options?: RequestOptions,
      ) => Promise<SceneResource>;
    };
  },
  objectId: string,
  request: ObjectPatchRequest,
  options?: RequestOptions,
): Promise<SceneResource> {
  return api.model.patchObject(objectId, request, options);
}

export function commitObjectTransformTransaction(
  api: GeometryTransactionApi,
  objectId: string,
  request: Omit<CommitObjectTransformTransaction, "kind" | "object_id">,
  options?: RequestOptions,
): Promise<AuthoringTransactionResponse> {
  return commitTransaction(
    api,
    {
      ...request,
      kind: "commit_object_transform",
      object_id: objectId,
    },
    options,
  );
}

export function deleteObjectTransaction(
  api: GeometryTransactionApi,
  objectId: string,
  request: Omit<DeleteObjectTransaction, "kind" | "object_id"> = {},
  options?: RequestOptions,
): Promise<AuthoringTransactionResponse> {
  return commitTransaction(
    api,
    {
      ...request,
      kind: "delete_object",
      object_id: objectId,
    },
    options,
  );
}

export function submitObjectMeshBuild(
  api: SimulationCommandApi,
  objectId: string,
  reason?: string,
  options?: RequestOptions,
): Promise<CommandResponse> {
  const command: MeshBuildCommand = {
    kind: "mesh_build",
    mesh_target: { kind: "object_mesh", object_id: objectId },
    ...(reason ? { mesh_reason: reason } : {}),
  };
  return options === undefined
    ? api.commands.submit(command)
    : api.commands.submit(command, options);
}
