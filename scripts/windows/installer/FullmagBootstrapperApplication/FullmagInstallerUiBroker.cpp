#include "FullmagInstallerUiBroker.h"

#include <windows.h>
#include <wincrypt.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cwctype>
#include <iterator>
#include <limits>
#include <string>
#include <utility>

namespace {

constexpr DWORD kReaderCancelWaitMs = 2000;
constexpr DWORD kSendWriteWaitMs = 2000;
constexpr size_t kHashBufferBytes = 64 * 1024;

bool IsPathSeparator(wchar_t value) {
    return value == L'\\' || value == L'/';
}

bool IsDriveAbsolutePath(const std::wstring& value) {
    return value.size() >= 3 &&
           ((value[0] >= L'A' && value[0] <= L'Z') ||
            (value[0] >= L'a' && value[0] <= L'z')) &&
           value[1] == L':' && IsPathSeparator(value[2]);
}

std::wstring FullPath(const std::wstring& value) {
    if (!IsDriveAbsolutePath(value)) return {};
    DWORD required = GetFullPathNameW(value.c_str(), 0, nullptr, nullptr);
    if (required == 0) return {};
    std::vector<wchar_t> buffer(static_cast<size_t>(required) + 1, L'\0');
    const DWORD written = GetFullPathNameW(value.c_str(), required, buffer.data(), nullptr);
    if (written == 0 || written >= buffer.size()) return {};
    return std::wstring(buffer.data(), written);
}

bool IsReparseOrMissing(const std::wstring& path) {
    const DWORD attributes = GetFileAttributesW(path.c_str());
    return attributes == INVALID_FILE_ATTRIBUTES ||
           (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
}

HANDLE OpenRegularPayload(const std::wstring& path) {
    HANDLE handle = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                                OPEN_EXISTING,
                                FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT |
                                    FILE_FLAG_SEQUENTIAL_SCAN,
                                nullptr);
    if (handle == INVALID_HANDLE_VALUE) return nullptr;
    BY_HANDLE_FILE_INFORMATION information{};
    if (!GetFileInformationByHandle(handle, &information) ||
        (information.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0) {
        CloseHandle(handle);
        return nullptr;
    }
    return handle;
}

std::wstring Sha256Handle(HANDLE file) {
    if (!file || file == INVALID_HANDLE_VALUE) return {};
    LARGE_INTEGER origin{};
    if (!SetFilePointerEx(file, origin, nullptr, FILE_BEGIN)) return {};

    HCRYPTPROV provider = 0;
    HCRYPTHASH hash = 0;
    bool success = CryptAcquireContextW(&provider, nullptr, nullptr, PROV_RSA_AES,
                                        CRYPT_VERIFYCONTEXT) != FALSE;
    if (success) success = CryptCreateHash(provider, CALG_SHA_256, 0, 0, &hash) != FALSE;
    std::array<BYTE, kHashBufferBytes> buffer{};
    while (success) {
        DWORD read = 0;
        if (!ReadFile(file, buffer.data(), static_cast<DWORD>(buffer.size()), &read, nullptr)) {
            success = false;
            break;
        }
        if (read == 0) break;
        success = CryptHashData(hash, buffer.data(), read, 0) != FALSE;
    }

    std::wstring result;
    if (success) {
        DWORD digestBytes = 0;
        success = CryptGetHashParam(hash, HP_HASHVAL, nullptr, &digestBytes, 0) != FALSE;
        std::vector<BYTE> digest(digestBytes);
        if (success) {
            success = CryptGetHashParam(hash, HP_HASHVAL, digest.data(), &digestBytes, 0) != FALSE;
        }
        if (success) {
            static constexpr wchar_t digits[] = L"0123456789abcdef";
            result.reserve(static_cast<size_t>(digestBytes) * 2);
            for (DWORD index = 0; index < digestBytes; ++index) {
                result.push_back(digits[(digest[index] >> 4) & 0x0f]);
                result.push_back(digits[digest[index] & 0x0f]);
            }
        }
    }
    if (hash) CryptDestroyHash(hash);
    if (provider) CryptReleaseContext(provider, 0);
    return result;
}

bool IsSecretEnvironmentName(const std::wstring& name) {
    const std::wstring upper = [&]() {
        std::wstring value = name;
        std::transform(value.begin(), value.end(), value.begin(),
                       [](wchar_t character) { return static_cast<wchar_t>(std::towupper(character)); });
        return value;
    }();
    return upper.find(L"SECRET") != std::wstring::npos ||
           upper.find(L"PASSWORD") != std::wstring::npos ||
           upper.find(L"TOKEN") != std::wstring::npos ||
           upper.find(L"APIKEY") != std::wstring::npos ||
           upper.find(L"ACCESS_KEY") != std::wstring::npos ||
           upper == L"KEY";
}

bool IsAllowedEnvironmentName(const std::wstring& name) {
    static constexpr const wchar_t* allowed[] = {
        L"ALLUSERSPROFILE", L"APPDATA", L"COMMONPROGRAMFILES", L"COMMONPROGRAMFILES(X86)",
        L"COMSPEC", L"DOTNET_ROOT", L"DOTNET_ROOT_X64", L"DOTNET_MULTILEVEL_LOOKUP",
        L"HOMEDRIVE", L"HOMEPATH", L"LOCALAPPDATA", L"NUMBER_OF_PROCESSORS", L"OS",
        L"PATH", L"PATHEXT", L"PROCESSOR_ARCHITECTURE", L"PROCESSOR_IDENTIFIER",
        L"PROCESSOR_LEVEL", L"PROCESSOR_REVISION", L"PROGRAMDATA", L"PROGRAMFILES",
        L"PROGRAMFILES(X86)", L"PROGRAMW6432", L"PUBLIC", L"SYSTEMDRIVE", L"SYSTEMROOT",
        L"TEMP", L"TMP", L"USERPROFILE", L"WINDIR",
    };
    return std::any_of(std::begin(allowed), std::end(allowed), [&](const wchar_t* candidate) {
        return _wcsicmp(name.c_str(), candidate) == 0;
    });
}

bool ParseJsonString(const std::string& text, size_t* position, std::string* value) {
    if (!position || !value || *position >= text.size() || text[*position] != '"') return false;
    ++(*position);
    value->clear();
    while (*position < text.size()) {
        const char character = text[(*position)++];
        if (character == '"') return true;
        if (character == '\\') {
            if (*position >= text.size()) return false;
            const char escaped = text[(*position)++];
            switch (escaped) {
            case '"': case '\\': case '/': value->push_back(escaped); break;
            case 'b': value->push_back('\b'); break;
            case 'f': value->push_back('\f'); break;
            case 'n': value->push_back('\n'); break;
            case 'r': value->push_back('\r'); break;
            case 't': value->push_back('\t'); break;
            case 'u':
                if (*position + 4 > text.size()) return false;
                for (size_t index = 0; index < 4; ++index) {
                    const char hex = text[*position + index];
                    if (!((hex >= '0' && hex <= '9') || (hex >= 'a' && hex <= 'f') ||
                          (hex >= 'A' && hex <= 'F'))) return false;
                }
                // Protocol handshake fields are ASCII.  Preserve escaped values
                // as a mismatch rather than attempting partial Unicode decoding.
                *position += 4;
                value->push_back('?');
                break;
            default: return false;
            }
        } else {
            if (static_cast<unsigned char>(character) < 0x20) return false;
            value->push_back(character);
        }
    }
    return false;
}

void SkipJsonWhitespace(const std::string& text, size_t* position) {
    while (position && *position < text.size()) {
        const unsigned char character = static_cast<unsigned char>(text[*position]);
        if (character != ' ' && character != '\t' && character != '\r' && character != '\n') break;
        ++(*position);
    }
}

bool JsonStringFieldEquals(const std::string& text, const char* field, const char* expected) {
    if (!field || !expected) return false;
    size_t position = 0;
    while (position < text.size()) {
        if (text[position] != '"') {
            ++position;
            continue;
        }
        const size_t candidateStart = position;
        std::string key;
        if (!ParseJsonString(text, &position, &key)) {
            position = candidateStart + 1;
            continue;
        }
        SkipJsonWhitespace(text, &position);
        if (position >= text.size() || text[position] != ':') continue;
        ++position;
        SkipJsonWhitespace(text, &position);
        std::string value;
        if (!ParseJsonString(text, &position, &value)) return false;
        if (key == field && value == expected) return true;
    }
    return false;
}

bool IsSingleJsonObject(const std::wstring& value) {
    if (value.empty() || value.find_first_of(L"\r\n") != std::wstring::npos ||
        value.find(L'\0') != std::wstring::npos) return false;
    size_t first = 0;
    while (first < value.size() && std::iswspace(value[first])) ++first;
    size_t last = value.size();
    while (last > first && std::iswspace(value[last - 1])) --last;
    return last > first + 1 && value[first] == L'{' && value[last - 1] == L'}';
}

std::wstring ParentDirectory(const std::wstring& path) {
    const size_t separator = path.find_last_of(L"\\/");
    if (separator == std::wstring::npos) return L".";
    if (separator == 2 && path.size() >= 3 && path[1] == L':') return path.substr(0, 3);
    return path.substr(0, separator);
}

} // namespace

namespace fullmag::installer {

FullmagInstallerUiBroker::SharedState::~SharedState() {
    // A detached reader owns a shared state instance until ReaderMain has
    // returned.  It is therefore safe to close the remaining transport
    // handles here, after the reader can no longer touch them.  Close the job
    // first so a late child cannot outlive the state that owns its handles.
    if (job) CloseHandle(job);
    if (process) CloseHandle(process);
    if (stdinPipe) CloseHandle(stdinPipe);
    if (stdoutPipe) CloseHandle(stdoutPipe);
    if (readerThreadHandle) CloseHandle(readerThreadHandle);
    if (ioDoneEvent) CloseHandle(ioDoneEvent);
}

FullmagInstallerUiBroker::FullmagInstallerUiBroker()
    : state_(std::make_shared<SharedState>()) {
    state_->ioDoneEvent = CreateEventW(nullptr, TRUE, TRUE, nullptr);
}

FullmagInstallerUiBroker::~FullmagInstallerUiBroker() {
    Shutdown();
}

void FullmagInstallerUiBroker::CloseIf(HANDLE handle) {
    if (handle && handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
}

bool FullmagInstallerUiBroker::IsSha256(const std::wstring& value) {
    if (value.size() != 64) return false;
    return std::all_of(value.begin(), value.end(), [](wchar_t character) {
        return (character >= L'0' && character <= L'9') ||
               (character >= L'a' && character <= L'f') ||
               (character >= L'A' && character <= L'F');
    });
}

bool FullmagInstallerUiBroker::IsLocalRegularFile(const std::wstring& path) {
    const std::wstring full = FullPath(path);
    if (full.empty() || full.rfind(L"\\\\", 0) == 0 || !IsDriveAbsolutePath(full)) return false;
    for (size_t position = 3; position < full.size(); ++position) {
        if (!IsPathSeparator(full[position])) continue;
        const std::wstring parent = full.substr(0, position);
        if (IsReparseOrMissing(parent)) return false;
    }
    const DWORD attributes = GetFileAttributesW(full.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES ||
        (attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0) {
        return false;
    }
    HANDLE file = OpenRegularPayload(full);
    if (!file) return false;
    CloseIf(file);
    return true;
}

std::wstring FullmagInstallerUiBroker::Sha256File(const std::wstring& path) {
    HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_DELETE, nullptr,
                              OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
    if (file == INVALID_HANDLE_VALUE) return {};
    const std::wstring result = Sha256Handle(file);
    CloseIf(file);
    return result;
}

std::wstring FullmagInstallerUiBroker::FromUtf8(const std::string& value) {
    if (value.empty()) return {};
    if (value.size() > static_cast<size_t>(std::numeric_limits<int>::max())) return {};
    const int characters = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                                               static_cast<int>(value.size()), nullptr, 0);
    if (characters <= 0) return {};
    std::wstring result(static_cast<size_t>(characters), L'\0');
    if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                            static_cast<int>(value.size()), result.data(), characters) <= 0) {
        return {};
    }
    return result;
}

std::string FullmagInstallerUiBroker::ToUtf8(const std::wstring& value) {
    if (value.empty() || value.size() > static_cast<size_t>(std::numeric_limits<int>::max())) return {};
    const int bytes = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                                         static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    if (bytes <= 0) return {};
    std::string result(static_cast<size_t>(bytes), '\0');
    if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()),
                            result.data(), bytes, nullptr, nullptr) <= 0) {
        return {};
    }
    return result;
}

bool FullmagInstallerUiBroker::IsHello(const std::string& line) {
    size_t first = 0;
    while (first < line.size() && (line[first] == ' ' || line[first] == '\t' ||
                                   line[first] == '\r' || line[first] == '\n')) ++first;
    size_t last = line.size();
    while (last > first && (line[last - 1] == ' ' || line[last - 1] == '\t' ||
                            line[last - 1] == '\r' || line[last - 1] == '\n')) --last;
    if (last <= first + 1 || line[first] != '{' || line[last - 1] != '}') return false;

    // Handshake fields must be direct members of the top-level object.  A
    // substring scan would accept an attacker-controlled nested object such as
    // {"payload":{"type":"hello",...}}.
    size_t position = first + 1;
    std::array<std::string, 4> values{};
    std::array<bool, 4> seen{};
    const std::array<const char*, 4> names = {"schema", "type", "version", "arch"};
    SkipJsonWhitespace(line, &position);
    while (position < last - 1) {
        std::string key;
        if (!ParseJsonString(line, &position, &key)) return false;
        SkipJsonWhitespace(line, &position);
        if (position >= last - 1 || line[position++] != ':') return false;
        SkipJsonWhitespace(line, &position);
        std::string value;
        if (!ParseJsonString(line, &position, &value)) return false;
        size_t index = names.size();
        for (size_t candidate = 0; candidate < names.size(); ++candidate) {
            if (key == names[candidate]) {
                index = candidate;
                break;
            }
        }
        if (index == names.size()) return false;
        if (seen[index]) return false;
        seen[index] = true;
        values[index] = std::move(value);
        SkipJsonWhitespace(line, &position);
        if (position < last - 1 && line[position] == ',') {
            ++position;
            SkipJsonWhitespace(line, &position);
            continue;
        }
        break;
    }
    SkipJsonWhitespace(line, &position);
    if (position != last - 1 || !std::all_of(seen.begin(), seen.end(), [](bool value) { return value; })) {
        return false;
    }
    return values[0] == "fullmag.windows-installer-ui.v1" && values[1] == "hello" &&
           values[2] == "1.0.0" && values[3] == "x64";
}

bool FullmagInstallerUiBroker::BuildSafeEnvironment(std::vector<wchar_t>* block) {
    if (!block) return false;
    block->clear();
    LPWCH environment = GetEnvironmentStringsW();
    if (!environment) return false;

    std::vector<std::wstring> entries;
    for (const wchar_t* cursor = environment; *cursor != L'\0';) {
        const std::wstring entry(cursor);
        cursor += entry.size() + 1;
        const size_t separator = entry.find(L'=');
        if (separator == std::wstring::npos || separator == 0) continue;
        const std::wstring name = entry.substr(0, separator);
        if (!IsAllowedEnvironmentName(name) || IsSecretEnvironmentName(name)) continue;
        const bool duplicate = std::any_of(entries.begin(), entries.end(), [&](const std::wstring& prior) {
            return _wcsnicmp(prior.c_str(), name.c_str(), name.size()) == 0 &&
                   prior.size() > name.size() && prior[name.size()] == L'=';
        });
        if (!duplicate) entries.push_back(entry);
    }
    FreeEnvironmentStringsW(environment);

    std::sort(entries.begin(), entries.end(), [](const std::wstring& left, const std::wstring& right) {
        return _wcsicmp(left.c_str(), right.c_str()) < 0;
    });
    for (const std::wstring& entry : entries) {
        block->insert(block->end(), entry.begin(), entry.end());
        block->push_back(L'\0');
    }
    // CreateProcessW expects a double-NUL terminated environment block even
    // when every ambient variable was rejected by the allow-list.
    if (entries.empty()) block->push_back(L'\0');
    block->push_back(L'\0');
    return true;
}

bool FullmagInstallerUiBroker::ReadLine(const std::shared_ptr<SharedState>& state,
                                        HANDLE handle, std::string* line, size_t maximum) {
    if (!state || !handle || !line) return false;
    line->clear();
    while (line->size() <= maximum) {
        if (state->stopRequested.load()) return false;
        char character = '\0';
        DWORD read = 0;
        if (!ReadFile(handle, &character, 1, &read, nullptr) || read == 0) return false;
        if (character == '\n') return true;
        if (character == '\r') continue;
        if (character == '\0') return false;
        line->push_back(character);
    }
    return false;
}

bool FullmagInstallerUiBroker::WriteAll(const std::shared_ptr<SharedState>& state,
                                        HANDLE handle, const std::string& bytes) {
    if (!state || !handle || bytes.empty()) return false;
    size_t offset = 0;
    while (offset < bytes.size()) {
        if (state->stopRequested.load()) return false;
        const DWORD count = static_cast<DWORD>(std::min<size_t>(
            bytes.size() - offset, static_cast<size_t>(std::numeric_limits<DWORD>::max())));
        DWORD written = 0;
        if (!WriteFile(handle, bytes.data() + offset, count, &written, nullptr) || written == 0) {
            return false;
        }
        offset += written;
    }
    return true;
}

bool FullmagInstallerUiBroker::RegisterReaderThread(
    const std::shared_ptr<SharedState>& state) {
    if (!state || state->stopRequested.load() || !state->ioDoneEvent) return false;
    HANDLE duplicate = nullptr;
    if (!DuplicateHandle(GetCurrentProcess(), GetCurrentThread(), GetCurrentProcess(), &duplicate,
                         0, FALSE, DUPLICATE_SAME_ACCESS)) {
        return false;
    }
    std::lock_guard<std::mutex> guard(state->readerLock);
    if (state->stopRequested.load() || !ResetEvent(state->ioDoneEvent)) {
        CloseIf(duplicate);
        return false;
    }
    CloseIf(state->readerThreadHandle);
    state->readerThreadHandle = duplicate;
    return true;
}

void FullmagInstallerUiBroker::UnregisterReaderThread(
    const std::shared_ptr<SharedState>& state) {
    if (!state) return;
    std::lock_guard<std::mutex> guard(state->readerLock);
    CloseIf(state->readerThreadHandle);
    state->readerThreadHandle = nullptr;
    if (state->ioDoneEvent) SetEvent(state->ioDoneEvent);
}

bool FullmagInstallerUiBroker::CancelReaderThread(
    const std::shared_ptr<SharedState>& state) {
    if (!state) return true;
    HANDLE duplicate = nullptr;
    {
        std::lock_guard<std::mutex> guard(state->readerLock);
        if (!state->readerThreadHandle) return true;
        if (!DuplicateHandle(GetCurrentProcess(), state->readerThreadHandle, GetCurrentProcess(), &duplicate,
                             0, FALSE, DUPLICATE_SAME_ACCESS)) {
            duplicate = nullptr;
        }
    }

    if (duplicate) {
        const BOOL canceled = CancelSynchronousIo(duplicate);
        const DWORD error = canceled ? ERROR_SUCCESS : GetLastError();
        if (!canceled && error != ERROR_NOT_FOUND) {
            // The reader owns the original thread handle.  CancelSynchronousIo
            // is preferred; CancelIoEx is the bounded fallback for pipe reads
            // and is issued while the state lock protects the pipe handle.
            std::lock_guard<std::mutex> guard(state->stateLock);
            if (state->stdoutPipe) CancelIoEx(state->stdoutPipe, nullptr);
        }
    }

    auto terminateChildAndCancelRead = [&state]() {
        std::lock_guard<std::mutex> guard(state->stateLock);
        if (state->stdoutPipe) CancelIoEx(state->stdoutPipe, nullptr);
        if (state->job) {
            TerminateJobObject(state->job, 1);
        } else if (state->process) {
            TerminateProcess(state->process, 1);
        }
    };

    DWORD wait = state->ioDoneEvent ?
        WaitForSingleObject(state->ioDoneEvent, kReaderCancelWaitMs) : WAIT_FAILED;
    if (wait == WAIT_TIMEOUT || wait == WAIT_FAILED) {
        // A synchronous pipe read can outlive CancelSynchronousIo when the
        // child is wedged.  Kill the owned child and perform one bounded
        // second wait before Stop takes the safe shared-state detach path.
        terminateChildAndCancelRead();
        wait = state->ioDoneEvent ?
            WaitForSingleObject(state->ioDoneEvent, kReaderCancelWaitMs) : WAIT_FAILED;
    }
    CloseIf(duplicate);
    return wait == WAIT_OBJECT_0;
}

void FullmagInstallerUiBroker::ReaderMain(std::shared_ptr<SharedState> state) {
    const bool registered = RegisterReaderThread(state);
    if (registered) {
        std::string line;
        const bool readHello = ReadLine(state, state->stdoutPipe, &line, kMaxFrameBytes);
        const bool validHello = readHello && IsHello(line);
        {
            std::lock_guard<std::mutex> guard(state->stateLock);
            state->helloReceived = true;
            state->helloValid = validHello;
            if (!validHello && state->firstError.empty()) {
                state->firstError = L"The installer UI sent an invalid protocol handshake.";
            }
            if (!validHello || state->stopRequested.load()) state->running = false;
            state->helloCondition.notify_all();
        }

        if (validHello && !state->stopRequested.load()) {
            MessageHandler handler;
            {
                std::lock_guard<std::mutex> guard(state->stateLock);
                handler = state->onMessage;
            }
            if (handler) {
                try {
                    handler(FromUtf8(line));
                } catch (...) {
                    state->stopRequested.store(true);
                    std::lock_guard<std::mutex> guard(state->stateLock);
                    if (state->firstError.empty()) {
                        state->firstError = L"The installer UI message handler failed.";
                    }
                }
            }
        }

        while (validHello && !state->stopRequested.load()) {
            line.clear();
            if (!ReadLine(state, state->stdoutPipe, &line, kMaxFrameBytes)) break;
            const std::wstring message = FromUtf8(line);
            if (message.empty()) {
                std::lock_guard<std::mutex> guard(state->stateLock);
                if (state->firstError.empty()) {
                    state->firstError = L"The installer UI returned invalid UTF-8.";
                }
                break;
            }
            MessageHandler handler;
            {
                std::lock_guard<std::mutex> guard(state->stateLock);
                handler = state->onMessage;
            }
            if (!handler) continue;
            try {
                handler(message);
            } catch (...) {
                state->stopRequested.store(true);
                std::lock_guard<std::mutex> guard(state->stateLock);
                if (state->firstError.empty()) {
                    state->firstError = L"The installer UI message handler failed.";
                }
                break;
            }
        }
    }

    ClosedHandler closed;
    bool notifyClosed = false;
    {
        std::lock_guard<std::mutex> guard(state->stateLock);
        if (!registered && state->firstError.empty()) {
            state->firstError = L"The installer UI reader could not start.";
        }
        notifyClosed = registered && state->helloValid && !state->stopRequested.load();
        if (notifyClosed) closed = state->onClosed;
        state->readerDone = true;
        state->running = false;
        state->helloCondition.notify_all();
    }
    if (notifyClosed && closed) {
        try {
            closed();
        } catch (...) {
            std::lock_guard<std::mutex> guard(state->stateLock);
            if (state->firstError.empty()) {
                state->firstError = L"The installer UI close handler failed.";
            }
        }
    }
    // Signal the cancellation waiter only after the terminal callback has
    // returned; otherwise Stop() could observe a completed pipe read and then
    // block unboundedly in join() while user code is still running.
    UnregisterReaderThread(state);
}

void FullmagInstallerUiBroker::StopProcessUnlocked(
    const std::shared_ptr<SharedState>& state) {
    if (!state) return;
    CloseIf(state->job);
    state->job = nullptr;
    if (!state->process) return;
    const DWORD wait = WaitForSingleObject(state->process, 250);
    if (wait == WAIT_TIMEOUT) {
        TerminateProcess(state->process, 1);
        WaitForSingleObject(state->process, 1000);
    }
    CloseIf(state->process);
    state->process = nullptr;
}

void FullmagInstallerUiBroker::StopAfterReaderUnlocked(
    const std::shared_ptr<SharedState>& state) {
    if (!state) return;
    CloseIf(state->stdinPipe);
    state->stdinPipe = nullptr;
    CloseIf(state->stdoutPipe);
    state->stdoutPipe = nullptr;
}

bool FullmagInstallerUiBroker::Start(const std::wstring& executablePath,
                                     const std::wstring& expectedSha256,
                                     const std::wstring& initJson,
                                     MessageHandler onMessage,
                                     std::wstring* publicError,
                                     ClosedHandler onClosed) {
    std::lock_guard<std::recursive_mutex> lifecycleGuard(lifecycleLock_);
    if (publicError) publicError->clear();
    if (!IsSha256(expectedSha256)) {
        if (publicError) *publicError = L"The installer UI payload hash is invalid.";
        return false;
    }
    if (!IsLocalRegularFile(executablePath)) {
        if (publicError) *publicError = L"The installer UI payload is not a local regular file.";
        return false;
    }
    if (!IsSingleJsonObject(initJson)) {
        if (publicError) *publicError = L"The installer UI initialization message is invalid.";
        return false;
    }
    if (terminalShutdown_.load()) {
        if (publicError) *publicError = L"The installer UI broker is shutting down.";
        return false;
    }
    std::shared_ptr<SharedState> state;
    {
        std::lock_guard<std::mutex> ownerGuard(ownerLock_);
        state = state_;
    }
    if (!state) {
        if (publicError) *publicError = L"The installer UI broker has no transport state.";
        return false;
    }
    {
        bool active = false;
        {
            std::lock_guard<std::mutex> guard(state->stateLock);
            active = state->process != nullptr || readerThread_.joinable();
        }
        if (active) Stop();
        {
            std::lock_guard<std::mutex> ownerGuard(ownerLock_);
            state = state_;
        }
    }
    if (!state) {
        if (publicError) *publicError = L"The installer UI broker has no transport state.";
        return false;
    }
    {
        std::lock_guard<std::mutex> guard(state->stateLock);
        if (terminalShutdown_.load()) {
            if (publicError) *publicError = L"The installer UI broker is shutting down.";
            return false;
        }
        state->stopRequested.store(false);
        state->firstError.clear();
        state->helloReceived = false;
        state->helloValid = false;
        state->readerDone = false;
        state->running = false;
        state->onMessage = std::move(onMessage);
        state->onClosed = std::move(onClosed);
    }

    HANDLE payloadGuard = OpenRegularPayload(executablePath);
    if (!payloadGuard) {
        if (publicError) *publicError = L"The installer UI payload could not be opened.";
        return false;
    }
    const std::wstring actualHash = Sha256Handle(payloadGuard);
    if (actualHash.empty() || _wcsicmp(actualHash.c_str(), expectedSha256.c_str()) != 0) {
        CloseIf(payloadGuard);
        if (publicError) *publicError = L"The installer UI payload hash does not match its receipt.";
        return false;
    }
    DWORD binaryType = 0;
    if (!GetBinaryTypeW(executablePath.c_str(), &binaryType) || binaryType != SCS_64BIT_BINARY) {
        CloseIf(payloadGuard);
        if (publicError) *publicError = L"The installer UI payload is not an x64 executable.";
        return false;
    }

    SECURITY_ATTRIBUTES inheritable{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    HANDLE stdinRead = nullptr;
    HANDLE stdinWrite = nullptr;
    HANDLE stdoutRead = nullptr;
    HANDLE stdoutWrite = nullptr;
    HANDLE stderrHandle = nullptr;
    if (!CreatePipe(&stdinRead, &stdinWrite, &inheritable, 0) ||
        !CreatePipe(&stdoutRead, &stdoutWrite, &inheritable, 0) ||
        !SetHandleInformation(stdinWrite, HANDLE_FLAG_INHERIT, 0) ||
        !SetHandleInformation(stdoutRead, HANDLE_FLAG_INHERIT, 0)) {
        CloseIf(stdinRead); CloseIf(stdinWrite); CloseIf(stdoutRead); CloseIf(stdoutWrite);
        CloseIf(payloadGuard);
        if (publicError) *publicError = L"The installer UI protocol pipes could not be created.";
        return false;
    }
    stderrHandle = CreateFileW(L"NUL", GENERIC_WRITE,
                               FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                               &inheritable, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (stderrHandle == INVALID_HANDLE_VALUE) stderrHandle = nullptr;
    if (!stderrHandle) {
        CloseIf(stdinRead); CloseIf(stdinWrite); CloseIf(stdoutRead); CloseIf(stdoutWrite);
        CloseIf(payloadGuard);
        if (publicError) *publicError = L"The installer UI error pipe could not be created.";
        return false;
    }

    std::vector<wchar_t> environment;
    if (!BuildSafeEnvironment(&environment)) {
        CloseIf(stdinRead); CloseIf(stdinWrite); CloseIf(stdoutRead); CloseIf(stdoutWrite);
        CloseIf(stderrHandle); CloseIf(payloadGuard);
        if (publicError) *publicError = L"The installer UI environment could not be prepared.";
        return false;
    }

    HANDLE job = CreateJobObjectW(nullptr, nullptr);
    if (!job) {
        CloseIf(stdinRead); CloseIf(stdinWrite); CloseIf(stdoutRead); CloseIf(stdoutWrite);
        CloseIf(stderrHandle); CloseIf(payloadGuard);
        if (publicError) *publicError = L"The installer UI process job could not be created.";
        return false;
    }
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION jobLimits{};
    jobLimits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &jobLimits,
                                 sizeof(jobLimits))) {
        CloseIf(job);
        CloseIf(stdinRead); CloseIf(stdinWrite); CloseIf(stdoutRead); CloseIf(stdoutWrite);
        CloseIf(stderrHandle); CloseIf(payloadGuard);
        if (publicError) *publicError = L"The installer UI process job could not be configured.";
        return false;
    }

    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = stdinRead;
    startup.StartupInfo.hStdOutput = stdoutWrite;
    startup.StartupInfo.hStdError = stderrHandle;
    SIZE_T attributeBytes = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &attributeBytes);
    if (attributeBytes == 0) {
        CloseIf(job);
        CloseIf(stdinRead); CloseIf(stdinWrite); CloseIf(stdoutRead); CloseIf(stdoutWrite);
        CloseIf(stderrHandle); CloseIf(payloadGuard);
        if (publicError) *publicError = L"The installer UI handle allow-list could not be prepared.";
        return false;
    }
    std::vector<BYTE> attributeStorage(attributeBytes);
    startup.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributeStorage.data());
    if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &attributeBytes)) {
        CloseIf(job);
        CloseIf(stdinRead); CloseIf(stdinWrite); CloseIf(stdoutRead); CloseIf(stdoutWrite);
        CloseIf(stderrHandle); CloseIf(payloadGuard);
        if (publicError) *publicError = L"The installer UI handle allow-list could not be initialized.";
        return false;
    }
    HANDLE inheritedHandles[] = {stdinRead, stdoutWrite, stderrHandle};
    const bool allowListReady = UpdateProcThreadAttribute(
        startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inheritedHandles,
        sizeof(inheritedHandles), nullptr, nullptr) != FALSE;
    if (!allowListReady) {
        DeleteProcThreadAttributeList(startup.lpAttributeList);
        CloseIf(job);
        CloseIf(stdinRead); CloseIf(stdinWrite); CloseIf(stdoutRead); CloseIf(stdoutWrite);
        CloseIf(stderrHandle); CloseIf(payloadGuard);
        if (publicError) *publicError = L"The installer UI handle allow-list could not be configured.";
        return false;
    }

    const std::wstring commandLine = L"" + std::wstring(L"\"") + executablePath +
        L"\" --bridge-stdio --protocol \"" + kProtocolSchema + L"\"";
    std::vector<wchar_t> mutableCommand(commandLine.begin(), commandLine.end());
    mutableCommand.push_back(L'\0');
    const std::wstring currentDirectory = ParentDirectory(executablePath);
    PROCESS_INFORMATION processInfo{};
    const BOOL created = CreateProcessW(
        executablePath.c_str(), mutableCommand.data(), nullptr, nullptr, TRUE,
        CREATE_NO_WINDOW | CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT |
            CREATE_UNICODE_ENVIRONMENT,
        environment.data(), currentDirectory.c_str(), &startup.StartupInfo, &processInfo);
    DeleteProcThreadAttributeList(startup.lpAttributeList);
    CloseIf(payloadGuard);
    CloseIf(stdinRead);
    CloseIf(stdoutWrite);
    CloseIf(stderrHandle);
    if (!created) {
        CloseIf(job);
        CloseIf(stdinWrite); CloseIf(stdoutRead);
        if (publicError) *publicError = L"The installer UI process could not be started.";
        return false;
    }

    bool published = false;
    bool processOwned = false;
    {
        std::lock_guard<std::mutex> guard(state->stateLock);
        if (!terminalShutdown_.load() && !state->stopRequested.load() &&
            AssignProcessToJobObject(job, processInfo.hProcess) != FALSE) {
            state->process = processInfo.hProcess;
            processInfo.hProcess = nullptr;
            state->job = job;
            job = nullptr;
            state->stdinPipe = stdinWrite;
            stdinWrite = nullptr;
            state->stdoutPipe = stdoutRead;
            stdoutRead = nullptr;
            processOwned = true;
            state->running = true;
            try {
                readerThread_ = std::thread(&FullmagInstallerUiBroker::ReaderMain, state);
                if (ResumeThread(processInfo.hThread) != DWORD(-1)) {
                    published = true;
                } else {
                    state->stopRequested.store(true);
                }
            } catch (...) {
                state->stopRequested.store(true);
                if (state->firstError.empty()) {
                    state->firstError = L"The installer UI reader could not start.";
                }
            }
        }
    }
    CloseIf(processInfo.hThread);
    if (!published) {
        if (processOwned) {
            Stop();
        } else {
            TerminateProcess(processInfo.hProcess, 1);
            WaitForSingleObject(processInfo.hProcess, 1000);
        }
        CloseIf(processInfo.hProcess);
        CloseIf(job);
        CloseIf(stdinWrite);
        CloseIf(stdoutRead);
        if (publicError) *publicError = L"The installer UI process could not be attached to its job.";
        return false;
    }
    CloseIf(processInfo.hProcess);
    CloseIf(job);
    CloseIf(stdinWrite);
    CloseIf(stdoutRead);

    std::wstring startupError;
    {
        std::unique_lock<std::mutex> guard(state->stateLock);
        const bool signaled = state->helloCondition.wait_for(guard, std::chrono::seconds(10), [&state]() {
            return state->helloReceived || state->readerDone || state->stopRequested.load();
        });
        if (!signaled || !state->helloReceived || !state->helloValid) {
            startupError = state->firstError.empty() ? L"The installer UI did not complete its handshake."
                                                     : state->firstError;
        }
    }
    if (!startupError.empty()) {
        Stop();
        if (publicError) *publicError = startupError;
        return false;
    }

    if (!Send(initJson, &startupError)) {
        Stop();
        if (publicError) *publicError = startupError.empty() ?
            L"The installer UI rejected initialization." : startupError;
        return false;
    }
    return true;
}

bool FullmagInstallerUiBroker::Send(const std::wstring& json, std::wstring* publicError) {
    if (publicError) publicError->clear();
    if (!IsSingleJsonObject(json)) {
        if (publicError) *publicError = L"The installer UI message is not one JSON object.";
        return false;
    }
    const std::string bytes = ToUtf8(json);
    if (bytes.empty() || bytes.size() + 1 > kMaxFrameBytes) {
        if (publicError) *publicError = L"The installer UI message is too large.";
        return false;
    }
    std::shared_ptr<SharedState> state;
    {
        std::lock_guard<std::mutex> ownerGuard(ownerLock_);
        state = state_;
    }
    if (!state) {
        if (publicError) *publicError = L"The installer UI broker has no transport state.";
        return false;
    }
    std::lock_guard<std::mutex> ioGuard(state->sendLock);
    HANDLE input = nullptr;
    HANDLE processGuard = nullptr;
    {
        std::lock_guard<std::mutex> guard(state->stateLock);
        if (!state->process || !state->stdinPipe || !state->running || !state->helloValid ||
            state->stopRequested.load()) {
            if (publicError) *publicError = L"The installer UI session is not running.";
            return false;
        }
        input = state->stdinPipe;
        if (!DuplicateHandle(GetCurrentProcess(), state->process, GetCurrentProcess(), &processGuard,
                             0, FALSE, DUPLICATE_SAME_ACCESS)) {
            processGuard = nullptr;
        }
    }
    if (!processGuard) {
        if (publicError) *publicError = L"The installer UI write timeout could not be armed.";
        return false;
    }

    HANDLE writerThread = nullptr;
    if (!DuplicateHandle(GetCurrentProcess(), GetCurrentThread(), GetCurrentProcess(), &writerThread,
                         0, FALSE, DUPLICATE_SAME_ACCESS)) {
        CloseIf(processGuard);
        if (publicError) *publicError = L"The installer UI write timeout could not be armed.";
        return false;
    }
    HANDLE doneEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!doneEvent) {
        CloseIf(writerThread);
        CloseIf(processGuard);
        if (publicError) *publicError = L"The installer UI write timeout could not be armed.";
        return false;
    }
    std::string frame = bytes;
    frame.push_back('\n');

    std::thread watchdog;
    try {
        watchdog = std::thread([doneEvent, writerThread, input, processGuard]() {
            const DWORD wait = WaitForSingleObject(doneEvent, kSendWriteWaitMs);
            if (wait == WAIT_TIMEOUT || wait == WAIT_FAILED) {
                // The writer is a synchronous pipe operation.  Cancel it first,
                // then terminate the owned child so a full input pipe cannot
                // leave the BA thread blocked indefinitely.
                CancelSynchronousIo(writerThread);
                CancelIoEx(input, nullptr);
                TerminateProcess(processGuard, 1);
            }
            FullmagInstallerUiBroker::CloseIf(writerThread);
            FullmagInstallerUiBroker::CloseIf(processGuard);
        });
    } catch (...) {
        CloseIf(doneEvent);
        CloseIf(writerThread);
        TerminateProcess(processGuard, 1);
        CloseIf(processGuard);
        if (publicError) *publicError = L"The installer UI write timeout could not be armed.";
        return false;
    }

    const bool written = WriteAll(state, input, frame);
    SetEvent(doneEvent);
    watchdog.join();
    CloseIf(doneEvent);
    if (!written) {
        if (publicError) *publicError = L"The installer UI session rejected the message.";
        return false;
    }
    return true;
}

void FullmagInstallerUiBroker::Stop() {
    std::lock_guard<std::recursive_mutex> lifecycleGuard(lifecycleLock_);
    std::shared_ptr<SharedState> state;
    {
        std::lock_guard<std::mutex> ownerGuard(ownerLock_);
        state = state_;
    }
    if (!state) return;
    state->stopRequested.store(true);
    const bool readerStopped = CancelReaderThread(state);
    {
        std::lock_guard<std::mutex> guard(state->stateLock);
        state->running = false;
        StopProcessUnlocked(state);
    }

    // Kill the child before waiting for an in-flight sender.  The pipe write
    // then fails and the sender releases state->sendLock without racing handle close.
    {
        std::lock_guard<std::mutex> ioGuard(state->sendLock);
        std::lock_guard<std::mutex> guard(state->stateLock);
        if (readerStopped) {
            StopAfterReaderUnlocked(state);
        } else {
            // A detached reader owns this shared state until its final
            // callback returns.  Clear callbacks before handing it off so an
            // explicit stop cannot marshal into a BA that is being destroyed.
            state->onMessage = {};
            state->onClosed = {};
        }
    }

    const bool currentReader = readerThread_.joinable() &&
        readerThread_.get_id() == std::this_thread::get_id();
    if (readerThread_.joinable()) {
        if (currentReader || !readerStopped) {
            // ReaderMain captures only SharedState, never this.  If the hard
            // cancellation deadline was exceeded, detach that self-owned
            // worker rather than blocking the BA indefinitely or leaving a
            // dangling this pointer.  The state destructor closes handles
            // after ReaderMain releases its shared owner.
            readerThread_.detach();
            auto replacement = std::make_shared<SharedState>();
            replacement->ioDoneEvent = CreateEventW(nullptr, TRUE, TRUE, nullptr);
            std::lock_guard<std::mutex> ownerGuard(ownerLock_);
            state_ = std::move(replacement);
        } else {
            readerThread_.join();
        }
    }
    if (readerStopped) {
        std::lock_guard<std::mutex> guard(state->stateLock);
        StopAfterReaderUnlocked(state);
    }
}

void FullmagInstallerUiBroker::Shutdown() {
    std::lock_guard<std::recursive_mutex> lifecycleGuard(lifecycleLock_);
    terminalShutdown_.store(true);
    Stop();
}

bool FullmagInstallerUiBroker::Running() const {
    std::shared_ptr<SharedState> state;
    {
        std::lock_guard<std::mutex> ownerGuard(ownerLock_);
        state = state_;
    }
    if (!state) return false;
    std::lock_guard<std::mutex> guard(state->stateLock);
    return state->running && state->process != nullptr && !state->stopRequested.load();
}

} // namespace fullmag::installer
