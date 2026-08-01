"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ComponentPropsWithRef } from "react";

import { cn } from "@/shared/utils/className";

const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetClose = DialogPrimitive.Close;
const SheetPortal = DialogPrimitive.Portal;

function SheetOverlay({
  className,
  ref,
  ...props
}: ComponentPropsWithRef<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      ref={ref}
      className={cn("fm-sheet__overlay", className)}
      {...props}
    />
  );
}
SheetOverlay.displayName = DialogPrimitive.Overlay.displayName;

type SheetSide = "top" | "right" | "bottom" | "left";

interface SheetContentProps
  extends ComponentPropsWithRef<typeof DialogPrimitive.Content> {
  side?: SheetSide;
}

function SheetContent({
  className,
  children,
  side = "right",
  ref,
  ...props
}: SheetContentProps) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn("fm-sheet__content", `fm-sheet__content--${side}`, className)}
        {...props}
      >
        {children}
        <DialogPrimitive.Close className="fm-sheet__close" aria-label="Close">
          <X size={16} aria-hidden="true" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </SheetPortal>
  );
}
SheetContent.displayName = "SheetContent";

function SheetHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("fm-sheet__header", className)} {...props} />;
}

function SheetTitle({
  className,
  ref,
  ...props
}: ComponentPropsWithRef<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title ref={ref} className={cn("fm-sheet__title", className)} {...props} />
  );
}

function SheetDescription({
  className,
  ref,
  ...props
}: ComponentPropsWithRef<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      ref={ref}
      className={cn("fm-sheet__description", className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetOverlay,
  SheetPortal,
  SheetTitle,
  SheetTrigger,
};
