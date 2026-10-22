import { notFound } from "next/navigation";

import FrontendControlsFixturePage from "../../../scripts/fixtures/frontend-controls-page";

export default function FrontendControlsPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <FrontendControlsFixturePage />;
}
