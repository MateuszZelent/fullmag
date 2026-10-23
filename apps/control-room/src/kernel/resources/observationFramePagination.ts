import type { ObservationFrameListQuery, ObservationFrameListResource, ObservationFrameResource } from "../api/apiTypes";

export interface ObservationFramePage {
  cursor: string | null;
  data: ObservationFrameListResource;
}

export interface ObservationFramePagesState {
  owner: string;
  cursor: string | null;
  pages: ObservationFramePage[];
  retained: ObservationFrameResource[];
  refresh: { remaining: number; pages: ObservationFramePage[]; awaitingRequest?: boolean } | null;
  error: Error | null;
  rejectedPage: ObservationFrameListResource | null;
}

export function initialObservationFramePages(owner: string): ObservationFramePagesState {
  return { owner, cursor: null, pages: [], retained: [], refresh: null, error: null, rejectedPage: null };
}

export function validateObservationFramePage(
  data: ObservationFrameListResource,
  query: ObservationFrameListQuery,
): ObservationFrameListResource {
  const limit = query.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || data.frames.length > limit) {
    throw new Error("Observation frame page exceeds its requested limit.");
  }
  if (!data.run_id || (query.run_id && data.run_id !== query.run_id)) {
    throw new Error("Observation frame page belongs to a different run.");
  }
  const ids = new Set<string>();
  for (const frame of data.frames) {
    if (!frame.frame_id || ids.has(frame.frame_id) || frame.frame_id === query.cursor) {
      throw new Error("Observation frame page repeated a frame identity.");
    }
    if (frame.run_id !== data.run_id || (query.stage_id && frame.stage_id !== query.stage_id)) {
      throw new Error("Observation frame does not belong to the requested run and stage.");
    }
    ids.add(frame.frame_id);
  }
  if (data.next_cursor != null && (data.next_cursor === query.cursor
    || data.next_cursor !== data.frames.at(-1)?.frame_id)) {
    throw new Error("Observation frame page cursor did not advance to its last frame.");
  }
  return data;
}

export function acceptObservationFramePage(
  state: ObservationFramePagesState,
  data: ObservationFrameListResource,
): ObservationFramePagesState {
  const existingIndex = state.pages.findIndex((page) => page.cursor === state.cursor);
  if (!state.refresh && existingIndex >= 0 && state.pages[existingIndex].data === data) return state;
  const prefix = state.refresh?.pages
    ?? (existingIndex < 0 ? state.pages : state.pages.slice(0, existingIndex));
  const previous = prefix.at(-1);
  if ((state.cursor === null && prefix.length > 0)
    || (state.cursor !== null && previous?.data.next_cursor !== state.cursor)) {
    throw new Error("Observation frame pagination lost its cursor chain. Refresh snapshots.");
  }
  if (previous && previous.data.run_id !== data.run_id) {
    throw new Error("Observation frame pages belong to different runs.");
  }
  const ids = new Set(prefix.flatMap((page) => page.data.frames.map((frame) => frame.frame_id)));
  for (const frame of data.frames) {
    if (ids.has(frame.frame_id)) throw new Error("Observation frame pagination repeated a frame.");
    ids.add(frame.frame_id);
  }
  const pages = [...prefix, { cursor: state.cursor, data }];
  const nextCursor = data.next_cursor ?? null;
  if (nextCursor !== null && pages.some((page) => page.cursor === nextCursor)) {
    throw new Error("Observation frame pagination repeated a cursor.");
  }
  if (state.refresh && state.refresh.remaining > 1 && nextCursor !== null) {
    return { ...state, cursor: nextCursor, refresh: { remaining: state.refresh.remaining - 1, pages, awaitingRequest: true }, error: null, rejectedPage: null };
  }
  // New stage publications may sort before an old page boundary. A bounded
  // refresh must not erase previously loaded selections outside its new window.
  const priorFrames = [...state.pages.flatMap((page) => page.data.frames), ...state.retained];
  const retained = nextCursor === null ? [] : priorFrames.filter((frame) => !ids.has(frame.frame_id));
  return { ...state, pages, retained, refresh: null, error: null, rejectedPage: null };
}

export function mergeObservationFramePages(pages: ObservationFramePage[], retained: ObservationFrameResource[] = []): ObservationFrameListResource | null {
  const last = pages.at(-1);
  return last ? { run_id: last.data.run_id, frames: [...pages.flatMap((page) => page.data.frames), ...retained], next_cursor: last.data.next_cursor ?? null } : null;
}
