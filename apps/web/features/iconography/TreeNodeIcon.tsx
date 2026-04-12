/**
 * @module iconography/TreeNodeIcon
 *
 * Hybrid icon renderer for the model tree.
 *
 * Accepts either:
 *  • An emoji string (legacy) — rendered as-is
 *  • A Lucide icon name — rendered via lucide-react
 *
 * Detection heuristic: if the string contains only ASCII lower + hyphen
 * characters, treat it as a Lucide icon name.  Otherwise treat as emoji.
 *
 * Usage in ModelTree:
 *   <TreeNodeIcon icon={node.icon} />
 */

"use client";

import React from "react";
import { icons } from "lucide-react";
import type { LucideIcon } from "lucide-react";

interface TreeNodeIconProps {
  icon: string | undefined;
  className?: string;
  size?: number;
}

const LUCIDE_NAME_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Converts a kebab-case lucide name to PascalCase for the icons map lookup.
 *  e.g. "arrow-right" → "ArrowRight"
 */
function kebabToPascal(name: string): string {
  return name
    .split("-")
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join("");
}

export default function TreeNodeIcon({ icon, className, size = 14 }: TreeNodeIconProps) {
  if (!icon) return null;

  // Lucide icon?
  if (LUCIDE_NAME_RE.test(icon)) {
    const pascalName = kebabToPascal(icon);
    const LucideComponent = (icons as Record<string, LucideIcon>)[pascalName];
    if (LucideComponent) {
      return <LucideComponent size={size} className={className} />;
    }
    // Fallback: unknown icon name → render text
  }

  // Emoji / unicode glyph
  return <span className={className}>{icon}</span>;
}
