/** Same face normals the ViewCube snaps to (see orientation/viewCubeModel.ts). */
export const VIEW_DIRECTION_COMMANDS: ReadonlyArray<{
  direction: [number, number, number];
  id: string;
  label: string;
  title: string;
}> = [
  { id: "viewport-3d.view-top", label: "Top", title: "View from Top (+Z)", direction: [0, 0, 1] },
  { id: "viewport-3d.view-bottom", label: "Bottom", title: "View from Bottom (-Z)", direction: [0, 0, -1] },
  { id: "viewport-3d.view-front", label: "Front", title: "View from Front (+Y)", direction: [0, 1, 0] },
  { id: "viewport-3d.view-back", label: "Back", title: "View from Back (-Y)", direction: [0, -1, 0] },
  { id: "viewport-3d.view-right", label: "Right", title: "View from Right (+X)", direction: [1, 0, 0] },
  { id: "viewport-3d.view-left", label: "Left", title: "View from Left (-X)", direction: [-1, 0, 0] },
  { id: "viewport-3d.view-isometric", label: "Isometric", title: "Isometric View", direction: [1, 1, 1] },
];
