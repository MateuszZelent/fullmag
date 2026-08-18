"use client";

import { useCallback } from "react";
import type { RibbonTabDef, RibbonTabId } from "./ribbonTypes";

interface RibbonTabStripProps {
  tabs: RibbonTabDef[];
  activeTabId: RibbonTabId;
  onTabClick: (tabId: RibbonTabId) => void;
}

export function RibbonTabStrip({
  tabs,
  activeTabId,
  onTabClick,
}: RibbonTabStripProps) {
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const currentIndex = tabs.findIndex((t) => t.id === activeTabId);
      if (currentIndex < 0) return;

      let nextIndex: number | undefined;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        nextIndex = (currentIndex + 1) % tabs.length;
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
      } else if (e.key === "Home") {
        nextIndex = 0;
      } else if (e.key === "End") {
        nextIndex = tabs.length - 1;
      }

      if (nextIndex !== undefined) {
        e.preventDefault();
        onTabClick(tabs[nextIndex].id);
        const container = e.currentTarget;
        const buttons = container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
        buttons[nextIndex]?.focus();
      }
    },
    [tabs, activeTabId, onTabClick],
  );

  return (
    <div
      className="fm-ribbon__tabs"
      role="tablist"
      aria-label="Ribbon tabs"
      onKeyDown={handleKeyDown}
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          className="fm-ribbon__tab"
          data-active={tab.id === activeTabId}
          role="tab"
          type="button"
          id={`fm-ribbon-tab-${tab.id}`}
          aria-controls="fm-ribbon-tabpanel"
          aria-selected={tab.id === activeTabId}
          tabIndex={tab.id === activeTabId ? 0 : -1}
          onClick={() => onTabClick(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
