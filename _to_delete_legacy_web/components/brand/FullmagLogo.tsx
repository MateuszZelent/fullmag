"use client";

import { cn } from "@/lib/utils";
import React, { useState } from "react";
import { createPortal } from "react-dom";
import { FullmagLogoVector } from "./FullmagLogoVector";

/* ────────────────────────────────────────────────────────────
   FullmagLogo — High-Fidelity Infinity Loop Vector Mark
   
   Using the highly optimized, auto-traced SVG wrapped as a TSX component
   to allow for future animations and raw DOM access.
   ────────────────────────────────────────────────────────── */

interface FullmagLogoProps {
  size?: number;
  animate?: boolean;
  spin?: boolean;
  className?: string;
}

export default function FullmagLogo({
  size = 64,
  animate: _animate = false,
  spin = false,
  className,
}: FullmagLogoProps) {
  void _animate;
  const [zoomed, setZoomed] = useState(false);
  const mounted = typeof document !== "undefined";

  return (
    <>
      {/* ── Standard UI Render ── */}
      <FullmagLogoVector
        width={size}
        height={size} // The SVG viewbox is 626x635, roughly 1:1 aspect ratio
        className={cn(
          "select-none cursor-pointer transition-opacity hover:opacity-80",
          spin && "animate-[spin_4s_linear_infinite]",
          className
        )}
        onClick={() => setZoomed(true)}
      />

      {/* ── Zoom Modal Render ── */}
      {zoomed && mounted && createPortal(
        <div
          className="fixed inset-0 z-[99999] p-4 sm:p-8 flex items-center justify-center bg-background/90 backdrop-blur-xl cursor-zoom-out animate-in fade-in duration-200"
          onClick={() => setZoomed(false)}
        >
          <div
            className="relative flex items-center justify-center w-full h-full max-w-[90vw] max-h-[90vh] sm:max-w-[70vw] sm:max-h-[70vh] p-8 sm:p-16 rounded-3xl border border-white/10 bg-black/20 shadow-2xl animate-in zoom-in-95 duration-300 cursor-default"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="absolute inset-0 bg-primary/10 rounded-3xl blur-3xl pointer-events-none" />
            <FullmagLogoVector
              className="w-full h-full object-contain drop-shadow-[0_0_80px_rgba(203,166,247,0.3)] relative z-10 pointer-events-none"
            />
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

/* ────────────────────────────────────────────────────────────
   Compact Mark Variant (for badges/icons without the text mark)
   ────────────────────────────────────────────────────────── */
export function FullmagMark({
  size = 32,
  className,
}: { size?: number; className?: string }) {
  return (
    <div
      className={cn("inline-flex items-center justify-center filter drop-shadow-md", className)}
      style={{ width: size, height: size }}
    >
      <FullmagLogo size={size * 1.5} className="!w-full !h-full" />
    </div>
  );
}
