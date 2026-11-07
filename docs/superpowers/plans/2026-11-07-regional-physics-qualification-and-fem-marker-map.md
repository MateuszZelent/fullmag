# Kwalifikacja regionów i zwarte mapowanie FEM — wykonanie

Użytkownik zatwierdził kolejność: odblokować grupę WSL, wykonać brakujące testy
fizyki i poprawki, następnie dokończyć mapowanie FEM oraz cały cykl integracji.
Ten plan uszczegóławia wykonanie; nie rozszerza obsługi kombinacji odrzuconych
przez capability gates. Stan wykonania należy zapisywać z SHA i receiptami.

## Źródła kontraktu

- `docs/superpowers/specs/2026-11-01-fdm-unbounded-regions-architecture-design.md`,
  sekcje 6 i 9;
- `docs/physics/0104-material-regions-parameter-fields-and-interface-couplings.md`;
- `docs/superpowers/plans/2026-11-07-wsl-worktree-runtime-recovery.md`;
- `docs/guides/fullmag-build-storage-governance.md`, cykl integracji zadania;
- ADR 0067 i ADR 0076: izolacja grup oraz prywatny volume.

## Granice

Źródła: istniejący worktree `regional-physics-fixes`, branch
`codex/regional-physics-fixes-20261106`. Wyłączna grupa aplikacji:
`fullmag-worktree-fullmag-eacd36ead0850e14`, port 3345, wymagane GPU.
Nie uruchamiać main ani historycznych grup Windows. Buildy wyłącznie przez
recepty tej grupy, bez kompilacji na hoście. Wyniki naukowe i skrypty pozostają
na ext4 WSL. Zachować cudze zmiany, dane, control, leases i provenance.

## 1. Odblokowanie i runtime WSL

- [x] Uzgodnić oryginalną próbę `21294d69464d4230a09574eb9ea79649` przez
  zarządzany reconciler, zachowując stare przygotowanie i wszystkie piny.
  Terminal oraz zwolnienie blokady muszą być rzeczywiście potwierdzone.
- [x] Uaktualnić źródła zadania do aktualnego `origin/master` bez naruszania
  obcej pracy; zapisać pełny SHA i status wejścia.
- [x] Potwierdzić source/common Git/storage na WSL, port i budżet miejsca.
- [x] Wykonać `just docker-dev-toolchain`, a następnie
  `just docker-dev <worktree> 3345 '' required fem-demag-poisson`.
- [ ] Zweryfikować receipt, dokładne obrazy i kontenery, mounty RO/RW,
  prywatny volume i ledger grupy, API, native contract oraz browser QA.

## 2. Brakujące dowody fizyki i poprawki

- [ ] Zestawić istniejące dowody z bieżącymi źródłami; nie powtarzać wyników,
  których wejścia i warunki nadal mają zastosowanie. Zapisać pozostałe luki.
- [x] Wykonać analityczne sprawdzenie redukcji FEM DG0 na dokładnym zbiorze
  elementów w zarządzanym runtime; odróżnić je od ABI bez MFEM.
- [ ] Wykonać brakujące przypadki FDM CPU/CUDA fp64 i fp32: lokalne Ms/A/alpha,
  wymiana i jej energia, demag, Zeeman, anizotropia, MEL, legalne DMI,
  dynamika i obserwable. Zakres deklaracji ograniczyć do zmierzonych kombinacji.
- [ ] Dla niewspieranych kombinacji potwierdzić odmowy z publicznego planera
  oraz na odpowiednich granicach native/FFI, bez cichego fallbacku.
- [ ] Domknąć niezależne wyrocznie: pole jako pochodna energii, PBC i osie
  długości 1/2, rozłączni właściciele, Ms-ważony moment, relaksacja i zbieżność.
  Tolerancje przypiąć przed pomiarem, zgodnie z notą i istniejącymi skryptami.
- [ ] Każdy wykryty błąd: wykonywalna regresja RED, poprawka przyczyny,
  GREEN w dozwolonej bramce, commit spójnego fragmentu z dowodami.

## 3. Zwarte mapowanie FEM

- [ ] Udokumentować osobne mapy marker u32 → dodatni zwarty atrybut i mapy
  odwrotne dla domen i granic; marker air=0 nie może kolidować z materiałem.
- [ ] Zachować kanoniczne markery, ciągłe pole magnetyzacji i istniejące
  stopnie swobody. Koszt pamięci ma zależeć od liczby markerów, nie max-ID.
- [ ] Przenieść wszystkie konsumujące ścieżki: builder, verify_marker_map,
  CPU/GPU demag, Robin/Dirichlet/PBC, modalne airbox/Floquet, transport,
  selektory i fingerprinty. Bez utożsamiania atrybutu z markerem publicznym.
- [ ] Regresje obejmują 255/256/257/1000 markerów, wysokie rzadkie u32,
  air=0, granice 0 i 1, permutację etykiet, nieznany selector i zmianę mapy.
- [ ] Zweryfikować import/assembly, H_ex/E_ex i pochodną energii dla FEM CPU
  oraz obsługiwanej realizacji GPU/double. Ograniczenia DG0 pozostają jawne.
- [ ] Porównać wspólny prosty problem FDM/FEM przy zagęszczaniu siatki;
  kryterium stanowi zbieżność fizyczna, bez wymagania bitowej równości.

## 4. Integracja i zamknięcie

- [ ] Uaktualnić notę, source-map, macierz dowodów i stare checkboxy na
  podstawie rzeczywistych wyników, bez promocji builda do walidacji fizyki.
- [ ] Review pełnej zmiany, wymagane CI, PR do master, merge i kontrola
  integracji w zachowanym głównym checkoutcie bez resetowania cudzej pracy.
- [ ] Drain i kwalifikowane wycofanie dokładnej grupy zadania; zachować
  wyniki oraz dowody. Historyczne kontenery usuwać po osobnej kwalifikacji,
  bez usuwania wolumenów i wyników jako skutku ubocznego.
- [ ] Wykonać `worktree-finish ... completed`, niezależny inventory i retencję,
  następnie usunąć wyłącznie worktree i branch tego zadania właściwą ścieżką.
- [ ] Konfiguracja hosta nie może wskazywać usuniętego worktree. Zapisać
  końcowy stan rejestru i zachowane zasoby. Nierozstrzygnięte bramki oznaczyć
  dokładnie `NOT VERIFIED`/`blocked`; nie oznaczać całego zadania jako zakończonego.
