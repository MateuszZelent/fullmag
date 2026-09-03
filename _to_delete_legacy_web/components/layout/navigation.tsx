import { type ReactNode } from 'react';
import { type NavItem } from './Sidebar';

/* ── Inline SVG Icons ── */

function WorkspaceIcon(): ReactNode {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

/* ── Navigation items ──
 *
 * All navigation is now through the workspace shell (AppBar perspective
 * switcher + ribbon + overlays). Physics Docs and Settings are opened from
 * the AppBar menu.
 *
 * This array is kept for AppLayout compatibility but the (main) layout no
 * longer renders AppLayout, so it's effectively unused.
 */
export const navigationItems: NavItem[] = [
  { href: '/workspace', label: 'Workspace', icon: <WorkspaceIcon /> },
];
