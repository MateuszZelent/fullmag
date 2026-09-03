"use client";

import { useState, type ComponentPropsWithRef } from "react";

import { cn } from "@/shared/utils/className";

export function Avatar({ className, ...props }: ComponentPropsWithRef<"span">) {
  return (
    <span
      className={cn("fm-avatar", className)}
      data-slot="avatar"
      {...props}
    />
  );
}

/**
 * Dependency-free avatar image (frontend audit 2026-09-03, P2 item — no
 * @radix-ui/react-avatar in this workspace). Falls back to hiding itself on
 * load error so a sibling <AvatarFallback> shows through.
 */
export function AvatarImage({
  className,
  onError,
  ...props
}: ComponentPropsWithRef<"img">) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;

  return (
    // eslint-disable-next-line @next/next/no-img-element -- avatar sources are runtime/user-provided, not static assets
    <img
      className={cn("fm-avatar__image", className)}
      data-slot="avatar-image"
      onError={(event) => {
        setFailed(true);
        onError?.(event);
      }}
      {...props}
    />
  );
}

export function AvatarFallback({
  className,
  ...props
}: ComponentPropsWithRef<"span">) {
  return (
    <span
      className={cn("fm-avatar__fallback", className)}
      data-slot="avatar-fallback"
      {...props}
    />
  );
}
