export interface WorkspaceRuntimeIdentityInput {
  sessionId: string | null | undefined;
  runId: string | null | undefined;
  scriptPath: string | null | undefined;
  sourceHash: string | null | undefined;
}

export interface WorkspaceRuntimeIdentity {
  documentIdentity: string | null;
  runtimeIdentity: string | null;
  runIdentity: string | null;
}

function identityToken(value: string | null | undefined, fallback: string): string {
  const token = String(value ?? "").trim();
  return token.length > 0 ? token : fallback;
}

export function resolveWorkspaceRuntimeIdentity(
  input: WorkspaceRuntimeIdentityInput,
): WorkspaceRuntimeIdentity {
  const sessionId = String(input.sessionId ?? "").trim();
  if (!sessionId) {
    return {
      documentIdentity: null,
      runtimeIdentity: null,
      runIdentity: null,
    };
  }

  const scriptPath = identityToken(input.scriptPath, "no-script-path");
  const sourceHash = identityToken(input.sourceHash, "no-source-hash");
  const runId = identityToken(input.runId, "no-run");
  return {
    documentIdentity: `${scriptPath}:${sourceHash}`,
    runtimeIdentity: sessionId,
    runIdentity: `${sessionId}:${runId}`,
  };
}
