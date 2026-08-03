import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { useAnalysisViewPreferencesHydration } from "./useAnalysisViewPreferencesHydration";

function PreferencesProbe() {
  const { isHydrated, preferences } = useAnalysisViewPreferencesHydration();
  return <span>{`${preferences.activeSurface}:${isHydrated}`}</span>;
}

describe("analysis preference hydration", () => {
  it("uses the stable server snapshot during SSR", () => {
    expect(renderToStaticMarkup(<PreferencesProbe />)).toContain("dynamics:false");
  });
});
