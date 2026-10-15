"""Interpreted source checks for the native WiX 3 BA contract.

This check intentionally does not configure CMake or invoke a compiler. A
managed Windows packaging job must provide the real WiX 3 SDK and prove the
Win32 DLL build separately.
"""

from __future__ import annotations

from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parent
CPP = (ROOT / "FullmagBootstrapperApplication.cpp").read_text(encoding="utf-8")
HEADER = (ROOT / "FullmagBootstrapperApplication.h").read_text(encoding="utf-8")
CMAKE = (ROOT / "CMakeLists.txt").read_text(encoding="utf-8")
DEF = (ROOT / "FullmagBootstrapperApplication.def").read_text(encoding="utf-8")
README = (ROOT / "README.md").read_text(encoding="utf-8")


def _extract_protocol_chunks(source: str) -> list[str]:
    start = source.index("    static std::wstring ProtocolScript() {")
    end = source.index("\n    std::mutex lock_", start)
    return re.findall(r'LR"PS\((.*?)\)PS"', source[start:end], flags=re.DOTALL)


class BootstrapperApplicationSourceContract(unittest.TestCase):
    def test_real_wix3_x86_target_and_exports(self) -> None:
        self.assertIn("IBootstrapperApplication.h", CMAKE)
        self.assertIn("IBootstrapperEngine.h", CMAKE)
        self.assertIn("WIX3_SDK_ROOT", CMAKE)
        self.assertIn('"${WIX3_SDK_ROOT}"', CMAKE)
        self.assertIn("CMAKE_SIZEOF_VOID_P", CMAKE)
        self.assertIn("WIN32_LEAN_AND_MEAN", CMAKE)
        self.assertIn("NOMINMAX", CMAKE)
        self.assertIn("#include <unknwn.h>", HEADER)
        self.assertIn("#include <objbase.h>", HEADER)
        self.assertLess(HEADER.index('#include "IBootstrapperEngine.h"'),
                        HEADER.index('#include "IBootstrapperApplication.h"'))
        self.assertIn('NOT EXISTS "${WIX3_BURN_INCLUDE_DIR}/IBootstrapperApplication.h"', CMAKE)
        self.assertIn('NOT EXISTS "${WIX3_BURN_INCLUDE_DIR}/IBootstrapperEngine.h"', CMAKE)
        self.assertRegex(DEF, r"(?m)^\s*BootstrapperApplicationCreate\s*$")
        self.assertRegex(DEF, r"(?m)^\s*BootstrapperApplicationDestroy\s*$")
        self.assertIn("BootstrapperApplicationCreate", CPP)
        self.assertIn("BootstrapperApplicationDestroy", CPP)
        self.assertIn("__uuidof(IBootstrapperApplication)", CPP)
        self.assertIn('MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"', CMAKE)
        self.assertIn("WINDOWS_EXPORT_ALL_SYMBOLS OFF", CMAKE)
        self.assertNotIn("placeholder", README.lower())

    def test_persistent_redacted_helper_protocol(self) -> None:
        for marker in (
            "CreateProcessW",
            "-EncodedCommand",
            "WriteFile",
            "ReadFile",
            "ProtocolScript",
            "$sessions = @{}",
            "Get-PublicSession",
            "python_available = -not [string]::IsNullOrWhiteSpace([string]$Session.python_command)",
            "manifest_hash = [string]$identity.manifest_hash",
            "resolver_hash = [string]$identity.resolver_hash",
            "git_head = [string]$identity.git_head",
            "requested_git_head = [string]$identity.requested_git_head",
            "Get-PublicProposal",
            "installer_env.ps1",
            "Get-FullmagInstallerEnvSession",
            "Get-FullmagInstallerEnvPublicIdentity",
            "Get-FullmagInstallerEnvPreview",
            "bootstrap_prerequisites",
            "PrerequisitesOnly",
            "Get-FullmagInstallerEnvInheritedSecretNames",
            "Remove-Item -Path ('Env:' + [string]$name)",
            "Get-FileHash -LiteralPath $scriptPath -Algorithm SHA256",
            "Commit-FullmagInstallerEnvProposal",
            "Cancel-FullmagInstallerEnvProposal",
            "redacted_diff",
            "blockers = @($Blocker)",
            "admitted_git_path_reparse",
            "admitted_python_path_reparse",
            "checkout_input_reparse",
            "SafeHelperBlockerMessage",
        ):
            self.assertIn(marker, CPP, marker)
        self.assertNotIn('summary += L"- " + blocker.string', CPP)
        self.assertIn("const std::wstring safeBlocker = SafeHelperBlockerMessage(blocker.string);", CPP)
        self.assertIn("std::wstring acceptedMainCheckout_", HEADER)
        self.assertIn("std::wstring acceptedSetupHash_", HEADER)
        self.assertIn("BootstrapPrerequisites", HEADER)
        self.assertIn("fieldsTruncated_", HEADER)
        self.assertIn("std::wstring acceptedManifestHash_", HEADER)
        self.assertIn("std::wstring acceptedResolverHash_", HEADER)
        self.assertIn("std::wstring acceptedMainGitHead_", HEADER)
        self.assertIn("std::wstring acceptedRequestedGitHead_", HEADER)
        self.assertIn("std::wstring sourceAdmissionPath_", HEADER)
        self.assertIn("CaptureAcceptedSourceIdentity", HEADER)
        self.assertIn("WriteSourceFirstAdmission", HEADER)
        self.assertIn("std::wstring acceptedStorageProfile_", HEADER)
        self.assertIn("std::wstring committedStorageRoot_", HEADER)
        self.assertIn("std::wstring committedRunsRoot_", HEADER)
        self.assertIn("std::wstring committedValuesJson_", HEADER)
        self.assertIn("std::wstring committedEnvironmentHash_", HEADER)
        self.assertIn("PrepareSourceFirstBurnVariables", HEADER)
        self.assertIn("RevalidateCommittedEnvironment", HEADER)
        self.assertIn("ValidateSourceFirstReceipt", HEADER)
        self.assertIn("Sha256File", CPP)
        self.assertIn("Join-Path $PSHOME 'powershell.exe'", CPP)
        self.assertIn("previewIsValid_ = valid;", CPP)
        self.assertIn('committed.String(L"state") != L"committed"', CPP)
        self.assertIn('committed.String(L"state") != L"unchanged"', CPP)
        dependency = CPP[CPP.index("void FullmagBootstrapperApplication::RunDependencyCheck") :]
        self.assertIn("acceptedRequestedCheckout_", dependency)
        self.assertIn("Sha256File(acceptedSetupScriptPath_)", dependency)
        self.assertIn('setup_hash', dependency)
        self.assertIn("acceptedMainCheckout_", dependency)
        self.assertIn("committedStorageRoot_", dependency)
        self.assertIn("committedValuesJson_", dependency)
        self.assertIn('JsonString(session)', dependency)
        self.assertNotIn("GetWindowTextValue(field.second)", dependency)
        self.assertNotIn("JoinPath(checkout, L\"scripts\\\\windows\\\\setup_build_environment.ps1\")", dependency)

        protocol = CPP[CPP.index("static std::wstring ProtocolScript") :]
        self.assertIn("$sessions[[string]$session.session_id] = $session", protocol)
        self.assertIn("$session = $sessions[[string]$request.session_id]", protocol)
        self.assertIn("Assert-FullmagInstallerEnvSession -Session $session", protocol)
        self.assertIn("Get-FullmagInstallerEnvPreview -Session $session -Values @{}", protocol)
        self.assertIn("runs_root = [string]$Proposal.runs_root", protocol)
        self.assertIn("prerequisite bootstrap did not provide a verified Python path", protocol)
        self.assertIn("setup storage root changed after admission", protocol)
        self.assertIn("setup storage profile changed after admission", protocol)
        self.assertIn("the .env changed after commit; the environment session was not rebound", protocol)
        self.assertIn("template_path = [string]$identity.template_path", protocol)
        self.assertIn("requested_git_worktrees_hash = [string]$identity.requested_git_worktrees_hash", protocol)
        self.assertIn("state = 'blocked'", protocol)
        self.assertIn("blockers = @($Blocker)", protocol)
        self.assertIn("admitted_python_path_reparse", protocol)
        self.assertNotIn("ConvertTo-Json $session", protocol)
        self.assertNotIn("Write-Public $session", protocol)

    def test_embedded_protocol_chunks_reconstruct_one_powershell_program(self) -> None:
        chunks = _extract_protocol_chunks(CPP)
        self.assertEqual(len(chunks), 5)
        protocol = "".join(chunks)
        self.assertTrue(protocol.startswith("\n$ErrorActionPreference = 'Stop'\n"))
        self.assertTrue(protocol.endswith("\n"))
        self.assertEqual(protocol.count("while (($line = [Console]::In.ReadLine())"), 1)
        operations = [
            "bootstrap_preadmission",
            "discover",
            "preview",
            "commit",
            "cancel",
            "setup",
        ]
        positions = [protocol.index(f"'{operation}' {{") for operation in operations]
        self.assertEqual(positions, sorted(positions))
        self.assertIn("Assert-FullmagInstallerEnvSession -Session $session", protocol)
        self.assertIn("Write-Public $public", protocol)
        self.assertIn("state = 'blocked'", protocol)
        self.assertIn("blockers = @($Blocker)", protocol)
        self.assertIn("admitted_python_path_reparse", protocol)
        self.assertNotIn(")PS\"", protocol)

    def test_helper_requests_are_worker_owned_and_cancelled_without_ui_blocking(self) -> None:
        self.assertIn("std::thread helperThread_", HEADER)
        self.assertIn("helperRequestInFlight_", HEADER)
        self.assertIn("helperMessageWindow_", HEADER)
        self.assertIn("HandleHelperReply", HEADER)
        self.assertIn("kUiReply", CPP)
        self.assertIn("kUiCancel", CPP)
        self.assertIn("pendingCancelSession_", CPP)
        self.assertIn("helper_->Send(request", CPP)
        self.assertEqual(CPP.count("helper_->Send(request"), 1)
        send_async = CPP[CPP.index("void FullmagBootstrapperApplication::SendHelperAsync") :
                         CPP.index("helperThread_ = std::thread")]
        self.assertNotIn("helper_->Start", send_async)
        worker = CPP[CPP.index("helperThread_ = std::thread") :
                     CPP.index("void FullmagBootstrapperApplication::HandleHelperReply")]
        self.assertIn("helper_->Start", worker)
        self.assertIn("if (helperThread_.joinable()) helperThread_.join();", CPP)
        self.assertIn("shuttingDown_.store(true)", CPP)
        destructor = CPP[CPP.index("FullmagBootstrapperApplication::~FullmagBootstrapperApplication") :
                        CPP.index("void FullmagBootstrapperApplication::SendHelperAsync")]
        self.assertIn("helper_->Shutdown();", destructor)
        self.assertLess(
            destructor.index("if (uiThread_.joinable()) uiThread_.join();"),
            destructor.index("if (helperThread_.joinable()) helperThread_.join();"),
        )
        shutdown = CPP[CPP.index("STDMETHODIMP_(int) FullmagBootstrapperApplication::OnShutdown") :
                       CPP.index("STDMETHODIMP_(int) FullmagBootstrapperApplication::OnSystemShutdown")]
        self.assertIn("helper_->Shutdown();", shutdown)
        self.assertIn("uiWindow_", CPP)
        self.assertIn("kUiApplyComplete", CPP)

    def test_mutating_operations_freeze_inputs_and_invalidate_lane_storage(self) -> None:
        self.assertIn("SetEnvironmentMutationLock(true)", CPP)
        self.assertIn("SetEnvironmentMutationLock(false)", CPP)
        self.assertIn("if (environmentMutationLocked_)", CPP)
        command = CPP[CPP.index("case WM_COMMAND") : CPP.index("case kUiStatus")]
        self.assertIn("commandId == kStorageRoot && notification == EN_CHANGE", command)
        self.assertIn("InvalidateEnvironmentAdmission(true)", command)
        lane = CPP[CPP.index("void FullmagBootstrapperApplication::InvalidateLaneAdmission") :
                   CPP.index("std::wstring FullmagBootstrapperApplication::RuntimeStorageProfile")]
        self.assertIn("InvalidateEnvironmentAdmission(false)", lane)
        commit = CPP[CPP.index("void FullmagBootstrapperApplication::PreviewEnvironment") :
                     CPP.index("bool FullmagBootstrapperApplication::ValidateBootstrapPayloads")]
        self.assertIn("valuesJson != CollectFieldValuesJson()", commit)
        self.assertIn("rebound = parsed ? committed.String(L\"session_id\")", commit)

    def test_burn_completion_is_marshaled_to_gui_thread(self) -> None:
        apply = CPP[CPP.index("STDMETHODIMP_(int) FullmagBootstrapperApplication::OnApplyComplete") :]
        self.assertIn("PostMessageW(target, kUiApplyComplete", apply)
        self.assertIn("HandleApplyComplete", CPP)
        self.assertNotIn("EnableWindowIf(launchButton_", apply)

    def test_burn_plan_completion_is_marshaled_before_apply_or_state_mutation(self) -> None:
        plan_callback = CPP[CPP.index("STDMETHODIMP_(void) FullmagBootstrapperApplication::OnPlanComplete") :
                            CPP.index("STDMETHODIMP_(int) FullmagBootstrapperApplication::OnApplyBegin")]
        self.assertIn("UiPlanCompleteMessage", plan_callback)
        self.assertIn("PostMessageW(target, kUiPlanComplete", plan_callback)
        self.assertNotIn("SetEnvironmentMutationLock", plan_callback)
        self.assertNotIn("SendUiTerminal", plan_callback)
        self.assertNotIn("engine_->Apply", plan_callback)
        self.assertIn("if (!posted)", plan_callback)
        self.assertIn("delete completion", plan_callback)
        handler = CPP[CPP.index("void FullmagBootstrapperApplication::HandlePlanComplete") :
                      CPP.index("void FullmagBootstrapperApplication::HandleApplyComplete")]
        self.assertIn("SetEnvironmentMutationLock", handler)
        self.assertIn("SendUiTerminal", handler)
        self.assertIn("engine_->Apply(target)", handler)
        self.assertIn("case kUiPlanComplete", CPP)
        self.assertIn("HandlePlanComplete(completion->status)", CPP)
        self.assertIn("PeekMessageW(&pending, nullptr, kUiPlanComplete, kUiPlanComplete, PM_REMOVE)", CPP)
        self.assertIn("delete reinterpret_cast<UiPlanCompleteMessage*>(pending.lParam)", CPP)

    def test_burn_plan_request_flag_is_cross_thread_safe(self) -> None:
        self.assertIn("std::atomic<bool> installRequested_", HEADER)
        self.assertIn("installRequested_.store(true)", CPP)
        self.assertIn("installRequested_.store(false)", CPP)
        self.assertIn("installRequested_.load()", CPP)

    def test_cancel_waits_for_burn_terminal_callback(self) -> None:
        cancel = CPP[CPP.index(
            "void FullmagBootstrapperApplication::CancelEnvironmentSession"):
            CPP.index("void FullmagBootstrapperApplication::ShowPublicReply", CPP.index(
                "void FullmagBootstrapperApplication::CancelEnvironmentSession"))]
        self.assertIn("burnCancelOperation_ = cancelContext", cancel)
        self.assertIn("engine_->Quit(ERROR_CANCELLED)", cancel)
        self.assertIn("Burn cancellation requested; waiting for the engine to finish", cancel)
        burn_path = cancel[cancel.index("if (burnActive)"):cancel.index(
            "if (!helperSessionActive")]
        self.assertNotIn(
            'SendUiTerminal(this, cancelContext, true, L"canceled"', burn_path,
            "successful Quit must wait for an engine terminal callback",
        )

        apply = CPP[CPP.index("void FullmagBootstrapperApplication::HandleApplyComplete"):
                    CPP.index("STDMETHODIMP FullmagBootstrapperApplication::QueryInterface")]
        self.assertIn("burnCancelRequested_.load()", apply)
        self.assertIn("burnCancelOperation_", apply)
        shutdown = CPP[CPP.index("STDMETHODIMP_(int) FullmagBootstrapperApplication::OnShutdown"):
                       CPP.index("STDMETHODIMP_(int) FullmagBootstrapperApplication::OnSystemShutdown")]
        self.assertIn("burnCancelOperation_", shutdown)
        self.assertIn("engine_shutdown", shutdown)

    def test_avalonia_broker_replaces_visible_win32_form(self) -> None:
        """The BA owns Burn and admission; Avalonia owns the visible controls."""
        ui_thread = CPP[CPP.index("void FullmagBootstrapperApplication::UiThreadMain") :
                        CPP.index("void FullmagBootstrapperApplication::CreateUi")]
        for marker in (
            "HWND_MESSAGE",
            "FullmagInstallerUiBroker",
            "broker->Start",
            "brokerEofMessage",
            "postBrokerClosed",
            "std::move(postBrokerClosed)",
            "kUiBrokerMessage",
            "SetEvent(uiReadyEvent_)",
            'license_text',
            'setup_script',
            'setup_script_path',
            'setup_hash',
            'requirements_manifest',
            'manifest_path',
            'manifest_hash',
            'installer_env_module',
            'version',
        ):
            self.assertIn(marker, ui_thread, marker)
        self.assertNotIn("CreateUi(window_)", ui_thread)
        self.assertNotIn("ShowWindow(window_, SW_SHOW)", ui_thread)
        self.assertIn("UiBrokerRunning(this)", CPP)
        self.assertIn('The hash-bound Avalonia installer UI could not be started.', CPP)
        self.assertIn("if (!fieldPanel_)", CPP)
        self.assertIn("UiBrokerValues(const_cast<FullmagBootstrapperApplication*>(this))", CPP)
        self.assertIn("UiBrokerCheckout(this)", CPP)
        self.assertIn("UiBrokerStorageRoot(this)", CPP)
        self.assertIn("UiBrokerLicenseAccepted(this)", CPP)
        self.assertIn("if (fieldPanel_ &&", CPP)
        self.assertIn("The modern broker UI owns confirmation.", CPP)
        self.assertIn("std::wstring acceptedSetupHash_", HEADER)
        self.assertIn("std::wstring committedEnvironmentHash_", HEADER)
        self.assertIn("struct UiBrokerDispatchGate", HEADER)
        self.assertIn("std::shared_ptr<UiBrokerDispatchGate> brokerDispatchGate_", HEADER)
        self.assertIn("const auto dispatchGate = brokerDispatchGate_", ui_thread)
        self.assertNotIn("auto postBrokerMessage = [this]", ui_thread)
        self.assertIn("cleanupDispatchGate->accepting = false", ui_thread)
        self.assertLess(ui_thread.index("cleanupDispatchGate->accepting = false"),
                        ui_thread.index("DestroyWindow(window_)") )

        broker_header = (ROOT / "FullmagInstallerUiBroker.h").read_text(encoding="utf-8")
        broker_cpp = (ROOT / "FullmagInstallerUiBroker.cpp").read_text(encoding="utf-8")
        self.assertIn("kProtocolSchema", broker_header)
        self.assertIn("using ClosedHandler", broker_header)
        self.assertIn("ClosedHandler onClosed", broker_header)
        self.assertIn("expectedSha256", broker_header)
        self.assertIn("CreateJobObjectW", broker_cpp)
        self.assertIn("CREATE_SUSPENDED", broker_cpp)
        self.assertIn("IsHello", broker_cpp)
        self.assertIn("SetHandleInformation", broker_cpp)
        self.assertIn("BuildSafeEnvironment", broker_cpp)
        self.assertIn("value.find(L'\\0')", broker_cpp)

        manifest = (ROOT / "FullmagBootstrapperApplication.manifest").read_text(encoding="utf-8")
        self.assertIn(">system</dpiAwareness>", manifest)
        self.assertNotIn(">PerMonitorV2</dpiAwareness>", manifest)

    def test_source_first_bootstrap_mode_is_provenance_bound_before_ui_init(self) -> None:
        ui_thread = CPP[CPP.index("void FullmagBootstrapperApplication::UiThreadMain") :
                        CPP.index("void FullmagBootstrapperApplication::CreateUi")]
        mode_validation = ui_thread[ui_thread.index("bool sourceFirstModeValid") :
                                    ui_thread.index("const auto provenanceRecord")]
        for marker in (
            'const JsonReader::Value* source = provenance.Get(L"source_first")',
            'EqualsInsensitive(provenanceMode, L"setup-only")',
            'EqualsInsensitive(provenanceMode, L"initial-build")',
            'const bool modeMatchesBurn = bootstrapMode_.empty() ||',
            'EqualsInsensitive(bootstrapMode_, provenanceMode)',
            'sourceFirstModeValid = legalMode && modeMatchesBurn',
            'bootstrapMode_ = provenanceMode',
            'if (!sourceFirstModeValid) bootstrapMode_.clear()',
            'requestedLane_ = sourceFirstModeValid ? RequestedLane() : std::wstring{}',
        ):
            self.assertIn(marker, mode_validation, marker)
        self.assertLess(mode_validation.index("sourceFirstModeValid = legalMode"),
                        ui_thread.index("const std::wstring initJson"))
        broker_start_offset = ui_thread.index("bool brokerStarted")
        broker_start = ui_thread[broker_start_offset :
                                 ui_thread.index("if (uiReadyEvent_)", broker_start_offset)]
        self.assertLess(broker_start.index("if (!sourceFirstModeValid)"),
                        broker_start.index("broker->Start"))
        self.assertIn("source-first bootstrap mode is missing", broker_start)

    def test_source_first_fresh_burn_profile_defaults_to_private_all_scope(self) -> None:
        requested_lane = CPP[CPP.index("std::wstring FullmagBootstrapperApplication::RequestedLane") :
                             CPP.index("void FullmagBootstrapperApplication::HandleCommand", CPP.index("std::wstring FullmagBootstrapperApplication::RequestedLane"))]
        provenance_gate = requested_lane[:requested_lane.index("// A source-first bundle")]
        self.assertIn('EqualsInsensitive(provenanceRoot.String(L"route"), L"source-first")', provenance_gate)
        self.assertIn('source->String(L"helper_sha256")', provenance_gate)
        self.assertIn('provenanceMode.empty()', provenance_gate)
        self.assertIn("// persisted Burn profile is only a historical hint", requested_lane)
        self.assertIn('return L"all";', requested_lane)
        self.assertNotIn('EngineVariable(L"FullmagStorageProfile")', provenance_gate)
        self.assertLess(requested_lane.index('return L"all";'),
                        requested_lane.index("void FullmagBootstrapperApplication::HandleCommand")
                        if "void FullmagBootstrapperApplication::HandleCommand" in requested_lane else len(requested_lane))

    def test_setup_only_receipt_cannot_advertise_all_runtime_ready(self) -> None:
        receipt_validation = CPP[CPP.index("bool FullmagBootstrapperApplication::ValidateSourceFirstReceipt") :
                                CPP.index("void FullmagBootstrapperApplication::DiscoverCheckout")]
        apply_completion = CPP[CPP.index("void FullmagBootstrapperApplication::HandleApplyComplete") :
                              CPP.index("void FullmagBootstrapperApplication::HandleCommand")]
        for marker in (
            'EqualsInsensitive(bootstrapMode_, L"setup-only")',
            'receipt.String(L"scope").empty()',
            'initialBuild->Bool(L"requested", true)',
            'fullRuntime->kind == JsonReader::Kind::Null',
        ):
            self.assertIn(marker, receipt_validation, marker)
        self.assertIn('EqualsInsensitive(bootstrapMode_, L"initial-build")', apply_completion)
        self.assertIn('Fullmag environment setup completed. Build the all-realizations package before launch.',
                      apply_completion)
        self.assertIn('all_runtime_ready', apply_completion)

    def test_broker_teardown_drops_queued_commands_and_window_failure_unblocks_startup(self) -> None:
        broker_message = CPP[CPP.index("case kUiBrokerMessage") :
                             CPP.index("case kUiStatus", CPP.index("case kUiBrokerMessage"))]
        self.assertIn(
            "std::unique_ptr<UiBrokerMessage> brokerMessage",
            broker_message,
        )
        self.assertIn("if (application->shuttingDown_.load()) return 0;", broker_message)

        ui_thread = CPP[CPP.index("void FullmagBootstrapperApplication::UiThreadMain") :
                        CPP.index("void FullmagBootstrapperApplication::CreateUi")]
        self.assertIn("const ATOM registeredClass = RegisterClassExW", ui_thread)
        failure = ui_thread[ui_thread.index("if (!window_)") :
                            ui_thread.index("sourceFirst_ =", ui_thread.index("if (!window_)"))]
        for marker in (
            "shuttingDown_.store(true)",
            "helperMessageWindow_.store(nullptr)",
            "uiWindow_.store(nullptr)",
            "dispatchGate->accepting = false",
            "if (uiReadyEvent_) SetEvent(uiReadyEvent_)",
            "if (registeredClass) UnregisterClassW(kWindowClass, g_module)",
            "if (comStatus == S_OK || comStatus == S_FALSE) CoUninitialize()",
            "return;",
        ):
            self.assertIn(marker, failure, marker)
        self.assertLess(failure.index("SetEvent(uiReadyEvent_)") , failure.index("return;"))
        self.assertLess(failure.index("return;"), ui_thread.index("sourceFirst_ ="))

    def test_broker_commands_are_generation_bound_and_clearable(self) -> None:
        command = CPP[CPP.index("bool ApplyBrokerInputs") : CPP.index("void SendBrokerReply")]
        command += CPP[CPP.index("case kUiBrokerMessage") : CPP.index("case kUiStatus")]
        command += CPP[CPP.index("bool ParseBrokerCommand") : CPP.index("bool ApplyBrokerInputs")]
        for marker in (
            "command.generation == state->generation",
            "command.revision > state->incomingRevision",
            "The UI command contains invalid input types.",
            "checkoutValue",
            "storageValue",
            "laneValue",
            "if (checkoutValue && checkout != state->checkout)",
            "if (storageValue && storage != state->storageRoot)",
            "if (laneValue && lane != state->lane)",
            "SetUiBrokerActiveOperation",
            'payload->String(L"operation"',
            "bootstrap_preadmission",
            "bootstrap_prerequisites",
            "dependency_check",
            "dependency_install",
            "initial_build",
            "application->LaunchInstalledUi(UiBrokerActiveOperation(application))",
            "application->CancelEnvironmentSession(UiBrokerActiveOperation(application))",
        ):
            self.assertIn(marker, command, marker)

    def test_cancel_terminalizes_old_request_before_rebinding_cancel_context(self) -> None:
        command = CPP[CPP.index("case kUiBrokerMessage") : CPP.index("case kUiStatus")]
        captured = command.index("const auto supersededOperation = UiBrokerActiveOperation(application);")
        applied = command.index("ApplyBrokerInputs(application", captured)
        old_terminal = command.index(
            'SendUiTerminal(application, supersededOperation, false, L"canceled"', captured)
        rebound = command.index("SetUiBrokerActiveOperation(application, command.requestId", old_terminal)
        new_cancel = command.index(
            "application->CancelEnvironmentSession(UiBrokerActiveOperation(application));", rebound)
        self.assertLess(captured, applied)
        self.assertLess(old_terminal, rebound)
        self.assertLess(rebound, new_cancel)
        self.assertIn("CancelEnvironmentSession performs the single admission", command)
        self.assertNotIn(
            'SendUiTerminal(application, supersededOperation, true',
            command[captured:new_cancel],
        )

        cancel = CPP[CPP.index(
            "void FullmagBootstrapperApplication::CancelEnvironmentSession"):
            CPP.index("void FullmagBootstrapperApplication::ShowPublicReply", CPP.index(
                "void FullmagBootstrapperApplication::CancelEnvironmentSession"))]
        self.assertIn("burnCancelOperation_ = cancelContext", cancel)
        self.assertIn("waiting for the engine to finish", cancel)

    def test_burn_lifecycle_and_launch_gates(self) -> None:
        for marker in (
            "engine_->Detect(uiWindow_.load())",
            "engine_->Plan(BOOTSTRAPPER_ACTION_INSTALL)",
            "engine_->Apply(target)",
            "if (shuttingDown_.load())",
            "!shuttingDown_.load() && target",
            "CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED)",
            "HWND_MESSAGE",
            "broker->Start",
            "license_text",
            "setup_script",
            "OnProgress",
            "OnApplyComplete",
            "IsWebView2Installed",
            "ProgramW6432",
            "ShellExecuteW",
            "EN_CHANGE",
            "InvalidateEnvironmentAdmission",
            "GetVariableString",
            "SetVariableString",
            "FullmagSourceCheckout",
            "FullmagStorageRoot",
            "FullmagStorageProfile",
            "FullmagBootstrapMode",
            "FullmagReceiptPath",
            "FullmagSourceAdmissionPath",
            "FullmagSourceAdmissionSha256",
            "bootstrap_prerequisites",
            "always receive a new receipt path",
            "RuntimeStorageProfile",
            "windows-native-fem-gpu",
            "Select your source folder before continuing.",
            "Source-first completed without a trusted matching receipt; installation is blocked.",
            "receipt path is outside the resolver-owned runs root",
            "RevalidateCommittedEnvironment",
            "storage_profile",
            "expectedReportProfile",
            "compiler_ready_provider_pending",
            "requirements.storage.build_profiles",
            "The runtime lane manifest is missing or inconsistent; installation is blocked.",
            "Microsoft Edge WebView2 Runtime is not installed; launch is blocked.",
            "CPU fallback is blocked.",
            "fullmag.windows-installer-source-admission.v1",
            "CREATE_NEW",
            "MOVEFILE_WRITE_THROUGH",
            "PROTECTED_DACL_SECURITY_INFORMATION",
            "kMaxSourceAdmissionBytes",
            "admission_sha256",
            "receiptEnvironmentHash",
            "receiptRunsRoot",
            "receiptSessionId",
            "receiptLane",
            "receiptMode",
            "requested_git_worktrees_hash",
            "The private source-first admission record could not be created; installation is blocked.",
            "An admitted source input changed before installation; read and commit the checkout again.",
            "Fullmag setup completed. Launch Fullmag to open the browser.",
            "field the GUI could not display",
        ):
            self.assertIn(marker, CPP, marker)
        shell = CPP[CPP.index("void FullmagBootstrapperApplication::LaunchInstalledUi") :]
        self.assertLess(shell.index("IsWebView2Installed"), shell.index("ShellExecuteW"))

    def test_broker_lifecycle_is_versioned_and_does_not_hold_registry_lock(self) -> None:
        parser = CPP[CPP.index("bool ParseBrokerCommand") :
                     CPP.index("bool ApplyBrokerInputs")]
        self.assertIn(
            'root.String(L"schema") != fullmag::installer::FullmagInstallerUiBroker::kProtocolSchema',
            parser,
        )
        self.assertIn(
            'root.String(L"version") != fullmag::installer::FullmagInstallerUiBroker::kProtocolVersion',
            parser,
        )
        self.assertIn('type != L"command" && type != L"shutdown"', parser)
        self.assertNotIn('root.String(L"kind")', parser)
        envelope = CPP[CPP.index("bool SendUiEnvelope") : CPP.index("bool UiBrokerRunning")]
        self.assertIn("FullmagInstallerUiBroker::kProtocolVersion", envelope)
        ui_thread = CPP[CPP.index("void FullmagBootstrapperApplication::UiThreadMain") :
                        CPP.index("void FullmagBootstrapperApplication::CreateUi")]
        self.assertIn("FullmagInstallerUiBroker::kProtocolVersion", ui_thread)

        command_window = CPP[CPP.index("case kUiBrokerMessage") : CPP.index("case kUiStatus")]
        for marker in (
            'lifecycle.String(L"type") == L"eof"',
            'lifecycle.String(L"schema") != FullmagInstallerUiBroker::kProtocolSchema',
            'lifecycle.String(L"version") != FullmagInstallerUiBroker::kProtocolVersion',
            'command.operation == L"shutdown"',
            'The installer UI shutdown was accepted.',
            'application->MaybeSendPendingHelperCancel()',
            'application->engine_->Quit(ERROR_CANCELLED)',
            'StopUiBroker(application)',
            'PostMessageW(target, kUiClose, 0, 0)',
        ):
            self.assertIn(marker, command_window, marker)

        state = CPP[CPP.index("struct UiBrokerState") : CPP.index("std::mutex g_uiBrokerLock")]
        self.assertIn("std::shared_ptr<fullmag::installer::FullmagInstallerUiBroker>", state)
        for function, next_function in (
            ("void StopUiBroker", "void ShutdownUiBroker"),
            ("void ShutdownUiBroker", "std::wstring JsonCompactValue"),
            ("bool SendUiEnvelope", "bool UiBrokerRunning"),
            ("bool UiBrokerRunning", "void SetUiBrokerGeneration"),
        ):
            body = CPP[CPP.index(function) : CPP.index(next_function)]
            self.assertNotIn("std::lock_guard<std::mutex> guard(g_uiBrokerLock);\n        broker->", body)
            self.assertIn("broker->", body)

        detect = CPP[CPP.index("STDMETHODIMP_(void) FullmagBootstrapperApplication::OnDetectComplete") :
                      CPP.index("STDMETHODIMP_(int) FullmagBootstrapperApplication::OnPlanBegin")]
        self.assertIn("Choose your source folder to continue.", detect)
        self.assertIn("!sourceFirst_", detect)

    def test_source_first_launch_uses_verified_managed_browser_helper(self) -> None:
        shell = CPP[CPP.index("bool FullmagBootstrapperApplication::LaunchSourceFirstUi") :
                    CPP.index("void FullmagBootstrapperApplication::LaunchInstalledUi")]
        for marker in (
            'EqualsInsensitive(bootstrapMode_, L"initial-build")',
            'EqualsInsensitive(requestedLane_, L"all")',
            "ValidateSourceFirstReceipt()",
            "fullmag-installer-environment.exe",
            'L" --mode launch-ui"',
            'L" --admission-path "',
            'L" --admission-sha256 "',
            "CREATE_NEW_CONSOLE",
            "CREATE_UNICODE_ENVIRONMENT",
            "Launch requested; startup status is shown in the console.",
            "QuoteWindowsArgument",
        ):
            self.assertIn(marker, shell, marker)
        self.assertNotIn("ProgramW6432", shell)
        self.assertNotIn("ShellExecuteW", shell)

        launch = CPP[CPP.index("void FullmagBootstrapperApplication::LaunchInstalledUi") :]
        self.assertLess(launch.index("if (sourceFirst_)"), launch.index("IsWebView2Installed"))
        self.assertIn("sourceFirstBrowserReady", CPP)

    def test_source_first_fresh_host_preadmission(self) -> None:
        """The first operation on a clean host is tool bootstrap, not checkout admission."""
        for marker in (
            "BootstrapFreshHostPrerequisites",
            "ValidateBootstrapPayloads",
            "bootstrap_preadmission",
            "storageRootEdit_",
            "kStorageRoot",
            "prerequisite_setup",
            "prerequisite_manifest",
            "basename(recordName(setupRecord))",
            "setup_build_environment.ps1",
            "windows_build_requirements.json",
            "-ExpectedRequirementsSha256",
            "source_admitted = $false",
            "env_write = $false",
            "storage_resolver = 'not_run'",
            "fullmag.windows-installer-preadmission.v1",
            "prerequisites_ready",
            "bootstrapGitPath_",
            "bootstrapPythonPath_",
            "git_path",
            "python_path",
            "const int fieldPanelTop = sourceFirst_ ? kFieldPanelSourceTop : kFieldPanelRuntimeTop",
        ):
            self.assertIn(marker, CPP, marker)

        preadmission = CPP[CPP.index("'bootstrap_preadmission' {"):CPP.index("'discover' {")]
        self.assertIn("-PrerequisitesOnly", preadmission)
        self.assertIn("Write-Public $public", preadmission)
        self.assertNotIn("Get-FullmagInstallerEnvSession", preadmission)
        self.assertNotIn("$sessions[[string]$session.session_id]", preadmission)

        discover = CPP[CPP.index("void FullmagBootstrapperApplication::DiscoverCheckout") :]
        self.assertIn("admittedGitPath", discover)
        self.assertIn("bootstrapGitPath_ = admittedGitPath", discover)
        self.assertIn("bootstrapPythonPath_ = admittedPythonPath", discover)
        self.assertLess(discover.index("InvalidateEnvironmentAdmission(true, false)"),
                        discover.index("bootstrapGitPath_ = admittedGitPath"))

        controls = CPP[CPP.index("void FullmagBootstrapperApplication::UpdatePrerequisiteControls") :]
        self.assertIn("EnableWindowIf(discoverButton_, false)", controls)
        self.assertIn("SetControlText(dependencyInstallButton_, L\"Prepare Git/Python\")", controls)
        self.assertIn("storageReady", controls)

    def test_no_forbidden_host_or_secret_transport(self) -> None:
        for forbidden in (r"\bwsl\.exe\b", r"\bsystem\s*\(", r"\bpopen\s*\(", r"\bcargo\b"):
            self.assertIsNone(re.search(forbidden, CPP, re.IGNORECASE), forbidden)
        self.assertNotIn("POSTGRES_PASSWORD", CPP)
        self.assertNotIn("MINIO_ROOT_PASSWORD", CPP)
        self.assertIn("CREATE_NO_WINDOW", CPP)
        self.assertNotIn("SetEnvironmentVariable", CPP)


if __name__ == "__main__":
    unittest.main()
