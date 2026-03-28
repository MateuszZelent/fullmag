'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode } from 'react';

export interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
  section?: string;
}

interface SidebarProps {
  items: NavItem[];
  collapsed: boolean;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

export function Sidebar({ items, collapsed, mobileOpen, onCloseMobile }: SidebarProps) {
  const pathname = usePathname();

  const grouped = groupBySection(items);

  return (
    <>
      <div
        className="sidebar-overlay"
        data-open={mobileOpen}
        onClick={onCloseMobile}
      />
      <aside className="sidebar" data-open={mobileOpen}>
        <div className="sidebar-brand">
          <div className="sidebar-brand-logo">F</div>
          {!collapsed && <span className="sidebar-brand-text">Fullmag</span>}
        </div>

        <nav className="sidebar-nav">
          {grouped.map(({ section, items: sectionItems }) => (
            <div key={section || '__default'}>
              {section && !collapsed && (
                <div className="sidebar-section-label">{section}</div>
              )}
              {sectionItems.map((item) => {
                const isActive =
                  pathname === item.href ||
                  (item.href !== '/' && pathname.startsWith(item.href));
                return (
                  <Link
                    key={item.href}
                    href={item.href as any}
                    className="sidebar-link"
                    data-active={isActive}
                    onClick={onCloseMobile}
                    title={collapsed ? item.label : undefined}
                  >
                    <span className="sidebar-link-icon">{item.icon}</span>
                    {!collapsed && (
                      <span className="sidebar-link-label">{item.label}</span>
                    )}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-footer-brand">
            <span className="sidebar-footer-badge">
              FM
            </span>
            {!collapsed && <span>Fullmag v0.1</span>}
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
