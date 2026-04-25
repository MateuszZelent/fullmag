import { Binary, Box, Boxes, Microscope, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

interface ExamplesSectionProps {
  onOpenExample: (exampleId: string) => void;
}

const EXAMPLES = [
  { 
    id: "nanoflower_fem", 
    label: "Nanoflower FEM",
    description: "Multi-element tetrahedral mesh study",
    icon: <Box className="h-5 w-5 text-viewport-cyan" />,
    stats: "480k nodes | 3D",
    tint: "bg-viewport-cyan/10 text-viewport-cyan",
  },
  { 
    id: "relax_run", 
    label: "Relax + Run",
    description: "Ground state discovery with high-alpha damping",
    icon: <Zap className="h-5 w-5 text-viewport-amber" />,
    stats: "Relax alpha 1.0",
    tint: "bg-viewport-amber/10 text-viewport-amber",
  },
  { 
    id: "eigenmodes", 
    label: "Eigenmode Solver",
    description: "Frequency domain magnetization dynamics",
    icon: <Boxes className="h-5 w-5 text-viewport-violet" />,
    stats: "LANCZOS | GPU",
    tint: "bg-viewport-violet/10 text-viewport-violet",
  },
  { 
    id: "external_field_sweep", 
    label: "Hysteresis Loop",
    description: "Automated field sweep and coercivity calculation",
    icon: <Binary className="h-5 w-5 text-success" />,
    stats: "100 Field steps",
    tint: "bg-success/10 text-success",
  },
];

export default function ExamplesSection({ onOpenExample }: ExamplesSectionProps) {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
      {EXAMPLES.map((example) => (
        <button
          key={example.id}
          type="button"
          onClick={() => onOpenExample(example.id)}
          className="group flex min-h-44 flex-col rounded-md border border-border/60 bg-card/70 p-4 text-left shadow-sm transition-colors hover:border-primary/35 hover:bg-secondary/40"
        >
          <div className="mb-4 flex items-start justify-between gap-3">
            <div className={cn("flex h-10 w-10 items-center justify-center rounded-md", example.tint)}>
              {example.icon}
            </div>
            <div className="rounded-md border border-border/60 bg-background/50 px-2 py-1 text-xs font-medium text-muted-foreground">
              Ref Bundle
            </div>
          </div>

          <div className="flex flex-1 flex-col">
            <div className="flex items-center justify-between">
              <span className="text-base font-semibold tracking-tight text-foreground transition-colors group-hover:text-primary">
                {example.label}
              </span>
              <Microscope className="h-4 w-4 text-muted-foreground/50" />
            </div>
            <p className="mt-2 line-clamp-2 text-sm leading-5 text-muted-foreground">
              {example.description}
            </p>
            
            <div className="mt-auto flex items-center justify-between border-t border-border/60 pt-3">
              <span className="font-mono text-xs font-medium uppercase text-muted-foreground">
                {example.stats}
              </span>
              <div className="h-1.5 w-1.5 rounded-full bg-primary/45 transition-colors group-hover:bg-primary" />
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}
