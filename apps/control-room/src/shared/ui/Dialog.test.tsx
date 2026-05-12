import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@radix-ui/react-dialog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@radix-ui/react-dialog")>();

  return {
    ...actual,
    Portal: ({ children }: { children: ReactNode }) => <>{children}</>,
  };
});

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
