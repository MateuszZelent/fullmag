"use client";

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
  return (
    <div className="fm-ribbon__tabs" role="tablist" aria-label="Ribbon tabs">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          className="fm-ribbon__tab"
          data-active={tab.id === activeTabId}
          role="tab"
          type="button"
          aria-selected={tab.id === activeTabId}
          onClick={() => onTabClick(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
