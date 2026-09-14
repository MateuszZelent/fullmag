# Faza 0 — instrumentacja i przebieg pomiarowy live-refresh

**Data:** 2026-09-13
**Baza:** `master` `17127ba764dd50ae3f7f4b8c463221dd68ab82da`
**Dokument nadrzędny:** `docs/audits/2026-09-13-live-refresh-remediation-masterplan.md`, §6 Faza 0 i §7 kryteria akceptacji

Faza 0 ma odpowiedzieć na pytanie, którego pięć zamkniętych ustaleń wciąż nie rozstrzyga: **czy to, co naprawiliśmy, jest przyczyną tego, co widać na ekranie.** Wszystkie ustalenia LR-01…LR-14 są potwierdzone w kodzie i żadne w runtime.

---

## 1. Inwentaryzacja — czego nie trzeba budować

Sprawdzone na `17127ba76`. Znaczna część instrumentacji już istnieje i jest wpięta w CI.

| Potrzeba Fazy 0 | Stan | Dowód |
|---|---|---|
| Licznik resetów etapu (`model-layer-stage-reset`) | **JEST** | `viewport3dDiagnostics.ts:234` woła `recordVisualizationDebugViewportFrame(reason)`, a `visualizationDebugPerformanceProbe.ts` zbiera `viewportFrameReasons` do `window.__FULLMAG_VISUALIZATION_DEBUG_PERFORMANCE__` |
| Churn materiałów i geometrii | **JEST** | liczniki `materialsCreated/Disposed`, `geometriesCreated/Disposed`, `topologyBuilds`, `topologyUploads` w tej samej strukturze |
| Uploady GPU i kopiowane bajty | **JEST** | `gpuUploads`, `gpuUploadBytes`, `typedArrayCopiedBytes` |
| Request graph (LR-07) | **JEST** | `scripts/smoke-realtime-communication-budget.mjs` liczy i progiuje `fieldVectorHttpTxPerMinute`, `topologyHttpTxPerMinute`, `fieldSampleWsPerMinute`, `httpTxPerMinute` |
| Churn pamięci viewportu | **JEST, w CI** | `audit:viewport-3d-memory-churn`, `audit:viewport-3d-fem-topology-uploads` |
| Harness przeglądarkowy | **JEST** | Playwright + `scripts/lib/viewport-performance-proof.mjs` (`installViewportPerformanceProbe`, `captureViewportPerformanceSnapshot`) |

**Wniosek:** Faza 0 nie wymaga budowy infrastruktury. Wymaga trzech liczników i jednego scenariusza.

## 2. Luka — trzy liczniki, których brakuje

| Licznik | Czego dotyczy | Gdzie wpiąć |
|---|---|---|
| `retentionRejections: Record<reason, number>` | LR-04, odrzucenia retencji z powodem | `Viewport3DResourceTracker.recordRetentionRejection` (`viewport3dDiagnostics.ts:291`) zlicza poprawnie, ale **nie ma mostka** do `visualizationDebugPerformanceProbe.ts` — grep nie znajduje tam ani jednego wystąpienia `retentionRejection` |
| `uploadTicketsAborted: number` | LR-05, anulowane tickety uploadu | `viewport3dGpuUploadManager.ts` zna `ticket.aborted` (linie 94, 115, 126, 129), ale nie woła `recordVisualizationDebugPerformanceMetric` |
| `window.__FULLMAG_VIEWPORT_3D_LIVE_REFRESH__.revisions` | LR-14, czwórka `requested / received / prepared / displayed` | wartości są już wyliczane w `useViewport3DSceneModel.ts` i przekazywane do `buildViewport3DDiagnostics`; brakuje wystawienia ich na globalny obiekt, tak jak robi to probe wydajnościowy |

Wszystkie trzy są dopisaniem do istniejących struktur, bez nowego transportu, bez `setInterval`, bez nowego store'u.

## 3. Co dostarczono w tym kroku

| Plik | Rola | Status weryfikacji |
|---|---|---|
| `apps/control-room/scripts/lib/live-refresh-trace.mjs` | czysty analizator: delty próbek, podsumowanie przebiegu, rozstrzyganie bramek, formatowanie raportu | **przetestowany**, 14/14 przypadków |
| `apps/control-room/scripts/lib/live-refresh-trace.node-test.mjs` | testy analizatora (`node --test`) | **uruchomione, 14/14 PASS** |
| `apps/control-room/scripts/smoke-viewport-3d-live-refresh.mjs` | driver Playwright: próbkuje liczniki przez okno pomiaru, zapisuje artefakt, zwraca kod wyjścia | **niezweryfikowany w runtime** — wymaga działającego backendu i aktywnej sesji |

Analizator ma jedną własność wartą podkreślenia: **bramka, której licznika brakuje, kończy się statusem `unknown`, nigdy `pass`**. Driver domyślnie traktuje `unknown` jako niepowodzenie. To jest bezpośrednia odpowiedź na to, co się stało przy `cb22087d2` — wszystkie bramki były zielone, a aplikacja wywracała się przy pierwszym renderze. Zielona bramka bez dowodu jest gorsza niż jej brak.

Testy analizatora złapały przy okazji realny błąd w pierwszej wersji: stan `displayed` nie był inicjalizowany z próbki zerowej, przez co pierwszy zanik warstwy po już wyświetlonej klatce nie był wykrywany. Poprawione.

## 4. Bramki rozstrzygane przez analizator

Scenariusz zakłada **stałą topologię, stałą domenę i nieruchomą kamerę** — zmienia się wyłącznie wartość pola.

| ID | Bramka | Limit | Ustalenie |
|---|---|---:|---|
| G1 | brak resetu etapu | 0 | LR-01 |
| G2 | brak tworzenia materiałów | 0 | LR-02, VPF-005 |
| G3 | brak tworzenia geometrii | 0 | LR-01 |
| G4 | brak przebudowy topologii | 0 | rdzeń kryteriów §7 |
| G5 | brak anulowanych ticketów uploadu | 0 | LR-05 |
| G6 | `displayedRevision` nigdy się nie cofa | 0 | LR-03, LR-04 |
| G7 | zero klatek bez zgodnej warstwy po pierwszym wyświetleniu | 0 | LR-02, LR-03 |
| G8 | brak odrzuceń retencji z powodu `generation` / `carrier` | 0 | LR-04 |

Progi są nadpisywalne przez `evaluateLiveRefreshGates(summary, overrides)`, ale domyślnie wszystkie wynoszą zero — to są bramki poprawności, nie wydajności. Liczby wydajnościowe (klatki na rewizję, bajty, czas do widoczności) raport wypisuje **bez progów**, do ustalenia po baseline.

## 5. Runbook

Wymagane: działający backend z aktywną sesją, uruchomiony Control Room, solver publikujący próbki pola.

```bash
# 1. Backend + Control Room wg zwykłej procedury uruchomieniowej.
# 2. Uruchom symulację i poczekaj, aż viewport pokaże pole.
# 3. Przebieg pomiarowy (60 s, próbkowanie co 500 ms):

cd apps/control-room
CONTROL_ROOM_URL=http://localhost:3100/workspace \
node scripts/smoke-viewport-3d-live-refresh.mjs
```

Parametry: `CONTROL_ROOM_LIVE_REFRESH_WINDOW_MS` (60000), `_SAMPLE_MS` (500), `_WARMUP_TICKS` (4, pomija pierwszą budowę sceny), `_MIN_REVISIONS` (30), `_ARTIFACT` (ścieżka JSON), `_ALLOW_UNKNOWN=1` (dopuszcza niekompletną instrumentację).

Kody wyjścia:

- **0** — wszystkie bramki `PASS`;
- **1** — regresja: co najmniej jedna bramka `FAIL`, albo `UNKNOWN` bez `_ALLOW_UNKNOWN=1`, albo błędy konsoli w trakcie przebiegu;
- **2** — problem środowiska: brak Playwrighta, nieosiągalny Control Room, albo mniej niż `_MIN_REVISIONS` zaobserwowanych rewizji (solver nie publikował — to nie jest wynik pomiaru, tylko brak scenariusza).

Artefakt JSON zawiera surowe próbki, podsumowanie, wynik każdej bramki i błędy konsoli — nadaje się do dołączenia jako dowód do raportu remediacji.

Testy analizatora bez przeglądarki:

```bash
cd apps/control-room && node --test scripts/lib/live-refresh-trace.node-test.mjs
```

## 6. Czego nie zrobiono i dlaczego

1. **Nie wykonano przebiegu pomiarowego.** Wymaga uruchomienia backendu, solvera i przeglądarki na maszynie z repozytorium. Środowisko powłoki na tej maszynie jest niedostępne od aktualizacji Windows z 2026-09-08; dostępny jest wyłącznie odczyt i zapis plików. **Przyczyna zgłoszonego migotania pozostaje `NOT VERIFIED`.**
2. **Nie dopisano trzech brakujących liczników z §2.** To są zmiany w `src/`, a tej zmiany nie da się tu przepuścić przez `typecheck`, `eslint` ani `vitest`. Commit niezweryfikowanego TypeScriptu do `master` jest dokładnie tym wzorcem, który w tej serii już raz kosztował nas bloker. Dopóki ich nie ma, bramki G5 i G8 będą raportowane jako `UNKNOWN`, a driver zakończy się kodem 1 — co jest zachowaniem pożądanym.
3. **Nie dodano wpisu do `package.json`.** Skrypt uruchamia się bezpośrednio przez `node`. Alias `smoke:viewport-3d-live-refresh` warto dodać razem z testem `.test.ts` w `src/kernel/performance/`, zgodnie z konwencją `realtimeCommunicationBudgetSmokeScript.test.ts` — wtedy analizator wejdzie też pod `vitest` i CI.
4. **Nie uruchomiono `eslint` na dostarczonych plikach.** Styl jest wzorowany na `scripts/smoke-viewport-3d.mjs` i `scripts/lib/viewport-performance-proof.mjs` (te same wzorce dostępu do `window` wewnątrz `page.evaluate`, ta sama kolejność deklaracji), ale weryfikacja należy do pierwszego uruchomienia bramek na tej gałęzi.

## 7. Następny krok

Kolejność jest teraz jednoznaczna:

1. dopisać trzy liczniki z §2 (mała zmiana, z bramkami);
2. wykonać przebieg z §5 i załączyć artefakt;
3. dopiero z wynikiem tego przebiegu podejmować decyzję o Fazie 3 (LR-05, transakcja uploadu) — bo to najbardziej ryzykowna zmiana w całym planie, a G5 powie wprost, czy anulowane tickety w ogóle występują w praktyce.
