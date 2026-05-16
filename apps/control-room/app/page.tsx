import { KernelProvider } from "@/kernel/KernelProvider";
import { WorkspaceShell } from "@/kernel/layout/WorkspaceShell";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Fullmag Control Room",
  description: "Interactive Fullmag workspace for geometry, solver, and viewport workflows.",
};

export default function HomePage() {
  return (
    <KernelProvider>
      <WorkspaceShell />
    </KernelProvider>
  );
}
