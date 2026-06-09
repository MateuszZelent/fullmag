export interface InspectorDraftState<TDraft> {
  baseKey: string;
  dirty: boolean;
  draft: TDraft;
  identityKey: string;
}

export interface ResolvedInspectorDraftState<TDraft> {
  dirty: boolean;
  draft: TDraft;
}

export function initialInspectorDraftState<TDraft>({
  baseDraft,
  baseKey,
  identityKey,
}: {
  baseDraft: TDraft;
  baseKey: string;
  identityKey: string;
}): InspectorDraftState<TDraft> {
  return {
    baseKey,
    dirty: false,
    draft: baseDraft,
    identityKey,
  };
}

export function resolveInspectorDraftState<TDraft>({
  baseDraft,
  baseKey,
  identityKey,
  isDirty,
  state,
}: {
  baseDraft: TDraft;
  baseKey: string;
  identityKey: string;
  isDirty: (draft: TDraft, baseDraft: TDraft) => boolean;
  state: InspectorDraftState<TDraft>;
}): ResolvedInspectorDraftState<TDraft> {
  if (state.identityKey !== identityKey) {
    return { dirty: false, draft: baseDraft };
  }
  if (state.baseKey !== baseKey && !state.dirty) {
    return { dirty: false, draft: baseDraft };
  }
  const dirty = isDirty(state.draft, baseDraft);
  return {
    dirty,
    draft: state.draft,
  };
}

export function updateInspectorDraftState<TDraft>({
  baseDraft,
  baseKey,
  currentDraft,
  identityKey,
  isDirty,
  patch,
}: {
  baseDraft: TDraft;
  baseKey: string;
  currentDraft: TDraft;
  identityKey: string;
  isDirty: (draft: TDraft, baseDraft: TDraft) => boolean;
  patch: Partial<TDraft>;
}): InspectorDraftState<TDraft> {
  const draft = {
    ...currentDraft,
    ...patch,
  };
  return {
    baseKey,
    dirty: isDirty(draft, baseDraft),
    draft,
    identityKey,
  };
}
