using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Input;
using Avalonia.Threading;
using Fullmag.Setup.UI.Broker;

namespace Fullmag.Setup.UI.ViewModels;

public sealed class MainWindowViewModel : ObservableObject, IAsyncDisposable
{
    private static readonly TimeSpan ShutdownCancelTimeout = TimeSpan.FromSeconds(2);

    private readonly IBrokerClient _broker;
    private bool _brokerAvailable;
    private readonly SemaphoreSlim _operationGate = new(1, 1);
    private readonly object _lifecycleGate = new();
    private readonly IReadOnlyDictionary<WizardPageId, WizardPageViewModel> _pages;
    private readonly IReadOnlyDictionary<WizardPageId, WizardStepViewModel> _stepsByPage;
    private string _setupScript;
    private string _requirementsManifest;
    private string _setupHash;
    private string _manifestHash;
    private WizardPageViewModel _currentPage;
    private WizardStepViewModel _selectedStep;
    private string _checkoutPath;
    private string _storageRoot;
    private string _lane;
    private string _sessionId = string.Empty;
    private string _admissionId = string.Empty;
    private string _storageProfile = string.Empty;
    private string _receiptPath = string.Empty;
    private string _setupMode = string.Empty;
    private string _statusMessage = "Choose a source checkout to begin.";
    private string _redactedDiff = string.Empty;
    private string _launchMessage = string.Empty;
    private string _licenseText;
    private bool _licenseFromVerifiedInit;
    private string _brokerState = "idle";
    private int? _progressPercent;
    private bool _licenseAccepted;
    private bool _busy;
    private bool _previewReady;
    private bool _requirementsReady;
    private bool _setupCompleted;
    private bool _launchRequested;
    private bool _canceled;
    private bool _cancelRequested;
    private bool _cancelInFlight;
    private bool _commitAttempted;
    private bool _environmentCommitted;
    private bool _environmentCommitConfirmed;
    private long _localEditEpoch;
    private string _environmentFieldsSessionId = string.Empty;
    private string _environmentFieldsAdmissionId = string.Empty;
    private int _highestVisitedIndex;
    private bool _shuttingDown;
    private int _operationWaiters;
    private int _operationActive;
    private Task? _shutdownTask;
    private Task? _disposeTask;

    public MainWindowViewModel(
        IBrokerClient broker,
        string licenseText,
        string? initialCheckoutPath,
        string? initialStorageRoot,
        string? initialLane,
        string? setupScript,
        string? requirementsManifest,
        string? setupHash,
        string? manifestHash)
    {
        _broker = broker;
        _brokerAvailable = broker is not MissingBrokerClient;
        _broker.EventReceived += OnBrokerEvent;
        _licenseText = licenseText;
        if (!_brokerAvailable)
        {
            _brokerState = "blocked";
            _statusMessage = "This setup window must be opened by the trusted Fullmag installer.";
        }
        _checkoutPath = initialCheckoutPath ?? string.Empty;
        _storageRoot = initialStorageRoot ?? string.Empty;
        _lane = NormalizeLane(initialLane);
        _setupScript = setupScript ?? string.Empty;
        _requirementsManifest = requirementsManifest ?? string.Empty;
        _setupHash = setupHash ?? string.Empty;
        _manifestHash = manifestHash ?? string.Empty;

        Steps = new ObservableCollection<WizardStepViewModel>(new[]
        {
            new WizardStepViewModel(1, WizardPageId.Welcome, "Welcome", "Choose how Fullmag will be prepared."),
            new WizardStepViewModel(2, WizardPageId.License, "License", "Review the terms before continuing."),
            new WizardStepViewModel(3, WizardPageId.Paths, "Paths", "Select the checkout and private storage root."),
            new WizardStepViewModel(4, WizardPageId.Environment, "Environment", "Review the proposed environment values."),
            new WizardStepViewModel(5, WizardPageId.Requirements, "Requirements", "Check tools and prepare the selected lane."),
            new WizardStepViewModel(6, WizardPageId.Progress, "Progress", "Run setup and build preparation."),
            new WizardStepViewModel(7, WizardPageId.Ready, "Ready", "Launch the workspace when setup is complete.")
        });
        _stepsByPage = Steps.ToDictionary(step => step.Id);
        _pages = Steps.ToDictionary(
            step => step.Id,
            step => new WizardPageViewModel(this, step.Id, step.Title, step.Description));
        _currentPage = _pages[WizardPageId.Welcome];
        _selectedStep = _stepsByPage[WizardPageId.Welcome];
        _selectedStep.IsCurrent = true;
        _selectedStep.CanNavigate = true;

        EnvironmentFields = new ObservableCollection<EnvironmentFieldViewModel>();
        Requirements = new ObservableCollection<RequirementCheckViewModel>();
        PrimaryCommand = new AsyncRelayCommand(AdvanceAsync);
        BackCommand = new AsyncRelayCommand(BackAsync);
        CancelCommand = new AsyncRelayCommand(CancelAsync);
    }

    public ObservableCollection<WizardStepViewModel> Steps { get; }
    public IReadOnlyList<string> LaneOptions { get; } = new[] { "native", "fem-cpu", "fem-gpu" };
    public ObservableCollection<EnvironmentFieldViewModel> EnvironmentFields { get; }
    public ObservableCollection<RequirementCheckViewModel> Requirements { get; }

    public bool HasEnvironmentFields => EnvironmentFields.Count > 0;
    public bool HasRequirements => Requirements.Count > 0;

    public WizardPageViewModel CurrentPage
    {
        get => _currentPage;
        private set
        {
            if (!SetProperty(ref _currentPage, value))
            {
                return;
            }
            RaiseNavigationProperties();
        }
    }

    public WizardStepViewModel SelectedStep
    {
        get => _selectedStep;
        set
        {
            if (value is null || value == _selectedStep)
            {
                return;
            }
            if (!value.CanNavigate || !CanNavigateTo(value.Id))
            {
                RaisePropertyChanged();
                return;
            }
            NavigateTo(value.Id);
        }
    }

    public string CheckoutPath
    {
        get => _checkoutPath;
        set
        {
            if (!SetProperty(ref _checkoutPath, value ?? string.Empty))
            {
                return;
            }
            InvalidateAdmission();
        }
    }

    public string StorageRoot
    {
        get => _storageRoot;
        set
        {
            if (!SetProperty(ref _storageRoot, value ?? string.Empty))
            {
                return;
            }
            InvalidateAdmission();
        }
    }

    public string Lane
    {
        get => _lane;
        set
        {
            var normalized = NormalizeLane(value);
            if (!SetProperty(ref _lane, normalized))
            {
                return;
            }
            InvalidateAdmission();
        }
    }

    public string LicenseText
    {
        get => _licenseText;
        private set => SetProperty(ref _licenseText, value);
    }

    public bool LicenseAvailable => _licenseFromVerifiedInit && !string.IsNullOrWhiteSpace(LicenseText);

    public bool LicenseAccepted
    {
        get => _licenseAccepted;
        set
        {
            if (!SetProperty(ref _licenseAccepted, value))
            {
                return;
            }
            RaiseNavigationProperties();
        }
    }

    public string StatusMessage
    {
        get => _statusMessage;
        private set => SetProperty(ref _statusMessage, value);
    }

    public string RedactedDiff
    {
        get => _redactedDiff;
        private set => SetProperty(ref _redactedDiff, value);
    }

    public string LaunchMessage
    {
        get => _launchMessage;
        private set => SetProperty(ref _launchMessage, value);
    }

    public string BrokerState
    {
        get => _brokerState;
        private set => SetProperty(ref _brokerState, value);
    }

    public int? ProgressPercent
    {
        get => _progressPercent;
        private set
        {
            if (!SetProperty(ref _progressPercent, value))
            {
                return;
            }
            RaisePropertyChanged(nameof(HasProgress));
            RaisePropertyChanged(nameof(IsProgressIndeterminate));
        }
    }

    public bool HasProgress => ProgressPercent.HasValue;
    public bool IsProgressIndeterminate => CurrentPage.Id == WizardPageId.Progress &&
                                           IsBusy && !HasProgress;

    public bool IsBusy
    {
        get => _busy;
        private set
        {
            if (!SetProperty(ref _busy, value))
            {
                return;
            }
            RaisePropertyChanged(nameof(IsProgressIndeterminate));
            RaisePropertyChanged(nameof(CanEditInputs));
            RaiseNavigationProperties();
        }
    }

    public bool CanEditInputs => !_shuttingDown && !IsBusy && !IsCanceled && !_cancelRequested;

    public bool CanCancel => !_shuttingDown && !IsCanceled && !_cancelInFlight;

    public bool PreviewReady
    {
        get => _previewReady;
        private set
        {
            if (!SetProperty(ref _previewReady, value))
            {
                return;
            }
            RaiseNavigationProperties();
        }
    }

    public bool RequirementsReady
    {
        get => _requirementsReady;
        private set
        {
            if (!SetProperty(ref _requirementsReady, value))
            {
                return;
            }
            RaiseNavigationProperties();
        }
    }

    public bool SetupCompleted
    {
        get => _setupCompleted;
        private set
        {
            if (!SetProperty(ref _setupCompleted, value))
            {
                return;
            }
            RaiseNavigationProperties();
        }
    }

    public bool LaunchRequested
    {
        get => _launchRequested;
        private set => SetProperty(ref _launchRequested, value);
    }

    public bool IsCanceled
    {
        get => _canceled;
        private set => SetProperty(ref _canceled, value);
    }

    public string PrimaryActionLabel => CurrentPage.Id switch
    {
        WizardPageId.Welcome => "Get started",
        WizardPageId.License => "Accept and continue",
        WizardPageId.Paths => "Install prerequisites",
        WizardPageId.Environment => "Review changes",
        WizardPageId.Requirements => "Prepare environment",
        WizardPageId.Progress => SetupCompleted ? "Continue" : "Install Fullmag",
        WizardPageId.Ready => LaunchRequested ? "Finish" :
            CanLaunchWorkspace ? "Launch Fullmag" : "Finish",
        _ => "Continue"
    };

    public bool CanPrimaryAction => _brokerAvailable && !IsBusy && !IsCanceled && CurrentPage.Id switch
    {
        WizardPageId.Welcome => true,
        WizardPageId.License => LicenseAvailable && LicenseAccepted,
        WizardPageId.Paths => HasRequiredPaths && HasSupportedLane,
        WizardPageId.Environment => PreviewReady,
        WizardPageId.Requirements => (HasAdmission || HasRequiredPaths) &&
                                     (!RequirementsReady || EnvironmentFields.Count == 0),
        WizardPageId.Progress => SetupCompleted || HasCommittedSession,
        // A setup-only run finishes here.  A completed initial build first
        // offers launch, then keeps the same button enabled as Finish after
        // the launch request has been accepted.
        WizardPageId.Ready => SetupCompleted,
        _ => false
    };

    public bool CanGoBack => !IsBusy && !IsCanceled && CurrentPage.Id != WizardPageId.Welcome &&
                             CurrentPage.Id != WizardPageId.Ready;

    public bool IsFinalPage => CurrentPage.Id == WizardPageId.Ready;
    public bool HasRequiredPaths => !string.IsNullOrWhiteSpace(CheckoutPath) &&
                                    !string.IsNullOrWhiteSpace(StorageRoot);
    public bool HasSupportedLane => LaneOptions.Contains(Lane, StringComparer.OrdinalIgnoreCase);
    public bool HasCommittedSession => !string.IsNullOrWhiteSpace(_sessionId) && _requirementsReady;
    public bool HasAdmission => !string.IsNullOrWhiteSpace(_sessionId) ||
                                 !string.IsNullOrWhiteSpace(_admissionId);
    public bool CanLaunchWorkspace => SetupCompleted &&
                                      string.Equals(_setupMode, "initial-build", StringComparison.OrdinalIgnoreCase);
    public string ReadyHeading => CanLaunchWorkspace
        ? "Fullmag is ready."
        : "Build environment is ready.";
    public string ReadyDescription => CanLaunchWorkspace
        ? "The selected workspace passed its final setup checks and can be launched."
        : "The setup tools are ready. Workspace launch requires a completed initial build.";

    public ICommand PrimaryCommand { get; }
    public ICommand BackCommand { get; }
    public ICommand CancelCommand { get; }
    public event EventHandler? FinishRequested;

    public async Task InitializeAsync()
    {
        if (!_brokerAvailable || _shuttingDown)
        {
            return;
        }

        try
        {
            await _broker.StartAsync().ConfigureAwait(true);
        }
        catch (BrokerTransportException exception)
        {
            _brokerAvailable = false;
            Block(exception.Message);
        }
        catch (Exception)
        {
            _brokerAvailable = false;
            Block("The trusted installer connection could not be established.");
        }
        finally
        {
            RaiseNavigationProperties();
        }
    }

    private async Task AdvanceAsync()
    {
        await RunOperationAsync(async () =>
        {
            switch (CurrentPage.Id)
            {
                case WizardPageId.Welcome:
                    NavigateTo(WizardPageId.License);
                    break;
                case WizardPageId.License:
                    if (!LicenseAvailable || !LicenseAccepted)
                    {
                        Block("Review the supplied license and accept it before continuing.");
                        return;
                    }
                    NavigateTo(WizardPageId.Paths);
                    break;
                case WizardPageId.Paths:
                    await AdmitPathsAsync().ConfigureAwait(true);
                    break;
                case WizardPageId.Environment:
                    await PreviewEnvironmentAsync().ConfigureAwait(true);
                    break;
                case WizardPageId.Requirements:
                    await PrepareRequirementsAsync().ConfigureAwait(true);
                    break;
                case WizardPageId.Progress:
                    if (SetupCompleted)
                    {
                        NavigateTo(WizardPageId.Ready);
                    }
                    else
                    {
                        await CommitAndSetupAsync().ConfigureAwait(true);
                    }
                    break;
                case WizardPageId.Ready:
                    if (CanLaunchWorkspace && !LaunchRequested)
                    {
                        await LaunchUiAsync().ConfigureAwait(true);
                    }
                    else if (SetupCompleted)
                    {
                        FinishRequested?.Invoke(this, EventArgs.Empty);
                    }
                    break;
            }
        }).ConfigureAwait(true);
    }

    private async Task BackAsync()
    {
        if (!CanGoBack)
        {
            return;
        }

        await RunOperationAsync(() =>
        {
            var currentIndex = Steps.IndexOf(_stepsByPage[CurrentPage.Id]);
            if (currentIndex > 0)
            {
                NavigateTo(Steps[currentIndex - 1].Id);
            }
            return Task.CompletedTask;
        }).ConfigureAwait(true);
    }

    private async Task CancelAsync()
    {
        if (!CanCancel)
        {
            return;
        }

        if (!IsBusy)
        {
            FinishRequested?.Invoke(this, EventArgs.Empty);
            return;
        }

        _cancelRequested = true;
        _cancelInFlight = true;
        RaiseNavigationProperties();
        try
        {
            // A fresh-host prerequisites/bootstrap operation can be active
            // before it has returned a session or admission id.  The BA
            // accepts this correlation envelope and cancels its active IPC
            // operation; do not silently turn that click into local UI state.
            var response = await SendAsync(
                BrokerOperations.Cancel,
                new
                {
                    session_id = _sessionId,
                    admission_id = _admissionId,
                    cancel_requested = true,
                    license_accepted = LicenseAccepted
                },
                CancellationToken.None).ConfigureAwait(true);

            var brokerCompletedBeforeCancel = response is not null &&
                                               response.Ok &&
                                               string.Equals(response.State, "complete", StringComparison.OrdinalIgnoreCase) &&
                                               JsonPayload.Bool(response.Payload, "receipt_valid");
            if (response is not null)
            {
                if (IsCanceled)
                {
                    return;
                }
                var wrote = JsonPayload.Bool(response.Payload, "wrote") ||
                            JsonPayload.Bool(response.Payload, "environment_committed") ||
                            JsonPayload.Bool(response.Payload, "committed");
                if (wrote)
                {
                    _environmentCommitted = true;
                }

                var cancellationConfirmed = string.Equals(
                                                response.State,
                                                "canceled",
                                                StringComparison.OrdinalIgnoreCase) ||
                                            JsonPayload.Bool(response.Payload, "canceled") ||
                                            JsonPayload.Bool(response.Payload, "cancelled");
                if (!cancellationConfirmed && !brokerCompletedBeforeCancel)
                {
                    if (response.Ok)
                    {
                        BrokerState = response.State;
                        StatusMessage = "Cancellation requested. Waiting for the installer to confirm it.";
                        RaiseNavigationProperties();
                        return;
                    }

                    _cancelRequested = false;
                    Block(response.Errors.FirstOrDefault() ?? response.Message);
                    return;
                }
            }

            if (brokerCompletedBeforeCancel)
            {
                _cancelRequested = false;
                StatusMessage = "Setup finished before cancellation could take effect.";
                BrokerState = "complete";
                RaiseNavigationProperties();
                return;
            }

            IsCanceled = true;
            StatusMessage = _environmentCommitted
                ? "Canceled. Saved settings remain; setup was not confirmed as complete."
                : _commitAttempted
                    ? "Canceled. A save attempt was in flight; its final write state is not confirmed."
                    : _environmentCommitConfirmed
                        ? "Canceled. The approved settings were already current; no environment file write was needed."
                        : "Canceled before saving settings. No environment write was confirmed.";
            BrokerState = "canceled";
            RaiseNavigationProperties();
        }
        catch (BrokerTransportException exception)
        {
            _cancelRequested = false;
            Block(exception.Message);
        }
        catch (Exception)
        {
            _cancelRequested = false;
            Block("Cancellation could not be confirmed by the installer.");
        }
        finally
        {
            _cancelInFlight = false;
            RaiseNavigationProperties();
        }
    }

    private async Task AdmitPathsAsync()
    {
        if (!HasRequiredPaths || !HasSupportedLane)
        {
            Block("Select a source checkout, private storage root and supported build lane.");
            return;
        }

        var editEpoch = CurrentEditEpoch();
        var response = await SendAsync(
            BrokerOperations.Preadmission,
            new
            {
                checkout_path = CheckoutPath,
                storage_root = StorageRoot,
                lane = Lane,
                setup_path = _setupScript,
                manifest_path = _requirementsManifest,
                setup_hash = _setupHash,
                manifest_hash = _manifestHash,
                license_accepted = LicenseAccepted
            },
            CancellationToken.None).ConfigureAwait(true);
        if (IsStaleOrCanceled(editEpoch))
        {
            return;
        }
        ApplyResponse(response);
        if (!response.Ok)
        {
            return;
        }

        var sourceAdmitted = JsonPayload.Bool(response.Payload, "source_admitted") || HasAdmission;
        if (!sourceAdmitted || !ReadinessConfirmed(response.Payload, allowFreshHost: true))
        {
            StatusMessage = "The selected folders are ready. Check the required tools before loading environment fields.";
            RequirementsReady = false;
            NavigateTo(WizardPageId.Requirements, allowForwardJump: true);
            return;
        }

        if (!await DiscoverAsync().ConfigureAwait(true))
        {
            return;
        }
        NavigateTo(WizardPageId.Environment);
    }

    private async Task<bool> DiscoverAsync()
    {
        var editEpoch = CurrentEditEpoch();
        var response = await SendAsync(
            BrokerOperations.Discover,
            new
            {
                checkout_path = CheckoutPath,
                storage_root = StorageRoot,
                session_id = _sessionId,
                admission_id = _admissionId,
                license_accepted = LicenseAccepted
            },
            CancellationToken.None).ConfigureAwait(true);
        if (IsStaleOrCanceled(editEpoch))
        {
            return false;
        }
        ApplyResponse(response);
        return response.Ok;
    }

    private async Task PreviewEnvironmentAsync()
    {
        if (!HasAdmission)
        {
            Block("The selected checkout must be checked again before previewing values.");
            return;
        }
        if (!ValidateEnvironmentValues())
        {
            return;
        }

        var editEpoch = CurrentEditEpoch();
        var response = await SendAsync(
            BrokerOperations.Preview,
            new
            {
                session_id = _sessionId,
                admission_id = _admissionId,
                values = BuildValues(),
                license_accepted = LicenseAccepted
            },
            CancellationToken.None).ConfigureAwait(true);
        if (IsStaleOrCanceled(editEpoch))
        {
            return;
        }
        ApplyResponse(response);
        PreviewReady = response.Ok &&
                       JsonPayload.Bool(response.Payload, "valid") &&
                       JsonPayload.Bool(response.Payload, "can_commit");
        if (PreviewReady)
        {
            NavigateTo(WizardPageId.Requirements);
        }
    }

    private async Task PrepareRequirementsAsync()
    {
        if (!ValidateEnvironmentValues())
        {
            return;
        }

        var editEpoch = CurrentEditEpoch();
        var response = await SendAsync(
            BrokerOperations.Prerequisites,
            new
            {
                session_id = _sessionId,
                admission_id = _admissionId,
                checkout_path = CheckoutPath,
                storage_root = StorageRoot,
                lane = Lane,
                setup_path = _setupScript,
                manifest_path = _requirementsManifest,
                setup_hash = _setupHash,
                manifest_hash = _manifestHash,
                values = BuildValues(),
                license_accepted = LicenseAccepted
            },
            CancellationToken.None).ConfigureAwait(true);
        if (IsStaleOrCanceled(editEpoch))
        {
            return;
        }
        ApplyResponse(response);
        var readinessConfirmed = response.Ok && ReadinessConfirmed(response.Payload, allowFreshHost: true);
        if (!response.Ok)
        {
            return;
        }

        if (EnvironmentFields.Count == 0 && !await DiscoverAsync().ConfigureAwait(true))
        {
            return;
        }

        if (IsStaleOrCanceled(editEpoch))
        {
            return;
        }

        if (!readinessConfirmed)
        {
            RequirementsReady = false;
            StatusMessage = "The required tools are not ready yet; setup remains blocked.";
            return;
        }

        if (!PreviewReady)
        {
            StatusMessage = "Requirements are ready. Review the environment proposal before saving settings.";
            NavigateTo(WizardPageId.Environment);
            return;
        }

        RequirementsReady = true;
        NavigateTo(WizardPageId.Progress);
    }

    private async Task CommitAndSetupAsync()
    {
        if (!PreviewReady)
        {
            Block("A current redacted preview is required before saving settings.");
            return;
        }
        if (!ValidateEnvironmentValues())
        {
            return;
        }

        ProgressPercent = null;
        var editEpoch = CurrentEditEpoch();
        _commitAttempted = true;
        var commit = await SendAsync(
            BrokerOperations.Commit,
            new
            {
                session_id = _sessionId,
                admission_id = _admissionId,
                values = BuildValues(),
                license_accepted = LicenseAccepted
            },
            CancellationToken.None).ConfigureAwait(true);
        var commitWrote = commit.Ok && JsonPayload.Bool(commit.Payload, "wrote");
        var commitConfirmed = CommitConfirmed(commit);
        if (commitWrote)
        {
            _environmentCommitted = true;
        }
        _environmentCommitConfirmed = commitConfirmed;
        _commitAttempted = false;
        if (IsStaleOrCanceled(editEpoch))
        {
            if (commitWrote && IsCanceled)
            {
                StatusMessage = "Canceled after settings were saved; setup was not confirmed as complete.";
            }
            else if (IsCanceled)
            {
                StatusMessage = "Canceled; the save response did not confirm a write. Setup was not confirmed as complete.";
            }
            return;
        }
        ApplyResponse(commit);
        if (!commitConfirmed)
        {
            Block("The approved environment was not confirmed as valid; setup remains blocked.");
            return;
        }
        if (!commitWrote)
        {
            StatusMessage = "The approved settings already match the environment; continuing setup without a file write.";
        }

        editEpoch = CurrentEditEpoch();
        var setup = await SendAsync(
            BrokerOperations.Setup,
            new
            {
                session_id = _sessionId,
                admission_id = _admissionId,
                checkout_path = CheckoutPath,
                storage_root = StorageRoot,
                lane = Lane,
                storage_profile = _storageProfile,
                receipt_path = _receiptPath,
                mode = _setupMode,
                license_accepted = LicenseAccepted
            },
            CancellationToken.None).ConfigureAwait(true);
        if (IsStaleOrCanceled(editEpoch))
        {
            return;
        }
        ApplyResponse(setup);
        SetupCompleted = setup.Ok &&
                         string.Equals(setup.State, "complete", StringComparison.OrdinalIgnoreCase) &&
                         JsonPayload.Bool(setup.Payload, "receipt_valid");
        if (SetupCompleted)
        {
            StatusMessage = CanLaunchWorkspace
                ? "The selected workspace passed its final setup checks. Launch is ready."
                : "The setup checks passed. The build environment is ready.";
            LaunchMessage = CanLaunchWorkspace
                ? string.Empty
                : "Workspace launch remains unavailable until an initial build is completed.";
            NavigateTo(WizardPageId.Ready);
        }
        else if (setup.Ok)
        {
            Block("Setup returned without a verified completion result; launch remains blocked.");
        }
    }

    private async Task LaunchUiAsync()
    {
        if (!SetupCompleted)
        {
            Block("Launch requires a verified setup result.");
            return;
        }
        if (!CanLaunchWorkspace)
        {
            Block("This setup prepared the build environment only; workspace launch requires an initial build.");
            return;
        }

        var editEpoch = CurrentEditEpoch();
        var response = await SendAsync(
            BrokerOperations.LaunchUi,
            new
            {
                session_id = _sessionId,
                admission_id = _admissionId,
                checkout_path = CheckoutPath,
                storage_root = StorageRoot,
                lane = Lane,
                storage_profile = _storageProfile,
                receipt_path = _receiptPath,
                license_accepted = LicenseAccepted
            },
            CancellationToken.None).ConfigureAwait(true);
        if (IsStaleOrCanceled(editEpoch))
        {
            return;
        }
        ApplyResponse(response);
        if (!response.Ok || !JsonPayload.Bool(response.Payload, "launch_requested"))
        {
            LaunchMessage = "The workspace launch request was not accepted.";
            return;
        }

        LaunchRequested = true;
        LaunchMessage = "Launch requested. Startup status will appear in the workspace console; this window does not claim that the browser has rendered.";
        StatusMessage = LaunchMessage;
        RaiseNavigationProperties();
    }

    private async Task<BrokerResponse> SendAsync(
        string operation,
        object payload,
        CancellationToken cancellationToken)
    {
        var response = await _broker.SendAsync(operation, payload, cancellationToken).ConfigureAwait(true);
        return response;
    }

    private async Task RunOperationAsync(Func<Task> operation)
    {
        var waitingRegistered = false;
        var gateAcquired = false;
        var operationActive = false;
        lock (_lifecycleGate)
        {
            if (_shuttingDown || IsBusy)
            {
                return;
            }
            _operationWaiters++;
            waitingRegistered = true;
        }

        try
        {
            await _operationGate.WaitAsync().ConfigureAwait(true);
            gateAcquired = true;
            lock (_lifecycleGate)
            {
                if (_shuttingDown)
                {
                    return;
                }
                _operationActive++;
                operationActive = true;
            }

            IsBusy = true;
            try
            {
                await operation().ConfigureAwait(true);
            }
            catch (OperationCanceledException)
            {
                if (!_cancelRequested)
                {
                    StatusMessage = "The operation was canceled before the installer confirmed a save.";
                }
                BrokerState = "canceled";
            }
            catch (BrokerTransportException exception)
            {
                if (!_cancelRequested)
                {
                    Block(exception.Message);
                }
            }
            catch (Exception)
            {
                if (!_cancelRequested)
                {
                    Block("The setup operation failed; no unconfirmed success is shown.");
                }
            }
        }
        finally
        {
            if (operationActive)
            {
                IsBusy = false;
            }
            if (gateAcquired)
            {
                _operationGate.Release();
            }
            if (operationActive)
            {
                lock (_lifecycleGate)
                {
                    _operationActive--;
                }
                RaiseNavigationProperties();
            }
            if (waitingRegistered)
            {
                lock (_lifecycleGate)
                {
                    _operationWaiters--;
                    waitingRegistered = false;
                }
            }
        }
    }

    private void ApplyResponse(BrokerResponse response)
    {
        BrokerState = response.State;
        if (response.Progress is >= 0 and <= 100)
        {
            ProgressPercent = response.Progress;
        }

        if (response.Ok)
        {
            StatusMessage = string.IsNullOrWhiteSpace(response.Message)
                ? "The operation was accepted."
                : UserFacingMessage(response.Message);
        }
        else
        {
            Block(response.Errors.FirstOrDefault() ?? response.Message);
        }

        ApplyResponsePayload(response.Payload, preserveConfirmedCommit: CommitConfirmed(response));
        RaiseNavigationProperties();
    }

    private void ApplyResponsePayload(JsonElement payload, bool preserveConfirmedCommit = false)
    {
        if (JsonPayload.Bool(payload, "wrote") ||
            JsonPayload.Bool(payload, "environment_committed") ||
            JsonPayload.Bool(payload, "committed"))
        {
            _environmentCommitted = true;
        }

        var sessionId = JsonPayload.String(payload, "session_id");
        var admissionId = JsonPayload.String(payload, "admission_id");
        var sessionChanged = !string.IsNullOrWhiteSpace(sessionId) &&
                             !string.IsNullOrWhiteSpace(_sessionId) &&
                             !string.Equals(_sessionId, sessionId, StringComparison.Ordinal);
        var admissionChanged = !string.IsNullOrWhiteSpace(admissionId) &&
                               !string.IsNullOrWhiteSpace(_admissionId) &&
                               !string.Equals(_admissionId, admissionId, StringComparison.Ordinal);
        if (sessionChanged || admissionChanged)
        {
            if (preserveConfirmedCommit)
            {
                ClearEnvironmentFields();
            }
            else
            {
                ResetSessionDerivedState();
            }
        }
        if (!string.IsNullOrWhiteSpace(sessionId))
        {
            _sessionId = sessionId;
            RaisePropertyChanged(nameof(HasAdmission));
        }

        if (!string.IsNullOrWhiteSpace(admissionId))
        {
            _admissionId = admissionId;
            RaisePropertyChanged(nameof(HasAdmission));
        }

        var storageProfile = JsonPayload.String(payload, "storage_profile");
        if (!string.IsNullOrWhiteSpace(storageProfile))
        {
            _storageProfile = storageProfile;
        }

        var receiptPath = JsonPayload.String(payload, "receipt_path");
        if (!string.IsNullOrWhiteSpace(receiptPath))
        {
            _receiptPath = receiptPath;
        }

        var setupMode = JsonPayload.String(payload, "bootstrap_mode");
        if (string.IsNullOrWhiteSpace(setupMode))
        {
            setupMode = JsonPayload.String(payload, "mode");
        }
        if (!string.IsNullOrWhiteSpace(setupMode))
        {
            _setupMode = setupMode;
            RaisePropertyChanged(nameof(CanLaunchWorkspace));
            RaisePropertyChanged(nameof(ReadyHeading));
            RaisePropertyChanged(nameof(ReadyDescription));
        }

        var redactedDiff = JsonPayload.String(payload, "redacted_diff");
        if (!string.IsNullOrWhiteSpace(redactedDiff))
        {
            RedactedDiff = redactedDiff;
        }

        UpdateEnvironmentFields(payload);
        UpdateRequirements(payload);
    }

    private void ResetSessionDerivedState()
    {
        PreviewReady = false;
        RequirementsReady = false;
        SetupCompleted = false;
        LaunchRequested = false;
        _environmentCommitted = false;
        _environmentCommitConfirmed = false;
        _commitAttempted = false;
        _admissionId = string.Empty;
        _storageProfile = string.Empty;
        _receiptPath = string.Empty;
        _setupMode = string.Empty;
        RedactedDiff = string.Empty;
        Requirements.Clear();
        RaisePropertyChanged(nameof(HasRequirements));
        RaisePropertyChanged(nameof(HasAdmission));
        RaisePropertyChanged(nameof(CanLaunchWorkspace));
        RaisePropertyChanged(nameof(ReadyHeading));
        RaisePropertyChanged(nameof(ReadyDescription));

        ClearEnvironmentFields();
        StatusMessage = "The setup session changed. Review the current settings again before saving.";
    }

    private void ApplyPublicEvent(BrokerResponse response)
    {
        if (!string.IsNullOrWhiteSpace(response.State))
        {
            BrokerState = response.State;
        }
        if (response.Progress is >= 0 and <= 100)
        {
            ProgressPercent = response.Progress;
        }
        else if (string.Equals(response.State, "running", StringComparison.OrdinalIgnoreCase) ||
                 string.Equals(response.State, "progress", StringComparison.OrdinalIgnoreCase) ||
                 string.Equals(response.State, "in_progress", StringComparison.OrdinalIgnoreCase))
        {
            ProgressPercent = null;
        }
        ApplyResponsePayload(response.Payload);
        if (!string.IsNullOrWhiteSpace(response.Message))
        {
            StatusMessage = UserFacingMessage(response.Message);
        }
        RaiseNavigationProperties();
    }

    private void UpdateEnvironmentFields(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object ||
            !payload.TryGetProperty("fields", out var fields) ||
            fields.ValueKind != JsonValueKind.Array)
        {
            return;
        }

        var responseSessionId = JsonPayload.String(payload, "session_id");
        var responseAdmissionId = JsonPayload.String(payload, "admission_id");
        var fieldIdentityChanged = EnvironmentFields.Count > 0 &&
            ((!string.IsNullOrWhiteSpace(_environmentFieldsSessionId) &&
              !string.IsNullOrWhiteSpace(responseSessionId) &&
              !string.Equals(_environmentFieldsSessionId, responseSessionId, StringComparison.Ordinal)) ||
             (!string.IsNullOrWhiteSpace(_environmentFieldsAdmissionId) &&
              !string.IsNullOrWhiteSpace(responseAdmissionId) &&
              !string.Equals(_environmentFieldsAdmissionId, responseAdmissionId, StringComparison.Ordinal)));
        if (fieldIdentityChanged)
        {
            // A secret entered for another admission must never be carried into
            // this field collection, even when the response is a metadata-only
            // rebind that intentionally preserves confirmed commit state.
            ClearEnvironmentFields();
        }

        var preserved = new Dictionary<string, EnvironmentFieldViewModel>(StringComparer.OrdinalIgnoreCase);
        foreach (var existing in EnvironmentFields)
        {
            if (!preserved.ContainsKey(existing.Key))
            {
                preserved.Add(existing.Key, existing);
            }
            existing.PropertyChanged -= OnEnvironmentFieldChanged;
        }

        EnvironmentFields.Clear();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var field in fields.EnumerateArray())
        {
            if (field.ValueKind != JsonValueKind.Object)
            {
                continue;
            }
            var key = JsonPayload.String(field, "key").Trim();
            if (string.IsNullOrWhiteSpace(key) || !seen.Add(key))
            {
                continue;
            }
            var secret = JsonPayload.Bool(field, "secret");
            var present = JsonPayload.Bool(field, "present");
            var value = NormalizeBrokerFieldValue(
                JsonPayload.String(field, "current_value"),
                secret);
            var preserveUserValue = preserved.TryGetValue(key, out var previous) &&
                                    previous.IsDirty &&
                                    previous.IsSecret == secret;
            // The broker deliberately redacts secret current_value. Rebinding
            // field metadata during progress must not clear a value the user
            // has entered in this process; it is never copied to a response or log.
            if (preserveUserValue)
            {
                value = previous.Value;
            }
            var model = new EnvironmentFieldViewModel(key, secret, present, value, preserveUserValue);
            model.PropertyChanged += OnEnvironmentFieldChanged;
            EnvironmentFields.Add(model);
        }

        if (!string.IsNullOrWhiteSpace(responseSessionId))
        {
            _environmentFieldsSessionId = responseSessionId;
        }
        else if (string.IsNullOrWhiteSpace(_environmentFieldsSessionId) &&
                 !string.IsNullOrWhiteSpace(_sessionId))
        {
            _environmentFieldsSessionId = _sessionId;
        }
        if (!string.IsNullOrWhiteSpace(responseAdmissionId))
        {
            _environmentFieldsAdmissionId = responseAdmissionId;
        }
        else if (string.IsNullOrWhiteSpace(_environmentFieldsAdmissionId) &&
                 !string.IsNullOrWhiteSpace(_admissionId))
        {
            _environmentFieldsAdmissionId = _admissionId;
        }
        RaisePropertyChanged(nameof(EnvironmentFields));
        RaisePropertyChanged(nameof(HasEnvironmentFields));
    }

    private static string NormalizeBrokerFieldValue(string value, bool secret)
    {
        // These markers are meaningful only in broker metadata. They are not
        // reserved user input: a dirty field containing the same literal is
        // sent unchanged through BuildValues().
        if (secret || string.Equals(value, "<unset>", StringComparison.Ordinal))
        {
            return string.Empty;
        }
        return value;
    }

    private void ClearEnvironmentFields()
    {
        foreach (var field in EnvironmentFields)
        {
            field.PropertyChanged -= OnEnvironmentFieldChanged;
        }
        EnvironmentFields.Clear();
        _environmentFieldsSessionId = string.Empty;
        _environmentFieldsAdmissionId = string.Empty;
        RaisePropertyChanged(nameof(EnvironmentFields));
        RaisePropertyChanged(nameof(HasEnvironmentFields));
    }

    private void UpdateRequirements(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object ||
            !payload.TryGetProperty("requirements", out var requirements) ||
            requirements.ValueKind != JsonValueKind.Array)
        {
            return;
        }

        Requirements.Clear();
        foreach (var item in requirements.EnumerateArray())
        {
            var name = JsonPayload.String(item, "name");
            if (string.IsNullOrWhiteSpace(name))
            {
                continue;
            }
            Requirements.Add(new RequirementCheckViewModel(
                name,
                JsonPayload.String(item, "state"),
                JsonPayload.String(item, "details")));
        }
        RequirementsReady = Requirements.Count > 0 && Requirements.All(item => item.IsReady);
        RaisePropertyChanged(nameof(HasRequirements));
    }

    private void OnEnvironmentFieldChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs eventArgs)
    {
        if (eventArgs.PropertyName != nameof(EnvironmentFieldViewModel.Value))
        {
            return;
        }
        AdvanceLocalEditEpoch();
        PreviewReady = false;
        RequirementsReady = false;
        SetupCompleted = false;
        LaunchRequested = false;
        _environmentCommitted = false;
        _environmentCommitConfirmed = false;
        _commitAttempted = false;
        StatusMessage = "Environment values changed. Review a new redacted proposal before saving.";
        RaiseNavigationProperties();
    }

    private void OnBrokerEvent(object? sender, BrokerResponse response)
    {
        Dispatcher.UIThread.Post(() =>
        {
            if (_shuttingDown)
            {
                return;
            }
            var cancellationEvent = string.Equals(response.State, "canceled", StringComparison.OrdinalIgnoreCase) ||
                                     JsonPayload.Bool(response.Payload, "canceled") ||
                                     JsonPayload.Bool(response.Payload, "cancelled");
            if ((_cancelRequested || IsCanceled) &&
                !string.Equals(response.Type, "init", StringComparison.OrdinalIgnoreCase) &&
                !cancellationEvent)
            {
                return;
            }
            if (_cancelRequested && cancellationEvent)
            {
                ApplyResponsePayload(response.Payload);
                _cancelRequested = false;
                IsCanceled = true;
                BrokerState = "canceled";
                StatusMessage = _environmentCommitted
                    ? "Canceled. Saved settings remain; setup was not confirmed as complete."
                    : "Canceled before setup was confirmed as complete.";
                RaiseNavigationProperties();
                return;
            }
            if (string.Equals(response.Type, "init", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(response.Type, "state", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(response.Type, "burn", StringComparison.OrdinalIgnoreCase))
            {
                if (string.Equals(response.Type, "init", StringComparison.OrdinalIgnoreCase))
                {
                    ApplyInitialState(response.Payload);
                }
                ApplyPublicEvent(response);
            }
            else
            {
                ApplyResponse(response);
            }
        });
    }

    private void ApplyInitialState(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object)
        {
            return;
        }

        var licenseIsValid = JsonPayload.Bool(payload, "license_valid");
        var license = JsonPayload.FirstString(payload, "license_text", "license");
        if (licenseIsValid && !string.IsNullOrWhiteSpace(license) && license.Length <= 1_048_576)
        {
            var changed = !string.Equals(LicenseText, license, StringComparison.Ordinal);
            LicenseText = license;
            _licenseFromVerifiedInit = true;
            if (changed)
            {
                LicenseAccepted = false;
            }
        }
        else
        {
            _licenseFromVerifiedInit = false;
            LicenseAccepted = false;
            LicenseText = string.Empty;
        }

        var setupScript = JsonPayload.FirstString(payload, "setup_path", "setup_script", "setup_script_path");
        if (string.IsNullOrWhiteSpace(setupScript))
        {
            setupScript = JsonPayload.NestedString(payload, "setup_script", "filename");
        }
        if (!string.IsNullOrWhiteSpace(setupScript))
        {
            _setupScript = setupScript;
        }

        var requirementsManifest = JsonPayload.FirstString(
            payload,
            "manifest_path",
            "requirements_manifest",
            "requirements_manifest_path");
        if (string.IsNullOrWhiteSpace(requirementsManifest))
        {
            requirementsManifest = JsonPayload.NestedString(payload, "requirements_manifest", "filename");
        }
        if (!string.IsNullOrWhiteSpace(requirementsManifest))
        {
            _requirementsManifest = requirementsManifest;
        }

        var setupHash = JsonPayload.FirstString(payload, "setup_hash", "setup_sha256", "setup_script_sha256");
        if (string.IsNullOrWhiteSpace(setupHash))
        {
            setupHash = JsonPayload.NestedString(payload, "setup_script", "sha256");
        }
        if (!string.IsNullOrWhiteSpace(setupHash))
        {
            _setupHash = setupHash;
        }

        var manifestHash = JsonPayload.FirstString(
            payload,
            "manifest_hash",
            "requirements_hash",
            "requirements_manifest_sha256");
        if (string.IsNullOrWhiteSpace(manifestHash))
        {
            manifestHash = JsonPayload.NestedString(payload, "requirements_manifest", "sha256");
        }
        if (!string.IsNullOrWhiteSpace(manifestHash))
        {
            _manifestHash = manifestHash;
        }

        var setupMode = JsonPayload.FirstString(payload, "bootstrap_mode", "setup_mode", "mode");
        if (!string.IsNullOrWhiteSpace(setupMode))
        {
            _setupMode = setupMode;
        }

        var storageProfile = JsonPayload.FirstString(payload, "storage_profile", "profile");
        if (!string.IsNullOrWhiteSpace(storageProfile))
        {
            _storageProfile = storageProfile;
        }

        var receiptPath = JsonPayload.String(payload, "receipt_path");
        if (!string.IsNullOrWhiteSpace(receiptPath))
        {
            _receiptPath = receiptPath;
        }

        var checkout = JsonPayload.FirstString(payload, "checkout_path", "source_checkout");
        if (!HasAdmission && !string.IsNullOrWhiteSpace(checkout) && string.IsNullOrWhiteSpace(_checkoutPath))
        {
            _checkoutPath = checkout;
            RaisePropertyChanged(nameof(CheckoutPath));
        }

        var storage = JsonPayload.FirstString(payload, "storage_root", "project_storage_root");
        if (!HasAdmission && !string.IsNullOrWhiteSpace(storage) && string.IsNullOrWhiteSpace(_storageRoot))
        {
            _storageRoot = storage;
            RaisePropertyChanged(nameof(StorageRoot));
        }

        var lane = JsonPayload.FirstString(payload, "lane", "requested_lane");
        if (!HasAdmission && !string.IsNullOrWhiteSpace(lane))
        {
            var normalized = NormalizeLane(lane);
            if (!string.Equals(_lane, normalized, StringComparison.Ordinal))
            {
                _lane = normalized;
                RaisePropertyChanged(nameof(Lane));
            }
            if (string.IsNullOrWhiteSpace(normalized))
            {
                StatusMessage = "The installer supplied an unsupported build lane. Choose native, FEM CPU or FEM GPU.";
            }
        }
        RaisePropertyChanged(nameof(CanLaunchWorkspace));
        RaisePropertyChanged(nameof(ReadyHeading));
        RaisePropertyChanged(nameof(ReadyDescription));
        RaiseNavigationProperties();
    }

    private Dictionary<string, string> BuildValues()
    {
        var values = EnvironmentFields
            .Where(field => field.IsDirty)
            .ToDictionary(field => field.Key, field => field.Value, StringComparer.OrdinalIgnoreCase);

        // The storage root is an explicit path selected on the Paths page. It
        // must remain authoritative even when the corresponding .env field was
        // absent in the broker's redacted metadata and therefore is untouched.
        if (!string.IsNullOrWhiteSpace(StorageRoot))
        {
            values["FULLMAG_PROJECT_STORAGE_ROOT"] = StorageRoot;
        }

        return values;
    }

    private bool ValidateEnvironmentValues()
    {
        var hasReservedSecret = EnvironmentFields.Any(field =>
            field.IsDirty &&
            field.IsSecret &&
            (string.Equals(field.Value, "<redacted>", StringComparison.OrdinalIgnoreCase) ||
             string.Equals(field.Value, "__FULLMAG_KEEP_SECRET__", StringComparison.OrdinalIgnoreCase)));
        if (!hasReservedSecret)
        {
            return true;
        }

        Block("The selected secret value is reserved by the installer. Enter a different value before continuing.");
        return false;
    }

    private void InvalidateAdmission()
    {
        if (_shuttingDown)
        {
            return;
        }
        AdvanceLocalEditEpoch();
        _sessionId = string.Empty;
        _admissionId = string.Empty;
        _storageProfile = string.Empty;
        _receiptPath = string.Empty;
        PreviewReady = false;
        RequirementsReady = false;
        SetupCompleted = false;
        LaunchRequested = false;
        _setupMode = string.Empty;
        _commitAttempted = false;
        _environmentCommitted = false;
        _environmentCommitConfirmed = false;
        RaisePropertyChanged(nameof(CanLaunchWorkspace));
        RaisePropertyChanged(nameof(ReadyHeading));
        RaisePropertyChanged(nameof(ReadyDescription));
        RedactedDiff = string.Empty;
        Requirements.Clear();
        ClearEnvironmentFields();
        RaisePropertyChanged(nameof(HasRequirements));
        RaisePropertyChanged(nameof(HasAdmission));
        StatusMessage = "The selected checkout or storage changed. Check paths again before continuing.";
        RaiseNavigationProperties();
    }

    private void Block(string message)
    {
        BrokerState = "blocked";
        StatusMessage = string.IsNullOrWhiteSpace(message)
            ? "This operation is blocked."
            : UserFacingMessage(message);
        RaiseNavigationProperties();
    }

    private static bool ReadinessConfirmed(JsonElement payload, bool allowFreshHost)
    {
        if (payload.ValueKind != JsonValueKind.Object)
        {
            return false;
        }

        if (JsonPayload.Bool(payload, "tools_ready"))
        {
            return true;
        }

        var readiness = JsonPayload.FirstString(payload, "readiness", "state");
        if (string.Equals(readiness, "ready", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(readiness, "prerequisites_ready", StringComparison.OrdinalIgnoreCase) ||
            (allowFreshHost && string.Equals(
                readiness,
                "compiler_ready_provider_pending",
                StringComparison.OrdinalIgnoreCase)))
        {
            return true;
        }

        var gitPath = JsonPayload.NestedObjectString(payload, "tools", "git", "path");
        var pythonPath = JsonPayload.NestedObjectString(payload, "tools", "python", "path");
        if (!string.IsNullOrWhiteSpace(gitPath) && !string.IsNullOrWhiteSpace(pythonPath))
        {
            return true;
        }

        if (payload.TryGetProperty("requirements", out var requirements) &&
            requirements.ValueKind == JsonValueKind.Array)
        {
            var checks = requirements.EnumerateArray().ToArray();
            return checks.Length > 0 && checks.All(item =>
                string.Equals(JsonPayload.String(item, "state"), "ready", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(JsonPayload.String(item, "state"), "complete", StringComparison.OrdinalIgnoreCase));
        }

        return false;
    }

    private static bool CommitConfirmed(BrokerResponse response)
    {
        if (!response.Ok || !JsonPayload.Bool(response.Payload, "valid"))
        {
            return false;
        }

        var payloadState = JsonPayload.String(response.Payload, "state");
        return JsonPayload.Bool(response.Payload, "wrote") ||
               JsonPayload.Bool(response.Payload, "environment_committed") ||
               JsonPayload.Bool(response.Payload, "committed") ||
               string.Equals(response.State, "committed", StringComparison.OrdinalIgnoreCase) ||
               string.Equals(response.State, "unchanged", StringComparison.OrdinalIgnoreCase) ||
               string.Equals(payloadState, "committed", StringComparison.OrdinalIgnoreCase) ||
               string.Equals(payloadState, "unchanged", StringComparison.OrdinalIgnoreCase);
    }

    private static string UserFacingMessage(string message)
    {
        return message
            .Replace("broker", "installer", StringComparison.OrdinalIgnoreCase)
            .Replace("admitted", "accepted", StringComparison.OrdinalIgnoreCase)
            .Replace("admission", "setup session", StringComparison.OrdinalIgnoreCase)
            .Replace("receipt", "completion result", StringComparison.OrdinalIgnoreCase);
    }

    private long CurrentEditEpoch() => Interlocked.Read(ref _localEditEpoch);

    private void AdvanceLocalEditEpoch()
    {
        Interlocked.Increment(ref _localEditEpoch);
    }

    private bool IsStaleOrCanceled(long editEpoch) =>
        _cancelRequested || IsCanceled || CurrentEditEpoch() != editEpoch;

    private void NavigateTo(WizardPageId page, bool allowForwardJump = false)
    {
        if (!_pages.TryGetValue(page, out var pageViewModel))
        {
            return;
        }
        var pageIndex = Steps.IndexOf(_stepsByPage[page]);
        if (pageIndex < 0 || (!allowForwardJump && pageIndex > _highestVisitedIndex + 1) ||
            (allowForwardJump && pageIndex > Steps.Count - 1))
        {
            return;
        }

        var nextStep = _stepsByPage[page];
        _selectedStep.IsCurrent = false;
        _selectedStep = nextStep;
        _selectedStep.IsCurrent = true;
        CurrentPage = pageViewModel;
        _highestVisitedIndex = Math.Max(_highestVisitedIndex, Steps.IndexOf(nextStep));
        UpdateStepState();
        RaisePropertyChanged(nameof(SelectedStep));
    }

    private bool CanNavigateTo(WizardPageId page)
    {
        var pageIndex = Steps.IndexOf(_stepsByPage[page]);
        return pageIndex >= 0 && pageIndex <= _highestVisitedIndex;
    }

    private void UpdateStepState()
    {
        foreach (var step in Steps)
        {
            var index = Steps.IndexOf(step);
            step.CanNavigate = index <= _highestVisitedIndex;
            step.IsCompleted = index < _highestVisitedIndex;
        }
    }

    private void RaiseNavigationProperties()
    {
        RaisePropertyChanged(nameof(PrimaryActionLabel));
        RaisePropertyChanged(nameof(CanPrimaryAction));
        RaisePropertyChanged(nameof(CanGoBack));
        RaisePropertyChanged(nameof(IsFinalPage));
        RaisePropertyChanged(nameof(HasRequiredPaths));
        RaisePropertyChanged(nameof(HasSupportedLane));
        RaisePropertyChanged(nameof(HasCommittedSession));
        RaisePropertyChanged(nameof(HasAdmission));
        RaisePropertyChanged(nameof(IsProgressIndeterminate));
        RaisePropertyChanged(nameof(CanEditInputs));
        RaisePropertyChanged(nameof(CanCancel));
        RaisePropertyChanged(nameof(CanLaunchWorkspace));
        RaisePropertyChanged(nameof(ReadyHeading));
        RaisePropertyChanged(nameof(ReadyDescription));
        RaisePropertyChanged(nameof(LicenseAvailable));
    }

    private static string NormalizeLane(string? lane)
    {
        var normalized = lane?.Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(normalized))
        {
            return string.Empty;
        }
        return normalized switch
        {
            "native" or "windows-native" => "native",
            "fem-gpu" or "windows-native-fem-gpu" => "fem-gpu",
            "fem-cpu" or "windows-native-fem-cpu" => "fem-cpu",
            _ => string.Empty
        };
    }

    public Task ShutdownAsync()
    {
        lock (_lifecycleGate)
        {
            _shutdownTask ??= ShutdownCoreAsync();
            return _shutdownTask;
        }
    }

    private async Task ShutdownCoreAsync()
    {
        lock (_lifecycleGate)
        {
            _shuttingDown = true;
        }
        using var shutdownBudget = new CancellationTokenSource(ShutdownCancelTimeout);
        try
        {
            try
            {
                if (!string.IsNullOrWhiteSpace(_sessionId) && !SetupCompleted)
                {
                    try
                    {
                        await _broker.SendAsync(
                            BrokerOperations.Cancel,
                            new
                            {
                                session_id = _sessionId,
                                admission_id = _admissionId,
                                license_accepted = LicenseAccepted
                            },
                            shutdownBudget.Token).ConfigureAwait(false);
                    }
                    catch (OperationCanceledException)
                    {
                        // The operation state is unknown; do not infer a
                        // canceled or no-write result from a timeout.
                    }
                    catch (BrokerTransportException)
                    {
                        // The private transport is closing; no commit state is
                        // changed when cancellation cannot be confirmed.
                    }
                    catch (Exception)
                    {
                        // Shutdown must still close the inherited transport;
                        // an unexpected cancel failure is not a success claim.
                    }
                }
            }
            finally
            {
                try
                {
                    // Share the same deadline with the best-effort cancel.
                    // The broker task remains terminally requested if native
                    // IO outlives this bounded UI wait.
                    await _broker.ShutdownAsync()
                        .WaitAsync(shutdownBudget.Token)
                        .ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    // The transport owns any native IO still in flight; this
                    // UI task must not hold window teardown past its budget.
                }
                catch (Exception)
                {
                    // The native BA owns the final pipe/process teardown.
                    // Never turn a cleanup failure into a commit/no-write claim.
                }
            }
        }
        finally
        {
            _broker.EventReceived -= OnBrokerEvent;
        }
    }

    public ValueTask DisposeAsync()
    {
        lock (_lifecycleGate)
        {
            _disposeTask ??= DisposeCoreAsync();
            return new ValueTask(_disposeTask);
        }
    }

    private async Task DisposeCoreAsync()
    {
        await ShutdownAsync().ConfigureAwait(false);
        var disposeOperationGate = false;
        lock (_lifecycleGate)
        {
            if (_operationWaiters == 0 && _operationActive == 0)
            {
                disposeOperationGate = true;
            }
        }
        if (disposeOperationGate)
        {
            // No RunOperationAsync can still release this gate after the
            // lifecycle lock confirmed quiescence.  If an operation remains
            // active or queued, leave the managed semaphore alive until the
            // process tears down rather than racing its finally block.
            _operationGate.Dispose();
        }
        await _broker.DisposeAsync().ConfigureAwait(false);
    }
}
