import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

interface CapturedSubContentProps {
  onFocusOutside?: (event: {
    defaultPrevented: boolean;
    preventDefault: () => void;
    target: unknown;
  }) => void;
  [key: string]: unknown;
}

const capturedDropdownSubProps: CapturedSubContentProps[] = [];
const capturedContextSubProps: CapturedSubContentProps[] = [];

vi.mock("@radix-ui/react-dropdown-menu", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@radix-ui/react-dropdown-menu")
  >();

  return {
    ...actual,
    Portal: ({ children }: { children?: ReactNode }) => (
      <div data-mock-portal="dropdown">{children}</div>
    ),
    SubContent: (
      props: ComponentPropsWithoutRef<typeof actual.SubContent>,
    ) => {
      capturedDropdownSubProps.push(props as unknown as CapturedSubContentProps);
      return (
        <div
          className={props.className}
          data-slot={(props as Record<string, unknown>)["data-slot"] as string}
        >
          {props.children}
        </div>
      );
    },
  };
});

vi.mock("@radix-ui/react-context-menu", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@radix-ui/react-context-menu")
  >();

  return {
    ...actual,
    Portal: ({ children }: { children?: ReactNode }) => (
      <div data-mock-portal="context">{children}</div>
    ),
    SubContent: (
      props: ComponentPropsWithoutRef<typeof actual.SubContent>,
    ) => {
      capturedContextSubProps.push(props as unknown as CapturedSubContentProps);
      return (
        <div
          className={props.className}
          data-slot={(props as Record<string, unknown>)["data-slot"] as string}
        >
          {props.children}
        </div>
      );
    },
  };
});

import { ContextMenuSubContent } from "./ContextMenu";
import { DropdownMenuSubContent } from "./DropdownMenu";

function makeFocusOutsideEvent(slot: string | null) {
  let defaultPrevented = false;
  return {
    get defaultPrevented() {
      return defaultPrevented;
    },
    preventDefault: vi.fn(() => {
      defaultPrevented = true;
    }),
    target: {
      getAttribute: (name: string) => (name === "data-slot" ? slot : null),
    },
  };
}

describe("DropdownMenuSubContent & ContextMenuSubContent", () => {
  it("portals DropdownMenuSubContent and prevents premature collapse when focus bounces to a parent menu container", () => {
    capturedDropdownSubProps.length = 0;
    const callerFocusOutside = vi.fn();

    const html = renderToStaticMarkup(
      <DropdownMenuSubContent onFocusOutside={callerFocusOutside}>
        <span>Hole Cutter</span>
      </DropdownMenuSubContent>,
    );

    expect(html).toContain('data-mock-portal="dropdown"');
    expect(html).toContain('data-slot="dropdown-menu-sub-content"');
    expect(html).toContain("Hole Cutter");
    expect(capturedDropdownSubProps).toHaveLength(1);

    const onFocusOutside = capturedDropdownSubProps[0]?.onFocusOutside;
    expect(onFocusOutside).toBeTypeOf("function");

    // Parent menu container focus bounce (Radix onItemLeave on side="left" flip) -> prevented
    const parentBounce = makeFocusOutsideEvent("dropdown-menu-content");
    onFocusOutside?.(parentBounce);
    expect(parentBounce.preventDefault).toHaveBeenCalledTimes(1);
    expect(callerFocusOutside).toHaveBeenCalledTimes(1);

    // Nested parent submenu container bounce -> prevented
    const nestedBounce = makeFocusOutsideEvent("dropdown-menu-sub-content");
    onFocusOutside?.(nestedBounce);
    expect(nestedBounce.preventDefault).toHaveBeenCalledTimes(1);

    // Sibling menuitem (no menu-container data-slot) -> NOT prevented, so submenu closes cleanly
    const siblingItem = makeFocusOutsideEvent(null);
    onFocusOutside?.(siblingItem);
    expect(siblingItem.preventDefault).not.toHaveBeenCalled();
  });

  it("portals ContextMenuSubContent and applies the same parent-container focus bounce guard", () => {
    capturedContextSubProps.length = 0;

    const html = renderToStaticMarkup(
      <ContextMenuSubContent>
        <span>Sub Action</span>
      </ContextMenuSubContent>,
    );

    expect(html).toContain('data-mock-portal="context"');
    expect(html).toContain('data-slot="context-menu-sub-content"');
    expect(capturedContextSubProps).toHaveLength(1);

    const onFocusOutside = capturedContextSubProps[0]?.onFocusOutside;
    const parentBounce = makeFocusOutsideEvent("context-menu-content");
    onFocusOutside?.(parentBounce);
    expect(parentBounce.preventDefault).toHaveBeenCalledTimes(1);

    const siblingItem = makeFocusOutsideEvent(null);
    onFocusOutside?.(siblingItem);
    expect(siblingItem.preventDefault).not.toHaveBeenCalled();
  });
});
