import { BufferAttribute, type BufferGeometry } from "three";

interface SharedTopologyPositionEntry {
  attribute: BufferAttribute;
  owners: number;
}

const sharedTopologyPositions = new WeakMap<Float32Array, SharedTopologyPositionEntry>();

/**
 * Shares one GPU position buffer across indexed raw-topology passes. Three.js
 * disposes every attribute attached to a geometry, so non-final geometry owners
 * detach the shared attribute before disposal; the final owner performs the
 * normal Three.js disposal that releases the WebGL buffer.
 */
export function attachViewport3DSharedTopologyPosition(
  geometry: BufferGeometry,
  positions: Float32Array,
): BufferAttribute {
  const entry = acquireSharedTopologyPosition(positions);
  geometry.setAttribute("position", entry.attribute);

  const dispose = geometry.dispose.bind(geometry);
  let disposed = false;
  geometry.dispose = () => {
    if (disposed) return;
    disposed = true;
    const finalOwner = releaseSharedTopologyPosition(positions, entry);
    if (!finalOwner) {
      geometry.deleteAttribute("position");
    }
    dispose();
  };

  return entry.attribute;
}

function acquireSharedTopologyPosition(
  positions: Float32Array,
): SharedTopologyPositionEntry {
  const existing = sharedTopologyPositions.get(positions);
  if (existing) {
    existing.owners += 1;
    return existing;
  }
  const entry: SharedTopologyPositionEntry = {
    attribute: new BufferAttribute(positions, 3),
    owners: 1,
  };
  sharedTopologyPositions.set(positions, entry);
  return entry;
}

function releaseSharedTopologyPosition(
  positions: Float32Array,
  entry: SharedTopologyPositionEntry,
): boolean {
  entry.owners = Math.max(0, entry.owners - 1);
  if (entry.owners > 0) return false;
  if (sharedTopologyPositions.get(positions) === entry) {
    sharedTopologyPositions.delete(positions);
  }
  return true;
}
