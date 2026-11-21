import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  BoxGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PerspectiveCamera,
  Scene,
  type BufferGeometry,
  type Material,
} from "three";

import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";

import {
  readViewport3DLightingAudit,
  VIEWPORT_3D_LIGHTING_AUDIT_METHOD,
} from "./viewport3dLightingAudit";

const geometries: BufferGeometry[] = [];
const materials: Material[] = [];

afterEach(() => {
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
  geometries.length = 0;
  materials.length = 0;
});

describe("readViewport3DLightingAudit", () => {
  it("recognizes a visible, lit, in-frustum primitive mesh", () => {
    const { scene, camera } = createSceneAndCamera();
    const mesh = createMesh(new MeshLambertMaterial());
    mesh.userData = { objectId: "primitive-1", primitive: true };
    scene.add(mesh);

    const result = audit(scene, camera);

    expect(result).toEqual({
      litPrimitiveMeshCount: 1,
      otherSurfaceMeshCount: 0,
      litPrimitiveObjectIds: ["primitive-1"],
      method: VIEWPORT_3D_LIGHTING_AUDIT_METHOD,
    });
  });

  it("does not traverse meshes below a hidden parent", () => {
    const { scene, camera } = createSceneAndCamera();
    const parent = new Group();
    parent.visible = false;
    const mesh = createMesh(new MeshLambertMaterial());
    mesh.userData = { objectId: "hidden-primitive", primitive: true };
    parent.add(mesh);
    scene.add(parent);

    expect(audit(scene, camera)).toMatchObject({
      litPrimitiveMeshCount: 0,
      otherSurfaceMeshCount: 0,
      litPrimitiveObjectIds: [],
    });
  });

  it("counts an unlit primitive as another visible surface mesh", () => {
    const { scene, camera } = createSceneAndCamera();
    const mesh = createMesh(new MeshBasicMaterial());
    mesh.userData = { objectId: "unlit-primitive", primitive: true };
    scene.add(mesh);

    expect(audit(scene, camera)).toMatchObject({
      litPrimitiveMeshCount: 0,
      otherSurfaceMeshCount: 1,
      litPrimitiveObjectIds: [],
    });
  });

  it("does not count a primitive outside the camera frustum as lit", () => {
    const { scene, camera } = createSceneAndCamera();
    const mesh = createMesh(new MeshLambertMaterial());
    mesh.userData = { objectId: "offscreen-primitive", primitive: true };
    mesh.position.set(100, 0, 0);
    scene.add(mesh);

    expect(audit(scene, camera)).toMatchObject({
      litPrimitiveMeshCount: 0,
      otherSurfaceMeshCount: 1,
      litPrimitiveObjectIds: [],
    });
  });

  it("excludes HUD-layer-only meshes from world-surface counts", () => {
    const { scene, camera } = createSceneAndCamera();
    const mesh = createMesh(new MeshLambertMaterial());
    mesh.layers.set(31);
    mesh.userData = { objectId: "hud-only", primitive: true };
    scene.add(mesh);

    expect(audit(scene, camera)).toMatchObject({
      litPrimitiveMeshCount: 0,
      otherSurfaceMeshCount: 0,
      litPrimitiveObjectIds: [],
    });
  });

  it("excludes screen-space annotation line quads from world surfaces", () => {
    const { scene, camera } = createSceneAndCamera();
    const geometry = new LineSegmentsGeometry();
    geometry.setPositions([-1, 0, 0, 1, 0, 0]);
    const material = new LineMaterial({ linewidth: 2 });
    geometries.push(geometry);
    materials.push(material);
    scene.add(new LineSegments2(geometry, material));

    expect(audit(scene, camera)).toMatchObject({
      litPrimitiveMeshCount: 0,
      otherSurfaceMeshCount: 0,
      litPrimitiveObjectIds: [],
    });
  });

  it("counts a realized non-primitive surface as another surface mesh", () => {
    const { scene, camera } = createSceneAndCamera();
    scene.add(createMesh(new MeshLambertMaterial()));

    expect(audit(scene, camera)).toMatchObject({
      litPrimitiveMeshCount: 0,
      otherSurfaceMeshCount: 1,
      litPrimitiveObjectIds: [],
    });
  });

  it("does not create a missing bounding sphere while auditing", () => {
    const { scene, camera } = createSceneAndCamera();
    const mesh = createMesh(new MeshLambertMaterial());
    mesh.geometry.boundingSphere = null;
    mesh.userData = { objectId: "unbounded-primitive", primitive: true };
    scene.add(mesh);

    expect(audit(scene, camera)).toMatchObject({
      litPrimitiveMeshCount: 0,
      otherSurfaceMeshCount: 1,
      litPrimitiveObjectIds: [],
    });
    expect(mesh.geometry.boundingSphere).toBeNull();
  });

  it("rejects a primitive with an invisible Lambert material", () => {
    expectNonRenderableMaterial(new MeshLambertMaterial({ visible: false }));
  });

  it("rejects a primitive with a zero-opacity Lambert material", () => {
    expectNonRenderableMaterial(new MeshLambertMaterial({ opacity: 0, transparent: true }));
  });

  it("requires every material in a primitive mesh to be lit and visible", () => {
    const { scene, camera } = createSceneAndCamera();
    const lit = new MeshLambertMaterial();
    const unlit = new MeshBasicMaterial();
    const mesh = createMesh([lit, unlit]);
    mesh.userData = { objectId: "mixed-material-primitive", primitive: true };
    scene.add(mesh);

    expect(audit(scene, camera)).toMatchObject({
      litPrimitiveMeshCount: 0,
      otherSurfaceMeshCount: 1,
      litPrimitiveObjectIds: [],
    });
  });
});

function createSceneAndCamera(): { scene: Scene; camera: PerspectiveCamera } {
  const scene = new Scene();
  const camera = new PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  return { scene, camera };
}

function createMesh(
  material: Material | Material[],
): Mesh<BoxGeometry, Material | Material[]> {
  const geometry = new BoxGeometry(1, 1, 1);
  geometry.computeBoundingSphere();
  geometries.push(geometry);
  materials.push(...(Array.isArray(material) ? material : [material]));
  return new Mesh(geometry, material);
}

function audit(scene: Scene, camera: PerspectiveCamera) {
  scene.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);
  return readViewport3DLightingAudit(scene, camera);
}

function expectNonRenderableMaterial(material: MeshLambertMaterial): void {
  const { scene, camera } = createSceneAndCamera();
  const mesh = createMesh(material);
  mesh.userData = { objectId: "non-visible-primitive", primitive: true };
  scene.add(mesh);

  expect(audit(scene, camera)).toMatchObject({
    litPrimitiveMeshCount: 0,
    otherSurfaceMeshCount: 1,
    litPrimitiveObjectIds: [],
  });
}
