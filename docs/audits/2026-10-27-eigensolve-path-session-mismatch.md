# Multi-k: błędny identyfikator sesji w manifeście

Run `run-live-68a54e1d778bd7565c035992c44c90ff07e3d29a2e4c05081864e2f5cbb99a86`, aktywacja `93b62e84b5334e08886efb7b4d942920`: oba zadania succeeded, 14 modów i pakiet generacji zapisane. Poprawka assembly_kind działa. API nadal pokazuje running, ponieważ odmawia projekcji pakietu: `accepted_modal_publication_stale_context`, `modal manifest session differs from the current live session`.

Źródło: `build_eigen_path_frequency_domain_manifest` wpisuje literalne `session_id=current`. Builder nie otrzymuje tożsamości sesji. Ścieżka single-k poprawnie nie publikuje tego opcjonalnego pola. Poprawka usuwa fikcyjny identyfikator u producenta multi-k; walidacja API pozostaje niezmieniona, podobnie jak obowiązkowe exact run/stage/generation/equilibrium. Regresja obejmuje rzeczywisty builder path z obiema rodzinami replay sidecarów. Nie modyfikujemy historycznych manifestów ani hashy.

Walidator mapy dokumentacji naukowej i diff check PASS. Test Rust wymaga GitHub Actions; runtime poprawki pozostaje NOT VERIFIED. Wykres nowych 15 punktów jest przygotowany, ale odmawia traktowania obecnego API-running jako completed. Nie przedstawiamy pakietu workera jako opublikowanego wyniku UI.

Dodatkowo potwierdzono przyczynę przejściowego HTTP409 przy archiwizacji Gamma: `live_retirement_terminal_evidence_unknown`, writer busy w host ledger przez żywy runtime. Idempotentne potwierdzenie tej samej operacji `bae4b9042537400aa9c16c71058f1f49` zakończyło się retired/replayed; archiwum SHA256 `3feeb69f69a076b72305cf812bfe66ee2139b4f90cd2e35920d0bb5ab129bff3`. Potrzebna jest osobna poprawa obsługi ograniczonego oczekiwania na tę blokadę oraz raportowania trwałej odmowy publikacji zamiast stanu running.
