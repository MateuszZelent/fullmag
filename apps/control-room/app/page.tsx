import type { Metadata } from "next";

import WorkspacePage from "./workspace/page";

export const metadata: Metadata = {
  title: "Fullmag Control Room",
  description: "Interactive Fullmag workspace for geometry, solver, and viewport workflows.",
};

/**
 * The root page is the workspace as well. The dev server redirects `/` to
 * `/workspace` before compiling any page (next.config.ts); a static export is
 * served with this page for every unknown path, so reloading a tab address
 * (src/kernel/layout/tabRoutes.ts) returns to that tab.
 */
export default function HomePage() {
  return <WorkspacePage />;
}
