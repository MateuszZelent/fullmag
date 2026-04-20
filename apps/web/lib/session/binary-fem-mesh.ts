"use client";

import type { FemLiveMesh } from "./types";

const FEM_MESH_TOPOLOGY_MAGIC = "FMMT";
const FEM_MESH_TOPOLOGY_HEADER_LEN = 32;
const FEM_MESH_TOPOLOGY_VERSION = 1;

export interface DecodedFemMeshTopology {
  version: 1;
  nodes: Float64Array;
  elements: Uint32Array;
  boundaryFaces: Uint32Array;
  elementMarkers: Uint32Array;
  boundaryMarkers: Uint32Array;
  nodeCount: number;
  elementCount: number;
  boundaryFaceCount: number;
}

function expectedBinaryByteLength(header: {
  nodeCount: number;
  elementCount: number;
  boundaryFaceCount: number;
  elementMarkerCount: number;
  boundaryMarkerCount: number;
}) {
  return (
    FEM_MESH_TOPOLOGY_HEADER_LEN +
    header.nodeCount * 3 * Float64Array.BYTES_PER_ELEMENT +
    header.elementCount * 4 * Uint32Array.BYTES_PER_ELEMENT +
    header.boundaryFaceCount * 3 * Uint32Array.BYTES_PER_ELEMENT +
    header.elementMarkerCount * Uint32Array.BYTES_PER_ELEMENT +
    header.boundaryMarkerCount * Uint32Array.BYTES_PER_ELEMENT
  );
}

function validateTopologyRanges(
  nodes: Float64Array,
  elements: Uint32Array,
  boundaryFaces: Uint32Array,
  nodeCount: number,
) {
  for (let i = 0; i < nodes.length; i += 1) {
    const value = nodes[i];
    if (!Number.isFinite(value)) {
      throw new Error(`FEM topology payload contains non-finite node coordinate at ${i}`);
    }
  }
  for (let i = 0; i < elements.length; i += 1) {
    if (elements[i] >= nodeCount) {
      throw new Error(`FEM topology payload contains out-of-range element node index at ${i}`);
    }
  }
  for (let i = 0; i < boundaryFaces.length; i += 1) {
    if (boundaryFaces[i] >= nodeCount) {
      throw new Error(`FEM topology payload contains out-of-range boundary node index at ${i}`);
    }
  }
}

function decodeHeader(view: DataView) {
  const magic = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );
  if (magic !== FEM_MESH_TOPOLOGY_MAGIC) {
    throw new Error(`invalid FEM topology payload magic: ${magic}`);
  }
  const version = view.getUint8(4);
  if (version !== FEM_MESH_TOPOLOGY_VERSION) {
    throw new Error(`unsupported FEM topology payload version: ${version}`);
  }
  return {
    version,
    nodeCount: view.getUint32(8, true),
    elementCount: view.getUint32(12, true),
    boundaryFaceCount: view.getUint32(16, true),
    elementMarkerCount: view.getUint32(20, true),
    boundaryMarkerCount: view.getUint32(24, true),
  };
}

function sliceFloat64Array(buffer: ArrayBuffer, offset: number, length: number) {
  return new Float64Array(buffer, offset, length);
}

function sliceUint32Array(buffer: ArrayBuffer, offset: number, length: number) {
  return new Uint32Array(buffer, offset, length);
}

function triplesFromFlat(values: Float64Array): [number, number, number][] {
  const triples = new Array<[number, number, number]>(Math.floor(values.length / 3));
  for (let i = 0; i < triples.length; i += 1) {
    const base = i * 3;
    triples[i] = [values[base] ?? 0, values[base + 1] ?? 0, values[base + 2] ?? 0];
  }
  return triples;
}

function quadsFromFlat(values: Uint32Array): [number, number, number, number][] {
  const quads = new Array<[number, number, number, number]>(Math.floor(values.length / 4));
  for (let i = 0; i < quads.length; i += 1) {
    const base = i * 4;
    quads[i] = [
      values[base] ?? 0,
      values[base + 1] ?? 0,
      values[base + 2] ?? 0,
      values[base + 3] ?? 0,
    ];
  }
  return quads;
}

function facesFromFlat(values: Uint32Array): [number, number, number][] {
  const faces = new Array<[number, number, number]>(Math.floor(values.length / 3));
  for (let i = 0; i < faces.length; i += 1) {
    const base = i * 3;
    faces[i] = [values[base] ?? 0, values[base + 1] ?? 0, values[base + 2] ?? 0];
  }
  return faces;
}

export function decodeFemMeshTopologyBinary(data: ArrayBuffer): DecodedFemMeshTopology {
  if (data.byteLength < FEM_MESH_TOPOLOGY_HEADER_LEN) {
    throw new Error("FEM topology payload too short");
  }
  const view = new DataView(data);
  const header = decodeHeader(view);
  const expectedByteLength = expectedBinaryByteLength(header);
  if (data.byteLength !== expectedByteLength) {
    throw new Error(
      `FEM topology payload size mismatch: got ${data.byteLength}, expected ${expectedByteLength}`,
    );
  }
  let offset = FEM_MESH_TOPOLOGY_HEADER_LEN;

  const nodesLength = header.nodeCount * 3;
  const nodesByteLength = nodesLength * Float64Array.BYTES_PER_ELEMENT;
  const nodes = sliceFloat64Array(data, offset, nodesLength);
  offset += nodesByteLength;

  const elementsLength = header.elementCount * 4;
  const elementsByteLength = elementsLength * Uint32Array.BYTES_PER_ELEMENT;
  const elements = sliceUint32Array(data, offset, elementsLength);
  offset += elementsByteLength;

  const boundaryFacesLength = header.boundaryFaceCount * 3;
  const boundaryFacesByteLength = boundaryFacesLength * Uint32Array.BYTES_PER_ELEMENT;
  const boundaryFaces = sliceUint32Array(data, offset, boundaryFacesLength);
  offset += boundaryFacesByteLength;

  const elementMarkersLength = header.elementMarkerCount;
  const elementMarkersByteLength = elementMarkersLength * Uint32Array.BYTES_PER_ELEMENT;
  const elementMarkers = sliceUint32Array(data, offset, elementMarkersLength);
  offset += elementMarkersByteLength;

  const boundaryMarkersLength = header.boundaryMarkerCount;
  const boundaryMarkers = sliceUint32Array(data, offset, boundaryMarkersLength);
  offset += boundaryMarkersLength * Uint32Array.BYTES_PER_ELEMENT;

  if (offset !== data.byteLength) {
    throw new Error("FEM topology payload truncated");
  }
  validateTopologyRanges(nodes, elements, boundaryFaces, header.nodeCount);

  return {
    version: 1,
    nodes,
    elements,
    boundaryFaces,
    elementMarkers,
    boundaryMarkers,
    nodeCount: header.nodeCount,
    elementCount: header.elementCount,
    boundaryFaceCount: header.boundaryFaceCount,
  };
}

export function hydrateFemMeshTopology(
  mesh: FemLiveMesh,
  topology: DecodedFemMeshTopology,
): FemLiveMesh {
  return {
    ...mesh,
    nodes: triplesFromFlat(topology.nodes),
    elements: quadsFromFlat(topology.elements),
    element_markers: Array.from(topology.elementMarkers),
    boundary_faces: facesFromFlat(topology.boundaryFaces),
    boundary_markers: Array.from(topology.boundaryMarkers),
    topology_buffers: {
      nodes: topology.nodes,
      elements: topology.elements,
      boundary_faces: topology.boundaryFaces,
      element_markers: topology.elementMarkers,
      boundary_markers: topology.boundaryMarkers,
    },
    topology_transport: "binary",
    node_count: topology.nodeCount,
    element_count: topology.elementCount,
    boundary_face_count: topology.boundaryFaceCount,
  };
}
