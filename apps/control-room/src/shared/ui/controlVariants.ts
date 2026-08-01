import { cva } from "class-variance-authority";

export const controlVariants = cva(
  [
    "inline-flex min-w-0 items-center rounded-fm-control border",
    "border-fm-subtle bg-fm-canvas text-fm-primary",
    "font-fm-ui text-fm-control outline-none",
    "transition-[background-color,border-color,color,box-shadow] duration-150",
    "hover:border-fm-border focus-visible:ring-2 focus-visible:ring-fm-accent",
    "disabled:cursor-not-allowed disabled:border-fm-disabled-border",
    "disabled:bg-fm-disabled disabled:text-fm-disabled-text disabled:opacity-100",
  ],
  {
    variants: {
      density: {
        compact: "h-fm-control-sm gap-2 px-2",
        regular: "h-fm-control-md gap-2 px-3",
      },
      invalid: {
        false: "",
        true: "border-fm-danger focus-visible:ring-fm-danger",
      },
    },
    defaultVariants: {
      density: "compact",
      invalid: false,
    },
  },
);

export const controlTextVariants = cva(
  "min-w-0 font-fm-ui text-fm-control leading-fm-control",
  {
    variants: {
      tone: {
        disabled: "text-fm-disabled-text",
        primary: "text-fm-primary",
        secondary: "text-fm-secondary",
      },
    },
    defaultVariants: {
      tone: "primary",
    },
  },
);
