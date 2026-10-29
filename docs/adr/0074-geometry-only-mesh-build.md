# ADR 0074: Build siatki FEM wyłącznie z geometrii

Status: przyjęte przez użytkownika 28.10.2026 (wariant A z audytu
`docs/audits/2026-10-28-ui-mesh-build-scenario-audit.md`). Zweryfikowane w przeglądarce
na grupie Docker DEV (FEM CPU): build bez fizyki, edycja po buildzie i Compute.
FEM GPU i FDM NOT VERIFIED.

## Kontekst

W trybie Docker API-only polecenie `mesh_build` (wewnętrznie `remesh`) wywołuje
`ensure_live_accepted_study_with_transition`. Tworzy ono pełny, wykonywalny
StudyPlan i zaakceptowany RunIntent, a siatka powstaje jako produkt uboczny
przygotowania Compute. Skutki w scenariuszu „universe → obiekty → parametry
siatki → build → jakość”:

- build wymaga materiału, magnetyzacji, interakcji i etapu study, choć
  siatkowanie zależy tylko od geometrii;
- w domyślnym trybie universe Auto planowanie study przed buildem żąda już
  istniejącej siatki z powietrzem, czyli zależność jest cykliczna;
- po pierwszym buildzie run czeka na Compute, a
  `validate_active_scene_mutation` blokuje każdą zmianę geometrii i polityk
  siatki; przycisk Stop jest nieaktywny;
- polityka shared-domain trafia do mesha tylko jako `canonical_policy_snapshot`,
  więc rozmiary z Inspektora nie są realizowane;
- jakość, provenance i historia builda nie są publikowane do zasobów meshingu.

Przed commitem 916e2c3d8 istniała ścieżka przygotowania bez RunIntent
(`prepare_current_live_scene_with_transition`), ale ona też budowała pełny model
`Problem`, więc nadal wymagała fizyki.

## Decyzja

`mesh_build` w trybie Docker API-only jest operacją authoringu geometrii, a nie
przygotowaniem runu.

1. **Wejście** to wyłącznie dokument sceny: obiekty siatkowane z geometrią
   i transformacją (`GeometryEntryIR`), universe (`study.universe_mesh`),
   polityka shared-domain (`study.shared_domain_mesh`) i polityki per-obiekt.
   Materiały, magnetyzacja, interakcje i etapy study nie są czytane ani
   wymagane. Geometria nie jest identyfikowana nazwą: `geometry_name = object_id`.
2. **Realizacja** idzie przez `fullmag.meshing.remesh_cli` w trybie
   `shared_domain_manual_remesh`, uruchamiane w kontenerze `backend`.
   Polityka shared-domain jest przekazywana jako top-level `mesh_options`
   (rozmiary jako liczby), a polityki obiektów jako `per_geometry`.
3. **Publikacja**: API pakuje siatkę przez planerowe
   `reorder_shared_domain_mesh` (segmenty obiektów i części siatki bez
   materiałów), buduje `FemMeshPayload` i publikuje go z `mesh_workspace`
   zawierającym `source_scene_revision`, podsumowanie jakości, statystyki,
   raport builda, historię i status pipeline. Podnosi `mesh_revision`
   i `mesh_build_revision` oraz wysyła zdarzenie realtime.
4. **Bez RunIntent i bez blokady**: build nie tworzy zaakceptowanego runu.
   Zmiana sceny po buildzie jest dozwolona; siatka staje się nieaktualna, gdy
   `source_scene_revision` jest różne od rewizji sceny, a nie blokuje edycji.
5. **Compute** tworzy zaakceptowany Study jak dotąd i realizuje siatkę
   w ramach własnego przygotowania z tych samych polityk. Ponowne użycie
   siatki z punktu 3 przez Compute jest późniejszą optymalizacją; wymaga
   dowodu tożsamości wejść (hash geometrii i polityk), a nie samej rewizji.
6. **Walidacja authoringu**: brak materiału lub magnetyzacji blokuje
   `run_solver`, ale nie `realize_geometry` ani `build_mesh`. `Sphere`
   i `Ellipsoid` są geometrią produkcyjną FEM, bo mesher realizuje je przez
   OCC.
7. **Universe Auto bez paddingu** nie ma domeny powietrza. Build zwraca wtedy
   jawny błąd z instrukcją „ustaw padding lub tryb Manual”; nie wymyślamy
   domyślnego paddingu.

## Konsekwencje

- Scenariusz z audytu nie wymaga fizyki do zbudowania i oceny siatki,
  a iteracja „parametry → build → jakość” nie zamraża sesji.
- Ścieżka mesh-only i przygotowanie Compute są dwiema realizacjami tej samej
  polityki. Rozbieżność między nimi jest błędem; obie zapisują polityki
  w provenance.
- Nie zmieniamy ścieżki Compute, kontraktu RunIntent ani immutability
  zaakceptowanych wejść w trakcie runu.
- Sesje, które już mają oczekujący RunIntent z poprzedniej ścieżki, pozostają
  zablokowane do czasu jego zakończenia lub zatrzymania. Migracja ich stanu
  wykracza poza zakres tej decyzji.

## Bramki weryfikacji

- pytest: siatka dwóch sfer z `airbox_hmax` większym od celu ciała realizuje
  cel ciała (`packages/fullmag-py/tests/test_shared_domain_body_hmax.py`);
- przeglądarka w grupie worktree: nowa symulacja FEM → universe → dwie sfery
  → polityka → Build → jakość widoczna w Inspektorze i viewport; następnie
  zmiana geometrii i ponowny build bez 409, a canvas WebGL bez utraty
  kontekstu;
- Compute po buildzie mesh-only nadal startuje i publikuje własną siatkę.
