import { notFound } from "next/navigation";

import FrontendControlsFixturePage from "../../../scripts/fixtures/frontend-controls-page";

export default function FrontendControlsPage() {
  if (
    process.env.NODE_ENV !== "development" &&
    process.env.NEXT_PUBLIC_AUDIT_BUILD !== "1"
  ) {
    notFound();
  }
  return <FrontendControlsFixturePage />;
}
