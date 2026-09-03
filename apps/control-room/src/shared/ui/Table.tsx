import type { ComponentPropsWithRef } from "react";

import { cn } from "@/shared/utils/className";

export function Table({
  className,
  ...props
}: ComponentPropsWithRef<"table">) {
  return (
    <div className="fm-table__wrapper" data-slot="table-wrapper">
      <table className={cn("fm-table", className)} data-slot="table" {...props} />
    </div>
  );
}

export function TableHeader({
  className,
  ...props
}: ComponentPropsWithRef<"thead">) {
  return (
    <thead
      className={cn("fm-table__header", className)}
      data-slot="table-header"
      {...props}
    />
  );
}

export function TableBody({
  className,
  ...props
}: ComponentPropsWithRef<"tbody">) {
  return (
    <tbody
      className={cn("fm-table__body", className)}
      data-slot="table-body"
      {...props}
    />
  );
}

export function TableFooter({
  className,
  ...props
}: ComponentPropsWithRef<"tfoot">) {
  return (
    <tfoot
      className={cn("fm-table__footer", className)}
      data-slot="table-footer"
      {...props}
    />
  );
}

export function TableRow({
  className,
  ...props
}: ComponentPropsWithRef<"tr">) {
  return (
    <tr
      className={cn("fm-table__row", className)}
      data-slot="table-row"
      {...props}
    />
  );
}

export function TableHead({
  className,
  ...props
}: ComponentPropsWithRef<"th">) {
  return (
    <th
      className={cn("fm-table__head", className)}
      data-slot="table-head"
      {...props}
    />
  );
}

export function TableCell({
  className,
  ...props
}: ComponentPropsWithRef<"td">) {
  return (
    <td
      className={cn("fm-table__cell", className)}
      data-slot="table-cell"
      {...props}
    />
  );
}

export function TableCaption({
  className,
  ...props
}: ComponentPropsWithRef<"caption">) {
  return (
    <caption
      className={cn("fm-table__caption", className)}
      data-slot="table-caption"
      {...props}
    />
  );
}
