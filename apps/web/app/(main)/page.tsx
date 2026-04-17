'use client';
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { Route } from "next";
import { useRouter, useSearchParams } from "next/navigation";
import StartHubPage from "@/components/start-hub/StartHubPage";
import {
  resolveLaunchIntentFromSearchParams,
  targetPathForLaunchIntent,
} from "@/lib/workspace/launch-intent";
import { detectLiveSessionIntent } from "@/lib/workspace/launch-intent-live";
import { recordFrontendDebugEvent } from "@/lib/workspace/navigation-debug";

function RootPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryString = searchParams.toString();
  const intent = useMemo(
    () => resolveLaunchIntentFromSearchParams(new URLSearchParams(queryString)),
    [queryString],
  );
  const [checkedLiveSession, setCheckedLiveSession] = useState(false);
  const navigationIssuedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      recordFrontendDebugEvent("root-route", "effect_run", {
        queryString,
        intentSource: intent.source,
        intentStage: intent.targetStage,
      });
      if (navigationIssuedRef.current) {
        recordFrontendDebugEvent("root-route", "effect_skip_navigation_already_issued");
        return;
      }
      if (intent.source !== "none") {
        navigationIssuedRef.current = true;
        const target = targetPathForLaunchIntent(intent);
        const params = new URLSearchParams(queryString);
        const route = params.toString().length > 0 ? `${target}?${params}` : target;
        recordFrontendDebugEvent(
          "root-route",
          "redirect_from_query_intent",
          {
            target: route,
            params: params.toString(),
            source: intent.source,
          },
          { includeStack: true },
        );
        router.replace(route as Route);
        return;
      }

      recordFrontendDebugEvent("root-route", "detect_live_session_start");
      const detected = await detectLiveSessionIntent();
      if (cancelled) return;
      recordFrontendDebugEvent("root-route", "detect_live_session_complete", {
        detected: Boolean(detected),
        targetStage: detected?.intent.targetStage ?? null,
        source: detected?.intent.source ?? null,
      });

      if (detected) {
        navigationIssuedRef.current = true;
        const target = targetPathForLaunchIntent(detected.intent);
        const params = new URLSearchParams();
        params.set("source", detected.intent.source);
        if (detected.intent.entryPath) params.set("path", detected.intent.entryPath);
        if (detected.intent.entryKind) params.set("kind", detected.intent.entryKind);
        if (detected.intent.targetStage) params.set("stage", detected.intent.targetStage);
        if (detected.intent.resumeProjectId) params.set("projectId", detected.intent.resumeProjectId);
        const route = params.toString().length > 0 ? `${target}?${params}` : target;
        recordFrontendDebugEvent(
          "root-route",
          "redirect_from_live_detection",
          {
            target: route,
            params: params.toString(),
            runId: detected.intent.resumeProjectId,
          },
          { includeStack: true },
        );
        router.replace(route as Route);
        return;
      }

      recordFrontendDebugEvent("root-route", "no_live_session_show_start_hub");
      setCheckedLiveSession(true);
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [intent, queryString, router]);

  if (intent.source === "none" && checkedLiveSession) {
    return <StartHubPage />;
  }
  return <div className="min-h-screen bg-background" />;
}

export default function RootPage() {
  return (
    <Suspense fallback={null}>
      <RootPageInner />
    </Suspense>
  );
}
