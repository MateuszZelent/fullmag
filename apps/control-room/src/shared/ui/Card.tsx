import type { ComponentPropsWithRef } from "react";

import { cn } from "@/shared/utils/className";

export function Card({ className, ...props }: ComponentPropsWithRef<"div">) {
  return (
    <div className={cn("fm-card", className)} data-slot="card" {...props} />
  );
}

export function CardHeader({
  className,
  ...props
}: ComponentPropsWithRef<"div">) {
  return (
    <div
      className={cn("fm-card__header", className)}
      data-slot="card-header"
      {...props}
    />
  );
}

export function CardTitle({
  className,
  ...props
}: ComponentPropsWithRef<"h3">) {
  return (
    <h3
      className={cn("fm-card__title", className)}
      data-slot="card-title"
      {...props}
    />
  );
}

export function CardDescription({
  className,
  ...props
}: ComponentPropsWithRef<"p">) {
  return (
    <p
      className={cn("fm-card__description", className)}
      data-slot="card-description"
      {...props}
    />
  );
}

export function CardContent({
  className,
  ...props
}: ComponentPropsWithRef<"div">) {
  return (
    <div
      className={cn("fm-card__content", className)}
      data-slot="card-content"
      {...props}
    />
  );
}

export function CardFooter({
  className,
  ...props
}: ComponentPropsWithRef<"div">) {
  return (
    <div
      className={cn("fm-card__footer", className)}
      data-slot="card-footer"
      {...props}
    />
  );
}
