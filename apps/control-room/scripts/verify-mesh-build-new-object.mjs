const rawBase =
  process.env.CONTROL_ROOM_API_BASE_URL ??
  process.env.NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL ??
  "http://localhost:8081";
const base = rawBase.replace(/\/+$/, "").replace(/\/v2$/, "");
const objectId = `codex-mesh-verify-${Date.now().toString(36)}`;
const objectName = `Codex Mesh Verify ${Date.now().toString(36)}`;
const timeoutMs = Number(process.env.MESH_VERIFY_TIMEOUT_MS ?? "240000");

let cleanupRevision = null;
let shouldCleanup = false;
let initialScene = null;

try {
  initialScene = await getJson("/v2/sessions/current/model/scene");
  const initialManifest = await getJson(
    "/v2/sessions/current/meshing/meshes/shared-domain/manifest",
  ).catch(() => null);
  const existingObject = firstSceneObject(initialScene);
  const objectSize = [6e-8, 6e-8, 8e-9];
  const universe = sceneStudyUniverse(initialScene) ?? sceneUniverse(initialScene) ?? {
    center: [0, 0, 0],
    mode: "box",
    padding: [0, 0, 0],
    size: [3.2e-6, 2.4e-6, 3e-7],
  };
  const translation = verificationObjectTranslation(existingObject, universe, objectSize);

  const createResponse = await postJson("/v2/sessions/current/model/transactions", {
    base_revision: sceneRevision(initialScene),
    geometry: {
      geometry_kind: "Box",
      geometry_params: { size: objectSize },
    },
    kind: "create_object",
    magnetization_ref: stringOrNull(existingObject?.magnetization_ref),
    material_ref: stringOrNull(existingObject?.material_ref),
    name: objectName,
    object_id: objectId,
    region_name: "mesh_verification",
    study_universe_mesh: universe,
    transform: {
      pivot: [0, 0, 0],
      rotation_quat: [0, 0, 0, 1],
      scale: [1, 1, 1],
      translation,
    },
    universe,
  });
  cleanupRevision = createResponse.scene_revision ?? null;
  shouldCleanup = true;

  if (!sceneObjects(createResponse.committed_scene).some((object) => object?.id === objectId)) {
    throw new Error(`Created scene does not contain ${objectId}.`);
  }

  const command = await postJson("/v2/sessions/current/simulation/commands", {
    kind: "mesh_build",
    mesh_reason: `codex_new_object_verification:${objectId}`,
    mesh_target: { kind: "study_domain" },
  });
  if (!command.accepted) {
    throw new Error(command.error ?? "mesh_build command was rejected.");
  }

  const manifest = await waitForManifestSegment(
    objectId,
    initialManifest?.revision ?? 0,
  );
  const segment = manifest.object_segments.find(
    (entry) => entry?.object_id === objectId,
  );
  const topology = await getBinary(
    `/v2/sessions/current/meshing/meshes/objects/${encodeURIComponent(
      objectId,
    )}/topology`,
  );
  const topologyHeader = parseFmmtHeader(topology);

  console.log(
    [
      "Mesh new-object verification passed:",
      `object_id=${objectId}`,
      `command_id=${command.command_id ?? "unknown"}`,
      `manifest_revision=${manifest.revision ?? "unknown"}`,
      `segment_nodes=${segment.node_count}`,
      `segment_elements=${segment.element_count}`,
      `segment_boundary_faces=${segment.boundary_face_count ?? 0}`,
      `object_topology=${topologyHeader.nodeCount}n/${topologyHeader.elementCount}e/${topologyHeader.boundaryFaceCount}bf`,
    ].join(" "),
  );
} finally {
  if (shouldCleanup) {
    await cleanupObject(objectId, initialScene).catch((error) => {
      console.warn(`Mesh verification cleanup failed for ${objectId}: ${error.message}`);
    });
  }
}

async function waitForManifestSegment(targetObjectId, initialRevision) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() <= deadline) {
    try {
      const manifest = await getJson(
        "/v2/sessions/current/meshing/meshes/shared-domain/manifest",
      );
      const segment = Array.isArray(manifest.object_segments)
        ? manifest.object_segments.find((entry) => entry?.object_id === targetObjectId)
        : null;
      if (
        segment &&
        Number(segment.node_count) > 0 &&
        Number(segment.element_count) > 0 &&
        Number(manifest.revision ?? 0) > Number(initialRevision ?? 0)
      ) {
        return manifest;
      }

      const activeBuild = await getJson(
        "/v2/sessions/current/meshing/builds/current",
      ).catch(() => null);
      const error = activeBuild?.mesh_build_diagnostics?.last_build_error;
      if (typeof error === "string" && error.length > 0) {
        lastError = new Error(error);
      }
    } catch (error) {
      lastError = error;
    }
    await delay(1000);
  }

  throw new Error(
    `Timed out waiting for shared-domain manifest segment for ${targetObjectId}.` +
      (lastError ? ` Last error: ${lastError.message}` : ""),
  );
}

async function cleanupObject(targetObjectId, originalScene) {
  const scene = await getJson("/v2/sessions/current/model/scene");
  if (!sceneObjects(scene).some((object) => object?.id === targetObjectId)) {
    return;
  }
  const revision = sceneRevision(scene) ?? cleanupRevision;
  if (typeof revision !== "number") {
    throw new Error("current scene revision is unavailable");
  }
  const deleted = await postJson("/v2/sessions/current/model/transactions", {
    base_revision: revision,
    kind: "delete_object",
    object_id: targetObjectId,
  });
  const restoreRevision =
    sceneRevision(deleted?.committed_scene) ?? deleted?.scene_revision ?? null;
  if (originalScene && typeof restoreRevision === "number") {
    await restoreUniverse(originalScene, restoreRevision);
  }
}

async function restoreUniverse(originalScene, baseRevision) {
  const universe = sceneUniverse(originalScene) ?? sceneStudyUniverse(originalScene);
  if (!universe) return;
  await postJson("/v2/sessions/current/model/transactions", {
    base_revision: baseRevision,
    kind: "patch_universe",
    sync_study_universe_mesh: true,
    universe,
  });
}

async function getJson(path) {
  const response = await fetch(`${base}${path}`);
  if (!response.ok) {
    throw new Error(`${response.status} GET ${path}: ${await response.text()}`);
  }
  return response.json();
}

async function postJson(path, body) {
  const response = await fetch(`${base}${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`${response.status} POST ${path}: ${await response.text()}`);
  }
  return response.json();
}

async function getBinary(path) {
  const response = await fetch(`${base}${path}`);
  if (!response.ok) {
    throw new Error(`${response.status} GET ${path}: ${await response.text()}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

function parseFmmtHeader(bytes) {
  if (bytes.length < 28) {
    throw new Error(`FMMT payload is too short: ${bytes.length} bytes.`);
  }
  if (String.fromCharCode(...bytes.slice(0, 4)) !== "FMMT") {
    throw new Error("FMMT payload has invalid magic.");
  }
  if (bytes[4] !== 1) {
    throw new Error(`Unsupported FMMT payload version ${bytes[4]}.`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    boundaryFaceCount: view.getUint32(16, true),
    elementCount: view.getUint32(12, true),
    nodeCount: view.getUint32(8, true),
  };
}

function sceneRevision(scene) {
  const revision = scene?.revision ?? scene?.scene_revision;
  return typeof revision === "number" ? revision : null;
}

function sceneUniverse(scene) {
  return isRecord(scene?.universe) ? scene.universe : null;
}

function sceneStudyUniverse(scene) {
  return isRecord(scene?.study?.universe_mesh) ? scene.study.universe_mesh : null;
}

function sceneObjects(scene) {
  return Array.isArray(scene?.objects) ? scene.objects : [];
}

function firstSceneObject(scene) {
  return sceneObjects(scene).find((object) => object && typeof object === "object") ?? null;
}

function verificationObjectTranslation(existingObject, universe, objectSize) {
  const bounds = objectBounds(existingObject);
  const center = numberTriple(universe?.center) ?? [0, 0, 0];
  const universeSize = numberTriple(universe?.size);
  const objectHalfY = objectSize[1] * 0.5;
  const objectHalfZ = objectSize[2] * 0.5;
  const targetY = bounds ? bounds.max[1] + 3.5e-7 : center[1] + 5e-7;
  const yLimit = universeSize ? center[1] + universeSize[1] * 0.5 - objectHalfY - 1e-8 : null;
  const y = yLimit === null ? targetY : Math.min(targetY, yLimit);
  const zLimit = universeSize ? Math.max(0, universeSize[2] * 0.5 - objectHalfZ - 1e-8) : 0;
  return [center[0], y, Math.min(Math.max(0, -zLimit), zLimit)];
}

function objectBounds(object) {
  const min = numberTriple(object?.geometry?.bounds_min);
  const max = numberTriple(object?.geometry?.bounds_max);
  return min && max ? { max, min } : null;
}

function numberTriple(value) {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const triple = value.map((entry) => Number(entry));
  return triple.every((entry) => Number.isFinite(entry)) ? triple : null;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringOrNull(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
