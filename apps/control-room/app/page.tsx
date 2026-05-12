import { redirect } from "next/navigation";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Fullmag Control Room",
  description: "Fullmag modeling and simulation control workspace.",
};

export default function HomePage() {
  redirect("/workspace");
}
