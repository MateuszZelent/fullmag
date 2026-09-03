"use client";

import MaterialPanel from "./MaterialPanel";

export default function MagneticTexturePanel({
  nodeId,
}: {
  nodeId?: string;
}) {
  return <MaterialPanel nodeId={nodeId} mode="magneticTexture" />;
}
