"use client";

import * as ToastPrimitive from "@radix-ui/react-toast";
import { X } from "lucide-react";
import type { ComponentPropsWithRef } from "react";

import { cn } from "@/shared/utils/className";

const ToastProvider = ToastPrimitive.Provider;

function ToastViewport({
  className,
  ref,
  ...props
}: ComponentPropsWithRef<typeof ToastPrimitive.Viewport>) {
  return (
    <ToastPrimitive.Viewport
      ref={ref}
      className={cn("fm-toast-viewport", className)}
      {...props}
    />
  );
}
ToastViewport.displayName = ToastPrimitive.Viewport.displayName;

type ToastVariant = "default" | "success" | "warning" | "error";

interface ToastProps extends ComponentPropsWithRef<typeof ToastPrimitive.Root> {
  variant?: ToastVariant;
}

function Toast({ className, variant = "default", ref, ...props }: ToastProps) {
  return (
    <ToastPrimitive.Root
      ref={ref}
      className={cn("fm-toast", className)}
      data-variant={variant}
      {...props}
    />
  );
}
Toast.displayName = ToastPrimitive.Root.displayName;

function ToastAction({
  className,
  ref,
  ...props
}: ComponentPropsWithRef<typeof ToastPrimitive.Action>) {
  return (
    <ToastPrimitive.Action
      ref={ref}
      className={cn("fm-toast__action", className)}
      {...props}
    />
  );
}
ToastAction.displayName = ToastPrimitive.Action.displayName;

function ToastClose({
  className,
  ref,
  ...props
}: ComponentPropsWithRef<typeof ToastPrimitive.Close>) {
  return (
    <ToastPrimitive.Close
      ref={ref}
      className={cn("fm-toast__close", className)}
      aria-label="Dismiss"
      {...props}
    >
      <X size={14} aria-hidden="true" />
    </ToastPrimitive.Close>
  );
}
ToastClose.displayName = ToastPrimitive.Close.displayName;

function ToastTitle({
  className,
  ref,
  ...props
}: ComponentPropsWithRef<typeof ToastPrimitive.Title>) {
  return (
    <ToastPrimitive.Title
      ref={ref}
      className={cn("fm-toast__title", className)}
      {...props}
    />
  );
}
ToastTitle.displayName = ToastPrimitive.Title.displayName;

function ToastDescription({
  className,
  ref,
  ...props
}: ComponentPropsWithRef<typeof ToastPrimitive.Description>) {
  return (
    <ToastPrimitive.Description
      ref={ref}
      className={cn("fm-toast__description", className)}
      {...props}
    />
  );
}
ToastDescription.displayName = ToastPrimitive.Description.displayName;

export {
  Toast,
  ToastAction,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
};
export type { ToastVariant };
