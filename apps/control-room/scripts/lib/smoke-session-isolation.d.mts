export interface SmokeMutationGuard {
  beforeSha256: string | null;
  installProcessGuards(): () => void;
  restoreAndVerify(): {
    afterSha256: string | null;
    beforeSha256: string | null;
    restored: boolean;
  };
  scriptPath: string | null;
}

export function createSmokeMutationGuard(options: {
  apiBase: string | null;
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  mutationRequired: boolean;
  pageUrl: string;
}): Promise<SmokeMutationGuard>;

export function resolveSmokeApiBase(options: {
  apiBase: string | null;
  pageUrl: string;
}): string;
