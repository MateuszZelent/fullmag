import { Suspense } from "react";

import WorkspaceEntryPage from "@/components/workspace/shell/WorkspaceEntryPage";
import { normalizeWorkspaceTabSlug } from "@/lib/workspace/workspace-route";

interface WorkspaceTabPageProps {
  params: Promise<{
    slug?: string[];
  }>;
}

export function generateStaticParams() {
  return [
    { slug: ["3d"] },
    { slug: ["2d"] },
    { slug: ["mesh"] },
    { slug: ["analyze"] },
    { slug: ["charts"] },
  ];
}

export default async function WorkspaceTabPage({ params }: WorkspaceTabPageProps) {
  const { slug } = await params;
  return (
    <Suspense fallback={null}>
      <WorkspaceEntryPage stage="study" initialTabSlug={normalizeWorkspaceTabSlug(slug)} />
    </Suspense>
  );
}
