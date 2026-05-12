import * as THREE from "three";

/**
 * Clip a tetrahedron by a plane and return the visible portion
 * as triangulated output vertices.
 *
 * The plane is defined by (normal, d) where the visible half-space is
 * { x : dot(normal, x) + d >= 0 }.
 *
 * Returns positions array (xyz interleaved) of the clipped triangles,
 * or null if the tetra is fully clipped.
 */
export function clipTetraByPlane(
  /** 4 vertices of the tetrahedron, each [x,y,z] */
  v0: [number, number, number],
  v1: [number, number, number],
  v2: [number, number, number],
  v3: [number, number, number],
  /** Plane normal (unit vector) */
  normal: [number, number, number],
  /** Plane offset: dot(normal, x) + d >= 0 is the visible side */
  d: number,
): Float32Array | null {
  const verts = [v0, v1, v2, v3];
  const dists = verts.map(
    (v) => v[0] * normal[0] + v[1] * normal[1] + v[2] * normal[2] + d,
  );

  // Count vertices on each side
  let positive = 0;
  let negative = 0;
  for (const dist of dists) {
    if (dist >= 0) positive++;
    else negative++;
  }

  // Fully visible
  if (negative === 0) {
    // Return original tetra as 4 triangles (12 vertices)
    return tetraToTriangles(verts);
  }

  // Fully clipped
  if (positive === 0) {
    return null;
  }

  // Partial clip: interpolate edges that cross the plane
  const insideVerts: [number, number, number][] = [];
  const intersectionVerts: [number, number, number][] = [];

  for (let i = 0; i < 4; i++) {
    if (dists[i] >= 0) {
      insideVerts.push(verts[i]);
    }
  }

  // Find intersection points on crossing edges
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      if ((dists[i] >= 0) !== (dists[j] >= 0)) {
        // Edge crosses the plane
        const t = dists[i] / (dists[i] - dists[j]);
        intersectionVerts.push([
          verts[i][0] + t * (verts[j][0] - verts[i][0]),
          verts[i][1] + t * (verts[j][1] - verts[i][1]),
          verts[i][2] + t * (verts[j][2] - verts[i][2]),
        ]);
      }
    }
  }

  // Triangulate the resulting convex polyhedron
  const allVerts = [...insideVerts, ...intersectionVerts];
  return triangulateConvexHull(allVerts);
}

/** Convert a tetrahedron (4 vertices) to 4 triangles (12 vertices). */
function tetraToTriangles(
  verts: [number, number, number][],
): Float32Array {
  const faces = [
    [0, 1, 2],
    [0, 1, 3],
    [0, 2, 3],
    [1, 2, 3],
  ];
  const out = new Float32Array(12 * 3);
  let oi = 0;
  for (const [a, b, c] of faces) {
    out[oi++] = verts[a][0]; out[oi++] = verts[a][1]; out[oi++] = verts[a][2];
    out[oi++] = verts[b][0]; out[oi++] = verts[b][1]; out[oi++] = verts[b][2];
    out[oi++] = verts[c][0]; out[oi++] = verts[c][1]; out[oi++] = verts[c][2];
  }
  return out;
}

/**
 * Simple fan triangulation of a convex hull from the centroid.
 * Works for 3-6 vertices (the output of tetra-plane clipping).
 */
function triangulateConvexHull(
  verts: [number, number, number][],
): Float32Array | null {
  if (verts.length < 3) return null;
  if (verts.length === 3) {
    const out = new Float32Array(9);
    for (let i = 0; i < 3; i++) {
      out[i * 3] = verts[i][0];
      out[i * 3 + 1] = verts[i][1];
      out[i * 3 + 2] = verts[i][2];
    }
    return out;
  }

  // Compute centroid
  let cx = 0, cy = 0, cz = 0;
  for (const v of verts) { cx += v[0]; cy += v[1]; cz += v[2]; }
  cx /= verts.length; cy /= verts.length; cz /= verts.length;

  // For a convex polyhedron with ≤ 6 vertices from tetra clipping,
  // we can identify faces by grouping coplanar vertices.
  // Simpler approach: use centroid-based fan for each group of 3+ coplanar points.
  
  // For the tetra clip case, we get either:
  // - 1 inside + 3 intersections → tetrahedron (4 faces of 3 verts each)
  // - 2 inside + 2 intersections → 4 vertices → 4 triangles
  // - 3 inside + 3 intersections → triangular prism → 8 triangles

  // General approach: convex hull from the centroid, fan each face
  // For small vertex counts, build triangles via centroid fan
  const triangles: number[] = [];

  // Sort vertices by angle around centroid projected onto each face
  // Simple approach for ≤ 6 vertices: brute-force all unique triangles
  // with outward-facing normal
  for (let i = 0; i < verts.length; i++) {
    for (let j = i + 1; j < verts.length; j++) {
      for (let k = j + 1; k < verts.length; k++) {
        // Check if this triangle is a face of the convex hull:
        // all other vertices should be on one side
        const ax = verts[j][0] - verts[i][0], ay = verts[j][1] - verts[i][1], az = verts[j][2] - verts[i][2];
        const bx = verts[k][0] - verts[i][0], by = verts[k][1] - verts[i][1], bz = verts[k][2] - verts[i][2];
        // Normal
        const nx = ay * bz - az * by;
        const ny = az * bx - ax * bz;
        const nz = ax * by - ay * bx;
        const len2 = nx * nx + ny * ny + nz * nz;
        if (len2 < 1e-20) continue; // degenerate

        let allSame = true;
        let sign = 0;
        for (let m = 0; m < verts.length; m++) {
          if (m === i || m === j || m === k) continue;
          const dx = verts[m][0] - verts[i][0];
          const dy = verts[m][1] - verts[i][1];
          const dz = verts[m][2] - verts[i][2];
          const dot = dx * nx + dy * ny + dz * nz;
          if (Math.abs(dot) < 1e-10) continue;
          const s = dot > 0 ? 1 : -1;
          if (sign === 0) sign = s;
          else if (s !== sign) { allSame = false; break; }
        }
        if (!allSame) continue;

        // Orient normal outward (away from centroid)
        const dcx = cx - verts[i][0], dcy = cy - verts[i][1], dcz = cz - verts[i][2];
        const dotC = dcx * nx + dcy * ny + dcz * nz;

        if (dotC > 0) {
          // Normal points inward, flip winding
          triangles.push(
            verts[i][0], verts[i][1], verts[i][2],
            verts[k][0], verts[k][1], verts[k][2],
            verts[j][0], verts[j][1], verts[j][2],
          );
        } else {
          triangles.push(
            verts[i][0], verts[i][1], verts[i][2],
            verts[j][0], verts[j][1], verts[j][2],
            verts[k][0], verts[k][1], verts[k][2],
          );
        }
      }
    }
  }

  if (triangles.length === 0) return null;
  return new Float32Array(triangles);
}

/**
 * Batch clip an array of tetrahedra by a plane.
 * Returns a merged BufferGeometry of the clipped result.
 */
export function clipTetrahedralMeshByPlane(
  nodes: Float64Array | Float32Array,
  elements: Uint32Array | Int32Array,
  normal: [number, number, number],
  planeD: number,
): THREE.BufferGeometry | null {
  const allPositions: number[] = [];
  const numTets = elements.length / 4;

  for (let ti = 0; ti < numTets; ti++) {
    const i0 = elements[ti * 4], i1 = elements[ti * 4 + 1];
    const i2 = elements[ti * 4 + 2], i3 = elements[ti * 4 + 3];

    const v0: [number, number, number] = [nodes[i0 * 3], nodes[i0 * 3 + 1], nodes[i0 * 3 + 2]];
    const v1: [number, number, number] = [nodes[i1 * 3], nodes[i1 * 3 + 1], nodes[i1 * 3 + 2]];
    const v2: [number, number, number] = [nodes[i2 * 3], nodes[i2 * 3 + 1], nodes[i2 * 3 + 2]];
    const v3: [number, number, number] = [nodes[i3 * 3], nodes[i3 * 3 + 1], nodes[i3 * 3 + 2]];

    const clipped = clipTetraByPlane(v0, v1, v2, v3, normal, planeD);
    if (clipped) {
      for (let i = 0; i < clipped.length; i++) {
        allPositions.push(clipped[i]);
      }
    }
  }

  if (allPositions.length === 0) return null;

  const geom = new THREE.BufferGeometry();
  geom.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(allPositions, 3),
  );
  geom.computeVertexNormals();
  return geom;
}
