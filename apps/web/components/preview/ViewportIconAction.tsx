import { ButtonHTMLAttributes, forwardRef, ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface ViewportIconActionProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  icon?: ReactNode;
  label?: ReactNode;
  showCaret?: boolean;
}

export const ViewportIconAction = forwardRef<HTMLButtonElement, ViewportIconActionProps>(
  ({ active, icon, label, showCaret, className, children, title, ...props }, ref) => {
    return (
      <button
        ref={ref}
        aria-label={props["aria-label"] ?? title}
        title={title}
        className={cn(
          "relative flex items-center justify-center gap-1.5 appearance-none border h-7 px-2 rounded-sm cursor-pointer transition-colors outline-none focus-visible:ring-1 focus-visible:ring-primary/50",
          "border-transparent bg-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground",
          active && "border-primary/55 bg-primary/18 text-primary shadow-[0_0_0_1px_rgba(96,165,250,0.18),0_0_18px_rgba(59,130,246,0.14)] hover:bg-primary/24 hover:text-primary",
          className
        )}
        {...props}
      >
        {icon && <span className="shrink-0 flex items-center justify-center w-4 h-4">{icon}</span>}
        {label && <span className="text-[0.65rem] font-semibold uppercase tracking-widest leading-none mt-[1px]">{label}</span>}
        {children}
        {showCaret && <span className="text-[0.55rem] opacity-70 ml-0.5">▼</span>}
      </button>
    );
  }
);
ViewportIconAction.displayName = "ViewportIconAction";
