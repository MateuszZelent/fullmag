import { type FramesPage } from "../model/framesModel";

export type FrameStep = "first" | "previous" | "next" | "last";

/** The position after a prev/next/first/last request, kept inside the index. */
export function stepPosition(position: number, total: number, step: FrameStep): number {
  if (total <= 0) return 0;
  const last = total - 1;
  switch (step) {
    case "first":
      return 0;
    case "last":
      return last;
    case "previous":
      return Math.max(0, Math.min(position, last) - 1);
    case "next":
      return Math.min(last, Math.max(position, 0) + 1);
  }
}

/** Why a page could not be used; null when it is a usable page of an index. */
export function pageProblem(page: FramesPage): string | null {
  return page.indexed ? null : "The backend lists no saved frames for this folder.";
}
