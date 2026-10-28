"use client";

import { ChevronDown, Rows3 } from "lucide-react";

import { Button } from "@/shared/ui/Button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/shared/ui/DropdownMenu";

import type { RibbonDensity } from "./ribbonPreference";

const DENSITY_LABELS: Record<RibbonDensity, string> = {
  full: "Full",
  compact: "Compact",
  collapsed: "Collapsed",
};

export function RibbonDensityControl({
  density,
  onChange,
}: {
  density: RibbonDensity;
  onChange: (density: RibbonDensity) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={`Ribbon density: ${DENSITY_LABELS[density]}`}
          className="fm-ribbon-density"
          size="sm"
          title="Choose ribbon density"
          type="button"
          variant="ghost"
        >
          <Rows3 aria-hidden="true" size={16} />
          <span>Density</span>
          <span className="fm-ribbon-density__value">
            {DENSITY_LABELS[density]}
          </span>
          <ChevronDown aria-hidden="true" size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="fm-ribbon-density__menu">
        <DropdownMenuLabel>Ribbon density</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={density}
          onValueChange={(value) => {
            if (value === "full" || value === "compact" || value === "collapsed") {
              onChange(value);
            }
          }}
        >
          <DropdownMenuRadioItem value="full">Full</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="compact">Compact</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="collapsed">Collapsed</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
