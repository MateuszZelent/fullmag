import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "Fullmag Control Room",
  description: "Interactive Fullmag workspace for geometry, solver, and viewport workflows.",
};

export default function HomePage() {
  redirect("/workspace");
}
