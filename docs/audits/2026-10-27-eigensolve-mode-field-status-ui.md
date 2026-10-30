# Rzetelny stan pola modu w UI

27.10.2026. Backend: istniejący runtime fde189663, bez nowego Solve. Run `run-live-016c843af31ca21339d8be8854dd6cb5ecc6a15af2373a8e9152e6658be4d874` completed, DE +10 rad/µm, f = 11.211886649578224 GHz.

## Błąd i poprawka

Viewport pomijał error/status kontrolera modeFieldOverlay, więc po odrzuceniu metadanych mógł pokazywać gotowość topologii. W useViewport3DSceneModel dodano priorytet błędu aktywnego kontrolera oraz komunikat ładowania. Warunek modeFieldOverlayEnabled zapobiega prezentacji nieaktywnego błędu. W inspektorze zmieniono opis dostępności metadanych z „3D field ready” na „Mode field available”. Pasek statusu ma pełny title i role=status, aby przy wizualnym skróceniu etykiety powód pozostawał dostępny.

## Dowody przeglądarkowe

- Negatywny probe przechwytywał wyłącznie odpowiedź metadata w prywatnym kontekście Chromium i podmieniał field_id na niezgodny. Po rzeczywistej akcji Plot viewport pokazał „Mode field unavailable: Mode-field metadata is incomplete, stale, or not a global complex XYZ field.”; zero pobrań binarnego pola. Backend i zapisane wyniki nie były zmieniane. To test błędu UI, nie nowy wynik fizyczny.
- Pozytywny probe bez przechwytywania odpowiedzi: rzeczywiste owner-bound pole +10, kontroler ready, Real/Imag/Abs/Phase, WebGL2 bez utraty kontekstu, 4/4 porównania animacji różne; dwie klatki po Stop identyczne. Animacja pozostawiona w widocznym oknie. Kamera obejmuje magnetyk 40 × 40 × 10 nm.
- Pierwsza kontrola samego title po dodatkowym dopracowaniu etykiety nie dotarła do pola: strona Home zgłaszała reconnecting, intercepted=0. Backend supervisor odnotował 6-sekundowe odzyskanie obserwacji. API ponownie potwierdziło active_session=true, completed i healthy. Po tym wznowiono wyłącznie obserwację, bez restartu i bez Solve. Wznowiony probe PASS, w tym asercja title == pełny komunikat. Ten timeout nie był regresją walidacji pola.

Kompilowane testy UI/typecheck/architecture/React Doctor wymagają GitHub Actions. Lokalnie zmiany podjęła istniejąca usługa frontend HMR; nie kompilowano testów jednostkowych.

Dowód obu głównych probe’ów: `2026-10-27-eigensolve-mode-field-status-ui.evidence.json`. Pełne raporty, zrzuty i dokładny skrypt negatywnego probe’a są w katalogu użytkownika eigensolve-current-results. Trzy nieaktualne własne okna weryfikacji zamknięto po sprawdzeniu PID/cmdline/starttime; najnowsze okno dodatnie pozostawiono. Nie zatrzymywano runtime ani innych aplikacji.

Nowy build backendu i pełny sweep z Gamma nadal blokuje miejsce WSL. Wyniki źródłowe: API/retirement CI 40481439173 PASS; native C ABI 40482575121 PASS; MFEM shared-domain 40482578832 PASS; imported certificate runner 40483507450 PASS. To osobne dowody od niewykonanej nowej symulacji Gamma.
