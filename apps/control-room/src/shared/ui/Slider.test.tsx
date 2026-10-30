import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Slider } from "./Slider";

describe("Slider", () => {
  it("forwards aria-valuetext to the Radix slider Thumb", () => {
    const html = renderToStaticMarkup(
      <Slider
        aria-label="Saved frame index"
        aria-valuetext="Sample 2 of 6"
        max={5}
        min={0}
        value={[1]}
      />,
    );

    expect(html).toMatch(
      /<span[^>]*role="slider"[^>]*aria-valuetext="Sample 2 of 6"[^>]*>/,
    );
  });
});
