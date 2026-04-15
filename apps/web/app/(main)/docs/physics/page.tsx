'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function PhysicsDocsRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/workspace?stage=analyze' as any);
  }, [router]);
  return null;
}
