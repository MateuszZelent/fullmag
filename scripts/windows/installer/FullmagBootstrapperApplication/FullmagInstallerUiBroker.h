#pragma once

#include <windows.h>

#include <atomic>
#include <cstddef>
#include <condition_variable>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace fullmag::installer {

// The Burn BA remains the authority for engine callbacks, admission, and
// source-first state.  The x64 Avalonia payload is a presentation process only
// and speaks this bounded line protocol over private inherited pipes:
//
//   {"schema":"fullmag.windows-installer-ui.v1",
//    "type":"hello|init|command|reply|state|burn|shutdown|error",
//    "version":"1.0.0","request_id":"...","generation":N,
//    "revision":N,"payload":{...}}
//
// The first child line must be a hello with version 1.0.0 and arch x64.  The
// BA sends init after that handshake.  UI commands use these operation names:
// discover, preview, commit, bootstrap_prerequisites, dependency_check,
// dependency_install, plan, apply, initial_build, launch, cancel, status.
// Every command carries the current admission generation and an opaque request
// id.  The BA rejects stale generations before touching HelperClient, Burn, or
// canonical storage.  Replies and state/burn events carry monotonically
// increasing revisions.  Values in command payloads travel only over stdin;
// replies, state, and logs must contain redacted values and never secrets.
//
// The broker validates the hash-bound x64 payload before CreateProcessW,
// passes no arbitrary command line, strips ambient secret environment names,
// restricts inherited handles, and owns the child and descendants with a Job
// Object.  It is transport/provenance code; it does not implement UI policy.
class FullmagInstallerUiBroker final {
public:
    static constexpr wchar_t kProtocolSchema[] = L"fullmag.windows-installer-ui.v1";
    static constexpr wchar_t kProtocolVersion[] = L"1.0.0";
    static constexpr size_t kMaxFrameBytes = 2 * 1024 * 1024;

    // Both handlers run on the reader thread and must only marshal work to a
    // BA/UI queue; they must return promptly and must not call broker methods.
    using MessageHandler = std::function<void(const std::wstring& message)>;
    // Called on the broker reader thread when an established UI session closes
    // without an explicit Stop()/Shutdown().  The callback must be short,
    // non-blocking, and must not call back into this broker.  BA integration
    // should marshal the notification to its own message window and keep the
    // broker shared owner alive until that notification has been handled.
    using ClosedHandler = std::function<void()>;

    FullmagInstallerUiBroker();
    ~FullmagInstallerUiBroker();

    FullmagInstallerUiBroker(const FullmagInstallerUiBroker&) = delete;
    FullmagInstallerUiBroker& operator=(const FullmagInstallerUiBroker&) = delete;

    // executablePath must be a regular local x64 file and expectedSha256 must
    // be the hash admitted by the Burn payload/provenance record.  initJson is
    // sent only after the child has emitted and passed the hello handshake.
    bool Start(const std::wstring& executablePath,
               const std::wstring& expectedSha256,
               const std::wstring& initJson,
               MessageHandler onMessage,
               std::wstring* publicError,
               ClosedHandler onClosed = {});

    // Sends one complete JSON object.  The broker appends exactly one LF and
    // never writes command-line or log copies of the payload.
    bool Send(const std::wstring& json, std::wstring* publicError);

    // Stops a restartable UI session.  Shutdown() is terminal and must be used
    // by BA teardown so a racing Start cannot clear the cancellation state.
    void Stop();
    void Shutdown();
    bool Running() const;

private:
    struct SharedState {
        ~SharedState();

        mutable std::mutex stateLock;
        std::mutex sendLock;
        std::mutex readerLock;
        std::condition_variable helloCondition;
        HANDLE ioDoneEvent = nullptr;
        HANDLE readerThreadHandle = nullptr;
        HANDLE process = nullptr;
        HANDLE job = nullptr;
        HANDLE stdinPipe = nullptr;
        HANDLE stdoutPipe = nullptr;
        MessageHandler onMessage;
        ClosedHandler onClosed;
        std::wstring firstError;
        bool helloReceived = false;
        bool helloValid = false;
        bool readerDone = true;
        bool running = false;
        std::atomic<bool> stopRequested{false};
    };

    static void CloseIf(HANDLE handle);
    static bool IsSha256(const std::wstring& value);
    static bool IsLocalRegularFile(const std::wstring& path);
    static std::wstring Sha256File(const std::wstring& path);
    static std::wstring FromUtf8(const std::string& value);
    static std::string ToUtf8(const std::wstring& value);
    static bool IsHello(const std::string& line);
    static bool BuildSafeEnvironment(std::vector<wchar_t>* block);

    static bool ReadLine(const std::shared_ptr<SharedState>& state,
                         HANDLE handle, std::string* line, size_t maximum);
    static bool WriteAll(const std::shared_ptr<SharedState>& state,
                         HANDLE handle, const std::string& bytes);
    static bool RegisterReaderThread(const std::shared_ptr<SharedState>& state);
    static void UnregisterReaderThread(const std::shared_ptr<SharedState>& state);
    static bool CancelReaderThread(const std::shared_ptr<SharedState>& state);
    static void ReaderMain(std::shared_ptr<SharedState> state);
    static void StopProcessUnlocked(const std::shared_ptr<SharedState>& state);
    static void StopAfterReaderUnlocked(const std::shared_ptr<SharedState>& state);

    std::recursive_mutex lifecycleLock_;
    mutable std::mutex ownerLock_;
    std::shared_ptr<SharedState> state_;
    std::thread readerThread_;
    std::atomic<bool> terminalShutdown_{false};
};

} // namespace fullmag::installer
