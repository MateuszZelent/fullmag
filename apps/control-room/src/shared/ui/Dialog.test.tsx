import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./Dialog";

describe("Dialog", () => {
  it("renders shadcn-compatible dialog primitives with fm-prefixed classes", () => {
    const html = renderToStaticMarkup(
      <Dialog open>
        <DialogContent>
          <DialogTitle>API error</DialogTitle>
          <DialogDescription>Details</DialogDescription>
        </DialogContent>
      </Dialog>,
    );

    expect(html).toContain("fm-dialog");
    expect(html).toContain("fm-dialog__overlay");
    expect(html).toContain("API error");
  });
});
