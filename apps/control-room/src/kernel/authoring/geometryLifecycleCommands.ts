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

export type PrimitiveDraftKind = "Box" | "Cylinder" | "Sphere";

export interface PrimitiveDraft {
  dimensions: [number, number, number] | null;
  errors: Readonly<Record<string, string>>;
  kind: PrimitiveDraftKind;
  translation: [number, number, number] | null;
}

type PrimitiveDraftListener = () => void;

class PrimitiveDraftOverlayStore {
  private listeners = new Set<PrimitiveDraftListener>();
  private snapshot: PrimitiveDraft | null = null;

  readonly getSnapshot = (): PrimitiveDraft | null => this.snapshot;
  readonly getServerSnapshot = (): null => null;
  readonly subscribe = (listener: PrimitiveDraftListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  publish(draft: PrimitiveDraft): void {
    this.snapshot = draft;
    this.emit();
  }

  clear(): void {
    if (this.snapshot === null) return;
    this.snapshot = null;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/** Inspector-owned draft overlay; never stores a committed SceneDocument. */
export const primitiveDraftOverlayStore = new PrimitiveDraftOverlayStore();

export interface MeshCommandTerminalOptions {
  baseMeshRevision?: number | null;
  pollDelaysMs?: readonly number[];
}

export type MeshCommandObservation =
  | "waiting"
  | "disconnected"
  | "publication-unconfirmed";

export type MeshCommandTerminalResult = {
  commandId: string;
  message?: string;
} & (
  | {
      detail: CommandDetailResource;
      observation?: never;
      status: "completed" | "failed" | "cancelled";
    }
  | {
      detail: CommandDetailResource | null;
      observation: MeshCommandObservation;
      status: "pending";
    }
);

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

    let detail: CommandDetailResource;
    try {
      detail = await api.detail(commandId);
    } catch (error) {
      return {
        commandId,
        detail: lastDetail,
        message: error instanceof Error
          ? `Mesh command observation disconnected: ${error.message}. The build outcome is unknown.`
          : "Mesh command observation disconnected. The build outcome is unknown.",
        observation: "disconnected",
        status: "pending",
      };
    }
    if (detail.command_id !== commandId) {
      return {
        commandId,
        detail: lastDetail,
        message: "The command resource identity does not match this mesh build.",
        observation: "publication-unconfirmed",
        status: "pending",
      };
    }
    lastDetail = detail;
    const status = commandStatus(detail);
    if (status === "failed" || status === "rejected") {
      return {
        commandId,
        detail,
        message: detail.error ?? detail.reason ?? "Mesh build failed.",
        status: "failed",
      };
    }
    if (status === "cancelled") {
      return {
        commandId,
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
        commandId,
        detail,
        message:
          "Mesh command completion is unconfirmed: no new mesh revision was published.",
        observation: "publication-unconfirmed",
        status: "pending",
      };
    }
    return { commandId, detail, status: "completed" };
  }

  return {
    commandId,
    detail: lastDetail,
    message: "Mesh build is still pending. Observation paused; resume to check the same command.",
    observation: "waiting",
    status: "pending",
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
