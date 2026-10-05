# Audyt dokumentacji Sphinx — 2026-10-05

## Cel i granice dowodów

Przegląd każdej publikowanej strony Sphinxa względem fizyki, kodu i prawdziwości odsyłaczy. Baza kodu: `056d4f50d10389be83a68b9941d2fbcdcb8fc072`. Dedykowany branch eigensolve jest osobnym przedmiotem przeglądu; jego możliwości nie oznaczają dostępności na master ani kwalifikacji runtime.

Właściciel: `codex:01a10920-f834-74a3-add8-8af3044a4b99`.
Worktree: `sphinx-physics-audit-20261005`; branch: `codex/sphinx-physics-audit-20261005`.
Rejestr: `storage/index/sphinx-physics-audit-20261005-6a17da8f226dfce5.json`.

## Plan i kryteria

1. Inwentaryzacja wszystkich źródeł publikowanych przez Sphinx, z odróżnieniem wyłączonych plików pomocniczych.
2. Semantyczny przegląd stron fizyki, metod numerycznych, API Python, walidacji, frontendowych i architektury; weryfikacja przywołanych symboli i zakresu odpowiedzialności.
3. Korekty udowodnionych rozbieżności i rozszerzenie eigensolve z przypiętą rewizją gałęzi oraz opisem ograniczeń.
4. Walidacja przykładów Python, map źródeł, nawigacji i ścisły build Sphinx z kontrolą HTML. Bez kompilowania testów jednostkowych i bez deklarowania nieprzeprowadzonej kwalifikacji solvera.
5. Review, commity etapów, PR, wymagane kontrole, integracja i bezpieczny cleanup; dokładny zapis ewentualnych blokad.

## Checkpoint

- Izolacja i rejestr gotowe; cudze zmiany `fullmag-runtime-control` pozostawione w głównym checkoutcie.
- Przeczytane: strony wprowadzenia, architektury, frontend (w tym wszystkie strony meshing), root, backend index i changelog.
- Korekty w toku: nieprawidłowe ścieżki linków Sphinx, nieistniejący `kernel/modules`, niezgodny przykład manifestu, transport FP64 HTTP zamiast deklarowanego FP32 WebSocket/SSE, mylenie stanu UI z ProblemIR.
- Audyty fizyki, Python, metod numerycznych/walidacji i eigensolve w toku; szczegółowe raporty zostaną dołączone z pokryciem każdej strony.
- Bazowa kontrola przykładów Python: PASS. Kontrola architektury informacji: PASS (exit 0).
- Pełne mapy źródeł: kontrola trwa. Build Sphinx i wykonanie solvera: NOT VERIFIED.
