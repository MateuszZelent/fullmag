export type WorkspaceTabMountPolicyValue = "active-only" | "hidden-mounted";

const WEBGL_WORKSPACE_TAB_KINDS = new Set([
  "viewport-3d",
  "viewport-2d",
  "viewport-mesh",
  "result-quantity",
]);

export function isWebGLWorkspaceTabKind(kind: string): boolean {
  return WEBGL_WORKSPACE_TAB_KINDS.has(kind);
}

export function isCore3DWorkspaceTab(args: { id?: string | null; kind: string }): boolean {
  return args.id === "core:3d" && args.kind === "viewport-3d";
}

export function resolveWorkspaceTabMountPolicy(args: {
  id?: string | null;
  kind: string;
  requestedMountPolicy: WorkspaceTabMountPolicyValue;
}): WorkspaceTabMountPolicyValue {
  if (isCore3DWorkspaceTab(args)) {
    return "hidden-mounted";
  }
  return isWebGLWorkspaceTabKind(args.kind) ? "active-only" : args.requestedMountPolicy;
}
