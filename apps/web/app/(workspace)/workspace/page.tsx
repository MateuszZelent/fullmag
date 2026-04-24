'use client';
import { Suspense } from 'react';
import WorkspaceEntryPage from '@/components/workspace/shell/WorkspaceEntryPage';

export default function WorkspacePage() {
  return (
    <Suspense fallback={null}>
      <WorkspaceEntryPage stage="study" />
    </Suspense>
  );
}
