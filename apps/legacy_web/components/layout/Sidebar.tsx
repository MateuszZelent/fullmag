'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { usePathname } from 'next/navigation';
import { type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';

export interface NavItem {
  href: Route;
  label: string;
  icon: ReactNode;
  section?: string;
}

interface SidebarProps {
  items: NavItem[];
  collapsed: boolean;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  onToggleCollapse?: () => void;
}

export function Sidebar({ items, collapsed, mobileOpen, onCloseMobile, onToggleCollapse }: SidebarProps) {
  const pathname = usePathname();
  const grouped = groupBySection(items);

  return (
    <>
      {/* Mobile Backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-background/80 backdrop-blur-sm md:hidden"
          onClick={onCloseMobile}
        />
      )}
      
      <aside 
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex flex-col border-r border-border/60 bg-gradient-to-b from-card/80 to-background/50 backdrop-blur-2xl transition-all duration-300 md:relative md:translate-x-0 h-full shadow-glass-side",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
          collapsed ? "w-sidebar-collapsed" : "w-sidebar"
        )}
      >
        <div className="flex h-topbar items-center border-b border-border/60 px-4 shrink-0 justify-between">
          <div className="flex items-center gap-3 overflow-hidden">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/20 text-primary font-bold shadow-inner border border-primary/20">
              F
            </div>
            {!collapsed && <span className="text-base font-semibold tracking-tight text-foreground whitespace-nowrap">Fullmag</span>}
          </div>
          {onToggleCollapse && (
            <button 
              onClick={onToggleCollapse} 
              className={cn("text-muted-foreground hover:text-foreground hidden md:flex", collapsed && "mx-auto")}
            >
              {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
            </button>
          )}
        </div>

        <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-3 py-6 scrollbar-none">
          {grouped.map(({ section, items: sectionItems }) => (
            <div key={section || '__default'} className="flex flex-col gap-1">
              {section && !collapsed && (
                <div className="mb-2 px-2 text-[0.65rem] font-bold uppercase tracking-[0.1em] text-muted-foreground">
                  {section}
                </div>
              )}
              {sectionItems.map((item) => {
                const isActive =
                  pathname === item.href ||
                  (item.href !== '/' && pathname.startsWith(item.href));
                  
                const navItemClassName = cn(
                  "group flex items-center gap-3 rounded-md border px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "border-primary/20 bg-primary/10 text-primary shadow-sm"
                    : "border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                );

                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={onCloseMobile}
                    title={collapsed ? item.label : undefined}
                    className={navItemClassName}
                  >
                    <span className={cn("shrink-0", isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground")}>
                      {item.icon}
                    </span>
                    {!collapsed && (
                      <span className="truncate">{item.label}</span>
                    )}
                  </Link>
                );
              })}
            </div>
          ))}
        </div>

        <div className="border-t border-border/60 p-4 shrink-0">
          <div className={cn("flex items-center gap-3 text-xs text-muted-foreground", collapsed && "justify-center")}>
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-muted font-mono text-[10px] uppercase font-bold text-foreground">
              FM
            </div>
            {!collapsed && <span>v0.1.0-alpha</span>}
          </div>
        </div>
      </aside>
    </>
  );
}

/** Group nav items by their optional section property. */
function groupBySection(items: NavItem[]) {
  const groups: { section: string | undefined; items: NavItem[] }[] = [];
  let currentSection: string | undefined = '__unset__';

  for (const item of items) {
    if (item.section !== currentSection) {
      currentSection = item.section;
      groups.push({ section: currentSection, items: [] });
    }
    groups[groups.length - 1]!.items.push(item);
  }
  return groups;
}
