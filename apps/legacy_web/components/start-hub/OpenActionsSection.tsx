import { Code2, FolderOpen, PlayCircle, PlusCircle, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

interface OpenActionsSectionProps {
  canResumeCurrentSession?: boolean;
  onResumeCurrentSession?: () => void;
  onOpenSimulation: () => void;
  onOpenScript: () => void;
  onOpenExample: () => void;
}

export default function OpenActionsSection({
  canResumeCurrentSession = false,
  onResumeCurrentSession,
  onOpenSimulation,
  onOpenScript,
}: OpenActionsSectionProps) {
  const actions = [
    {
      title: "New Simulation",
      subtitle: "From physics template",
      icon: <PlusCircle className="h-5 w-5 text-primary" />,
      onClick: onOpenSimulation, // Assuming for now, might need separate "New" vs "Open"
      color: "hover:border-primary/40",
      badge: "Fast Launch",
    },
    {
      title: "Open Script",
      subtitle: ".py micromagnetic DSL",
      icon: <Code2 className="h-5 w-5 text-viewport-cyan" />,
      onClick: onOpenScript,
      color: "hover:border-viewport-cyan/40",
    },
    {
      title: "Open Project",
      subtitle: "Fullmag session bundle",
      icon: <FolderOpen className="h-5 w-5 text-viewport-amber" />,
      onClick: onOpenSimulation,
      color: "hover:border-viewport-amber/40",
    },
    {
      title: "Resume Session",
      subtitle: "Live control room",
      icon: <PlayCircle className={cn("h-5 w-5", canResumeCurrentSession ? "text-success" : "text-muted-foreground/60")} />,
      onClick: onResumeCurrentSession,
      disabled: !canResumeCurrentSession,
      color: canResumeCurrentSession 
        ? "hover:border-success/40" 
        : "opacity-55 cursor-not-allowed",
      badge: canResumeCurrentSession ? "Active" : "None",
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {actions.map((action) => (
        <button
          key={action.title}
          type="button"
          onClick={action.onClick}
          disabled={action.disabled}
          className={cn(
            "group flex min-h-36 flex-col items-start gap-4 rounded-md border border-border/60 bg-card/70 p-5 text-left shadow-sm transition-colors hover:bg-secondary/45 active:bg-secondary/60",
            action.color
          )}
        >
          <div className="flex w-full items-center justify-between">
            <div className="flex h-10 w-10 items-center justify-center rounded-md border border-border/70 bg-background/70">
              {action.icon}
            </div>
            {action.badge && (
              <span className={cn(
                "rounded-md border px-2 py-1 text-xs font-medium",
                action.title === "Resume Session" ? "border-success/20 bg-success/10 text-success" : "border-primary/20 bg-primary/10 text-primary"
              )}>
                {action.badge}
              </span>
            )}
          </div>

          <div className="flex flex-col">
            <span className="text-base font-semibold tracking-tight text-foreground">
              {action.title}
            </span>
            <span className="mt-1 text-sm text-muted-foreground">
              {action.subtitle}
            </span>
          </div>

          <div className="mt-auto flex items-center gap-2 text-xs font-medium text-primary/75 transition-colors group-hover:text-primary">
            <span>Launch Action</span>
            <Sparkles className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        </button>
      ))}
    </div>
  );
}
