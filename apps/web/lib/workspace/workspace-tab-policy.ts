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

export function resolveWorkspaceTabMountPolicy(args: {
  kind: string;
  requestedMountPolicy: WorkspaceTabMountPolicyValue;
}): WorkspaceTabMountPolicyValue {
  return isWebGLWorkspaceTabKind(args.kind) ? "active-only" : args.requestedMountPolicy;
}
