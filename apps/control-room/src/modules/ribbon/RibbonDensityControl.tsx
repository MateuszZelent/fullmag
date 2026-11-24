"use client";

import { Rows3 } from "lucide-react";

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
        <button
          aria-label={`Ribbon density: ${DENSITY_LABELS[density]}`}
          className="fm-ribbon-density"
          data-density={density}
          title={`Ribbon layout: ${DENSITY_LABELS[density]}`}
          type="button"
        >
          <Rows3 aria-hidden="true" size={15} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="fm-ribbon-density__menu">
        <DropdownMenuLabel>Ribbon layout</DropdownMenuLabel>
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
