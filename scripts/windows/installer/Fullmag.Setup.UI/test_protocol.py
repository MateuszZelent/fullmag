"""Interpreted source checks for the Avalonia installer UI contract.

This deliberately does not restore NuGet packages, compile C# or start a
Windows process. It catches drift in the native BA wire envelope, the wizard
steps and the no-direct-write boundary before the managed producer builds the
actual win-x64 application.
"""
from __future__ import annotations

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def require(text: str, needle: str, label: str) -> None:
    if needle not in text:
        raise AssertionError(f"{label}: missing {needle!r}")


def require_order(text: str, first: str, second: str, label: str) -> None:
    first_index = text.find(first)
    second_index = text.find(second, first_index + len(first)) if first_index >= 0 else -1
    if first_index < 0 or second_index < 0:
        raise AssertionError(f"{label}: expected {first!r} before {second!r}")


def main() -> None:
    project = (ROOT / "Fullmag.Setup.UI.csproj").read_text(encoding="utf-8")
    broker_contracts = (ROOT / "Broker" / "BrokerContracts.cs").read_text(encoding="utf-8")
    broker_transport = (ROOT / "Broker" / "JsonLinesBrokerClient.cs").read_text(encoding="utf-8")
    broker_options = (ROOT / "Program.cs").read_text(encoding="utf-8")
    app_options = (ROOT / "App.axaml.cs").read_text(encoding="utf-8")
    view_model = (ROOT / "ViewModels" / "MainWindowViewModel.cs").read_text(encoding="utf-8")
    wizard_models = (ROOT / "ViewModels" / "WizardModels.cs").read_text(encoding="utf-8")
    xaml = (ROOT / "MainWindow.axaml").read_text(encoding="utf-8")
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    operations = (ROOT / "Broker" / "IBrokerClient.cs").read_text(encoding="utf-8")
    windows_root = ROOT.parents[1]
    ba_header = (windows_root / "installer" / "FullmagBootstrapperApplication" / "FullmagBootstrapperApplication.h").read_text(encoding="utf-8")
    ba_source = (windows_root / "installer" / "FullmagBootstrapperApplication" / "FullmagBootstrapperApplication.cpp").read_text(encoding="utf-8")
    bootstrap_source = (windows_root / "installer" / "FullmagEnvironmentBootstrap" / "FullmagEnvironmentBootstrap.cpp").read_text(encoding="utf-8")
    environment_script = (windows_root / "run_installer_environment.ps1").read_text(encoding="utf-8")
    full_package_script = (windows_root / "native_full_package.ps1").read_text(encoding="utf-8")

    package_versions = re.findall(
        r'PackageReference Include="Avalonia(?:\.Desktop|\.Themes\.Fluent)?" Version="([^"]+)"',
        project,
    )
    assert package_versions == ["12.1.4", "12.1.4", "12.1.4"], package_versions
    require(project, '<TargetFramework>net10.0</TargetFramework>', "Avalonia producer target")
    require(project, '<AssemblyName>FullmagInstallerUi</AssemblyName>', "published GUI entrypoint")
    assert project.count('<AvaloniaResource Include=') == 0, "Avalonia SDK owns default AXAML items"
    global_json = (ROOT / "global.json").read_text(encoding="utf-8")
    require(global_json, '"version": "10.0.402"', "pinned .NET SDK")
    require(global_json, '"rollForward": "disable"', "SDK roll-forward policy")
    for setting in (
        '<RuntimeIdentifier>win-x64</RuntimeIdentifier>',
        '<SelfContained>true</SelfContained>',
        '<PublishSingleFile>true</PublishSingleFile>',
        '<PublishTrimmed>false</PublishTrimmed>',
    ):
        require(project, setting, "self-contained producer settings")

    for marker in (
        'fullmag.windows-installer-ui.v1',
        'VersionString = "1.0.0"',
        'MaxLineLength = 2_097_152',
        'Architecture = "x64"',
        'JsonPropertyName("type")',
        'JsonPropertyName("version")',
        'JsonPropertyName("request_id")',
        'JsonPropertyName("generation")',
        'JsonPropertyName("revision")',
        'JsonPropertyName("payload")',
        '"command"',
        '"init"',
        '"reply"',
        '"shutdown"',
        'BrokerOperations.LaunchUi',
    ):
        require(broker_contracts + broker_transport + view_model, marker, "typed BA protocol")

    for forbidden in (
        'BrokerClientOptions',
        'ProcessStartInfo',
        'Process.Start',
        'System.Diagnostics',
        'RedirectStandardInput',
        'RedirectStandardOutput',
        'RedirectStandardError',
        '--broker',
        'BrokerPath',
        'BrokerArguments',
    ):
        if forbidden in broker_transport + broker_options:
            raise AssertionError(f"Avalonia UI must not spawn/configure a broker process: {forbidden}")
    require(broker_transport, 'new BrokerHello(', "inherited-stdio hello")
    require(broker_transport, 'BrokerProtocol.VersionString,', "versioned command and shutdown envelopes")
    if broker_transport.count('BrokerProtocol.VersionString,') < 2:
        raise AssertionError("command and shutdown envelopes must carry version 1.0.0")
    require(broker_options, 'Console.OpenStandardInput()', "inherited stdin")
    require(broker_options, 'Console.OpenStandardOutput()', "inherited stdout")
    require(broker_options, 'Console.IsInputRedirected', "private stdin guard")
    require(broker_options, 'Console.IsOutputRedirected', "private stdout guard")
    require(broker_transport, 'CreateCommandPayload', "command payload operation binding")
    require(broker_transport, 'permitShutdown: true', "terminal shutdown frame")
    require(broker_transport, 'ReadFrameAsync(cancellationToken)', "bounded cancellable response reader")
    require(broker_transport, 'encoder.GetByteCount', "UTF-8 byte bounded response reader")
    require(readme, '"type":"hello"', "documented exact hello frame")
    require(readme, '"type":"command"', "documented command frame")
    require(readme, '"version":"1.0.0"', "documented command version")
    require(readme, '"request_id"', "documented request identity")
    require(readme, "init.payload", "documented verified init context")
    require(readme, "license_valid: true", "documented verified license flag")
    require(readme, "license_text", "documented init license")
    require(readme, "setup_script", "documented setup provenance")
    require(readme, "bootstrap_mode", "documented init setup mode")
    require(readme, 'inherited stdin/stdout', "documented BA-owned transport")
    require(readme, 'does not start PowerShell, Git, Burn or a', "no child broker boundary")
    if "signed installer payload" in readme.lower():
        raise AssertionError("UI README must not claim an unverified signing boundary")

    for operation in (
        'Preadmission = "preadmission"',
        'Discover = "discover"',
        'Prerequisites = "prerequisites"',
        'Preview = "preview"',
        'Commit = "commit"',
        'Cancel = "cancel"',
        'Setup = "initial_build"',
        'LaunchUi = "launch_ui"',
    ):
        require(operations, operation, "broker operation")

    for step in ("IsWelcome", "IsLicense", "IsPaths", "IsEnvironment", "IsRequirements", "IsProgress", "IsReady"):
        require(xaml, f'IsVisible="{{Binding {step}}}"', "wizard pages")
    for automation_id in (
        "wizard-steps",
        "license-text",
        "license-accept",
        "checkout-path",
        "storage-root",
        "installation-scope",
        "environment-fields",
        "redacted-preview",
        "requirements-list",
        "setup-progress",
        "setup-progress-indeterminate",
        "setup-status",
        "launch-status",
        "cancel",
        "back",
        "primary-action",
        "status-message",
        "browse-checkout",
        "browse-storage",
    ):
        require(xaml, f'AutomationProperties.AutomationId="{automation_id}"', "UI automation IDs")
    require(xaml, 'AutomationProperties.AutomationId="{Binding AutomationId}"', "wizard step and field automation binding")
    require(wizard_models, 'AutomationId => $"wizard-step-{Id.ToString().ToLowerInvariant()}"', "wizard step automation IDs")
    require(wizard_models, "environment-field-{Key.ToLowerInvariant().Replace('_', '-')}", "environment field automation IDs")
    require(wizard_models, "NestedString", "nested init provenance reader")
    require(xaml, 'MinWidth="800"', "small-window width")
    require(xaml, 'MinHeight="600"', "small-window height")
    app = (ROOT / "App.axaml").read_text(encoding="utf-8")
    require(app, 'RequestedThemeVariant="Default"', "system-following theme")
    for variant in ("Light", "Dark"):
        require(app, f'<fluent:ColorPaletteResources x:Key="{variant}"', "Fluent theme palette")
        require(app, f'<ResourceDictionary x:Key="{variant}">', "dynamic application palette")
    light_dictionary = re.search(
        r'<ResourceDictionary x:Key="Light">(.*?)</ResourceDictionary>\s*'
        r'<ResourceDictionary x:Key="Dark">',
        app,
        re.S,
    )
    dark_dictionary = re.search(
        r'<ResourceDictionary x:Key="Dark">(.*?)</ResourceDictionary>\s*'
        r'</ResourceDictionary.ThemeDictionaries>',
        app,
        re.S,
    )
    if not light_dictionary or not dark_dictionary:
        raise AssertionError("Light/Dark dynamic resource dictionaries must be complete")
    light_keys = set(re.findall(r'x:Key="([^"]+)"', light_dictionary.group(1)))
    dark_keys = set(re.findall(r'x:Key="([^"]+)"', dark_dictionary.group(1)))
    if not light_keys or light_keys != dark_keys:
        raise AssertionError("Light/Dark dynamic resource dictionaries must expose matching keys")
    for key in light_keys:
        require(app + xaml, f"DynamicResource {key}", "dynamic application palette usage")
    require(xaml, 'VerticalScrollBarVisibility="Auto"', "responsive content scroll")
    require(xaml, 'ScrollViewer.VerticalScrollBarVisibility="Auto"', "Avalonia TextBox scroll attachment")
    require(xaml, 'IsEnabled="{Binding Owner.CanEditInputs}"', "freeze path inputs during operations")
    require(xaml, 'IsEnabled="{Binding DataContext.CanEditInputs, RelativeSource={RelativeSource AncestorType=Window}}"', "freeze environment inputs during operations")
    require(xaml, 'IsEnabled="{Binding CanCancel}"', "cancel stays available during operations")
    require(xaml, 'Click="BrowseCheckout"', "source folder picker")
    require(xaml, 'Click="BrowseStorage"', "storage folder picker")
    require(
        xaml,
        "Continuing from this step installs Git and Python when needed to read the project settings.",
        "paths action explains prerequisite installation",
    )
    require(
        xaml,
        "Your .env file is saved only after you review and approve it.",
        "paths action explains deferred environment save",
    )
    if "Nothing is changed until you approve a later step." in xaml:
        raise AssertionError("paths page must disclose prerequisite installation before approval")
    require(xaml, 'Technical details', "technical details disclosure")
    if xaml.count('Text="{Binding BrokerState}"') != 1:
        raise AssertionError("broker state must stay in one technical-details disclosure")
    require(xaml, 'Text="{Binding DiagnosticDetails}"', "public blocker details binding")
    require(xaml, 'IsVisible="{Binding HasDiagnosticDetails}"', "blocker details visibility")
    require(xaml, 'AutomationProperties.AutomationId="diagnostic-details"', "blocker details automation id")
    require(
        xaml,
        "This installer prepares all four Fullmag realizations: FDM CPU, FDM GPU, FEM CPU and FEM GPU.",
        "all-realizations installation scope copy",
    )
    if "runtime-lane" in xaml or "LaneOptions" in xaml or "Simulation backend" in xaml:
        raise AssertionError("The installer must not expose a public simulation backend selector")
    requirements_page = xaml.index('<StackPanel IsVisible="{Binding IsRequirements}"')
    preview_automation_id = 'AutomationProperties.AutomationId="redacted-preview"'
    if xaml.count(preview_automation_id) != 1:
        raise AssertionError("the settings preview must expose one stable automation id")
    preview_control = xaml.index(preview_automation_id)
    if preview_control < requirements_page:
        raise AssertionError("The settings preview must remain visible on the Requirements page")

    forbidden_direct_writes = (
        "File.WriteAllText",
        "File.AppendAllText",
        "File.Move",
        "File.Replace",
        "SetEnvironmentVariable",
        "Environment.SetEnvironmentVariable",
    )
    ui_sources = "\n".join(path.read_text(encoding="utf-8") for path in ROOT.rglob("*.cs"))
    for forbidden in forbidden_direct_writes:
        if forbidden in ui_sources:
            raise AssertionError(f"UI must not perform direct write/global environment operation: {forbidden}")

    require(view_model, "The approved environment was not confirmed as valid", "commit fail-closed")
    require(view_model, "This setup window must be opened by the trusted Fullmag installer", "direct launch blocked")
    require(view_model, "InitializeAsync", "prompt BA handshake")
    require(view_model, "ApplyInitialState", "init state binding")
    require(view_model, 'JsonPayload.FirstString(payload, "license_text", "license")', "init license binding")
    require(view_model, 'JsonPayload.Bool(payload, "license_valid")', "verified init license flag")
    require(view_model, "license_accepted = LicenseAccepted", "license acceptance handoff")
    require(view_model, "_licenseFromVerifiedInit = true", "license requires verified init")
    require(view_model, 'JsonPayload.FirstString(payload, "setup_path", "setup_script", "setup_script_path")', "init setup binding")
    require(view_model, 'JsonPayload.NestedString(payload, "setup_script", "filename")', "init setup provenance binding")
    require(view_model, 'JsonPayload.FirstString(\n            payload,\n            "manifest_path",\n            "requirements_manifest",', "init manifest binding")
    require(view_model, 'JsonPayload.FirstString(payload, "setup_hash", "setup_sha256", "setup_script_sha256")', "init setup hash binding")
    require(view_model, 'JsonPayload.NestedString(payload, "setup_script", "sha256")', "init setup provenance hash")
    require(view_model, 'JsonPayload.FirstString(\n            payload,\n            "manifest_hash",', "init manifest hash binding")
    require(view_model, 'JsonPayload.NestedString(payload, "requirements_manifest", "sha256")', "init manifest provenance hash")
    require(view_model, "receipt_valid", "receipt validation")
    require(view_model, "bootstrap_mode", "setup mode binding")
    require(view_model, 'string.Equals(_setupMode, "initial-build"', "initial-build launch gate")
    require(view_model, "Build environment is ready.", "setup-only ready copy")
    require(view_model, 'LaunchRequested ? "Finish"', "terminal finish action")
    require(view_model, "WizardPageId.Ready => SetupCompleted", "finish stays enabled after launch")
    require(view_model, "FinishRequested?.Invoke", "terminal finish event")
    require(view_model, "IsProgressIndeterminate", "unknown progress state")
    require(view_model, "Launch requested. Startup status will appear in the workspace console", "honest launch status")
    require(view_model, "_cancelRequested = true", "cancel independent from operation gate")
    require(view_model, "cancel_requested = true", "cancel broker operation")
    require(view_model, "A save attempt was in flight; its final write state is not confirmed", "ambiguous cancel status")
    require(view_model, "CanEditInputs", "freeze inputs during operation")
    require(view_model, "WizardPageId.Environment => HasAdmission && EnvironmentFields.Count > 0,", "review remains available after an environment edit")
    if "WizardPageId.Environment => PreviewReady," in view_model:
        raise AssertionError("Review cannot require the preview that the action creates")
    require(view_model, "public bool CanCancel => !_shuttingDown && !IsCanceled && !_cancelInFlight;", "cancel available while idle and busy")
    require(view_model, "AdvanceLocalEditEpoch", "local edit epoch")
    require(view_model, "IsStaleOrCanceled", "discard stale operation response")
    require(view_model, "ReadinessConfirmed", "readiness report gate")
    require(view_model, "DiagnosticDetails", "public diagnostic details state")
    require(view_model, "HasDiagnosticDetails", "diagnostic visibility state")
    require(view_model, "ReadPublicBlockers", "allowlisted blocker parser")
    require(view_model, 'TryGetProperty("blockers"', "blocker array only")
    require(view_model, "MaxPublicBlockers", "bounded public blocker list")
    require(view_model, "MaxPublicBlockerLength", "bounded public blocker text")
    if "failure_location" in view_model:
        raise AssertionError("UI must not expose backend failure_location in public diagnostics")
    require(view_model, 'WizardPageId.Paths => "Install prerequisites"', "paths action label")
    require(view_model, "CommitConfirmed", "valid unchanged commit gate")
    require(view_model, 'JsonPayload.String(response.Payload, "state")', "commit payload state")
    require(view_model, "ResetSessionDerivedState", "session rebind invalidates stale preview")
    require(view_model, "preserveConfirmedCommit", "confirmed commit session rebind")
    require(view_model, "source_admitted", "source admission report gate")
    require(view_model, 'private const string InstallationScope = "all";', "fixed all-realizations scope")
    require(view_model, "HasInstallationScope", "all-realizations admission gate")
    require(view_model, "IsAllInstallationScope", "init scope validation")
    require(view_model, "InstallationScopeMatches", "single-realization response rejection")
    if any(marker in view_model for marker in ("LaneOptions", "HasSupportedLane", "NormalizeLane", "public string Lane", "private string _lane", "ref _lane")):
        raise AssertionError("UI must not expose or store a selectable single-realization lane")
    if any(marker in view_model for marker in ('"native"', '"fem-cpu"', '"fem-gpu"')):
        raise AssertionError("UI source must not retain single-realization scope literals")
    require(view_model, "UserFacingMessage", "user-facing status copy")
    require(broker_options, 'First(values, "lane"),', "lane must be explicitly supplied")
    require(app_options, "null,\n        null,\n        null,\n        null,", "app default must not select a lane")
    require(view_model, "lane = InstallationScope", "private all-realizations wire scope")
    if view_model.count("lane = InstallationScope") < 4:
        raise AssertionError("preadmission, prerequisites, setup and launch must use the all-realizations scope")
    if 'First(values, "lane") ?? "native"' in broker_options:
        raise AssertionError("UI must not silently select native when lane is absent")
    require(ba_header, 'std::wstring requestedLane_ = L"all";', "BA defaults to the all-realizations scope")
    require(ba_source, 'RuntimeProfileForLane(const std::wstring& lane)', "BA scope-to-profile resolver")
    require(ba_source, 'if (EqualsInsensitive(lane, L"all")) return L"windows-native-fem-gpu";', "all scope uses the physical FEM GPU package")
    require(ba_source, 'EqualsInsensitive(requestedLane_, L"all")', "BA launch gate requires all scope")
    if "Select the source-first build lane" in ba_source:
        raise AssertionError("BA must not ask the user to select a single-realization lane")
    require(ba_source, 'windows-full-capability-package.v1', "BA accepts the full capability manifest")
    require(ba_source, 'EqualsInsensitive(receipt.String(L"scope"), L"all")', "BA validates the all-realizations receipt scope")
    require(bootstrap_source, 'bool ReceiptIsSafe(const std::wstring& path, const std::wstring& storageRoot,', "native bootstrap validates the selected profile")
    require(bootstrap_source, 'const std::wstring& mode, const std::wstring& profile)', "native bootstrap validates the selected profile")
    require(bootstrap_source, 'profile == L"windows-native-fem-gpu"', "native bootstrap distinguishes the full package")
    require(environment_script, 'windows-full-capability-package.v1', "PowerShell validates the full capability manifest")
    require(environment_script, 'Assert-FullmagFullRuntimeManifest', "PowerShell validates component provenance and artifacts")
    require(environment_script, 'windows-full-workspace-build', "PowerShell dispatches the full workspace build")
    require(environment_script, 'windows-full-workspace', "PowerShell dispatches the full workspace launch")
    require(environment_script, '$fullBuildRoot = Assert-LocalAbsolutePath ([string]$RuntimeLayout.build_root)', "full receipt uses the runtime profile build root")
    require(environment_script, '$initialReceipt = Get-ExistingInitialReceipt $requestedReceipt $layout $admission $identity $mapping $profile $storageRoot $runtimeLayout', "full launch passes the runtime profile to receipt validation")
    require(environment_script, 'full_receipt_manifest_hash', "full receipt re-hashes capability and origin manifests")
    require(environment_script, 'initial_receipt_full_runtime_mismatch', "full launch binds receipt provenance to the admitted capability manifest")
    require(environment_script, 'full_workspace_browser_manifest_untrusted', "full package requires the browser workspace marker")
    require(environment_script, 'full_static_web_hash_mismatch', "full package hashes the static browser tree")
    for component in ("fdm_cpu", "fdm_gpu", "fem_cpu", "fem_gpu"):
        require(environment_script, component, f"PowerShell requires installed {component} support")
        require(full_package_script, component, f"full package manifest contains {component}")
    require(environment_script, 'source_environment_receipt', "full receipt retains setup provenance")
    require(full_package_script, 'runtime_environment = [ordered]@{', "full package leaves runtime lane selection unforced")
    require(full_package_script, 'FULLMAG_FDM_EXECUTION = $null', "full package does not force FDM execution")
    require(full_package_script, 'FULLMAG_FEM_EXECUTION = $null', "full package does not force FEM execution")
    require(full_package_script, 'FULLMAG_RELAX_DEVICE = $null', "full package does not force a solver device")
    cancel_start = view_model.index("private async Task CancelAsync()")
    cancel_end = view_model.index("private async Task AdmitPathsAsync()", cancel_start)
    cancel_body = view_model[cancel_start:cancel_end]
    if "RunOperationAsync" in cancel_body:
        raise AssertionError("cancel must not wait for the primary operation gate")
    if "if (HasAdmission)" in cancel_body:
        raise AssertionError("cancel must reach an active fresh-host operation before admission")
    require(cancel_body, "if (!IsBusy)", "idle cancel closes without broker mutation")
    require(cancel_body, "FinishRequested?.Invoke(this, EventArgs.Empty)", "idle cancel uses the close route")
    require(cancel_body, "BrokerOperations.Cancel", "busy cancel reaches the broker")
    require(cancel_body, "session_id = _sessionId", "cancel session correlation")
    require(cancel_body, "admission_id = _admissionId", "cancel admission correlation")
    require_order(
        view_model,
        "var response = await SendAsync(\n            BrokerOperations.Preview",
        "if (IsStaleOrCanceled(editEpoch))",
        "preview responses must be checked before applying state",
    )
    require_order(
        view_model,
        "var commitWrote = commit.Ok && JsonPayload.Bool(commit.Payload, \"wrote\");",
        "if (IsStaleOrCanceled(editEpoch))",
        "commit result must be reconciled before setup",
    )
    require(view_model, "preserved", "secret field preservation")
    require(view_model, "previous.IsSecret", "secret rebind guard")
    require(wizard_models, "public bool IsDirty", "environment edit tracking")
    require(wizard_models, "bool isDirty = false", "metadata hydration starts clean")
    require(view_model, ".Where(field => field.IsDirty)", "untouched environment fields are omitted")
    require(view_model, 'values["FULLMAG_PROJECT_STORAGE_ROOT"] = StorageRoot', "storage root remains explicit")
    require(view_model, "NormalizeBrokerFieldValue", "broker sentinel normalization")
    require(view_model, 'string.Equals(value, "<unset>"', "missing non-secret value stays untouched")
    require(view_model, "if (secret ||", "secret metadata is never copied to the editor")
    require(view_model, "_environmentFieldsSessionId", "field metadata is session-bound")
    require(view_model, "_environmentFieldsAdmissionId", "field metadata is admission-bound")
    require(view_model, "ClearEnvironmentFields", "cross-admission fields are cleared")
    build_values_start = view_model.index("private Dictionary<string, string> BuildValues()")
    build_values_end = view_model.index("private bool ValidateEnvironmentValues()", build_values_start)
    build_values = view_model[build_values_start:build_values_end]
    if "EnvironmentFields.ToDictionary" in build_values:
        raise AssertionError("BuildValues must not submit untouched broker metadata")
    if '"<unset>"' in build_values or '"<redacted>"' in build_values:
        raise AssertionError("broker redaction markers must never be submitted as user values")
    require(view_model, "previous.IsDirty", "only user-edited values survive a metadata rebind")
    require(view_model, "value = previous.Value", "entered secret survives same-admission metadata refresh")
    require(view_model, "ValidateEnvironmentValues", "reserved secret validation")
    require(view_model, 'string.Equals(field.Value, "<redacted>"', "redacted secret sentinel is rejected")
    require(view_model, 'string.Equals(field.Value, "__FULLMAG_KEEP_SECRET__"', "keep-secret sentinel is rejected")
    require(view_model, "field.IsDirty &&", "reserved values are checked only after user edits")
    require(view_model, "field.IsSecret &&", "reserved values are restricted to secret fields")
    require(view_model, "The selected secret value is reserved by the installer", "reserved secret rejection copy")
    if view_model.count("if (!ValidateEnvironmentValues())") < 3:
        raise AssertionError("preview, requirements and commit must all reject reserved secret values")
    require_order(
        view_model,
        "var value = NormalizeBrokerFieldValue",
        "var preserveUserValue = preserved.TryGetValue",
        "metadata is normalized before dirty-value preservation",
    )

    installer_env = (ROOT.parent.parent / "installer_env.ps1").read_text(encoding="utf-8")
    env_example = (ROOT.parents[3] / ".env.example").read_text(encoding="utf-8")
    require(installer_env, 'return "<unset>"', "absent non-secret environment marker")
    require(installer_env, 'return "<empty>"', "empty secret environment marker")
    require(installer_env, 'return (Get-FullmagInstallerEnvSecretToken)', "present secret redaction")
    require(env_example, "RUST_LOG=info", "existing non-secret RUST_LOG remains available")
    require(broker_transport, "_pending", "request correlation map")
    require(broker_transport, "MaxLineLength", "bounded JSON line")
    require(broker_transport, "TryObserve", "monotonic response sequence")
    require(broker_transport, "_nextCommandRevision", "monotonic outgoing command sequence")
    require(broker_transport, "Math.Max(_nextCommandRevision, _revision) + 1", "strict native command revision")
    require(broker_transport, "WriteCommandFrameAsync", "wire-ordered command allocator")
    require(broker_transport, "WriteFrameUnderGateAsync", "serialized frame writer")
    require(broker_transport, "_handshakeComplete = false", "terminal transport invalidation")
    require(broker_transport, "response.IsTerminal", "accepted reply remains pending")
    require(broker_transport, "ShutdownCoreAsync", "idempotent bounded shutdown")
    require(broker_transport, "_shutdownTask", "idempotent shutdown task")
    require(broker_transport, "_transportAbort", "terminal write cancellation")
    require(broker_transport, "var shutdownBudget = new CancellationTokenSource(ShutdownTimeout)", "single shutdown deadline")
    require(broker_transport, "WaitAsync(shutdownToken)", "bounded write gate wait")
    require(broker_transport, "_writeGateReleaseUncertain", "uncertain write gate is never reused")
    require(broker_transport, "AwaitWriteTaskAsync", "bounded write task observation")
    require(broker_transport, "WriteLineAsync(line.AsMemory(), cancellationToken)", "cancellable UTF-8 write")
    require(broker_transport, "DisposeStreams", "raw stream shutdown escape")
    if "gateTimeout" in broker_transport or "drainTimeout" in broker_transport:
        raise AssertionError("shutdown must use one shared deadline rather than independent gate windows")
    if "_writeGate.Dispose()" in broker_transport:
        raise AssertionError("write gate must outlive bounded shutdown and late writer unwinding")
    require_order(
        broker_transport,
        "_input.Dispose()",
        "_reader.Dispose()",
        "inherited stream facades dispose before wrapper disposal",
    )
    if "WriteLineAsync(line).ConfigureAwait(false)" in broker_transport:
        raise AssertionError("writes must use the cancellable memory overload")
    shutdown_body = view_model[
        view_model.index("public Task ShutdownAsync()"): view_model.index(
            "public ValueTask DisposeAsync()"
        )
    ]
    require(shutdown_body, "var shutdownBudget = new CancellationTokenSource(ShutdownCancelTimeout)", "single VM shutdown deadline")
    require(shutdown_body, "shutdownBudget.Token", "cancel uses bounded token")
    require(shutdown_body, ".WaitAsync(shutdownBudget.Token)", "broker shutdown shares VM deadline")
    if "cancelTimeout" in shutdown_body:
        raise AssertionError("VM shutdown must not create an independent cancel timeout")
    require(shutdown_body, "finally", "broker shutdown is unconditional")
    require(shutdown_body, "await _broker.ShutdownAsync()", "terminal broker shutdown")
    require_order(
        shutdown_body,
        "BrokerOperations.Cancel",
        "await _broker.ShutdownAsync()",
        "cancel precedes terminal shutdown",
    )
    if "CancellationToken.None" in shutdown_body:
        raise AssertionError("VM shutdown cancel must not wait on an unbounded token")
    require(view_model, "_operationWaiters", "operation waiter lifetime accounting")
    require(view_model, "_operationActive", "active operation lifetime accounting")
    require(view_model, "_disposeTask", "idempotent VM disposal task")
    require(view_model, "if (_operationWaiters == 0 && _operationActive == 0)", "operation gate quiescence guard")
    require_order(
        view_model[view_model.index("private async Task RunOperationAsync") : view_model.index("private void ApplyResponse")],
        "_operationGate.Release();",
        "_operationWaiters--",
        "waiter count remains until a queued gate owner releases",
    )
    require(readme, "Secret field values stay in\nthis process only", "secret boundary")
    require(readme, "Avalonia.Themes.Fluent", "Fluent package documentation")
    require(readme, "12.1.4", "Avalonia package pin documentation")
    require(readme, "10.0.402", ".NET SDK pin documentation")

    print("Fullmag.Setup.UI protocol/source checks: PASS")


if __name__ == "__main__":
    main()
