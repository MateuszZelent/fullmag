"use client";

import type { ComponentPropsWithRef, MouseEvent } from "react";

import { cn } from "@/shared/utils/className";

import { Button, type ButtonProps } from "./Button";

export function InputGroup({
  className,
  ref,
  ...props
}: ComponentPropsWithRef<"div">) {
  return (
    <div
      ref={ref}
      className={cn("fm-input-group", className)}
      data-slot="input-group"
      role="group"
      {...props}
    />
  );
}

export type InputGroupAddonAlign =
  | "inline-start"
  | "inline-end"
  | "block-start"
  | "block-end";

export interface InputGroupAddonProps extends ComponentPropsWithRef<"div"> {
  align?: InputGroupAddonAlign;
}

export function InputGroupAddon({
  align = "inline-start",
  className,
  onClick,
  ref,
  ...props
}: InputGroupAddonProps) {
  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    const target = event.target as HTMLElement | null;
    if (
      target?.closest("button") ||
      target?.closest("a") ||
      target?.closest('[role="button"]')
    ) {
      return;
    }
    const control = event.currentTarget.parentElement?.querySelector<HTMLElement>(
      '[data-slot="input-group-control"]',
    );
    control?.focus();
  };

  return (
    <div
      ref={ref}
      className={cn("fm-input-group__addon", className)}
      data-align={align}
      data-slot="input-group-addon"
      onClick={handleClick}
      {...props}
    />
  );
}

export function InputGroupText({
  className,
  ref,
  ...props
}: ComponentPropsWithRef<"span">) {
  return (
    <span
      ref={ref}
      className={cn("fm-input-group__text", className)}
      data-slot="input-group-text"
      {...props}
    />
  );
}

export function InputGroupButton({
  className,
  size = "sm",
  type = "button",
  variant = "ghost",
  ...props
}: ButtonProps) {
  return (
    <Button
      className={cn("fm-input-group__button", className)}
      data-slot="input-group-button"
      size={size}
      type={type}
      variant={variant}
      {...props}
    />
  );
}

export function InputGroupInput({
  className,
  ref,
  ...props
}: ComponentPropsWithRef<"input">) {
  return (
    <input
      ref={ref}
      className={cn("fm-input-group__input", className)}
      data-slot="input-group-control"
      {...props}
    />
  );
}

export function InputGroupTextarea({
  className,
  ref,
  ...props
}: ComponentPropsWithRef<"textarea">) {
  return (
    <textarea
      ref={ref}
      className={cn("fm-input-group__textarea", className)}
      data-slot="input-group-control"
      {...props}
    />
  );
}
