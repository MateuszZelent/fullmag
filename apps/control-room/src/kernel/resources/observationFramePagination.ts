import type { ObservationFrameListQuery, ObservationFrameListResource, ObservationFrameResource } from "../api/apiTypes";

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
  if (data.next_cursor != null && data.next_cursor !== data.frames.at(-1)?.frame_id) {
    throw new Error("Observation frame page cursor did not advance to its last frame.");
  }
  return data;
}

export async function loadObservationFrameWindow(
  previous: ObservationFrameListResource[],
  append: boolean,
  load: (cursor: string | null) => Promise<ObservationFrameListResource>,
): Promise<ObservationFrameListResource[]> {
  const pages = append ? [...previous] : [];
  const pageCount = append ? previous.length + 1 : Math.max(1, previous.length);
  const seen = new Set(pages.flatMap((page) => page.frames.map((frame) => frame.frame_id)));
  while (pages.length < pageCount) {
    const cursor = pages.at(-1)?.next_cursor ?? null;
    if (pages.length > 0 && cursor === null) break;
    const page = await load(cursor);
    for (const frame of page.frames) {
      if (seen.has(frame.frame_id)) {
        throw new Error("Observation frame pagination repeated a frame. Refresh snapshots.");
      }
      seen.add(frame.frame_id);
    }
    pages.push(page);
  }
  return pages;
}

export function mergeObservationFramePages(
  pages: ObservationFrameListResource[],
  selected: ObservationFrameResource | null,
): ObservationFrameListResource | null {
  const last = pages.at(-1);
  if (!last) return null;
  const frames = pages.flatMap((page) => page.frames);
  if (last.next_cursor && selected && !frames.some((frame) => frame.frame_id === selected.frame_id)) {
    frames.push(selected);
  }
  return { run_id: last.run_id, frames, next_cursor: last.next_cursor ?? null };
}
