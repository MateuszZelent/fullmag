"use client";

import { useEffect, useState } from "react";

import { readAuthorName } from "./provenance";

/** The user's name from the host, or null until (and unless) it answers. */
export function useAuthorName(): string | null {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void readAuthorName().then((found) => {
      if (!cancelled) setName(found);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return name;
}
