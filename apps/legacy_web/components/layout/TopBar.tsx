'use client';

import { type ReactNode } from 'react';
import { ThemeToggle } from '../theme';
import { Menu } from 'lucide-react';
import Link from 'next/link';
import type { Route } from 'next';

interface TopBarProps {
  breadcrumb?: { label: string; href?: Route }[];
  onMobileMenuToggle: () => void;
  actions?: ReactNode;
}

export function TopBar({ breadcrumb, onMobileMenuToggle, actions }: TopBarProps) {
  return (
    <header className="sticky top-0 z-30 flex h-topbar shrink-0 items-center justify-between border-b border-border/60 bg-gradient-to-r from-card/80 to-background/50 px-4 backdrop-blur-2xl shadow-glass">
      <div className="flex items-center gap-4">
        <button
          className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted md:hidden transition-colors"
          onClick={onMobileMenuToggle}
          aria-label="Toggle navigation"
        >
          <Menu size={20} />
        </button>

        {breadcrumb && breadcrumb.length > 0 && (
          <nav className="hidden sm:flex" aria-label="Breadcrumb">
            <ol className="flex items-center space-x-2 text-sm text-muted-foreground">
              {breadcrumb.map((item, i) => (
                <li key={i} className="flex items-center space-x-2">
                  {i > 0 && <span className="opacity-50">/</span>}
                  {i === breadcrumb.length - 1 ? (
                    <span className="font-medium text-foreground">{item.label}</span>
                  ) : item.href ? (
                    <Link href={item.href} className="hover:text-foreground transition-colors">
                      {item.label}
                    </Link>
                  ) : (
                    <span>{item.label}</span>
                  )}
                </li>
              ))}
            </ol>
          </nav>
        )}
      </div>

      <div className="flex items-center gap-3">
        {actions && (
          <div className="flex items-center border-r border-border/60 pr-3 mr-1">
            {actions}
          </div>
        )}
        <ThemeToggle />
      </div>
    </header>
  );
}
