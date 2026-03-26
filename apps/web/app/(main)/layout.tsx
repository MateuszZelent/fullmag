'use client';

import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { AppLayout } from '../../components/layout';

export default function MainLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (pathname === '/') {
    return <>{children}</>;
  }
  return <AppLayout>{children}</AppLayout>;
}
