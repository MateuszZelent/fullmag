import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";

import {
  installSimulationPreparationTestDom,
  type TestElement,
  TestEvent,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

vi.mock("@radix-ui/react-tooltip", () => ({
  Provider: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Content: ({ children }: { children?: ReactNode }) => (
    <span data-slot="mock-tooltip-content">{children}</span>
  ),
}));

vi.mock("@radix-ui/react-hover-card", () => ({
  Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Content: ({ children }: { children?: ReactNode }) => (
    <div data-slot="mock-hover-card">{children}</div>
  ),
}));

vi.mock("@radix-ui/react-dropdown-menu", () => ({
  Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Group: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Sub: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SubTrigger: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SubContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Content: ({ children }: { children?: ReactNode }) => (
    <div data-slot="mock-dropdown-menu-content">{children}</div>
  ),
  Item: ({
    children,
    disabled,
    onSelect,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onSelect?: (event: Event) => void;
  }) => (
    <button
      disabled={disabled}
      role="menuitem"
      type="button"
      onClick={() => onSelect?.(new Event("select"))}
    >
      {children}
    </button>
  ),
  CheckboxItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  RadioGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  RadioItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ItemIndicator: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Label: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Separator: () => <hr />,
}));

vi.mock("@radix-ui/react-context-menu", () => ({
  Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Group: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Sub: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SubTrigger: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SubContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Content: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Item: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  CheckboxItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  RadioGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  RadioItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ItemIndicator: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Label: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Separator: () => <hr />,
}));

vi.mock("@radix-ui/react-dialog", () => ({
  Root: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
    open ? <div data-slot="mock-dialog-root">{children}</div> : null,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Overlay: () => <div data-slot="mock-dialog-overlay" />,
  Content: ({
    children,
    role,
  }: {
    children?: ReactNode;
    role?: string;
  }) => (
    <div data-slot="mock-dialog-content" role={role ?? "dialog"}>
      {children}
    </div>
  ),
  Title: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  Description: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  Close: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock("@radix-ui/react-tabs", async () => {
  const React = await import("react");
  const TabsCtx = React.createContext<{
    value?: string;
    onValueChange?: (next: string) => void;
  }>({});
  return {
    Root: ({
      children,
      className,
      value,
      onValueChange,
    }: {
      children?: ReactNode;
      className?: string;
      value?: string;
      onValueChange?: (next: string) => void;
    }) => (
      <TabsCtx.Provider value={{ value, onValueChange }}>
        <div className={className}>{children}</div>
      </TabsCtx.Provider>
    ),
    List: ({
      children,
      className,
      ...props
    }: {
      children?: ReactNode;
      className?: string;
    }) => (
      <div className={className} role="tablist" {...props}>
        {children}
      </div>
    ),
    Trigger: ({
      children,
      className,
      value,
      onClick,
    }: {
      children?: ReactNode;
      className?: string;
      value: string;
      onClick?: () => void;
    }) => {
      const ctx = React.useContext(TabsCtx);
      const active = ctx.value === value;
      return (
        <button
          aria-selected={active}
          className={className}
          data-state={active ? "active" : "inactive"}
          data-value={value}
          role="tab"
          type="button"
          onClick={() => {
            onClick?.();
            ctx.onValueChange?.(value);
          }}
        >
          {children}
        </button>
      );
    },
    Content: ({
      children,
      hidden,
    }: {
      children?: ReactNode;
      hidden?: boolean;
    }) => <div hidden={hidden}>{children}</div>,
  };
});

vi.mock("@radix-ui/react-select", async () => {
  const React = await import("react");
  const SelectCtx = React.createContext<{
    value?: string;
    onValueChange?: (next: string) => void;
  }>({});
  return {
    Root: ({
      children,
      value,
      onValueChange,
    }: {
      children?: ReactNode;
      value?: string;
      onValueChange?: (next: string) => void;
    }) => (
      <SelectCtx.Provider value={{ value, onValueChange }}>
        <div data-slot="mock-select" data-value={value ?? ""}>
          {children}
        </div>
      </SelectCtx.Provider>
    ),
    Group: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    Value: ({ placeholder }: { placeholder?: string }) => {
      const ctx = React.useContext(SelectCtx);
      return <span>{ctx.value ?? placeholder ?? ""}</span>;
    },
    Trigger: Object.assign(
      ({ children, className }: { children?: ReactNode; className?: string }) => (
        <button className={className} type="button">
          {children}
        </button>
      ),
      { displayName: "SelectTrigger" },
    ),
    Icon: ({ children }: { children?: ReactNode }) => <>{children}</>,
    Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
    Content: Object.assign(
      ({ children, className }: { children?: ReactNode; className?: string }) => (
        <div className={className}>{children}</div>
      ),
      { displayName: "SelectContent" },
    ),
    Viewport: ({ children, className }: { children?: ReactNode; className?: string }) => (
      <div className={className}>{children}</div>
    ),
    ScrollUpButton: Object.assign(() => <div />, { displayName: "SelectScrollUpButton" }),
    ScrollDownButton: Object.assign(() => <div />, { displayName: "SelectScrollDownButton" }),
    Label: Object.assign(
      ({ children, className }: { children?: ReactNode; className?: string }) => (
        <div className={className}>{children}</div>
      ),
      { displayName: "SelectLabel" },
    ),
    Item: Object.assign(
      ({
        children,
        className,
        disabled,
        value,
      }: {
        children?: ReactNode;
        className?: string;
        disabled?: boolean;
        value: string;
      }) => {
        const ctx = React.useContext(SelectCtx);
        return (
          <button
            className={className}
            data-value={value}
            disabled={disabled}
            type="button"
            onClick={() => ctx.onValueChange?.(value)}
          >
            {children}
          </button>
        );
      },
      { displayName: "SelectItem" },
    ),
    ItemText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    ItemIndicator: ({ children }: { children?: ReactNode }) => <>{children}</>,
    Separator: Object.assign(() => <hr />, { displayName: "SelectSeparator" }),
  };
});

vi.mock("@radix-ui/react-slider", () => ({
  Root: ({
    children,
    className,
    value,
  }: {
    children?: ReactNode;
    className?: string;
    value?: readonly number[];
  }) => (
    <div className={className} data-slot="mock-slider" data-value={value?.[0] ?? 0}>
      {children}
    </div>
  ),
  Track: ({ children, className }: { children?: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  Range: ({ className }: { className?: string }) => <div className={className} />,
  Thumb: ({ className }: { className?: string }) => (
    <span
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={0}
      className={className}
      role="slider"
    />
  ),
}));

vi.mock("@/shared/ui/AlertDialog", () => ({
  AlertDialog: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
    open ? <div data-slot="alert-dialog-root">{children}</div> : null,
  AlertDialogAction: ({
    children,
    onClick,
  }: {
    children?: ReactNode;
    onClick?: () => void;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  AlertDialogCancel: ({
    children,
    onClick,
  }: {
    children?: ReactNode;
    onClick?: () => void;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  AlertDialogContent: ({
    children,
    ...props
  }: {
    children?: ReactNode;
    [key: string]: unknown;
  }) => (
    <section data-slot="alert-dialog-content" role="alertdialog" {...props}>
      {children}
    </section>
  ),
  AlertDialogDescription: ({ children }: { children?: ReactNode }) => (
    <div data-slot="alert-dialog-description">{children}</div>
  ),
  AlertDialogFooter: ({ children }: { children?: ReactNode }) => (
    <footer data-slot="alert-dialog-footer">{children}</footer>
  ),
  AlertDialogHeader: ({ children }: { children?: ReactNode }) => (
    <header data-slot="alert-dialog-header">{children}</header>
  ),
  AlertDialogTitle: ({ children }: { children?: ReactNode }) => (
    <h2 data-slot="alert-dialog-title">{children}</h2>
  ),
}));

export interface MountedWave5TestDom {
  container: TestElement;
  root: Root;
  unmount: () => void;
}

export function mountWave5TestDom(): MountedWave5TestDom {
  const env = installSimulationPreparationTestDom();
  (
    env.document.defaultView as unknown as {
      getSelection?: () => {
        anchorNode: null;
        anchorOffset: number;
        focusNode: null;
        focusOffset: number;
        rangeCount: number;
      };
    }
  ).getSelection = () => ({
    anchorNode: null,
    anchorOffset: 0,
    focusNode: null,
    focusOffset: 0,
    rangeCount: 0,
  });
  const container = env.document.createElement("div");
  env.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  return {
    container,
    root,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      env.restore();
    },
  };
}

type TestInputCompat = TestElement & {
  _onPropertyChange?: (event: {
    propertyName: string;
    target: TestElement;
    srcElement: TestElement;
  }) => void;
  _valueTracker?: { setValue: (value: string) => void };
  attachEvent?: (
    name: string,
    listener: (event: {
      propertyName: string;
      target: TestElement;
      srcElement: TestElement;
    }) => void,
  ) => void;
  detachEvent?: (name: string) => void;
};

export async function setTestInputValue(
  input: TestElement,
  nextValue: string,
): Promise<void> {
  const compat = input as TestInputCompat;
  if (!compat.attachEvent) {
    compat.attachEvent = (_name, listener) => {
      compat._onPropertyChange = listener;
    };
    compat.detachEvent = () => {
      compat._onPropertyChange = undefined;
    };
  }
  await act(async () => {
    input.focus();
    input.dispatchEvent(new TestEvent("focusin", { bubbles: true }));
  });
  await act(async () => {
    const previous = input.value;
    input.value = nextValue;
    compat._valueTracker?.setValue(previous);
    if (compat._onPropertyChange) {
      compat._onPropertyChange({
        propertyName: "value",
        target: input,
        srcElement: input,
      });
    } else {
      input.dispatchEvent(new TestEvent("input", { bubbles: true }));
    }
  });
  await act(async () => {
    input.dispatchEvent(new TestEvent("focusout", { bubbles: true }));
  });
}
