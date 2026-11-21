"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ComponentPropsWithoutRef, ComponentPropsWithRef } from "react";

import { cn } from "@/shared/utils/className";

import { Button, type ButtonProps } from "./Button";

/**
 * Confirmation modal (`role="alertdialog"`) built on `@radix-ui/react-dialog`
 * that blocks outside-click dismissal so destructive or costly operations
 * always require an explicit decision.
 */
function AlertDialog(
  props: Omit<ComponentPropsWithoutRef<typeof DialogPrimitive.Root>, "modal">,
) {
  return <DialogPrimitive.Root modal {...props} />;
}

function AlertDialogTrigger({
  ref,
  ...props
}: ComponentPropsWithRef<typeof DialogPrimitive.Trigger>) {
  return (
    <DialogPrimitive.Trigger
      ref={ref}
      data-slot="alert-dialog-trigger"
      {...props}
    />
  );
}
AlertDialogTrigger.displayName = "AlertDialogTrigger";

function AlertDialogPortal(props: ComponentPropsWithRef<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal {...props} />;
}
AlertDialogPortal.displayName = "AlertDialogPortal";

function AlertDialogOverlay({
  className,
  ref,
  ...props
}: ComponentPropsWithRef<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      ref={ref}
      className={cn("fm-dialog__overlay fm-alert-dialog__overlay", className)}
      data-slot="alert-dialog-overlay"
      {...props}
    />
  );
}
AlertDialogOverlay.displayName = "AlertDialogOverlay";

function AlertDialogContent({
  className,
  onInteractOutside,
  onPointerDownOutside,
  ref,
  ...props
}: ComponentPropsWithRef<typeof DialogPrimitive.Content>) {
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn("fm-dialog fm-alert-dialog", className)}
        data-slot="alert-dialog-content"
        role="alertdialog"
        onInteractOutside={(event) => {
          event.preventDefault();
          onInteractOutside?.(event);
        }}
        onPointerDownOutside={(event) => {
          event.preventDefault();
          onPointerDownOutside?.(event);
        }}
        {...props}
      />
    </AlertDialogPortal>
  );
}
AlertDialogContent.displayName = "AlertDialogContent";

function AlertDialogHeader({
  className,
  ...props
}: ComponentPropsWithRef<"div">) {
  return (
    <div
      className={cn("fm-dialog__header", className)}
      data-slot="alert-dialog-header"
      {...props}
    />
  );
}

function AlertDialogFooter({
  className,
  ...props
}: ComponentPropsWithRef<"div">) {
  return (
    <div
      className={cn("fm-dialog__footer", className)}
      data-slot="alert-dialog-footer"
      {...props}
    />
  );
}

function AlertDialogTitle({
  className,
  ref,
  ...props
}: ComponentPropsWithRef<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      ref={ref}
      className={cn("fm-dialog__title", className)}
      data-slot="alert-dialog-title"
      {...props}
    />
  );
}
AlertDialogTitle.displayName = "AlertDialogTitle";

function AlertDialogDescription({
  className,
  ref,
  ...props
}: ComponentPropsWithRef<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      ref={ref}
      className={cn("fm-dialog__description", className)}
      data-slot="alert-dialog-description"
      {...props}
    />
  );
}
AlertDialogDescription.displayName = "AlertDialogDescription";

function AlertDialogAction({
  className,
  size = "md",
  variant = "primary",
  ...props
}: ButtonProps) {
  return (
    <DialogPrimitive.Close asChild>
      <Button
        className={className}
        data-slot="alert-dialog-action"
        size={size}
        variant={variant}
        {...props}
      />
    </DialogPrimitive.Close>
  );
}

function AlertDialogCancel({
  className,
  size = "md",
  variant = "secondary",
  ...props
}: ButtonProps) {
  return (
    <DialogPrimitive.Close asChild>
      <Button
        className={className}
        data-slot="alert-dialog-cancel"
        size={size}
        variant={variant}
        {...props}
      />
    </DialogPrimitive.Close>
  );
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
};
