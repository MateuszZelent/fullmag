"use client";

// Return HTTP 200 on GET / so that health-check probes (reqwest in the Rust binary)
// see a success status without following a server-side 307 redirect that may time out.
// The client-side navigation to /workspace is identical from the user's perspective.
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function HomePage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/workspace");
  }, [router]);
  return null;
}
