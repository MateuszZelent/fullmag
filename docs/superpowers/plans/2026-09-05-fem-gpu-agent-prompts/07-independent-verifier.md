# Agent 7 – niezależna weryfikacja, audyt regresji i kontrola jakości (propozycja)

> [!IMPORTANT]
> **PROPOZYCJA PROMPTU DLA AGENTA 7 DO ZATWIERDZENIA PRZEZ UŻYTKOWNIKA.**
> Skopiuj poniższy prompt w całości po zatwierdzeniu przez użytkownika. Nie uruchamiaj przed zakończeniem prac i przekazaniem zamrożonych commitów przez Agenta 4 i Agenta 5.

---

Repozytorium: C:\git\fullmag\fullmag.
Kanoniczny worktree integracyjny: C:/git/fullmag/fullmag/.worktrees/fem-gpu-tasks1-5-remediation.
Branch integracyjny: codex/fem-gpu-tasks1-5-remediation.
Zweryfikowany baseline wejściowy: `95a1876ed496c757849707f599c418613b7db603` (commit lokalny po odbiorze agentów 1–3 i NCG refinement).
Raport Astra Pro: C:/git/fullmag/fullmag/.worktrees/fem-gpu-tasks1-5-remediation/docs/reports/05.09.2026/fullmag-fem-gpu-audit-2026-09-05/fullmag-fem-gpu-audit-2026-09-05/RAPORT.md.
Raport odbioru: C:/git/fullmag/fullmag/.worktrees/fem-gpu-tasks1-5-remediation/docs/reports/05.09.2026/agent-1-3-integration-review.md.
Plan domknięcia: C:/git/fullmag/fullmag/.worktrees/fem-gpu-tasks1-5-remediation/docs/superpowers/plans/2026-09-05-fem-gpu-integration-closure.md.
Kolejność zespołu: C:/git/fullmag/fullmag/.worktrees/fem-gpu-tasks1-5-remediation/docs/superpowers/plans/2026-09-05-fem-gpu-agent-prompts/README.md.

Przed pracą:
- Przeczytaj AGENTS.md, skill `verification-before-completion`, raport pierwotnego audytu oraz raport odbioru fazy 1–3.
- Sprawdź `git rev-parse HEAD`, `git status --short`, tożsamość commita wejściowego oraz historię commitów dostarczonych przez Agenta 4 i Agenta 5.
- Pracuj w osobnym, izolowanym worktree i branchu audytowym `codex/fem-gpu-audit-agent7`. Nie modyfikuj branchy roboczych agentów 4 i 5 ani integracyjnego checkoutu.
- Koordynuj sekwencyjny dostęp do GPU – buildy i testy natywne nie mogą działać równolegle z innymi procesami na karcie NVIDIA RTX.

Zasady wykonania:
- Działasz jako bezstronny, niezależny audytor jakości i poprawności (red-team).
- Odrzucaj deklaracje sukcesu niepoparte dowodami. „Plausibility is not correctness”.
- Sprawdzaj czy zmiany agentów 4 i 5:
  1. Nie wprowadzają cichego fallbacku na CPU.
  2. Nie naruszają podwójnej precyzji (IEEE 754 float64).
  3. Nie deklarują `profile_qualified=true` na podstawie zmiennej środowiskowej zamiast dowiedzionego wykonania kernela.
  4. Nie modyfikują plików spoza swojego dozwolonego zakresu (brak naruszeń granic własności).
  5. Nie wprowadzają regresji do kontraktu receiptów (`gpu_execution_receipt_v2`), liczników energii czy wydajności.
- Uruchom pełną kanoniczną receptę kontenerową: `just verify-fem-gpu-execution-receipt-contract`.
- Zweryfikuj, że wszystkie natywne testy przechodzą z kodem 0 i statusem PASS (żadnych ukrytych SKIP).
- Zweryfikuj, że log Rust zawiera dokładnie 28 zdarzeń testowych przechodzących walidator `validate_exact_rust_test_log.py`.
- Zweryfikuj testy launchera i walidatora na hoście: `scripts/test_windows_fullmag_launcher_contract.py` oraz `scripts/test_validate_exact_rust_test_log.py`.

Wynik końcowy po polsku:
1. Identyfikacja sprawdzanych commitów (SHA wejściowy, SHA agenta 4, SHA agenta 5).
2. Wynik audytu granic plików (czy żaden agent nie naruszył ownershipu).
3. Rzeczywiste kody wyjścia i logi z `just verify-fem-gpu-execution-receipt-contract` oraz testów hostowych.
4. Niezależna ocena poprawności numerycznej i fizycznej (czy zachowano tolerancje, zbieżność, brak degradacji energii).
5. Rekomendacja dla integratora (Agent 6): ACCEPT do scalenia lub REJECT z listą usterek blokujących.
