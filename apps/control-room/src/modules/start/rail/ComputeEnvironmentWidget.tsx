import { cn } from "@/shared/utils/className";

/** Static placeholder until the host reports devices (host API §6.4). */
export function ComputeEnvironmentWidget({ className }: { readonly className?: string }) {
  return (
    <div
      aria-label="Compute environment"
      className={cn("rounded-fm-md border border-fm-subtle bg-fm-raised px-fm-2 py-fm-2", className)}
      role="group"
    >
      <p className="font-fm-ui text-fm-2xs font-semibold uppercase text-fm-start-meta" style={{ letterSpacing: "var(--fm-start-section-tracking)" }}>
        Compute
      </p>
      <p className="mt-1 font-fm-ui text-fm-xs text-fm-secondary">Detected when a simulation is created.</p>
    </div>
  );
}
