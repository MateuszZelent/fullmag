import type {
  AuthoringTransactionRequest,
  AuthoringTransactionResponse,
  CommandResponse,
  ObjectCreateRequest,
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

export function directCreateObject(
  api: {
    model: {
      createObject: (
        request: ObjectCreateRequest,
        options?: RequestOptions,
      ) => Promise<unknown>;
    };
  },
  request: ObjectCreateRequest,
  options?: RequestOptions,
): Promise<unknown> {
  return api.model.createObject(request, options);
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
