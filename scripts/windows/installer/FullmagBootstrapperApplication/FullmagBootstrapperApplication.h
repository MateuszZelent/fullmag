#pragma once

// This header intentionally includes the WiX 3 Burn interfaces from the
// configured SDK.  Do not copy those interfaces into this project: the BA must
// be rebuilt against the exact WiX 3 SDK used by the bundle authoring step.
#include <windows.h>
#include <unknwn.h>
#include <objbase.h>
#include <commctrl.h>
#include <msi.h>

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "IBootstrapperEngine.h"
#include "IBootstrapperApplication.h"

namespace fullmag::installer {

class HelperClient;
struct HelperReply;

struct UiOperationContext {
    std::wstring requestId;
    std::wstring operation;
    uint64_t generation = 0;
    bool valid = false;
};

// The broker reader can outlive the BA's UI thread after a bounded transport
// cancellation.  Keep its notification target in a shared gate so a detached
// reader never dereferences the BA object while it is being destroyed.
struct UiBrokerDispatchGate {
    std::mutex lock;
    HWND target = nullptr;
    bool accepting = false;
};

class FullmagBootstrapperApplication final : public IBootstrapperApplication {
public:
    FullmagBootstrapperApplication(IBootstrapperEngine* engine,
                                   const BOOTSTRAPPER_COMMAND* command);
    ~FullmagBootstrapperApplication();

    STDMETHODIMP QueryInterface(REFIID riid, void** object) override;
    STDMETHODIMP_(ULONG) AddRef() override;
    STDMETHODIMP_(ULONG) Release() override;

    STDMETHODIMP OnStartup() override;
    STDMETHODIMP_(int) OnShutdown() override;
    STDMETHODIMP_(int) OnSystemShutdown(DWORD endSession, int recommendation) override;
    STDMETHODIMP_(int) OnDetectBegin(BOOL installed, DWORD packageCount) override;
    STDMETHODIMP_(int) OnDetectForwardCompatibleBundle(LPCWSTR bundleId,
        BOOTSTRAPPER_RELATION_TYPE relationType, LPCWSTR bundleTag, BOOL perMachine,
        DWORD64 version, int recommendation) override;
    STDMETHODIMP_(int) OnDetectUpdateBegin(LPCWSTR updateLocation, int recommendation) override;
    STDMETHODIMP_(int) OnDetectUpdate(LPCWSTR updateLocation, DWORD64 size, DWORD64 version,
        LPCWSTR title, LPCWSTR summary, LPCWSTR contentType, LPCWSTR content,
        int recommendation) override;
    STDMETHODIMP_(void) OnDetectUpdateComplete(HRESULT status, LPCWSTR updateLocation) override;
    STDMETHODIMP_(int) OnDetectRelatedBundle(LPCWSTR bundleId,
        BOOTSTRAPPER_RELATION_TYPE relationType, LPCWSTR bundleTag, BOOL perMachine,
        DWORD64 version, BOOTSTRAPPER_RELATED_OPERATION operation) override;
    STDMETHODIMP_(int) OnDetectPackageBegin(LPCWSTR packageId) override;
    STDMETHODIMP_(int) OnDetectCompatiblePackage(LPCWSTR packageId,
        LPCWSTR compatiblePackageId) override;
    STDMETHODIMP_(int) OnDetectRelatedMsiPackage(LPCWSTR packageId, LPCWSTR productCode,
        BOOL perMachine, DWORD64 version, BOOTSTRAPPER_RELATED_OPERATION operation) override;
    STDMETHODIMP_(int) OnDetectTargetMsiPackage(LPCWSTR packageId, LPCWSTR productCode,
        BOOTSTRAPPER_PACKAGE_STATE patchState) override;
    STDMETHODIMP_(int) OnDetectMsiFeature(LPCWSTR packageId, LPCWSTR featureId,
        BOOTSTRAPPER_FEATURE_STATE state) override;
    STDMETHODIMP_(void) OnDetectPackageComplete(LPCWSTR packageId, HRESULT status,
        BOOTSTRAPPER_PACKAGE_STATE state) override;
    STDMETHODIMP_(void) OnDetectComplete(HRESULT status) override;
    STDMETHODIMP_(int) OnPlanBegin(DWORD packageCount) override;
    STDMETHODIMP_(int) OnPlanRelatedBundle(LPCWSTR bundleId,
        BOOTSTRAPPER_REQUEST_STATE* requestedState) override;
    STDMETHODIMP_(int) OnPlanPackageBegin(LPCWSTR packageId,
        BOOTSTRAPPER_REQUEST_STATE* requestedState) override;
    STDMETHODIMP_(int) OnPlanCompatiblePackage(LPCWSTR packageId,
        BOOTSTRAPPER_REQUEST_STATE* requestedState) override;
    STDMETHODIMP_(int) OnPlanTargetMsiPackage(LPCWSTR packageId, LPCWSTR productCode,
        BOOTSTRAPPER_REQUEST_STATE* requestedState) override;
    STDMETHODIMP_(int) OnPlanMsiFeature(LPCWSTR packageId, LPCWSTR featureId,
        BOOTSTRAPPER_FEATURE_STATE* requestedState) override;
    STDMETHODIMP_(void) OnPlanPackageComplete(LPCWSTR packageId, HRESULT status,
        BOOTSTRAPPER_PACKAGE_STATE state, BOOTSTRAPPER_REQUEST_STATE requested,
        BOOTSTRAPPER_ACTION_STATE execute, BOOTSTRAPPER_ACTION_STATE rollback) override;
    STDMETHODIMP_(void) OnPlanComplete(HRESULT status) override;
    STDMETHODIMP_(int) OnApplyBegin() override;
    STDMETHODIMP_(void) OnApplyPhaseCount(DWORD phaseCount) override;
    STDMETHODIMP_(int) OnElevate() override;
    STDMETHODIMP_(int) OnProgress(DWORD progress, DWORD overallProgress) override;
    STDMETHODIMP_(int) OnError(BOOTSTRAPPER_ERROR_TYPE errorType, LPCWSTR packageId,
        DWORD code, LPCWSTR error, DWORD uiFlags, DWORD dataCount, LPCWSTR* data,
        int recommendation) override;
    STDMETHODIMP_(int) OnRegisterBegin() override;
    STDMETHODIMP_(void) OnRegisterComplete(HRESULT status) override;
    STDMETHODIMP_(int) OnCacheBegin() override;
    STDMETHODIMP_(int) OnCachePackageBegin(LPCWSTR packageId, DWORD payloadCount,
        DWORD64 packageCacheSize) override;
    STDMETHODIMP_(int) OnCacheAcquireBegin(LPCWSTR packageOrContainerId, LPCWSTR payloadId,
        BOOTSTRAPPER_CACHE_OPERATION operation, LPCWSTR source) override;
    STDMETHODIMP_(int) OnCacheAcquireProgress(LPCWSTR packageOrContainerId, LPCWSTR payloadId,
        DWORD64 progress, DWORD64 total, DWORD overallProgress) override;
    STDMETHODIMP_(int) OnResolveSource(LPCWSTR packageOrContainerId, LPCWSTR payloadId,
        LPCWSTR localSource, LPCWSTR downloadSource) override;
    STDMETHODIMP_(int) OnCacheAcquireComplete(LPCWSTR packageOrContainerId, LPCWSTR payloadId,
        HRESULT status, int recommendation) override;
    STDMETHODIMP_(int) OnCacheVerifyBegin(LPCWSTR packageOrContainerId, LPCWSTR payloadId) override;
    STDMETHODIMP_(int) OnCacheVerifyComplete(LPCWSTR packageOrContainerId, LPCWSTR payloadId,
        HRESULT status, int recommendation) override;
    STDMETHODIMP_(int) OnCachePackageComplete(LPCWSTR packageId, HRESULT status,
        int recommendation) override;
    STDMETHODIMP_(void) OnCacheComplete(HRESULT status) override;
    STDMETHODIMP_(int) OnExecuteBegin(DWORD executingPackageCount) override;
    STDMETHODIMP_(int) OnExecutePackageBegin(LPCWSTR packageId, BOOL execute) override;
    STDMETHODIMP_(int) OnExecutePatchTarget(LPCWSTR packageId,
        LPCWSTR targetProductCode) override;
    STDMETHODIMP_(int) OnExecuteProgress(LPCWSTR packageId, DWORD progress,
        DWORD overallProgress) override;
    STDMETHODIMP_(int) OnExecuteMsiMessage(LPCWSTR packageId, INSTALLMESSAGE message,
        UINT uiFlags, LPCWSTR messageText, DWORD dataCount, LPCWSTR* data,
        int recommendation) override;
    STDMETHODIMP_(int) OnExecuteFilesInUse(LPCWSTR packageId, DWORD fileCount,
        LPCWSTR* files) override;
    STDMETHODIMP_(int) OnExecutePackageComplete(LPCWSTR packageId, HRESULT status,
        BOOTSTRAPPER_APPLY_RESTART restart, int recommendation) override;
    STDMETHODIMP_(void) OnExecuteComplete(HRESULT status) override;
    STDMETHODIMP_(void) OnUnregisterBegin() override;
    STDMETHODIMP_(void) OnUnregisterComplete(HRESULT status) override;
    STDMETHODIMP_(int) OnApplyComplete(HRESULT status,
        BOOTSTRAPPER_APPLY_RESTART restart) override;
    STDMETHODIMP_(int) OnLaunchApprovedExeBegin() override;
    STDMETHODIMP_(void) OnLaunchApprovedExeComplete(HRESULT status, DWORD processId) override;

private:
    FullmagBootstrapperApplication(const FullmagBootstrapperApplication&) = delete;
    FullmagBootstrapperApplication& operator=(const FullmagBootstrapperApplication&) = delete;

    static LRESULT CALLBACK WindowProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam);
    static LRESULT CALLBACK FieldPanelProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam);
    static LRESULT CALLBACK ContentControlSubclassProc(HWND window, UINT message, WPARAM wParam,
                                                       LPARAM lParam, UINT_PTR subclassId,
                                                       DWORD_PTR refData);
    static LRESULT CALLBACK FieldEditSubclassProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam,
                                                  UINT_PTR subclassId, DWORD_PTR refData);
    void UiThreadMain();
    void CreateUi(HWND window);
    void DestroyUi();
    void SetStatus(const std::wstring& status, bool error = false);
    void SetProgress(DWORD progress);
    void HandleCommand(WORD commandId);
    void DiscoverCheckout();
    void PreviewEnvironment(bool commit);
    void BootstrapPrerequisites();
    void RunDependencyCheck(bool install);
    void StartInstall(const UiOperationContext& context = {});
    void LaunchInstalledUi(const UiOperationContext& context = {});
    void CancelEnvironmentSession(const UiOperationContext& context = {});
    void InvalidateEnvironmentAdmission(bool cancelSession, bool cancelUiOperation = true);
    void RevalidateCommittedEnvironmentAsync(std::function<void(bool)> completion);
    void SendHelperAsync(const std::wstring& request,
                         std::function<void(const std::wstring&, const std::wstring&)> completion);
    void HandleHelperReply(HelperReply* reply);
    void MaybeSendPendingHelperCancel();
    void HandleApplyComplete(HRESULT status);
    void SetEnvironmentMutationLock(bool locked);
    bool PrepareSourceFirstBurnVariables();
    bool CaptureAcceptedSourceIdentity(const std::wstring& response);
    bool WriteSourceFirstAdmission();
    std::wstring BuildSourceFirstAdmissionJson() const;
    bool ValidateSourceFirstReceipt() const;
    bool LaunchSourceFirstUi(const UiOperationContext& context = {});
    bool ValidateBootstrapPayloads(std::wstring* setupPath, std::wstring* manifestPath,
                                  std::wstring* setupHash, std::wstring* manifestHash) const;
    bool BootstrapFreshHostPrerequisites();
    void UpdatePrerequisiteControls();
    void RebuildFieldControls(bool preserveValues = false);
    void SubclassContentControl(HWND control);
    void LayoutUi();
    void UpdateContentScrollBar();
    void ScrollContentTo(int offset);
    void ScrollContentBy(int delta);
    void UpdateFieldPanelScrollBar();
    void ScrollFieldPanelTo(int offset);
    void ScrollFieldPanelBy(int delta);
    void EnsureContentVisible(HWND control);
    void EnsureFieldVisible(HWND edit);
    std::wstring CollectFieldValuesJson() const;
    std::wstring ModuleDirectory() const;
    std::wstring FindPayload(const std::vector<std::wstring>& names) const;
    std::wstring EngineVariable(const wchar_t* name) const;
    std::wstring RequestedLane() const;
    std::wstring RuntimeStorageProfile() const;
    void InvalidateLaneAdmission();
    bool IsWebView2Installed() const;
    bool IsRegularLocalFile(const std::wstring& path) const;
    bool ReadTextFile(const std::wstring& path, std::wstring* text) const;
    std::wstring Sha256File(const std::wstring& path) const;
    void ShowPublicReply(const std::wstring& reply, bool error = false);

    std::atomic<ULONG> references_{1};
    IBootstrapperEngine* engine_ = nullptr;
    BOOTSTRAPPER_ACTION action_{};
    HWND window_ = nullptr;
    std::atomic<HWND> uiWindow_{nullptr};
    HANDLE uiReadyEvent_ = nullptr;
    std::shared_ptr<UiBrokerDispatchGate> brokerDispatchGate_;
    std::thread uiThread_;
    std::thread helperThread_;
    std::unique_ptr<HelperClient> helper_;
    std::atomic<bool> helperRequestInFlight_{false};
    std::atomic<HWND> helperMessageWindow_{nullptr};
    std::wstring pendingCancelSession_;
    UiOperationContext pendingCancelOperation_;
    UiOperationContext burnOperationContext_;
    UiOperationContext burnCancelOperation_;
    bool burnApplyAfterPlan_ = true;
    std::atomic<bool> burnCancelRequested_{false};
    uint64_t admissionGeneration_ = 0;
    mutable std::mutex stateMutex_;

    HWND statusLabel_ = nullptr;
    HWND progressBar_ = nullptr;
    HWND licenseText_ = nullptr;
    HWND licenseAccepted_ = nullptr;
    HWND checkoutEdit_ = nullptr;
    HWND storageRootLabel_ = nullptr;
    HWND storageRootEdit_ = nullptr;
    HWND laneCombo_ = nullptr;
    HWND summaryEdit_ = nullptr;
    HWND browseButton_ = nullptr;
    HWND discoverButton_ = nullptr;
    HWND previewButton_ = nullptr;
    HWND commitButton_ = nullptr;
    HWND dependencyCheckButton_ = nullptr;
    HWND dependencyInstallButton_ = nullptr;
    HWND installButton_ = nullptr;
    HWND launchButton_ = nullptr;
    HWND fieldPanel_ = nullptr;
    std::vector<HWND> fieldLabels_;
    std::vector<std::pair<std::wstring, HWND>> fieldControls_;
    int contentScrollOffset_ = 0;
    int contentHeight_ = 0;
    int fieldScrollOffset_ = 0;
    int fieldContentHeight_ = 0;
    std::wstring sessionId_;
    std::wstring lastSessionReply_;
    std::wstring acceptedMainCheckout_;
    std::wstring acceptedRequestedCheckout_;
    std::wstring acceptedSetupScriptPath_;
    std::wstring acceptedSetupHash_;
    std::wstring acceptedTemplatePath_;
    std::wstring acceptedTemplateHash_;
    std::wstring acceptedManifestPath_;
    std::wstring acceptedManifestHash_;
    std::wstring acceptedResolverPath_;
    std::wstring acceptedResolverHash_;
    std::wstring acceptedMainGitTop_;
    std::wstring acceptedMainGitHead_;
    std::wstring acceptedMainGitWorktreesHash_;
    std::wstring acceptedRequestedGitTop_;
    std::wstring acceptedRequestedGitHead_;
    std::wstring acceptedRequestedGitWorktreesHash_;
    std::wstring acceptedStorageProfile_;
    std::wstring requestedLane_ = L"all";
    std::wstring bootstrapMode_;
    std::wstring receiptPath_;
    std::wstring sourceAdmissionPath_;
    std::wstring sourceAdmissionHash_;
    std::wstring bootstrapGitPath_;
    std::wstring bootstrapPythonPath_;
    std::wstring lastPreview_;
    std::wstring committedEnvironmentHash_;
    std::wstring committedStorageRoot_;
    std::wstring committedRunsRoot_;
    std::wstring committedValuesJson_;
    bool licenseIsValid_ = false;
    bool previewIsValid_ = false;
    bool environmentCommitted_ = false;
    bool dependenciesReady_ = false;
    bool fieldsTruncated_ = false;
    bool sourceFirst_ = false;
    std::atomic<bool> installRequested_{false};
    bool applyFinished_ = false;
    std::atomic<bool> shuttingDown_{false};
    bool environmentMutationLocked_ = false;
};

} // namespace fullmag::installer
