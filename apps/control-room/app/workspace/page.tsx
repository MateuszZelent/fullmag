import { KernelProvider } from "@/kernel/KernelProvider";
import { WorkspaceShell } from "@/kernel/layout/WorkspaceShell";

export default function WorkspacePage() {
  return (
    <KernelProvider>
      <WorkspaceShell />
    </KernelProvider>
  );
}
