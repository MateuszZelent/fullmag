'use client';

import { useCallback, useState, type ReactNode } from 'react';
import type { Route } from "next";
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { navigationItems } from './navigation';

interface AppLayoutProps {
  children: ReactNode;
  breadcrumb?: { label: string; href?: Route }[];
  actions?: ReactNode;
}

export function AppLayout({ children, breadcrumb, actions }: AppLayoutProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  const toggleMobile = useCallback(() => {
    setMobileOpen((prev) => !prev);
  }, []);

  const closeMobile = useCallback(() => {
    setMobileOpen(false);
  }, []);

  return (
    <div className="flex h-screen w-full bg-background text-foreground overflow-hidden font-sans">
      <Sidebar
        items={navigationItems}
        collapsed={collapsed}
        mobileOpen={mobileOpen}
        onCloseMobile={closeMobile}
        onToggleCollapse={() => setCollapsed(prev => !prev)}
      />
      <div className="flex flex-col flex-1 min-w-0 h-full relative z-0 transition-all">
        <TopBar
          breadcrumb={breadcrumb}
          onMobileMenuToggle={toggleMobile}
          actions={actions}
        />
        <main className="flex-1 overflow-auto bg-muted/10">
          <div className="p-4 md:p-6 lg:p-8 h-full">
            {children}
          </div>
        </main>
        {/* <Footer /> */} 
        {/* Skipping footer for AppLayout, keep it clean if empty */}
      </div>
    </div>
  );
}
