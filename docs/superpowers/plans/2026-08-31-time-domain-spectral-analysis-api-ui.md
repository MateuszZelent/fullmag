# Time-Domain Spectral Analysis API/UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zbudować kompletny, run-scoped workflow API i Control Room dla anteny, dynamiki czasowej, FFT, widma, pików, zespolonych pól odpowiedzi, historii runów i reprodukowalnego eksportu.

**Architecture:** Fizyczny Study/ProblemIR i run-scoped runtime pozostają źródłem prawdy. Generated OpenAPI → `ControlRoomApi` → resource hooks dostarcza bounded control-plane i osobny ciężki data-plane; realtime niesie wyłącznie invalidacje. Explorer, Analysis, Inspector i jedyny aktywny viewport współpracują przez kernel selection, command contributions i jawne resource identities, bez cross-module imports.

**Tech Stack:** Rust/Axum/serde w `crates/fullmag-api`, OpenAPI v2, Next.js 16, React, TypeScript, Zustand, ECharts, Three.js/R3F, Vitest/React Testing Library oraz Playwright/browser smoke.

## Global Constraints

- Wszystkie opisy, plan i dokumentacja są po polsku; nazwy kodowe i symbole pozostają zgodne z repozytorium.
- Edytowany jest wyłącznie plik planu wskazany w zadaniu; plan nie zawiera commitów, zmian implementacyjnych ani uruchomień mutujących repozytorium.
- OpenAPI v2, generated transport/types, ControlRoomApi i resource hooks są jedyną drogą frontendowego dostępu do backendu.
- Każdy zasób analizy jest run-scoped i zawiera run_id, study_id, analysis_id oraz revision; `source_stage_id` jest jawnie oznaczonym identyfikatorem źródłowego etapu, a nie zamiennikiem `analysis_id`.
- Nie wprowadzamy globalnego zasobu latest; bieżący run jest wyborem UI, nie ukrytą semantyką API.
- Invalidation jest event-driven; frontend nie używa setInterval, setTimeout jako pollera ani refetch-on-render.
- Realtime niesie małe zdarzenia typu resource-family/resource-id/revision/status; ciężkie dane są pobierane dopiero przez typed resource query.
- Zustand przechowuje tylko identyfikatory selekcji, preferencje prezentacji, układ i wersjonowane drafty; nie przechowuje tablic czasowych, FFT ani pól.
- Center surface renderuje tylko aktywną kartę/tryb; panel boczny może opisywać wybór, lecz nie dubluje ciężkiego renderera.
- Explorer, Results, AnalysisPlots, Inspector i viewport są osobnymi modułami z lokalnym stanem i publicznymi contributions.
- Nie ma cross-module imports pomiędzy katalogami modules/*; do współpracy służą kernel/contracts, selection i command registry.
- Każdy semantyczny węzeł Explorer ma osobny Inspector detail view.
- Inspector zachowuje root identity, focus, scroll i draft podczas invalidation oraz ACK; pending jest field/transaction-scoped.
- Osobno opisujemy modal spectrum, forced/dynamic response spectrum oraz FFT transform of temporal data.
- Brak artefaktu jest jawnie reprezentowany jako missing/unavailable z reason; HTTP status i UI copy muszą być spójne.
- Dane są bounded: zakres, decymacja, max points, max bins, max vectors i budżet pamięci są częścią kontraktu.
- Oś częstotliwości ma jawne jednostki, skalę i konwencję; nie wolno mieszać Hz/rad/s bez selektora lub normalizacji.
- Pobudzenie anteny z taperem albo zmianą szerokości wzdłuż prądu wymaga pełnego 3D solve; 2.5D nie może być promowane jako produkcyjna realizacja.
- Backendowa FEM/CUDA kwalifikacja, jeżeli będzie wykonywana, przebiega przez repozytoryjne just recipes; host build nie jest dowodem produkcyjnym.
- Control Room pozostaje na Next.js 16, tokenach --fm-* i klasach CSS z prefiksem fm-.
- globals.css pozostaje import-only; style planowane dla implementacji trafiają do src/design/styles/*.
- R3F/WebGL nie jest uznany za działający na podstawie TypeScript, testów komponentowych ani odpowiedzi HTTP.
- Browser gate musi potwierdzić widoczny canvas, gl.isContextLost() === false i niezerowy drawing buffer.
- WebGL Context Lost podczas startupu jest porażką lifecycle, dopóki test nie wykaże teardown-only.
- Każdy nowy renderer ma bounded redraw, dispose instancji ECharts/Three, brak rAF podczas idle i brak wycieków event listenerów.
- Każda mutacja ma test failing-first, test potwierdzający regresję, test akceptacyjny i browser evidence, jeśli dotyczy viewportu.
- Plan odróżnia stan potwierdzony w repozytorium od rekomendacji wdrożeniowej; brak live runtime/browser evidence jest oznaczony NOT VERIFIED.

---

## 1. Baseline repozytorium i słownik kontraktów

### Stan potwierdzony

- Router v2 jest zdefiniowany w C:\git\fullmag\fullmag\crates\fullmag-api\src\router_v2\mod.rs.
- Część frequency-domain znajduje się w C:\git\fullmag\fullmag\crates\fullmag-api\src\router_v2\handlers\analysis\frequency_domain.rs.
- Ciężkie pola wektorowe są obsługiwane w C:\git\fullmag\fullmag\crates\fullmag-api\src\router_v2\handlers\data\fields.rs.
- Frontendowe ścieżki typed API są w C:\git\fullmag\fullmag\apps\control-room\src\kernel\api\apiPaths.ts.
- Generated OpenAPI JSON jest w C:\git\fullmag\fullmag\apps\control-room\src\kernel\api\generated\openapi-v2.json.
- Generated TypeScript types są w C:\git\fullmag\fullmag\apps\control-room\src\kernel\api\generated\openapi-v2-types.ts.
- Facade znajduje się w C:\git\fullmag\fullmag\apps\control-room\src\kernel\api\ControlRoomApi.ts.
- Resource hooks runtime znajdują się w C:\git\fullmag\fullmag\apps\control-room\src\kernel\resources\studyRuntimeResources.ts.
- Moduł wykresów jest w C:\git\fullmag\fullmag\apps\control-room\src\modules\analysis-plots.
- Moduł Explorer jest w C:\git\fullmag\fullmag\apps\control-room\src\modules\explorer.
- Inspector routing jest w C:\git\fullmag\fullmag\apps\control-room\src\modules\inspector\inspectorRouteCatalog.tsx.
- Overlay analysis field jest w C:\git\fullmag\fullmag\apps\control-room\src\kernel\visualization\AnalysisFieldOverlayController.ts.
- Contributions overlay są w C:\git\fullmag\fullmag\apps\control-room\src\kernel\visualization\analysisFieldOverlayCommandContributions.ts.
- Stage inspector sampling jest w C:\git\fullmag\fullmag\apps\control-room\src\modules\inspector\panels\stages\FftResponseStageInspector.tsx.
- Existing response stage panel jest w C:\git\fullmag\fullmag\apps\control-room\src\modules\inspector\panels\stages\FrequencyResponseStageInspector.tsx.

### Potwierdzone symbole, które trzeba zachować

- FrequencyDomainManifestResource.
- FrequencyPoint, FrequencyMode, FrequencyBranch, FrequencyDomainDiagnostic.
- SweepProgress.
- get_frequency_domain_manifest_v1.
- get_frequency_domain_eigen_spectrum_v2.
- get_frequency_domain_eigen_branches_v2.
- get_frequency_domain_dispersion_v2.
- get_frequency_domain_diagnostics_v2.
- get_frequency_domain_eigen_mode_field_meta_v2.
- analysis_eigen_mode_vector_response.
- analysis_frequency_response_vector_response.
- serialize_analysis_field_vector_binary.
- AnalysisPlotsView.
- useAnalysisPlotsController.
- useAnalysisFrequencyData.
- ExplorerModule.
- buildStudyExplorerNodes oraz buildResultsExplorerNodes.
- EigenModeInspectorPanel, FmrModalSpectrumInspectorPanel, FmrResponseSweepInspectorPanel.
- ModeVisualizationInspectorPanel.
- AnalysisFieldOverlayController.

### Terminologia planu

- Study: kanoniczny opis fizyczny i jego stage authoring.
- Run: jedna wykonana instancja Study z własnym run_id i provenance.
- Stage: jednostka execution, np. dynamika czasowa, FFT, frequency response lub eigensolve.
- Temporal series: ograniczona seria wartości w czasie, bez zastępowania artefaktu pełnym zrzutem.
- Spectrum: wynik transformacji z jawnie określoną domeną i jednostką.
- Peak: wskazany bin/częstotliwość i powiązanie do source series oraz spectral response field; nie jest automatycznie eigenmodem.
- Spectral response field: zespolone pole przestrzenne `delta_m(f,r)` związane z określonym peak/run/analysis. Termin `mode field` jest zarezerwowany dla produktu `modal_eigen`.
- Overlay: aktywna reprezentacja pola na unified viewport; nie jest nowym zasobem fizycznym.

### Przekrój zależności

    Study draft
      -> study stage resource
      -> command run
      -> run resource + stage progress
      -> temporal-series resource
      -> spectrum resource + peak list
      -> selection {run_id, analysis_id, source_stage_id, spectrum_id, peak_id}
      -> spectral-response-field resource
      -> AnalysisFieldOverlayController
      -> unified viewport and Inspector
      -> history and export

## 2. Tabela Consumes/Produces

| Warstwa | Consumes | Produces | Właściciel |
|---|---|---|---|
| Study authoring | Study draft, antenna, sampling, FFT settings | validated stage definition | Study/Explorer |
| Run command | study_id, stage_id, execution intent | run_id, requested/resolved provenance | ControlRoomApi |
| Progress | run_id, stage_id, realtime event | status, percent, phase, diagnostics | runtime resource |
| Temporal data | run_id, series_id, bounded query | units, time axis, values, decimation metadata | data-plane API |
| Spectrum | temporal-series reference, FFT policy | bins, units, amplitudes, phase, peaks | AnalysisPlots |
| Peak selection | peak_id and source spectrum identity | selection IDs only | kernel selection |
| Spectral response field | run/analysis/stage/peak identity, codec request | binary/typed field metadata and payload | field resource |
| Overlay | field resource, quantity, display preferences | drawable scene layer | viewport kernel |
| Inspector | target identity and resource snapshot | controls, provenance, diagnostics | Inspector module |
| History | run list query and invalidation | bounded run summaries | Results/Explorer |
| Export | run/result IDs and format | archive/script/manifest download | ControlRoomApi |

Każdy interfejs jest implementowany jako explicit request/response/event contract. Nazwa rodziny resource w kodzie musi być identyczna po stronie Rust, OpenAPI, typed transport i hooka.

## 3. Zadanie 1 — run-scoped manifest i OpenAPI v2

**Cel:** wprowadzić kanoniczny manifest analizy czasowo-spektralnej zamiast łączenia niepowiązanych legacy endpoints.

**Pliki i symbole:**

- Utworzyć C:\git\fullmag\fullmag\crates\fullmag-api\src\schemas\time_domain_spectral_analysis.rs.
- Dodać moduł w C:\git\fullmag\fullmag\crates\fullmag-api\src\schemas\mod.rs.
- Utworzyć kanoniczny handler C:\git\fullmag\fullmag\crates\fullmag-api\src\router_v2\handlers\analysis\time_domain_spectral_analysis.rs; plik `frequency_domain.rs` pozostaje read-only granicą odrębnego produktu `driven_response`/`modal_eigen`.
- Zarejestrować moduł w C:\git\fullmag\fullmag\crates\fullmag-api\src\router_v2\handlers\analysis.rs.
- Zarejestrować route w C:\git\fullmag\fullmag\crates\fullmag-api\src\router_v2\mod.rs.
- Zaktualizować generowanie w C:\git\fullmag\fullmag\crates\fullmag-api\src\openapi_v2.rs.
- Dodać skupione testy routera do istniejącego C:\git\fullmag\fullmag\crates\fullmag-api\src\router_v2\tests.rs.

**Interfejs:**

- TimeDomainSpectralManifestResource: schema=`time_domain_spectral_manifest.v1`, resource_id, study_id, run_id, analysis_id, source_stage_id, revision, execution_status, artifact_status, validation_state, temporal_series_ids, spectrum_ids, peak_ids, response_field_ids, provenance.
- TimeDomainSpectralExecutionStatus: planned, queued, running, succeeded, failed, cancelled, unsupported.
- TimeDomainSpectralArtifactStatus: missing, incomplete, ready, invalid. `succeeded` wymaga `ready`; `incomplete` nigdy nie jest sukcesem.
- TimeDomainSpectralValidationState: unvalidated, algebra_validated, physics_validated, production_qualified. Frontendowe idle/loading/stale/error pozostają lokalnym resource lifecycle.
- TimeDomainSpectralProvenance: requested_source_backend, requested_source_device, resolved_source_backend, resolved_source_device, source_precision, requested_analysis_engine, resolved_analysis_engine, engine_resolution_reason, engine_capability_snapshot_id, requested_analysis_device, resolved_analysis_device, analysis_precision, analysis_transfer_policy, source_revision, artifact_revision.
- TimeDomainSpectralManifestQuery: run_id, analysis_id, include=summary|all.
- TimeDomainSpectralManifestResponse: resource, etag/revision, missing_reason.

**TDD i implementacja:**

- [ ] Napisz test, który żąda manifestu dla obcego run_id i oczekuje 404 z kodem RUN_NOT_FOUND.
- [ ] Uruchom polecenie cargo test -p fullmag-api missing_run_manifest -- --nocapture; test ma początkowo nie przejść, bo route/resource nie istnieje.
- [ ] Napisz test valid manifest, który sprawdza run_id, analysis_id, source_stage_id, revision, trzy osie statusu i provenance bez pola z ciężkimi wartościami.
- [ ] Dodaj serde schema z bounded vector IDs i jawnie rozróżnionym missing_reason.
- [ ] Dodaj handler get_time_domain_spectral_manifest_v2(run_id, analysis_id, state).
- [ ] Rejestruj route `/v2/sessions/current/analysis/time-domain-spectral/{run_id}/{analysis_id}/manifest`.
- [ ] Dodaj OpenAPI operationId getTimeDomainSpectralManifestV2.
- [ ] Wygeneruj schemat z dokładnie tymi nazwami enumów i nullable semantics.
- [ ] Uruchom testy ponownie; oczekiwany wynik to exit code 0 i status ok dla testu missing_run_manifest.

**Oczekiwany kontrakt HTTP:**

- Consumes: path run_id/analysis_id oraz opcjonalne include; brak body. `source_stage_id` pochodzi z manifestu i jest sprawdzane z authority źródłowego runu.
- Produces: application/json dla manifestu; 404 application/problem+json dla nieistniejącego runu lub analizy; 409 dla niezgodnego `source_stage_id`/source revision.
- ETag/revision jest nagłówkiem i polem resource; klient może warunkowo pobrać nową rewizję.
- Manifest nie zwraca pełnego temporal array, FFT array ani field vectors.

## 4. Zadanie 2 — data-plane pola i serie czasowe

**Cel:** dostarczyć bounded, run-scoped temporal series oraz spectral response field metadata/payload z jednym codec contract.

**Pliki i symbole:**

- Rozszerzyć C:\git\fullmag\fullmag\crates\fullmag-api\src\router_v2\handlers\data\fields.rs.
- Utworzyć C:\git\fullmag\fullmag\crates\fullmag-api\src\router_v2\handlers\data\analysis_series.rs.
- Zarejestrować moduł w C:\git\fullmag\fullmag\crates\fullmag-api\src\router_v2\handlers\data\mod.rs.
- Utworzyć C:\git\fullmag\fullmag\apps\control-room\src\kernel\api\codecs\analysisFieldCodec.ts.
- Utworzyć C:\git\fullmag\fullmag\apps\control-room\src\kernel\api\queries\analysisSeriesQuery.ts.
- Rozszerzyć C:\git\fullmag\fullmag\apps\control-room\src\kernel\api\generated\openapi-v2-types.ts.

**Interfejs temporal series:**

- TemporalSeriesResource: resource_id, run_id, analysis_id, source_stage_id, series_id, quantity, component, unit, sampling_rate_hz, t0_s, dt_s, sample_count, returned_count, decimation, values, revision.
- TemporalSeriesQuery: run_id, analysis_id, source_stage_id, series_id, start_index, end_index, max_points, decimation, component. `source_stage_id` jest guardem spójności, a nie alternatywną authority adresowania.
- TemporalSeriesValues: numeric_type, encoding=json|f32|f64, values albo data_ref; max_points jest obowiązkowe po normalizacji.
- SeriesWindowMetadata: requested_window, actual_window, omitted_count, aliasing_warning, nyquist_hz.

**Interfejs spectral response field:**

- SpectralResponseFieldResource: field_id, run_id, analysis_id, source_stage_id, peak_id, frequency_hz, peak_index, response_kind, quantity, component, mesh_id, shape, bounds, codec, byte_length, revision.
- Temporal binary body: media type `application/vnd.fullmag.temporal-series+octet-stream;version=1`, magic `FMTDSER1`, version, endian, dtype, component layout, shape, payload length, payload.
- Spectral field binary body: media type `application/vnd.fullmag.spectral-response-field+octet-stream;version=1`, magic `FMTDFLD1`, version, endian, response kind, dtype, component layout, shape, payload length, payload.
- JSON metadata nigdy nie zawiera binary payload inline.
- Preferowany storage dla istniejących mode fields pozostaje Zarr vector_xyz_complex; compatibility binary musi ujawniać codec/version.

**TDD i implementacja:**

- [ ] Napisz test max_points, który dla serii 1_000_000 próbek żąda 4_096 i oczekuje returned_count <= 4096.
- [ ] Uruchom polecenie cargo test -p fullmag-api bounded_temporal_series -- --nocapture; test ma nie przejść przed implementacją limitu.
- [ ] Napisz test odrzucający max_points=0, ujemny window oraz nieskończony decimation z kodem INVALID_QUERY.
- [ ] Dodaj normalizację window i limit pamięci w analysis_series handler.
- [ ] Dodaj content negotiation JSON/binary oraz metadane aliasing_warning.
- [ ] Dodaj test, że payload field dla innego run_id lub analysis_id jest 404, a dla niezgodnego source_stage_id jest 409.
- [ ] Zaimplementuj analysis_time_domain_series_response oraz analysis_spectral_response_field_response.
- [ ] Zaimplementuj serialize_analysis_field_vector_binary tak, aby header był walidowalny przed alokacją.
- [ ] Dodaj frontendowy decoder z limitem byte_length i kontrolą dtype/shape.
- [ ] Uruchom polecenia cargo test -p fullmag-api time_domain_spectral -- --nocapture oraz pnpm --dir apps/control-room test -- analysisFieldCodec analysisSeriesQuery; oczekiwane są zielone testy i brak oversized allocation.

**Consumes/Produces:**

- Consumes: GET `/v2/sessions/current/analysis/time-domain-spectral/{run_id}/{analysis_id}/time-series/{series_id}` z query window/max_points.
- Produces: JSON TemporalSeriesResource, binary `application/vnd.fullmag.temporal-series+octet-stream;version=1` dla serii albo `application/vnd.fullmag.spectral-response-field+octet-stream;version=1` dla pola; problem+json dla limitów i identity errors.
- Cache key obejmuje run_id, analysis_id, source_stage_id, resource_id, revision, query window i codec.
- Client nie używa fetch poza ControlRoomApi/typed transport.

## 5. Zadanie 3 — realtime invalidation bez pollingu

**Cel:** połączyć run/stage/resource revision ze zdarzeniami WebSocket i unieważniać wyłącznie właściwy resource family.

**Pliki i symbole:**

- Rozszerzyć C:\git\fullmag\fullmag\crates\fullmag-api\src\realtime_policy.rs.
- Rozszerzyć C:\git\fullmag\fullmag\crates\fullmag-api\src\main.rs.
- Utworzyć C:\git\fullmag\fullmag\apps\control-room\src\kernel\realtime\RealtimeInvalidationBridge.ts.
- Utworzyć C:\git\fullmag\fullmag\apps\control-room\src\kernel\realtime\analysisInvalidation.ts.
- Dodać testy do C:\git\fullmag\fullmag\apps\control-room\src\kernel\realtime\RealtimeInvalidationBridge.test.ts.

**Event contract:**

- ResourceInvalidatedEvent: event_id, emitted_at, resource_family, resource_id, run_id, analysis_id nullable, source_stage_id nullable, revision, reason. Dla rodzin analizy `analysis_id` i `source_stage_id` są wymagane; dla run/stage pozostają nullable.
- StageProgressEvent: event_id, run_id, stage_id, status, phase, completed, total, percent, cancellable, diagnostics_revision.
- Resource families: time-domain-spectral-manifest, temporal-series, spectrum, peak-list, spectral-response-field, run, stage, artifact.
- Event nie zawiera values, field bytes, chart arrays ani pathów plików tymczasowych.

**TDD i implementacja:**

- [ ] Napisz test, który przyjmuje event spectrum dla analysis A i nie unieważnia cache temporal-series analysis B, nawet gdy oba należą do tego samego runu.
- [ ] Uruchom polecenie pnpm --dir apps/control-room test -- RealtimeInvalidationBridge; test ma failować przy braku family-scoped routing.
- [ ] Napisz test deduplikacji po event_id i monotonic revision.
- [ ] Zaimplementuj routeAnalysisInvalidation(event, cache) z odrzuceniem stale revision.
- [ ] Dodaj backendowy event serializer i test zgodności JSON z OpenAPI.
- [ ] Podłącz stage status do istniejącego realtime channel w main.rs, zachowując reconnect semantics.
- [ ] Usuń potrzebę refetch-on-focus dla aktywnego analysis resource; focus może jedynie sprawdzić świeżość revision.
- [ ] Dodaj test, że reconnect nie odtwarza poleceń ani nie resetuje Inspector draft.
- [ ] Uruchom pnpm --dir apps/control-room typecheck oraz testy realtime; oczekiwany wynik to brak błędów i brak interwałów pollingu.

**Produkuje:** invalidation event oraz bounded progress. **Konsumuje:** resource cache revision i active selection. **Nie produkuje:** pełnych danych.

## 6. Zadanie 4 — generated transport, ControlRoomApi i resource hooks

**Cel:** związać OpenAPI v2 z facade i hookami bez lokalnych requestów w komponentach.

**Pliki i symbole:**

- Zaktualizować C:\git\fullmag\fullmag\apps\control-room\src\kernel\api\generated\openapi-v2.json.
- Zaktualizować C:\git\fullmag\fullmag\apps\control-room\src\kernel\api\generated\openapi-v2-types.ts.
- Rozszerzyć C:\git\fullmag\fullmag\apps\control-room\src\kernel\api\apiPaths.ts.
- Rozszerzyć C:\git\fullmag\fullmag\apps\control-room\src\kernel\api\ControlRoomApi.ts.
- Rozszerzyć C:\git\fullmag\fullmag\apps\control-room\src\kernel\resources\studyRuntimeResources.ts.
- Utworzyć C:\git\fullmag\fullmag\apps\control-room\src\kernel\api\hooks\timeDomainSpectralResources.ts.
- Dodać C:\git\fullmag\fullmag\apps\control-room\src\kernel\api\hooks\timeDomainSpectralResources.test.ts.

**Public facade signatures:**

- getTimeDomainSpectralManifest(runId, analysisId, include): Promise<ResourceResult<TimeDomainSpectralManifestResource>>.
- getTemporalSeries(query): Promise<ResourceResult<TemporalSeriesResource>>.
- getSpectrum(runId, analysisId, spectrumId): Promise<ResourceResult<SpectrumResource>>.
- getPeakList(runId, analysisId, spectrumId): Promise<ResourceResult<PeakListResource>>.
- getSpectralResponseField(runId, analysisId, fieldId, options): Promise<BinaryResourceResult<SpectralResponseFieldResource>>.
- runStage(request): Promise<RunAcceptedResource>.
- cancelStage(runId, stageId): Promise<CommandAcceptedResource>.
- exportAnalysis(request): Promise<ArtifactDownloadResource>.

**TDD i implementacja:**

- [ ] Napisz test hooka z pustym runId, który nie wywołuje transportu i zwraca validation error.
- [ ] Uruchom polecenie pnpm --dir apps/control-room test -- timeDomainSpectralResources; test ma failować przed dopisaniem facade/path.
- [ ] Napisz test, że hook używa query key zawierającego wszystkie identity IDs i revision, nie tablicy jako klucza Zustand.
- [ ] Dodaj path builders i generated operation types.
- [ ] Dodaj metody facade delegujące do wspólnego typed transport.
- [ ] Dodaj useTimeDomainSpectralManifest, useTemporalSeries, useSpectrum, usePeakList i useSpectralResponseField.
- [ ] Każdy hook ma enabled tylko przy kompletnym target identity; disabled nie wykonuje requestu.
- [ ] Resource hook konsumuje invalidation bridge i refetchuje tylko po nowszej rewizji.
- [ ] Testuj problem+json, 404 missing, 409 conflict i codec mismatch.
- [ ] Uruchom pnpm --dir apps/control-room typecheck oraz testy hooków; oczekiwany wynik: exit code 0.

**Zakaz:** komponenty modules/analysis-plots, explorer, inspector i viewport nie importują fetch, axios ani niskopoziomowego transportu.

## 7. Zadanie 5 — Explorer/Study authoring osobnych stage'y i komendy pipeline

**Cel:** umożliwić authoring osobnych kontraktów drive/antenna, time evolution z samplingiem i analizy spektralnej oraz zautomatyzować ich złożenie jedną komendą bez tworzenia monolitycznego stage'a.

**Pliki i symbole:**

- Rozszerzyć C:\git\fullmag\fullmag\crates\fullmag-api\src\schemas\authoring.rs o serializowalny stage authoring contract.
- Rozszerzyć C:\git\fullmag\fullmag\crates\fullmag-api\src\router_v2\handlers\model\authoring.rs o revision-safe odczyt i transakcję stage'a.
- Rozszerzyć C:\git\fullmag\fullmag\crates\fullmag-api\src\script.rs o kanoniczny Python export nowego stage'a.
- Utworzyć C:\git\fullmag\fullmag\apps\control-room\src\modules\explorer\builders\study\timeDomainSpectralAnalysisStageNode.ts.
- Utworzyć C:\git\fullmag\fullmag\apps\control-room\src\modules\inspector\panels\stages\TimeDomainSpectralAnalysisStageInspector.tsx.
- Rozszerzyć C:\git\fullmag\fullmag\apps\control-room\src\modules\explorer\builders\study\runStageNode.ts o child identity samplingu.
- Rozszerzyć C:\git\fullmag\fullmag\apps\control-room\src\modules\inspector\panels\stages\RunStageInspector.tsx o TimeSeriesSampling editor.
- Rozszerzyć C:\git\fullmag\fullmag\apps\control-room\src\modules\ribbon\ribbonContributions.tsx o komendę `analysis.add-time-domain-spectroscopy-pipeline`.
- Ograniczyć C:\git\fullmag\fullmag\apps\control-room\src\modules\inspector\panels\stages\FftResponseStageInspector.tsx do czytnika kompatybilności starego `fft_response`, z jawną bramką usunięcia po jednej wersji zapisującej wyłącznie nowy kontrakt.
- Rozszerzyć C:\git\fullmag\fullmag\apps\control-room\src\modules\inspector\panels\stages\SamplingDiagnostics.tsx.
- Rozszerzyć C:\git\fullmag\fullmag\apps\control-room\src\modules\inspector\panels\stages\samplingPresentation.ts.

**Schema stage i pipeline:**

- TimeSeriesSamplingSpec, należący do TimeEvolution/Run stage: interval_s, quantities, clock, spatial_selection, components, format, resampling_policy. Duration pozostaje wyłącznie w source Run stage.
- TimeDomainSpectralAnalysisStageSpec: analysis_id, name, source_stage_id, source_artifact_id nullable, time_range_s nullable, response_quantity_id, source_quantity_id nullable, source_drive_ids, spatial_selection, components, reference, transform, products, peak_detection, requested_analysis_engine, spectral_compute_policy.
- Antenna/drive pozostaje osobnym authored physics module albo zależnym AntennaFieldSolve/SolvedAntennaDrive stage; analysis stage przechowuje tylko source identities i nie kopiuje geometrii anteny.
- Pipeline command tworzy uporządkowane zależności: opcjonalny equilibrium → opcjonalny AntennaFieldSolve/drive → TimeEvolution z TimeSeriesSampling → TimeDomainSpectralAnalysis.
- Walidacja odrzuca niespójny source duration/interval/expected sample count, częstotliwość ponad Nyquist, zero padding ponad politykę, brak source drive dla susceptibility oraz brak pełnego 3D solve dla taper/constriction.

**TDD i implementacja:**

- [ ] Napisz test schema, w którym source Run duration i sampling interval dają inny expected sample count niż resolved plan, i oczekuj INVALID_SAMPLING bez duplikowania duration w SamplingSpec.
- [ ] Uruchom polecenie cargo test -p fullmag-api script::time_domain_spectral; test ma początkowo failować.
- [ ] Napisz test buildStudyExplorerNodes sprawdzający osobne node identities dla drive/antenna, source Run, sampling i TimeDomainSpectralAnalysis.
- [ ] Dodaj TimeSeriesSamplingSpec i TimeDomainSpectralAnalysisStageSpec oraz walidator po stronie routera i shared generated types.
- [ ] Waliduj `requested_analysis_engine=auto|native|mmpp`; runtime resource pokazuje resolved engine i reason. UI nie wykonuje fallbacku ani nie zamienia jawnego MMPP na native.
- [ ] Dodaj analysis node builder z immutable stage/source IDs; nazwa obiektu ani stage presentation type nie aktywują fizyki.
- [ ] Zbuduj TimeDomainSpectralAnalysisStageInspector z sekcjami Source, Transform, Products, Peaks, Analysis Engine, Provenance i Validation. Antenna i Sampling zachowują własne Inspector targets; nie współdziel lokalnego stanu z eigensolve ani driven response.
- [ ] Zaimplementuj atomiczną pipeline transaction: błąd dowolnego child stage nie pozostawia częściowo utworzonego grafu.
- [ ] Walidacja inline jest dostępna dla klawiatury i nie resetuje draftu przy resource invalidation.
- [ ] Dodaj accessible descriptions dla units, Nyquist i bin width.
- [ ] Uruchom pnpm --dir apps/control-room test -- timeDomainSpectralAnalysisStageNode TimeDomainSpectralAnalysisStageInspector RunStageInspector FftResponseStageInspector SamplingDiagnostics; oczekiwany wynik: wszystkie testy zielone, pipeline ma osobne stage identities, a compatibility panel nie zapisuje starego kontraktu.

**Produces:** validated stage draft i canonical script export. **Consumes:** Study state, object identity i capabilities. **Rekomendacja:** błędne sampling settings blokują Run, ale nie blokują nawigacji do diagnostyki.

## 8. Zadanie 6 — stage execution, progress, cancel i provenance

**Cel:** zapewnić kontrolowane wykonanie stage i widoczny requested-versus-resolved execution reality.

**Pliki i symbole:**

- Rozszerzyć C:\git\fullmag\fullmag\apps\control-room\src\kernel\api\generated\openapi-v2-types.ts.
- Rozszerzyć C:\git\fullmag\fullmag\apps\control-room\src\kernel\api\ControlRoomApi.ts.
- Rozszerzyć C:\git\fullmag\fullmag\apps\control-room\src\kernel\resources\studyRuntimeResources.ts.
- Rozszerzyć C:\git\fullmag\fullmag\apps\control-room\src\modules\explorer\ExplorerModule.tsx.
- Rozszerzyć C:\git\fullmag\fullmag\apps\control-room\src\modules\inspector\panels\stages\FrequencyResponseStageInspector.tsx.
- Utworzyć C:\git\fullmag\fullmag\apps\control-room\src\modules\inspector\panels\stages\TimeDomainSpectralExecutionPanel.tsx.
- Utworzyć C:\git\fullmag\fullmag\apps\control-room\src\modules\inspector\panels\stages\StageProgressSummary.tsx.

**Commands:**

- RunStageCommand: study_id, stage_id, requested_execution, idempotency_key.
- CancelStageCommand: run_id, stage_id, idempotency_key.
- CommandAcceptedResource: command_id, run_id, stage_id, accepted_at, status.
- Progress: phase, completed, total, percent, cancellable, estimated_remaining_s nullable, diagnostics_revision.

**TDD i implementacja:**

- [ ] Napisz test, że dwa Run z tym samym idempotency_key nie tworzą dwóch runów.
- [ ] Uruchom pnpm --dir apps/control-room test -- StageProgressSummary; test ma failować bez phase-scoped progress.
- [ ] Napisz test cancel: przy statusie succeeded przycisk jest niedostępny, przy running wysyła jeden command.
- [ ] Dodaj useStageProgress(runId, stageId) z realtime-only invalidation.
- [ ] Dodaj useRunStageCommand z pending scoped do command_id.
- [ ] Explorer pokazuje queued/running/succeeded/cancelled/failed bez udawania procentu, gdy total jest nieznany.
- [ ] Inspector pokazuje trzy osobne osie: source backend/device, analysis engine i analysis compute device/transfer policy, każdą jako requested obok resolved; pokazuje też source/artifact revision.
- [ ] ACK nie odmontowuje panelu i nie zeruje scroll/focus.
- [ ] Dodaj test retry po reconnect bez ponownego wysłania mutacji.
- [ ] Uruchom pnpm --dir apps/control-room typecheck i testy; oczekiwany wynik: 0 oraz brak pollera.

**Produces:** run resource, stage progress events i provenance. **Consumes:** validated stage oraz capability resolution. **Brak:** silent CPU fallback dla wymuszonego GPU.

## 9. Zadanie 7 — AnalysisPlots dla serii czasowej, FFT i spectrum

**Cel:** przekształcić istniejący moduł wykresów w instrument naukowy z trzema jawnie rozdzielonymi powierzchniami.

**Pliki i symbole:**

- Rozszerzyć C:\git\fullmag\fullmag\apps\control-room\src\modules\analysis-plots\AnalysisPlotsView.tsx.
- Rozszerzyć C:\git\fullmag\fullmag\apps\control-room\src\modules\analysis-plots\useAnalysisPlotsController.ts.
- Rozszerzyć C:\git\fullmag\fullmag\apps\control-room\src\modules\analysis-plots\hooks\useAnalysisFrequencyData.ts.
- Utworzyć C:\git\fullmag\fullmag\apps\control-room\src\modules\analysis-plots\hooks\useTimeDomainSeriesData.ts.
- Utworzyć C:\git\fullmag\fullmag\apps\control-room\src\modules\analysis-plots\analysisDatasetAdapter.ts.
- Utworzyć C:\git\fullmag\fullmag\apps\control-room\src\modules\analysis-plots\AnalysisFrequencySurface.tsx.
- Utworzyć C:\git\fullmag\fullmag\apps\control-room\src\modules\analysis-plots\analysisPlotOption.ts.

**Surface contract:**

- TimeSeriesSurface: time axis in s, quantity/unit selector, raw/decimated indicator, bounded point count.
- SpectrumSurface: frequency axis in Hz or rad/s, amplitude/phase selector, window and FFT provenance.
- PeakSurface: peak markers, keyboard list, confidence/quality and source spectrum identity.
- response-map nie jest prezentowana jako gotowa; pozostaje unavailable, jeśli backend nie publikuje mapy.

**TDD i implementacja:**

- [ ] Napisz test, że dataset z unit mismatch nie tworzy jednej osi bez normalizacji.
- [ ] Uruchom pnpm --dir apps/control-room test -- analysisDatasetAdapter AnalysisPlotsView; test ma failować bez jawnego adaptera.
- [ ] Napisz test, że przy braku active run center surface pokazuje empty state, a nie request latest.
- [ ] Dodaj typed adapters dla TemporalSeriesResource, SpectrumResource i PeakListResource.
- [ ] Dodaj bounded ECharts option z dataZoom/samplingiem ograniczonym do datasetu.
- [ ] Dodaj explicit dispose w lifecycle AnalysisFrequencySurface i guard przeciw wielu instancjom ECharts.
- [ ] Dodaj useAnalysisPlotsController z selection IDs, nie z tablicami danych w Zustand.
- [ ] Peak click aktualizuje tylko peak_id oraz spectrum_id; ciężkie spectral response field jest lazy.
- [ ] Tooltip pokazuje label, wartość, jednostkę, run/stage i indeks próbki; nie pokazuje surowej krotki.
- [ ] Uruchom pnpm --dir apps/control-room test -- analysisDatasetAdapter AnalysisPlotsView useAnalysisPlotsController i oczekuj exit code 0.

**Produkuje:** accessible plot model i peak selection. **Konsumuje:** resource hooks. **Nie produkuje:** global state z values ani viewport draw calls.

## 10. Zadanie 8 — peak → spectral response field → 3D/2D overlay i Inspector

**Cel:** domknąć scientific interaction od zaznaczenia piku do przestrzennej reprezentacji wybranego pola.

**Pliki i symbole:**

- Rozszerzyć C:\git\fullmag\fullmag\apps\control-room\src\kernel\visualization\AnalysisFieldOverlayController.ts.
- Rozszerzyć C:\git\fullmag\fullmag\apps\control-room\src\kernel\visualization\analysisFieldOverlayCommandContributions.ts.
- Utworzyć C:\git\fullmag\fullmag\apps\control-room\src\modules\inspector\panels\time-domain-spectral\SpectralResponseFieldInspectorPanel.tsx.
- Rozszerzyć C:\git\fullmag\fullmag\apps\control-room\src\modules\inspector\inspectorRouteCatalog.tsx.
- Utworzyć C:\git\fullmag\fullmag\apps\control-room\src\modules\inspector\panels\time-domain-spectral\SpectralResponseFieldDataPreview.tsx.

**Selection contract:**

- AnalysisSelection: run_id, analysis_id, source_stage_id, spectrum_id, peak_id, field_id nullable, quantity, component.
- Overlay command: activate/deactivate, field identity, display mode, normalization, phase, opacity preference.
- Controller nie pobiera danych; otrzymuje decoded field resource przez kernel visualization adapter.

**TDD i implementacja:**

- [ ] Napisz test, że click peak ustawia selection IDs i nie umieszcza field bytes w Zustand.
- [ ] Uruchom pnpm --dir apps/control-room test -- AnalysisFieldOverlayController; test ma failować przed lazy field binding.
- [ ] Napisz test, że wybór innego runa usuwa overlay poprzedniego runa przed załadowaniem nowego.
- [ ] Dodaj bindAnalysisField(selection, resource) z walidacją run/stage/peak identity.
- [ ] Dodaj command contribution analysis.activate-spectral-response-field-overlay.
- [ ] Dodaj metadata-driven color scale, quantity/unit, phase/amplitude i normalization controls.
- [ ] SpectralResponseFieldInspectorPanel pokazuje field status loading/ready/missing/error, source peak i ostrzeżenie, że wynik nie jest eigenmodem bez osobnego modal-eigen dowodu.
- [ ] SpectralResponseFieldDataPreview pokazuje shape, codec, byte length, bounds i revision, bez dumpowania całego payloadu.
- [ ] Inspector route dla spectrum peak i spectral response field są osobnymi entries; nie używaj jednego generycznego detail view ani paneli `EigenModeInspectorPanel`/`FmrResponseSweepInspectorPanel`.
- [ ] Uruchom testy komponentów; oczekiwany wynik: root identity i focus zachowane przy loading/ACK.

**Browser/WebGL obowiązek:**

- Canvas musi być widoczny po wyborze peak.
- gl.isContextLost() musi zwracać false.
- gl.drawingBufferWidth > 0 i gl.drawingBufferHeight > 0.
- Włączenie overlay nie może wyłączyć domyślnej jakości sceny; fallback jest jawny i raportowany.
- 2D/3D mode map używa unified viewport, a nie osobnego ukrytego canvasu.

## 11. Zadanie 9 — Results/Explorer history i run-scoped context

**Cel:** pozwolić wrócić do zakończonych runów, ich stage, spectrum, peaków i artefaktów bez utraty identity.

**Pliki i symbole:**

- Rozszerzyć C:\git\fullmag\fullmag\apps\control-room\src\modules\explorer\ExplorerModule.tsx.
- Rozszerzyć C:\git\fullmag\fullmag\apps\control-room\src\modules\explorer\builders\resultsExplorerNodes.ts.
- Rozszerzyć C:\git\fullmag\fullmag\apps\control-room\src\modules\explorer\builders\buildModelTree.ts.
- Rozszerzyć C:\git\fullmag\fullmag\apps\control-room\src\modules\explorer\builders\study\studyExplorerNodes.ts.
- Rozszerzyć C:\git\fullmag\fullmag\apps\control-room\src\modules\explorer\explorerStore.ts.
- Utworzyć C:\git\fullmag\fullmag\apps\control-room\src\kernel\api\hooks\runHistoryResources.ts.
- Rozszerzyć C:\git\fullmag\fullmag\apps\control-room\src\modules\analysis-plots\AnalysisPlotsModule.tsx jako jedyną ciężką powierzchnię Results.

**Model node:**

- Run node: run_id, created_at, status, study_id, source_revision, resolved execution, artifact count.
- Stage node: stage_id, status, progress summary, resource revision.
- Analysis node: manifest_id, temporal series count, spectrum count, peak count, spectral response field count.
- Peak child node: peak_id, frequency/unit, amplitude, quality, field availability.
- Artifact child node: artifact_id, media_type, byte_length, checksum, persistence status.

**TDD i implementacja:**

- [ ] Napisz test, że buildResultsExplorerNodes utrzymuje dwa runy tego samego Study jako osobne branch nodes.
- [ ] Uruchom pnpm --dir apps/control-room test -- resultsExplorerNodes ExplorerModule runHistoryResources; test ma failować, gdy context jest tylko current run.
- [ ] Napisz test, że kliknięcie history run ustawia IDs i nie kopiuje arrays do store.
- [ ] Dodaj useRunHistory z bounded page size i cursor, z invalidation przez resource family run.
- [ ] Rozszerz ExplorerModule o run/stage breadcrumbs i history selection.
- [ ] Dodaj osobne route identity dla run, stage, spectrum, peak i field.
- [ ] Wynik nieistniejący ma status missing i reason, nie znika po cichu z drzewa.
- [ ] Results center pozostaje aktywną jedyną ciężką powierzchnią; Explorer nie renderuje wykresu obok center.
- [ ] Zachowaj referencje do source_revision/artifact_revision przy otwieraniu history.
- [ ] Uruchom testy modułu i typecheck; oczekiwany wynik: wszystkie testy zielone.

## 12. Zadanie 10 — typed export, persistence i reprodukowalność

**Cel:** eksportować wybrany run/analysis wraz z provenance, konfiguracją, checksumami i referencją do danych.

**Pliki i symbole:**

- Rozszerzyć C:\git\fullmag\fullmag\crates\fullmag-api\src\router_v2\mod.rs w route export analysis.
- Rozszerzyć należący do tej funkcji C:\git\fullmag\fullmag\crates\fullmag-api\src\router_v2\handlers\analysis\time_domain_spectral_analysis.rs; handler `frequency_domain.rs` pozostaje niezmieniony.
- Zaktualizować C:\git\fullmag\fullmag\crates\fullmag-api\src\openapi_v2.rs.
- Rozszerzyć C:\git\fullmag\fullmag\apps\control-room\src\kernel\api\apiPaths.ts.
- Rozszerzyć C:\git\fullmag\fullmag\apps\control-room\src\kernel\api\ControlRoomApi.ts.
- Rozszerzyć utworzony w Zadaniu 8 C:\git\fullmag\fullmag\apps\control-room\src\modules\inspector\panels\time-domain-spectral\SpectralResponseFieldInspectorPanel.tsx; istniejący frequency-domain Inspector pozostaje osobnym produktem.
- Rozszerzyć C:\git\fullmag\fullmag\apps\control-room\src\modules\explorer\builders\resultsExplorerNodes.ts.

**Export contract:**

- AnalysisExportRequest: run_id, analysis_id, source_stage_id nullable guard, selection IDs nullable, include=manifest|series|spectrum|fields|script|diagnostics, format=zip|json|zarr|python.
- AnalysisExportManifest: contract_version, study_id, run_id, analysis_id, source_stage_id, selection, sampling, FFT policy, requested/resolved execution, source/artifact revisions, checksums.
- Download response: application/zip, application/json, application/x-zarr lub text/x-python; metadata headers contain artifact_id and checksum.
- Export of missing field returns problem+json MISSING_ARTIFACT with field identity; nie tworzy pustego pliku.

**TDD i implementacja:**

- [ ] Napisz test, że export selected peak obejmuje manifest, spectrum, peak and exactly one referenced field.
- [ ] Uruchom cargo test -p fullmag-api export_selected_peak -- --nocapture; test ma failować bez selection-aware manifest.
- [ ] Napisz test facady, że format=python używa canonical script route, a nie UI-only JSON.
- [ ] Dodaj schema request/response i route `/v2/sessions/current/analysis/time-domain-spectral/{run_id}/{analysis_id}/exports`.
- [ ] Dodaj checksum i byte length przed rozpoczęciem downloadu.
- [ ] Dodaj exportAnalysis do ControlRoomApi i command contribution w Inspector.
- [ ] UI pokazuje format, zakres danych, run identity, revision i wynik pobierania.
- [ ] Export nie blokuje center renderera; progress download jest osobno trackowany.
- [ ] Dodaj test persistence/reload, że history run nadal rozwiązuje artifact IDs po restart-like cache clear.
- [ ] Uruchom Rust tests, frontend tests i OpenAPI snapshot; oczekiwany wynik: zero drift i exit code 0.

## 13. Zadanie 11 — lifecycle, accessibility i performance gates

**Cel:** zapewnić stabilny center surface, brak wycieków i naukowo użyteczne interakcje przy dużych danych.

**Pliki i symbole:**

- Rozszerzyć C:\git\fullmag\fullmag\apps\control-room\src\modules\analysis-plots\components\AnalysisFrequencySurface.tsx.
- Rozszerzyć C:\git\fullmag\fullmag\apps\control-room\src\modules\analysis-plots\components\EChartsSurface.tsx.
- Rozszerzyć C:\git\fullmag\fullmag\apps\control-room\src\kernel\visualization\AnalysisFieldOverlayController.ts.
- Rozszerzyć C:\git\fullmag\fullmag\apps\control-room\src\modules\inspector\InspectorModule.tsx.
- Rozszerzyć C:\git\fullmag\fullmag\apps\control-room\src\modules\viewport-3d\Viewport3DModule.tsx.
- Rozszerzyć C:\git\fullmag\fullmag\apps\control-room\src\modules\field-map\FieldMapModule.tsx.
- Dodać testy do C:\git\fullmag\fullmag\apps\control-room\src\modules\analysis-plots\components\AnalysisFrequencySurface.performance.test.tsx.
- Dodać testy do C:\git\fullmag\fullmag\apps\control-room\src\kernel\visualization\AnalysisFieldOverlayController.performance.test.ts.

**Accessibility:**

- Każdy wykres ma accessible name, opis jednostek i tabelaryczny/tekstowy fallback dla peaków.
- Keyboard focus porusza się po peakach, toggle amplitude/phase, quantity i export.
- Kontrast Catppuccin jest liczony względem tokenów --fm-*; nie używaj surowych hex w module.
- aria-busy dotyczy tylko target resource; pending jednego field nie wyłącza innych kontrolek.
- Reduced motion wyłącza entry animation i nie zmienia znaczenia danych.
- Color scale nie jest jedynym nośnikiem informacji; label/tooltip/legend ujawniają wartość.

**Performance:**

- ECharts ma co najwyżej jedną instancję na aktywny center target.
- Opcje wykresu są memoizowane względem revision/query, nie względem każdej klatki.
- Dane są decymowane po stronie API/adaptera do widocznego zakresu.
- Spectral response field jest lazy i dispose'owany przy zmianie targetu.
- Overlay nie tworzy geometrii w renderze React; update odbywa się przez controller.
- Idle surface nie wykonuje rAF ani redraw.
- Pomiar obejmuje heap growth, listener count, ECharts instance count, draw calls i frame time.

**TDD i implementacja:**

- [ ] Napisz failing test, że zmiana resource revision nie remountuje Inspector root.
- [ ] Uruchom pnpm --dir apps/control-room test -- AnalysisFrequencySurface.performance AnalysisFieldOverlayController.performance; oczekiwany pierwszy wynik to failure z limitem niezaimplementowanym.
- [ ] Dodaj test render/request budget dla 100 invalidation events; aktywny target może wykonać tylko bounded deduplicated refetch.
- [ ] Dodaj test Object i Airbox mutation, sprawdzający zero unrelated disabled/opacity changes oraz zachowanie focus/scroll.
- [ ] Dodaj cleanup ECharts, WebGL resources, ResizeObserver, pointer listeners i worker messages.
- [ ] Dodaj profiler evidence adapter zgodny z frontend-v2-performance-gates.
- [ ] Uruchom pnpm --dir apps/control-room typecheck i testy; oczekiwany wynik to exit code 0 oraz brak leak assertion.

## 14. Zadanie 12 — end-to-end matrix, browser i WebGL evidence

**Cel:** udowodnić pełny workflow w testach kontraktowych, komponentowych i przeglądarkowych.

**Pliki i symbole:**

- Utworzyć C:\git\fullmag\fullmag\apps\control-room\playwright.config.ts, ponieważ baseline ma zależność Playwright, lecz nie ma repozytoryjnego configu ani katalogu e2e.
- Utworzyć C:\git\fullmag\fullmag\apps\control-room\tests\e2e\time-domain-spectral-analysis.spec.ts.
- Utworzyć C:\git\fullmag\fullmag\apps\control-room\tests\e2e\fixtures\timeDomainSpectralFixture.ts.
- Utworzyć C:\git\fullmag\fullmag\apps\control-room\tests\e2e\fixtures\controlRoomApiFixture.ts.
- Dodać backend fixture do C:\git\fullmag\fullmag\crates\fullmag-api\tests\fixtures\time_domain_spectral.json.
- Dodać snapshot OpenAPI do C:\git\fullmag\fullmag\apps\control-room\src\kernel\api\generated\openapi-v2.json.

**Browser scenariusz:**

- Otwórz Study i dodaj TimeDomainSpectral stage.
- Ustaw antenna, duration, dt/count, window i FFT; potwierdź validation copy.
- Uruchom stage i sprawdź queued/running/progress/cancel.
- Poczekaj na realtime success event; nie używaj pollingu w teście.
- Otwórz temporal series, spectrum i peak list.
- Zaznacz peak; sprawdź, że Inspector pokazuje peak identity i lazy field loading.
- Otwórz spectral response field; sprawdź canvas unified viewport.
- Wykonaj WebGL gate: canvas visible, gl.isContextLost() === false, drawingBuffer width/height > 0.
- Zmień amplitude/phase/quantity; sprawdź update bez remountu i bez context loss.
- Otwórz history run; sprawdź preserved run/stage/spectrum/peak IDs.
- Wykonaj export i sprawdź content type, checksum header oraz manifest selection.

**Macierz testów:**

| Obszar | Przypadek | Dowód |
|---|---|---|
| Schema | poprawny stage | Rust contract test |
| Schema | invalid dt/count/Nyquist | Rust validation test |
| API | run-scoped manifest | handler integration |
| API | bounded series | max_points assertion |
| API | binary field | codec/header test |
| Realtime | revision dedupe | bridge unit test |
| Commands | run idempotency | command integration |
| Commands | cancel | API + UI test |
| Hooks | disabled identity | hook unit test |
| Hooks | no polling | fake timers/intervalless assertion |
| Explorer | study authoring | node builder test |
| Explorer | history run | results node test |
| Plots | units/axes | adapter/component test |
| Plots | peak keyboard selection | RTL accessibility test |
| Inspector | stable root | mutation regression |
| Inspector | missing resource | missing-state test |
| Overlay | peak to field | controller unit test |
| Overlay | field to viewport | Playwright/WebGL |
| Export | selected bundle | Rust + browser download |
| Performance | 100 invalidations | render/request budget |
| Performance | large series | memory/decimation gate |
| Browser | desktop Chromium | E2E |
| Browser | reduced motion | E2E accessibility |
| WebGL | context and buffer | explicit GL probe |

**Dokładne komendy i oczekiwane wyniki:**

- cargo test -p fullmag-api time_domain_spectral -- --nocapture → wszystkie skupione testy routera ok.
- cargo test -p fullmag-api script::time_domain_spectral → walidacja schema ok.
- pnpm --dir apps/control-room typecheck → exit code 0.
- pnpm --dir apps/control-room test -- timeDomainSpectral → wszystkie testy passed.
- pnpm --dir apps/control-room test -- AnalysisFieldOverlayController AnalysisFrequencySurface → brak leaków i budget violations.
- pnpm --dir apps/control-room exec playwright test tests/e2e/time-domain-spectral-analysis.spec.ts → scenariusz Chromium passed.
- Browser console nie zawiera THREE.WebGLRenderer: Context Lost.
- Browser probe raportuje canvasVisible=true, contextLost=false, drawingBufferWidth>0, drawingBufferHeight>0.
- API capture pokazuje wyłącznie ścieżki zaczynające się od `/v2/sessions/current/analysis/time-domain-spectral/{run_id}/{analysis_id}/`, z manifest, series, spectrum, peaks, fields i export; brak endpointu typu „latest”, zapisu przez legacy alias i interwałowego refetch.
- Realtime capture zawiera stage-progress i resource-invalidated z monotonic revision.

Jeżeli dowód runtime, browser albo WebGL nie został rzeczywiście uruchomiony, raport wykonania musi zawierać NOT VERIFIED; sam passing typecheck nie zamyka bramki.

## 15. Kolejność wdrożenia i punkty kontroli

1. Zadanie 1 ustanawia manifest i identity.
2. Zadanie 2 ustanawia bounded data-plane.
3. Zadanie 3 ustanawia invalidation i status event.
4. Zadanie 4 podłącza generated transport, facade i hooks.
5. Zadanie 5 udostępnia canonical stage authoring.
6. Zadanie 6 dodaje execution, progress, cancel i provenance.
7. Zadanie 7 buduje plots i peak selection.
8. Zadanie 8 wiąże peak ze spectral response field i viewport overlay.
9. Zadanie 9 dodaje history oraz run-scoped Explorer/Results.
10. Zadanie 10 domyka persistence i export.
11. Zadanie 11 stabilizuje lifecycle, accessibility i performance.
12. Zadanie 12 wykonuje pełne contract/browser/WebGL gates.

Po zadaniu 1 nie wolno generować frontendowych typów z niezatwierdzonego JSON. Po zadaniu 4 żaden nowy komponent nie może użyć bezpośredniego transportu. Po zadaniu 8 selection/overlay musi być sprawdzony z realnym field identity. Po zadaniu 12 można mówić o gotowym workflow tylko wtedy, gdy każda bramka ma dowód.

## 16. Kryteria akceptacji

- Manifest, series, spectrum, peaks i spectral response fields mają spójny run/analysis/source-stage identity.
- Każdy request i response jest opisany w OpenAPI v2 i odwzorowany w generated types.
- ControlRoomApi jest jedyną fasadą, a resource hooks jedynym miejscem cache/invalidation.
- Nie ma pollingu; progress i invalidation pochodzą z realtime.
- Explorer potrafi authorować antenę/sampling/FFT oraz pokazać status stage.
- AnalysisPlots rozróżnia serię czasową, spectrum i peak; osie są unit-aware.
- Peak selection prowadzi do właściwego spectral response field i unified 2D/3D overlay, bez semantycznego awansu do eigenmode.
- Inspector pokazuje właściwy target, provenance, codec i missing/error state.
- Historia umożliwia odtworzenie zakończonego runa bez latest fallbacku.
- Export zawiera canonical script/manifest, requested/resolved execution i checksumy.
- Center surface jest active-only, a ciężki renderer nie jest dublowany przez Explorer/Inspector.
- Zustand zawiera wyłącznie IDs/preferences/layout/draft metadata.
- Invalidations nie remountują panelu i nie zmieniają niezależnych kontrolek.
- Accessibility testy obejmują keyboard, labels, units, contrast, reduced motion i non-color semantics.
- Performance testy obejmują bounds danych, dedupe requests, heap/listeners, ECharts/Three disposal i idle redraw.
- Browser test potwierdza DOM/API wiring.
- WebGL test potwierdza canvas, context i drawing buffer; bez tego status pozostaje NOT VERIFIED.

## 17. Ryzyka i decyzje pozostawione jawnie

- Existing legacy aliases /analysis/eigenmodes/* i /analysis/eigen/* mogą pozostać dla kompatybilności, lecz nowy frontend nie może ich używać. Usunięcie aliasów jest osobną migracją.
- Istniejący optional-artifact behavior zwracający HTTP 200 z missing status musi zostać ujednolicony z MISSING_ARTIFACT; implementacja wybiera jeden kontrakt przed aktualizacją snapshotu.
- response-map pozostaje unavailable, dopóki backend nie publikuje jawnego map resource; UI nie symuluje mapy z niepełnego sweepu.
- AntennaFieldSolve/SolvedAntennaDrive nie są dodawane jako nazwy backendowe bez potwierdzenia ProblemIR i capability vocabulary; stage używa tylko zatwierdzonych typed schemas.
- Zarr jest preferowany dla dużych pól, ale binary codec pozostaje wymagany dla kompatybilnego transportu HTTP.
- History query jest bounded cursor pagination; pełne archiwum nie może być ładowane do drzewa jednorazowo.
- Estymowany czas pozostały jest nullable i nie może być wyliczany z arbitralnego percentu bez backendowego total.
- Cancellation jest best effort i ma końcowy status cancelled/failed wraz z diagnostics, nigdy ciche zniknięcie runa.
- GPU/FEM runtime evidence jest osobną bramką od correctness API/UI; brak managed runtime dowodu nie jest zastępowany testem mock.

## 18. Finalny self-review planu

- Plan zaczyna się wymaganym headerem, Goal, Architecture, Tech Stack i Global Constraints.
- Każde zadanie ma cel, dokładne pliki, symbole, Consumes/Produces albo jawny kontrakt, TDD, komendy i expected output.
- Kolejność jest dependency-aware: schema przed generated types, transport przed hooks, hooks przed modułami, overlay przed browser evidence.
- Żaden krok nie wymaga cross-module importu ani globalnych tablic w Zustand.
- Active-only center surface, no polling, realtime invalidation, Inspector stability i run-scoped identity są powtórzone w kryteriach akceptacji.
- Plan rozdziela state control-plane od data-plane i nie proponuje transportu ciężkich payloadów przez JSON.
- Plan nie deklaruje wykonania testów; komendy są przyszłymi krokami implementacji z oczekiwanymi wynikami.
- Nie ma nierozstrzygniętych markerów planistycznych.
- Nie ma instrukcji commit/push/merge.
- Browser/WebGL evidence ma osobne, sprawdzalne assertions i status NOT VERIFIED przy braku live proof.
- Rekomendowany zakres nie rozszerza semantyki fizycznej poza canonical Study/ProblemIR i istniejące capability contracts.
