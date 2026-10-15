#include "FullmagBootstrapperApplication.h"
#include "FullmagInstallerUiBroker.h"

#include <aclapi.h>
#include <shlobj.h>
#include <shellapi.h>
#include <wincrypt.h>
#include <winreg.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <climits>
#include <chrono>
#include <cwctype>
#include <fstream>
#include <iterator>
#include <limits>
#include <map>
#include <new>
#include <set>
#include <sstream>

#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "comctl32.lib")
#pragma comment(lib, "crypt32.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "version.lib")

namespace {

constexpr wchar_t kWindowClass[] = L"FullmagBootstrapperApplicationWindow";
constexpr wchar_t kFieldPanelClass[] = L"FullmagBootstrapperApplicationFieldPanel";
constexpr int kFieldRowHeight = 30;
constexpr int kFieldPanelSourceTop = 460;
constexpr int kFieldPanelRuntimeTop = 400;
constexpr UINT kUiReady = WM_APP + 1;
constexpr UINT kUiStatus = WM_APP + 2;
constexpr UINT kUiProgress = WM_APP + 3;
constexpr UINT kUiCommand = WM_APP + 4;
constexpr UINT kUiClose = WM_APP + 5;
constexpr UINT kUiReply = WM_APP + 6;
constexpr UINT kUiCancel = WM_APP + 7;
constexpr UINT kUiApplyComplete = WM_APP + 8;
constexpr UINT kUiBrokerMessage = WM_APP + 9;
constexpr UINT kUiPlanComplete = WM_APP + 10;
constexpr size_t kMaxSourceAdmissionBytes = 64 * 1024;
constexpr size_t kMaxHelperRequestBytes = 2 * 1024 * 1024;

enum : WORD {
    kBrowse = 1101,
    kDiscover = 1102,
    kPreview = 1103,
    kCommit = 1104,
    kDependencyCheck = 1105,
    kDependencyInstall = 1106,
    kInstall = 1107,
    kLaunch = 1108,
};

enum : int {
    kStatus = 1201,
    kProgress = 1202,
    kLicense = 1203,
    kLicenseAccepted = 1204,
    kCheckout = 1205,
    kSummary = 1206,
    kLaneCombo = 1207,
    kStorageRoot = 1208,
    kFieldBase = 1300,
};

std::wstring Lower(std::wstring value) {
    std::transform(value.begin(), value.end(), value.begin(),
                   [](wchar_t character) { return static_cast<wchar_t>(std::towlower(character)); });
    return value;
}

bool EqualsInsensitive(const std::wstring& left, const std::wstring& right) {
    return _wcsicmp(left.c_str(), right.c_str()) == 0;
}

std::wstring SafeHelperBlockerMessage(const std::wstring& blocker) {
    if (blocker == L"admitted_git_path_reparse") {
        return L"The selected Git executable uses a symbolic link, junction, or reparse point.";
    }
    if (blocker == L"admitted_python_path_reparse") {
        return L"The selected Python executable uses a symbolic link, junction, or reparse point.";
    }
    if (blocker == L"checkout_input_reparse") {
        return L"A selected checkout input uses a symbolic link, junction, or reparse point.";
    }
    return {};
}

std::wstring RuntimeProfileForLane(const std::wstring& lane) {
    if (EqualsInsensitive(lane, L"all")) return L"windows-native-fem-gpu";
    if (EqualsInsensitive(lane, L"native")) return L"windows-native-fdm-cpu";
    if (EqualsInsensitive(lane, L"fem-cpu")) return L"windows-native-fem-cpu";
    if (EqualsInsensitive(lane, L"fem-gpu")) return L"windows-native-fem-gpu";
    return {};
}

std::wstring SetupProfileForLane(const std::wstring& lane) {
    if (EqualsInsensitive(lane, L"all")) return L"windows-native-fem-gpu";
    if (EqualsInsensitive(lane, L"native")) return L"windows-setup";
    return RuntimeProfileForLane(lane);
}

bool IsHresultSuccess(HRESULT status) {
    return SUCCEEDED(status);
}

std::wstring HresultText(HRESULT status) {
    wchar_t buffer[32]{};
    swprintf_s(buffer, L"0x%08lX", static_cast<unsigned long>(status));
    return buffer;
}

std::wstring JsonEscape(const std::wstring& value) {
    std::wstring result;
    result.reserve(value.size() + 16);
    for (wchar_t character : value) {
        switch (character) {
        case L'\\': result += L"\\\\"; break;
        case L'"': result += L"\\\""; break;
        case L'\r': result += L"\\r"; break;
        case L'\n': result += L"\\n"; break;
        case L'\t': result += L"\\t"; break;
        case L'\b': result += L"\\b"; break;
        case L'\f': result += L"\\f"; break;
        default:
            if (character < 0x20) {
                wchar_t escaped[7]{};
                swprintf_s(escaped, L"\\u%04x", static_cast<unsigned int>(character));
                result += escaped;
            } else {
                result += character;
            }
        }
    }
    return result;
}

std::string Utf8(const std::wstring& value) {
    if (value.empty()) return {};
    const int bytes = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                                         static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    if (bytes <= 0) return {};
    std::string result(static_cast<size_t>(bytes), '\0');
    WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                        static_cast<int>(value.size()), result.data(), bytes, nullptr, nullptr);
    return result;
}

std::wstring Wide(const std::string& value) {
    if (value.empty()) return {};
    const int characters = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                                               static_cast<int>(value.size()), nullptr, 0);
    if (characters <= 0) return {};
    std::wstring result(static_cast<size_t>(characters), L'\0');
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                        static_cast<int>(value.size()), result.data(), characters);
    return result;
}

std::wstring JsonString(const std::wstring& value) {
    return L"\"" + JsonEscape(value) + L"\"";
}

std::wstring JsonBool(bool value) { return value ? L"true" : L"false"; }

std::wstring JoinPath(const std::wstring& parent, const std::wstring& child) {
    if (parent.empty()) return child;
    if (parent.back() == L'\\' || parent.back() == L'/') return parent + child;
    return parent + L"\\" + child;
}

std::wstring QuoteWindowsArgument(const std::wstring& value) {
    std::wstring result = L"\"";
    size_t backslashes = 0;
    for (const wchar_t character : value) {
        if (character == L'\\') {
            ++backslashes;
            continue;
        }
        if (character == L'\"') {
            result.append(backslashes * 2 + 1, L'\\');
            result.push_back(L'\"');
            backslashes = 0;
            continue;
        }
        result.append(backslashes, L'\\');
        backslashes = 0;
        result.push_back(character);
    }
    result.append(backslashes * 2, L'\\');
    result.push_back(L'\"');
    return result;
}

std::wstring GetWindowTextValue(HWND window) {
    if (!window) return {};
    const int length = GetWindowTextLengthW(window);
    std::wstring result(static_cast<size_t>(std::max(length, 0) + 1), L'\0');
    if (length > 0) {
        GetWindowTextW(window, result.data(), length + 1);
        result.resize(static_cast<size_t>(length));
    } else {
        result.clear();
    }
    return result;
}

bool HasReparsePoint(const std::wstring& path) {
    const DWORD attributes = GetFileAttributesW(path.c_str());
    return attributes != INVALID_FILE_ATTRIBUTES &&
           (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
}

bool IsHexString(const std::wstring& value, size_t expectedLength) {
    if (value.size() != expectedLength) return false;
    return std::all_of(value.begin(), value.end(), [](wchar_t character) {
        return (character >= L'0' && character <= L'9') ||
               (character >= L'a' && character <= L'f') ||
               (character >= L'A' && character <= L'F');
    });
}

bool IsSha256(const std::wstring& value) { return IsHexString(value, 64); }

bool IsGitCommit(const std::wstring& value) { return IsHexString(value, 40); }

bool IsPathInside(const std::wstring& path, const std::wstring& root) {
    if (path.empty() || root.empty()) return false;
    std::wstring candidate = path;
    std::wstring base = root;
    while (candidate.size() > 3 && (candidate.back() == L'\\' || candidate.back() == L'/')) {
        candidate.pop_back();
    }
    while (base.size() > 3 && (base.back() == L'\\' || base.back() == L'/')) {
        base.pop_back();
    }
    if (candidate.size() <= base.size() || _wcsnicmp(candidate.c_str(), base.c_str(), base.size()) != 0) {
        return false;
    }
    if (base.size() == 3 && base[1] == L':' && (base[2] == L'\\' || base[2] == L'/')) {
        return true;
    }
    return candidate[base.size()] == L'\\' || candidate[base.size()] == L'/';
}

bool ProtectPrivateFile(const std::wstring& path) {
    HANDLE token = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
    DWORD tokenBytes = 0;
    GetTokenInformation(token, TokenUser, nullptr, 0, &tokenBytes);
    if (tokenBytes == 0) {
        CloseHandle(token);
        return false;
    }
    std::vector<BYTE> tokenBuffer(tokenBytes);
    const bool userRead = GetTokenInformation(token, TokenUser, tokenBuffer.data(), tokenBytes,
                                               &tokenBytes) != FALSE;
    CloseHandle(token);
    if (!userRead) return false;

    BYTE systemSid[SECURITY_MAX_SID_SIZE]{};
    DWORD systemSidBytes = sizeof(systemSid);
    if (!CreateWellKnownSid(WinLocalSystemSid, nullptr, systemSid, &systemSidBytes)) return false;
    BYTE administratorsSid[SECURITY_MAX_SID_SIZE]{};
    DWORD administratorsSidBytes = sizeof(administratorsSid);
    if (!CreateWellKnownSid(WinBuiltinAdministratorsSid, nullptr, administratorsSid,
                            &administratorsSidBytes)) return false;

    PSID sids[] = {
        reinterpret_cast<TOKEN_USER*>(tokenBuffer.data())->User.Sid,
        systemSid,
        administratorsSid,
    };
    EXPLICIT_ACCESSW entries[ARRAYSIZE(sids)]{};
    for (size_t index = 0; index < ARRAYSIZE(sids); ++index) {
        entries[index].grfAccessPermissions = FILE_ALL_ACCESS;
        entries[index].grfAccessMode = SET_ACCESS;
        entries[index].grfInheritance = NO_INHERITANCE;
        entries[index].Trustee.TrusteeForm = TRUSTEE_IS_SID;
        entries[index].Trustee.TrusteeType = TRUSTEE_IS_USER;
        entries[index].Trustee.ptstrName = reinterpret_cast<LPWSTR>(sids[index]);
    }
    PACL acl = nullptr;
    const DWORD aclStatus = SetEntriesInAclW(static_cast<ULONG>(ARRAYSIZE(entries)), entries,
                                             nullptr, &acl);
    if (aclStatus != ERROR_SUCCESS) return false;
    std::wstring mutablePath = path;
    const DWORD securityStatus = SetNamedSecurityInfoW(
        mutablePath.data(), SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
        nullptr, nullptr, acl, nullptr);
    LocalFree(acl);
    return securityStatus == ERROR_SUCCESS;
}

std::wstring Base64Utf16(const std::wstring& command) {
    const auto* bytes = reinterpret_cast<const BYTE*>(command.data());
    const DWORD count = static_cast<DWORD>(command.size() * sizeof(wchar_t));
    DWORD outputLength = 0;
    if (!CryptBinaryToStringW(bytes, count, CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF,
                              nullptr, &outputLength)) {
        return {};
    }
    std::wstring result(outputLength, L'\0');
    if (!CryptBinaryToStringW(bytes, count, CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF,
                              result.data(), &outputLength)) {
        return {};
    }
    if (!result.empty() && result.back() == L'\0') result.pop_back();
    return result;
}

class JsonReader {
public:
    enum class Kind { Null, Bool, Number, String, Object, Array };

    struct Value {
        Kind kind = Kind::Null;
        bool boolean = false;
        std::wstring string;
        std::wstring number;
        std::map<std::wstring, Value> object;
        std::vector<Value> array;

        const Value* Get(const wchar_t* key) const {
            if (kind != Kind::Object) return nullptr;
            const auto found = object.find(key);
            return found == object.end() ? nullptr : &found->second;
        }
        std::wstring String(const wchar_t* key, const std::wstring& fallback = {}) const {
            const Value* value = Get(key);
            return value && value->kind == Kind::String ? value->string : fallback;
        }
        bool Bool(const wchar_t* key, bool fallback = false) const {
            const Value* value = Get(key);
            return value && value->kind == Kind::Bool ? value->boolean : fallback;
        }
    };

    explicit JsonReader(const std::wstring& text) : text_(text) {}

    bool Parse(Value* result) {
        if (!result) return false;
        SkipWhitespace();
        if (!ParseValue(result)) return false;
        SkipWhitespace();
        return position_ == text_.size();
    }

private:
    void SkipWhitespace() {
        while (position_ < text_.size() && std::iswspace(text_[position_])) ++position_;
    }

    bool Consume(wchar_t expected) {
        SkipWhitespace();
        if (position_ >= text_.size() || text_[position_] != expected) return false;
        ++position_;
        return true;
    }

    bool ParseValue(Value* result) {
        SkipWhitespace();
        if (position_ >= text_.size()) return false;
        const wchar_t character = text_[position_];
        if (character == L'"') {
            result->kind = Kind::String;
            return ParseString(&result->string);
        }
        if (character == L'{') return ParseObject(result);
        if (character == L'[') return ParseArray(result);
        if (text_.compare(position_, 4, L"true") == 0) {
            position_ += 4;
            result->kind = Kind::Bool;
            result->boolean = true;
            return true;
        }
        if (text_.compare(position_, 5, L"false") == 0) {
            position_ += 5;
            result->kind = Kind::Bool;
            result->boolean = false;
            return true;
        }
        if (text_.compare(position_, 4, L"null") == 0) {
            position_ += 4;
            result->kind = Kind::Null;
            return true;
        }
        const size_t start = position_;
        while (position_ < text_.size() &&
               wcschr(L"-+0123456789.eE", text_[position_]) != nullptr) ++position_;
        if (position_ == start) return false;
        result->kind = Kind::Number;
        result->number = text_.substr(start, position_ - start);
        return true;
    }

    bool ParseString(std::wstring* result) {
        if (!Consume(L'"')) return false;
        result->clear();
        while (position_ < text_.size()) {
            const wchar_t character = text_[position_++];
            if (character == L'"') return true;
            if (character != L'\\') {
                result->push_back(character);
                continue;
            }
            if (position_ >= text_.size()) return false;
            const wchar_t escaped = text_[position_++];
            switch (escaped) {
            case L'"': result->push_back(L'"'); break;
            case L'\\': result->push_back(L'\\'); break;
            case L'/': result->push_back(L'/'); break;
            case L'b': result->push_back(L'\b'); break;
            case L'f': result->push_back(L'\f'); break;
            case L'n': result->push_back(L'\n'); break;
            case L'r': result->push_back(L'\r'); break;
            case L't': result->push_back(L'\t'); break;
            case L'u': {
                if (position_ + 4 > text_.size()) return false;
                unsigned int code = 0;
                for (size_t index = 0; index < 4; ++index) {
                    const wchar_t digit = text_[position_++];
                    code *= 16;
                    if (digit >= L'0' && digit <= L'9') code += digit - L'0';
                    else if (digit >= L'a' && digit <= L'f') code += digit - L'a' + 10;
                    else if (digit >= L'A' && digit <= L'F') code += digit - L'A' + 10;
                    else return false;
                }
                result->push_back(static_cast<wchar_t>(code));
                break;
            }
            default: return false;
            }
        }
        return false;
    }

    bool ParseObject(Value* result) {
        if (!Consume(L'{')) return false;
        result->kind = Kind::Object;
        result->object.clear();
        SkipWhitespace();
        if (position_ < text_.size() && text_[position_] == L'}') {
            ++position_;
            return true;
        }
        while (position_ < text_.size()) {
            std::wstring key;
            if (!ParseString(&key) || !Consume(L':')) return false;
            Value value;
            if (!ParseValue(&value)) return false;
            result->object.emplace(std::move(key), std::move(value));
            SkipWhitespace();
            if (position_ < text_.size() && text_[position_] == L'}') {
                ++position_;
                return true;
            }
            if (!Consume(L',')) return false;
        }
        return false;
    }

    bool ParseArray(Value* result) {
        if (!Consume(L'[')) return false;
        result->kind = Kind::Array;
        result->array.clear();
        SkipWhitespace();
        if (position_ < text_.size() && text_[position_] == L']') {
            ++position_;
            return true;
        }
        while (position_ < text_.size()) {
            Value value;
            if (!ParseValue(&value)) return false;
            result->array.push_back(std::move(value));
            SkipWhitespace();
            if (position_ < text_.size() && text_[position_] == L']') {
                ++position_;
                return true;
            }
            if (!Consume(L',')) return false;
        }
        return false;
    }

    const std::wstring& text_;
    size_t position_ = 0;
};

} // namespace

namespace fullmag::installer {

struct HelperReply {
    std::wstring response;
    std::wstring error;
    std::function<void(const std::wstring&, const std::wstring&)> completion;
};

struct UiApplyCompleteMessage {
    HRESULT status = E_FAIL;
};

struct UiPlanCompleteMessage {
    HRESULT status = E_FAIL;
};

class HelperClient {
public:
    HelperClient() : io_done_event_(CreateEventW(nullptr, TRUE, TRUE, nullptr)) {}
    ~HelperClient() {
        Shutdown();
        // The owner normally joins its transport worker after Stop().  Keep
        // the event alive if a worker ignored cancellation so it cannot call
        // SetEvent on a closed handle while the object is being torn down.
        if (io_done_event_ &&
            WaitForSingleObject(io_done_event_, 2000) == WAIT_OBJECT_0) {
            CloseIf(io_done_event_);
            io_done_event_ = nullptr;
        }
    }

    // Startup includes the private payload write and readiness read.  The
    // caller must invoke it on the transport worker, never on the UI thread.
    bool Start(const std::wstring& powershellPath, std::wstring* publicError) {
        if (powershellPath.empty()) {
            if (publicError) *publicError = L"PowerShell is unavailable.";
            return false;
        }

        std::lock_guard<std::mutex> ioGuard(io_lock_);
        {
            std::lock_guard<std::mutex> guard(lock_);
            if (terminal_shutdown_.load()) {
                if (publicError) *publicError = L"The helper client is shutting down.";
                return false;
            }
            if (process_ != nullptr && ready_ && !stop_requested_.load()) return true;
            if (process_ != nullptr) StopUnlocked();
            stop_requested_.store(false);
        }

        SECURITY_ATTRIBUTES inheritable{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
        HANDLE stdinRead = nullptr;
        HANDLE stdinWrite = nullptr;
        HANDLE stdoutRead = nullptr;
        HANDLE stdoutWrite = nullptr;
        if (!CreatePipe(&stdinRead, &stdinWrite, &inheritable, 0) ||
            !CreatePipe(&stdoutRead, &stdoutWrite, &inheritable, 0)) {
            CloseIf(stdinRead); CloseIf(stdinWrite); CloseIf(stdoutRead); CloseIf(stdoutWrite);
            if (publicError) *publicError = L"Could not create the helper protocol pipes.";
            return false;
        }
        if (!SetHandleInformation(stdinWrite, HANDLE_FLAG_INHERIT, 0) ||
            !SetHandleInformation(stdoutRead, HANDLE_FLAG_INHERIT, 0)) {
            CloseIf(stdinRead); CloseIf(stdinWrite); CloseIf(stdoutRead); CloseIf(stdoutWrite);
            if (publicError) *publicError = L"Could not restrict the helper protocol pipe handles.";
            return false;
        }

        HANDLE stderrHandle = CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                                          &inheritable, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (stderrHandle == INVALID_HANDLE_VALUE) stderrHandle = nullptr;
        if (!stderrHandle) {
            CloseIf(stdinRead); CloseIf(stdinWrite); CloseIf(stdoutRead); CloseIf(stdoutWrite);
            if (publicError) *publicError = L"Could not create the helper error pipe handle.";
            return false;
        }

        // Keep the command line small.  The full protocol is sent over the
        // private stdin pipe by BootstrapScript(), otherwise CreateProcessW's
        // 32K command-line limit is exceeded by -EncodedCommand.
        const std::wstring bootstrapEncoded = Base64Utf16(BootstrapScript());
        const std::wstring protocolEncoded = Base64Utf16(ProtocolScript());
        if (bootstrapEncoded.empty() || protocolEncoded.empty()) {
            CloseIf(stdinRead); CloseIf(stdinWrite); CloseIf(stdoutRead); CloseIf(stdoutWrite);
            CloseIf(stderrHandle);
            if (publicError) *publicError = L"Could not prepare the helper protocol.";
            return false;
        }
        std::wstring commandLine = L"\"" + powershellPath +
            L"\" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand \"" +
            bootstrapEncoded + L"\"";
        std::vector<wchar_t> mutableCommand(commandLine.begin(), commandLine.end());
        mutableCommand.push_back(L'\0');

        HANDLE job = CreateJobObjectW(nullptr, nullptr);
        if (!job) {
            CloseIf(stdinRead); CloseIf(stdinWrite); CloseIf(stdoutRead); CloseIf(stdoutWrite);
            CloseIf(stderrHandle);
            if (publicError) *publicError = L"Could not create the helper process job.";
            return false;
        }
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION jobLimits{};
        jobLimits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &jobLimits,
                                     sizeof(jobLimits))) {
            CloseIf(job);
            CloseIf(stdinRead); CloseIf(stdinWrite); CloseIf(stdoutRead); CloseIf(stdoutWrite);
            CloseIf(stderrHandle);
            if (publicError) *publicError = L"Could not configure the helper process job.";
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
            CloseIf(stderrHandle);
            if (publicError) *publicError = L"Could not prepare the helper handle allow-list.";
            return false;
        }
        std::vector<BYTE> attributeStorage(attributeBytes);
        startup.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(
            attributeStorage.data());
        if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &attributeBytes)) {
            CloseIf(job);
            CloseIf(stdinRead); CloseIf(stdinWrite); CloseIf(stdoutRead); CloseIf(stdoutWrite);
            CloseIf(stderrHandle);
            if (publicError) *publicError = L"Could not initialize the helper handle allow-list.";
            return false;
        }
        HANDLE inheritedHandles[] = {stdinRead, stdoutWrite, stderrHandle};
        if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0,
                                       PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inheritedHandles,
                                       sizeof(inheritedHandles), nullptr, nullptr)) {
            DeleteProcThreadAttributeList(startup.lpAttributeList);
            CloseIf(job);
            CloseIf(stdinRead); CloseIf(stdinWrite); CloseIf(stdoutRead); CloseIf(stdoutWrite);
            CloseIf(stderrHandle);
            if (publicError) *publicError = L"Could not configure the helper handle allow-list.";
            return false;
        }
        PROCESS_INFORMATION processInfo{};
        if (!CreateProcessW(powershellPath.c_str(), mutableCommand.data(), nullptr, nullptr, TRUE,
                            CREATE_NO_WINDOW | CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT,
                            nullptr, nullptr, &startup.StartupInfo, &processInfo)) {
            DeleteProcThreadAttributeList(startup.lpAttributeList);
            CloseIf(job);
            CloseIf(stdinRead); CloseIf(stdinWrite); CloseIf(stdoutRead); CloseIf(stdoutWrite);
            CloseIf(stderrHandle);
            if (publicError) *publicError = L"Could not start the helper process.";
            return false;
        }
        DeleteProcThreadAttributeList(startup.lpAttributeList);
        bool resumed = false;
        {
            // Publish the process/job and pipe ownership before resuming the
            // suspended child.  Stop() takes the same lock after setting the
            // cancellation flag, so it cannot miss a just-started process.
            std::lock_guard<std::mutex> guard(lock_);
            if (!terminal_shutdown_.load() && !stop_requested_.load() &&
                AssignProcessToJobObject(job, processInfo.hProcess) != FALSE) {
                process_ = processInfo.hProcess;
                job_ = job;
                stdin_ = stdinWrite;
                stdout_ = stdoutRead;
                ready_ = false;
                resumed = ResumeThread(processInfo.hThread) != DWORD(-1);
                if (!resumed) {
                    process_ = nullptr;
                    job_ = nullptr;
                    stdin_ = nullptr;
                    stdout_ = nullptr;
                }
            }
        }
        if (!resumed) {
            TerminateProcess(processInfo.hProcess, 1);
            WaitForSingleObject(processInfo.hProcess, 1000);
            CloseHandle(processInfo.hThread);
            CloseHandle(processInfo.hProcess);
            CloseIf(job);
            CloseIf(stdinRead); CloseIf(stdinWrite); CloseIf(stdoutRead); CloseIf(stdoutWrite);
            CloseIf(stderrHandle);
            if (publicError) *publicError = L"Could not attach the helper process to its job.";
            return false;
        }
        CloseHandle(processInfo.hThread);
        CloseHandle(stdinRead);
        CloseHandle(stdoutWrite);
        CloseIf(stderrHandle);

        if (!RegisterCurrentIoThread()) {
            Stop();
            if (publicError) *publicError = L"The helper session was canceled before startup.";
            return false;
        }
        HANDLE input = nullptr;
        HANDLE output = nullptr;
        {
            std::lock_guard<std::mutex> guard(lock_);
            input = stdin_;
            output = stdout_;
        }
        const std::string payload = Utf8(protocolEncoded) + "\n";
        std::string readyLine;
        const bool started = input && output && WriteAll(input, payload) &&
            ReadLine(output, &readyLine, 4096) &&
            readyLine == ReadyLine();
        UnregisterCurrentIoThread();
        if (!started) {
            Stop();
            if (publicError) *publicError = L"The helper session did not become ready.";
            return false;
        }
        if (stop_requested_.load()) {
            Stop();
            if (publicError) *publicError = L"The helper session was canceled during startup.";
            return false;
        }
        {
            std::lock_guard<std::mutex> guard(lock_);
            if (!process_ || !stdin_ || !stdout_) {
                if (publicError) *publicError = L"The helper session ended during startup.";
                return false;
            }
            ready_ = true;
        }
        return true;
    }

    bool Send(const std::wstring& request, std::wstring* response, std::wstring* publicError) {
        std::lock_guard<std::mutex> ioGuard(io_lock_);
        HANDLE input = nullptr;
        HANDLE output = nullptr;
        {
            std::lock_guard<std::mutex> guard(lock_);
            if (!process_ || !stdin_ || !stdout_ || !ready_) {
                if (publicError) *publicError = L"The helper session is not running.";
                return false;
            }
            input = stdin_;
            output = stdout_;
        }
        const std::string bytes = Utf8(request + L"\n");
        if (bytes.empty() || bytes.size() > kMaxHelperRequestBytes) {
            if (publicError) *publicError = L"The helper request is too large.";
            return false;
        }
        if (!RegisterCurrentIoThread()) {
            if (publicError) *publicError = L"The helper session was canceled.";
            return false;
        }
        if (stop_requested_.load()) {
            UnregisterCurrentIoThread();
            if (publicError) *publicError = L"The helper session was canceled.";
            return false;
        }
        if (!input || !output || !WriteAll(input, bytes)) {
            UnregisterCurrentIoThread();
            if (publicError) *publicError = L"The helper session rejected the request.";
            Stop();
            return false;
        }
        std::string line;
        if (!ReadLine(output, &line, 2 * 1024 * 1024)) {
            UnregisterCurrentIoThread();
            if (publicError) *publicError = L"The helper session ended without a response.";
            Stop();
            return false;
        }
        UnregisterCurrentIoThread();
        if (response) *response = Wide(line);
        if (!response || response->empty()) {
            if (publicError) *publicError = L"The helper returned an empty response.";
            Stop();
            return false;
        }
        return true;
    }

    // Terminal shutdown is separate from a restartable transport stop.  The
    // BA must call this from teardown so a racing Start() cannot clear the
    // stop flag and create a new helper session.
    void Shutdown() {
        {
            std::lock_guard<std::mutex> guard(lock_);
            terminal_shutdown_.store(true);
            stop_requested_.store(true);
        }
        Stop();
    }

    void Stop() {
        stop_requested_.store(true);
        const bool ioStopped = CancelCurrentIoThread();
        if (ioStopped) {
            std::lock_guard<std::mutex> guard(lock_);
            StopUnlocked();
            return;
        }

        // Cancellation is bounded.  If the worker still owns a synchronous
        // pipe operation, terminate only this helper job but leave the pipe
        // handles open until the worker's UnregisterCurrentIoThread() has
        // signaled completion.  Closing them here would race ReadFile or
        // WriteFile in the worker and can turn a stop into a use-after-close.
        {
            std::lock_guard<std::mutex> guard(lock_);
            ready_ = false;
            StopProcessUnlocked();
        }
        if (io_done_event_ &&
            WaitForSingleObject(io_done_event_, 2000) == WAIT_OBJECT_0) {
            std::lock_guard<std::mutex> guard(lock_);
            if (!HasCurrentIoThread()) {
                CloseIf(stdin_); stdin_ = nullptr;
                CloseIf(stdout_); stdout_ = nullptr;
            }
        }
    }

private:
    static void CloseIf(HANDLE handle) {
        if (handle && handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
    }

    bool RegisterCurrentIoThread() {
        if (stop_requested_.load() || !io_done_event_) return false;
        HANDLE duplicate = nullptr;
        if (!DuplicateHandle(GetCurrentProcess(), GetCurrentThread(), GetCurrentProcess(),
                             &duplicate, 0, FALSE, DUPLICATE_SAME_ACCESS)) {
            return false;
        }
        {
            std::lock_guard<std::mutex> guard(io_thread_lock_);
            if (stop_requested_.load()) {
                CloseIf(duplicate);
                return false;
            }
            if (!ResetEvent(io_done_event_)) {
                CloseIf(duplicate);
                return false;
            }
            CloseIf(io_thread_);
            io_thread_ = duplicate;
        }
        if (stop_requested_.load()) {
            CancelSynchronousIo(duplicate);
            UnregisterCurrentIoThread();
            return false;
        }
        return true;
    }

    void UnregisterCurrentIoThread() {
        bool ioThreadCleared = false;
        {
            std::lock_guard<std::mutex> guard(io_thread_lock_);
            CloseIf(io_thread_);
            io_thread_ = nullptr;
            ioThreadCleared = true;
            if (io_done_event_) SetEvent(io_done_event_);
        }
        if (stop_requested_.load() && ioThreadCleared) {
            std::lock_guard<std::mutex> guard(lock_);
            CloseIf(stdin_); stdin_ = nullptr;
            CloseIf(stdout_); stdout_ = nullptr;
        }
    }

    bool HasCurrentIoThread() {
        std::lock_guard<std::mutex> guard(io_thread_lock_);
        return io_thread_ != nullptr;
    }

    bool CancelCurrentIoThread() {
        HANDLE duplicate = nullptr;
        bool hadIoThread = false;
        {
            std::lock_guard<std::mutex> guard(io_thread_lock_);
            hadIoThread = io_thread_ != nullptr;
            if (hadIoThread &&
                !DuplicateHandle(GetCurrentProcess(), io_thread_, GetCurrentProcess(), &duplicate,
                                 0, FALSE, DUPLICATE_SAME_ACCESS)) {
                return false;
            }
        }
        if (!hadIoThread) return true;
        if (!duplicate) return false;

        // Stop may run while WriteFile/ReadFile is synchronously blocked in
        // the transport worker. Closing a duplicate handle alone does not
        // cancel that I/O; CancelSynchronousIo targets the owner.
        const BOOL canceled = CancelSynchronousIo(duplicate);
        const DWORD cancelError = canceled ? ERROR_SUCCESS : GetLastError();
        if (!canceled && cancelError != ERROR_NOT_FOUND) {
            // CancelIoEx returns synchronously. Hold the state lock while
            // issuing it so UnregisterCurrentIoThread cannot close either
            // pipe between handle lookup and cancellation.
            std::lock_guard<std::mutex> guard(lock_);
            if (stdin_) CancelIoEx(stdin_, nullptr);
            if (stdout_) CancelIoEx(stdout_, nullptr);
        }
        const DWORD wait = io_done_event_ ?
            WaitForSingleObject(io_done_event_, 2000) : WAIT_FAILED;
        CloseIf(duplicate);
        return wait == WAIT_OBJECT_0;
    }

    bool WriteAll(HANDLE handle, const std::string& bytes) const {
        if (!handle || bytes.empty()) return false;
        size_t offset = 0;
        while (offset < bytes.size()) {
            if (stop_requested_.load()) return false;
            const DWORD remaining = static_cast<DWORD>(std::min<size_t>(
                bytes.size() - offset, static_cast<size_t>(std::numeric_limits<DWORD>::max())));
            DWORD written = 0;
            if (!WriteFile(handle, bytes.data() + offset, remaining, &written, nullptr) ||
                written == 0) {
                return false;
            }
            offset += written;
        }
        return true;
    }

    bool ReadLine(HANDLE handle, std::string* line, size_t maximum) const {
        if (!handle || !line) return false;
        line->clear();
        while (line->size() <= maximum) {
            if (stop_requested_.load()) return false;
            char character = 0;
            DWORD read = 0;
            if (!ReadFile(handle, &character, 1, &read, nullptr) || read == 0) return false;
            if (character == '\n') return true;
            if (character != '\r') line->push_back(character);
        }
        return false;
    }

    void StopUnlocked() {
        ready_ = false;
        StopProcessUnlocked();
        CloseIf(stdin_); stdin_ = nullptr;
        CloseIf(stdout_); stdout_ = nullptr;
    }

    void StopProcessUnlocked() {
        // Closing the owned job terminates the PowerShell helper and any
        // setup descendants without enumerating or touching unrelated PIDs.
        CloseIf(job_); job_ = nullptr;
        if (process_) {
            DWORD result = WaitForSingleObject(process_, 250);
            if (result == WAIT_TIMEOUT) {
                TerminateProcess(process_, 1);
                WaitForSingleObject(process_, 1000);
            }
            CloseHandle(process_);
            process_ = nullptr;
        }
    }

    static std::string ReadyLine() {
        return "fullmag.windows-installer-helper-ready.v1";
    }

    static std::wstring BootstrapScript() {
        return LR"PS($stream = [Console]::OpenStandardInput()
$payload = New-Object 'System.Collections.Generic.List[byte]'
while ($true) {
  $value = $stream.ReadByte()
  if ($value -lt 0) { exit 2 }
  if ($value -eq 10) { break }
  if ($value -gt 127 -or $payload.Count -ge 262144) { exit 2 }
  [void]$payload.Add([byte]$value)
}
try {
  $encoded = [System.Text.Encoding]::ASCII.GetString($payload.ToArray())
  $script = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($encoded))
  . ([ScriptBlock]::Create($script))
} catch {
  exit 2
}
)PS";
    }

    static std::wstring ProtocolScript() {
        std::wstring script;
        script.reserve(64 * 1024);
        script += LR"PS(
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$sessions = @{}
$helperLoaded = $false

function Write-Public($Value) {
  $Value | ConvertTo-Json -Depth 12 -Compress
}

function Write-Blocked {
  param(
    [string]$Blocker = 'helper_request_blocked',
    [string]$Message = 'The installer helper rejected the request.'
  )
  Write-Public ([ordered]@{
    schema = 'fullmag.windows-installer-bridge.v1'
    state = 'blocked'
    valid = $false
    can_commit = $false
    errors = @($Message)
    blockers = @($Blocker)
    wrote = $false
  })
}

function Get-PublicSession($Session) {
  $identity = Get-FullmagInstallerEnvPublicIdentity -Session $Session
  [ordered]@{
    schema = 'fullmag.windows-installer-env-session.v1'
    session_id = [string]$Session.session_id
    python_available = -not [string]::IsNullOrWhiteSpace([string]$Session.python_command)
    requested_checkout = [string]$identity.requested_checkout
    main_checkout = [string]$identity.main_checkout
    template_path = [string]$identity.template_path
    manifest_path = [string]$identity.manifest_path
    resolver_script = [string]$identity.resolver_script
    original_hash = [string]$Session.original_hash
    template_hash = [string]$identity.template_hash
    manifest_hash = [string]$identity.manifest_hash
    resolver_hash = [string]$identity.resolver_hash
    git_top = [string]$identity.git_top
    git_head = [string]$identity.git_head
    git_worktrees_hash = [string]$identity.git_worktrees_hash
    requested_git_top = [string]$identity.requested_git_top
    requested_git_head = [string]$identity.requested_git_head
    requested_git_worktrees_hash = [string]$identity.requested_git_worktrees_hash
    original_exists = [bool]$Session.original_exists
    encoding = [string]$Session.encoding
    newline = [string]$Session.newline
    storage_profile = [string]$Session.storage_profile
    allowed_fields = @($Session.allowed_fields | ForEach-Object { [string]$_ })
    secret_fields = @($Session.secret_fields | ForEach-Object { [string]$_ })
    fields = @($Session.fields | ForEach-Object {
      [ordered]@{
        key = [string]$_.key
        secret = [bool]$_.secret
        present = [bool]$_.present
        current_value = [string]$_.current_value
      }
    })
  }
}

function Get-PublicProposal($Proposal, [bool]$Committed, $Session) {
  $errors = @()
  if (-not [bool]$Proposal.valid) { $errors = @('The proposed configuration failed validation.') }
  $public = [ordered]@{
    schema = 'fullmag.windows-installer-env-proposal.v1'
    state = if ($Committed) { [string]$Proposal.state } else { [string]$Proposal.state }
    valid = [bool]$Proposal.valid
    can_commit = [bool]$Proposal.can_commit
    env_path = [string]$Proposal.env_path
    main_checkout = [string]$Proposal.main_checkout
    storage_profile = [string]$Proposal.storage_profile
    storage_root = [string]$Proposal.storage_root
    runs_root = [string]$Proposal.runs_root
    original_hash = [string]$Proposal.original_hash
    proposed_hash = [string]$Proposal.proposed_hash
    changed_fields = @($Proposal.changed_fields | ForEach-Object { [string]$_ })
    redacted_diff = [string]$Proposal.redacted_diff
    errors = $errors
    wrote = [bool]$Proposal.wrote
    session_id = ''
  }
  if ($null -ne $Session) {
    $identity = Get-FullmagInstallerEnvPublicIdentity -Session $Session
    $public['session_id'] = [string]$Session.session_id
    $public['requested_checkout'] = [string]$identity.requested_checkout
    $public['main_checkout'] = [string]$identity.main_checkout
    $public['template_path'] = [string]$identity.template_path
    $public['manifest_path'] = [string]$identity.manifest_path
    $public['resolver_script'] = [string]$identity.resolver_script
    $public['template_hash'] = [string]$identity.template_hash
    $public['manifest_hash'] = [string]$identity.manifest_hash
    $public['resolver_hash'] = [string]$identity.resolver_hash
    $public['git_top'] = [string]$identity.git_top
    $public['git_head'] = [string]$identity.git_head
    $public['git_worktrees_hash'] = [string]$identity.git_worktrees_hash
    $public['requested_git_top'] = [string]$identity.requested_git_top
    $public['requested_git_head'] = [string]$identity.requested_git_head
    $public['requested_git_worktrees_hash'] = [string]$identity.requested_git_worktrees_hash
  }
  return $public
}

[Console]::Out.WriteLine('fullmag.windows-installer-helper-ready.v1')
[Console]::Out.Flush()
)PS";
        script += LR"PS(while (($line = [Console]::In.ReadLine()) -ne $null) {
  try {
    $request = $line | ConvertFrom-Json -ErrorAction Stop
    if ($request.helper_path -and -not $helperLoaded) {
      . ([string]$request.helper_path)
      $helperLoaded = $true
    }
    switch ([string]$request.op) {
      'bootstrap_preadmission' {
        $checkout = [System.IO.Path]::GetFullPath([string]$request.checkout_path).TrimEnd('\', '/')
        if (-not $checkout -or -not (Test-Path -LiteralPath $checkout -PathType Container)) { throw 'preadmission checkout is missing' }
        $setupPath = Assert-FullmagInstallerEnvInside -Path ([string]$request.setup_path) `
          -Root $checkout -Label 'preadmission setup script'
        $manifestPath = Assert-FullmagInstallerEnvInside -Path ([string]$request.manifest_path) `
          -Root $checkout -Label 'preadmission requirements manifest'
        Assert-FullmagInstallerEnvNoReparse -Path $setupPath -Label 'preadmission setup script'
        Assert-FullmagInstallerEnvNoReparse -Path $manifestPath -Label 'preadmission requirements manifest'
        if (-not [string]::Equals([System.IO.Path]::GetFileName($setupPath), 'setup_build_environment.ps1',
            [System.StringComparison]::OrdinalIgnoreCase) -or
            -not [string]::Equals([System.IO.Path]::GetFileName($manifestPath), 'windows_build_requirements.json',
            [System.StringComparison]::OrdinalIgnoreCase) -or
            [string]$request.setup_hash -notmatch '^[0-9a-fA-F]{64}$' -or
            [string]$request.manifest_hash -notmatch '^[0-9a-fA-F]{64}$' -or
            (Get-FileHash -LiteralPath $setupPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne
              ([string]$request.setup_hash).ToLowerInvariant() -or
            (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne
              ([string]$request.manifest_hash).ToLowerInvariant()) {
          throw 'preadmission source inputs changed after bundle verification'
        }
        $lane = [string]$request.lane
        if ($lane -ne 'all') { throw 'installer scope must be all' }
        $storageRoot = ConvertTo-FullmagInstallerEnvFullPath -Path ([string]$request.storage_root) `
          -Label 'preadmission storage root'
        if (Get-Command Get-FullmagInstallerEnvInheritedSecretNames -ErrorAction SilentlyContinue) {
          foreach ($name in @(Get-FullmagInstallerEnvInheritedSecretNames)) {
            Remove-Item -Path ('Env:' + [string]$name) -ErrorAction SilentlyContinue
          }
        }
        $setupPowerShell = Join-Path $PSHOME 'powershell.exe'
        $arguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', $setupPath, '-Install', '-PrerequisitesOnly', '-Lane', $lane,
          '-StorageRoot', $storageRoot, '-ExpectedRequirementsSha256',
          ([string]$request.manifest_hash), '-Json')
        $raw = (& $setupPowerShell @arguments 2>$null | Out-String)
        $exitCode = [int]$LASTEXITCODE
        try { $report = $raw | ConvertFrom-Json -ErrorAction Stop }
        catch { throw 'preadmission prerequisite bootstrap returned invalid JSON' }
        $gitPath = if ($report.tools -and $report.tools.git) { [string]$report.tools.git.path } else { '' }
        $pythonPath = if ($report.tools -and $report.tools.python) { [string]$report.tools.python.path } else { '' }
        $reportState = if ($exitCode -eq 0) { 'complete' } else { 'blocked' }
        $public = [ordered]@{
          schema = 'fullmag.windows-installer-preadmission.v1'
          state = $reportState
          lane = $lane
          readiness = [string]$report.readiness
          storage_root = [string]$report.storage_root
          storage_profile = [string]$report.storage_profile
          source_admitted = $false
          env_write = $false
          project_owned_writes = $false
          storage_resolver = 'not_run'
          tools = [ordered]@{
            git = [ordered]@{ path = $gitPath; version = [string]$report.tools.git.version }
            python = [ordered]@{ path = $pythonPath; version = [string]$report.tools.python.version }
          }
          setup_path = $setupPath
          setup_hash = ([string]$request.setup_hash).ToLowerInvariant()
          manifest_path = $manifestPath
          manifest_hash = ([string]$request.manifest_hash).ToLowerInvariant()
          blockers = @($report.blockers | ForEach-Object { [string]$_ })
        }
        Write-Public $public
      }
)PS";
        script += LR"PS(      'discover' {
        $previousPath = $env:Path
        try {
          if ($request.git_path) {
            $gitPath = [System.IO.Path]::GetFullPath([string]$request.git_path)
            Assert-FullmagInstallerEnvNoReparse -Path $gitPath -Label 'admitted Git executable'
            if (-not (Test-Path -LiteralPath $gitPath -PathType Leaf)) { throw 'admitted Git executable is missing' }
            $env:Path = (Split-Path -Parent $gitPath) + [IO.Path]::PathSeparator + $env:Path
          }
          $pythonPath = [string]$request.python_path
          if ($pythonPath) {
            $pythonPath = [System.IO.Path]::GetFullPath($pythonPath)
            Assert-FullmagInstallerEnvNoReparse -Path $pythonPath -Label 'admitted Python executable'
            if (-not (Test-Path -LiteralPath $pythonPath -PathType Leaf)) { throw 'admitted Python executable is missing' }
          }
          $session = Get-FullmagInstallerEnvSession -CheckoutPath ([string]$request.checkout_path) `
            -PythonCommand $pythonPath
          if ($request.git_path) { $session | Add-Member -NotePropertyName git_command -NotePropertyValue $gitPath -Force }
          $sessions[[string]$session.session_id] = $session
        }
        finally { $env:Path = $previousPath }
        Write-Public (Get-PublicSession $session)
      }
      'bootstrap_prerequisites' {
        $session = $sessions[[string]$request.session_id]
        if ($null -eq $session) { throw 'invalid session' }
        Assert-FullmagInstallerEnvSession -Session $session | Out-Null
        if (-not [string]::Equals([string]$request.checkout_path, [string]$session.requested_checkout,
            [System.StringComparison]::OrdinalIgnoreCase)) {
          throw 'prerequisite checkout does not match the admitted session'
        }
        $lane = [string]$request.lane
        if ($lane -ne 'all') { throw 'installer scope must be all' }
        $scriptPath = Join-Path ([string]$session.requested_checkout) 'scripts\windows\setup_build_environment.ps1'
        $scriptPath = Assert-FullmagInstallerEnvInside -Path $scriptPath `
          -Root ([string]$session.requested_checkout) -Label 'setup script'
        Assert-FullmagInstallerEnvNoReparse -Path $scriptPath -Label 'setup script'
        if (-not [string]::Equals([string]$request.setup_path, $scriptPath,
            [System.StringComparison]::OrdinalIgnoreCase)) { throw 'setup script is not canonical' }
        if (-not $request.setup_hash -or
            (Get-FileHash -LiteralPath $scriptPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne
            ([string]$request.setup_hash).ToLowerInvariant()) {
          throw 'setup script changed after admission'
        }

        $snapshot = Read-FullmagInstallerEnvFile -Path ([string]$session.env_path) -AllowMissing -Label '.env'
        if ([string]$snapshot.hash -ne [string]$session.original_hash) {
          throw 'the .env changed after this editor session was opened'
        }
        $current = Get-FullmagInstallerEnvValues -Text $snapshot.text -AllowedKeys @($session.allowed_fields)
        $changes = Get-FullmagInstallerEnvSessionChanges -Session $session -Values $request.values
        $effective = [ordered]@{}
        foreach ($key in $current.Keys) { $effective[$key] = [string]$current[$key] }
        foreach ($key in $changes.Keys) { $effective[$key] = [string]$changes[$key] }
        $storageValue = if ($effective.Contains('FULLMAG_PROJECT_STORAGE_ROOT')) {
          [string]$effective['FULLMAG_PROJECT_STORAGE_ROOT']
        } else { '' }
        $storageRoot = ConvertTo-FullmagInstallerEnvFullPath -Path $storageValue -Label 'FULLMAG_PROJECT_STORAGE_ROOT'

        if (Get-Command Get-FullmagInstallerEnvInheritedSecretNames -ErrorAction SilentlyContinue) {
          foreach ($name in @(Get-FullmagInstallerEnvInheritedSecretNames)) {
            Remove-Item -Path ('Env:' + [string]$name) -ErrorAction SilentlyContinue
          }
        }
        $setupPowerShell = Join-Path $PSHOME 'powershell.exe'
        $arguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', $scriptPath, '-Install', '-PrerequisitesOnly', '-Lane', $lane,
          '-StorageRoot', $storageRoot, '-Json')
        $previousPath = $env:Path
        try {
          if ($session.git_command) {
            $env:Path = (Split-Path -Parent ([string]$session.git_command)) + [IO.Path]::PathSeparator + $env:Path
          }
          $raw = (& $setupPowerShell @arguments 2>$null | Out-String)
        }
        finally { $env:Path = $previousPath }
        $exitCode = [int]$LASTEXITCODE
        try { $report = $raw | ConvertFrom-Json -ErrorAction Stop }
        catch { throw 'prerequisite bootstrap returned invalid JSON' }
        if ($null -eq $report.tools -or $null -eq $report.tools.python -or
            [string]::IsNullOrWhiteSpace([string]$report.tools.python.path)) {
          if ($exitCode -ne 0) { throw 'prerequisite bootstrap did not provide a verified Python path' }
        }

        if ($exitCode -eq 0) {
          $python = [string]$report.tools.python.path
          $previousPath = $env:Path
          try {
            if ($session.git_command) {
              $env:Path = (Split-Path -Parent ([string]$session.git_command)) + [IO.Path]::PathSeparator + $env:Path
            }
            $rebound = Get-FullmagInstallerEnvSession -CheckoutPath ([string]$session.requested_checkout) `
              -PythonCommand $python
          }
          finally { $env:Path = $previousPath }
          if ($session.git_command) {
            $rebound | Add-Member -NotePropertyName git_command -NotePropertyValue ([string]$session.git_command) -Force
          }
          $sessions.Remove([string]$request.session_id)
          $sessions[[string]$rebound.session_id] = $rebound
          $public = Get-PublicSession $rebound
          $public['state'] = 'complete'
          $public['readiness'] = [string]$report.readiness
          $public['storage_root'] = [string]$report.storage_root
          $public['storage_profile'] = [string]$report.storage_profile
          $public['tools'] = [ordered]@{
            git = [ordered]@{ path = [string]$report.tools.git.path; version = [string]$report.tools.git.version }
            python = [ordered]@{ path = [string]$report.tools.python.path; version = [string]$report.tools.python.version }
          }
          Write-Public $public
        } else {
          Write-Public ([ordered]@{
            schema = 'fullmag.windows-build-prerequisites.v1'
            state = 'blocked'
            readiness = [string]$report.readiness
            lane = [string]$report.lane
            storage_root = [string]$report.storage_root
            storage_profile = [string]$report.storage_profile
            blockers = @($report.blockers | ForEach-Object { [string]$_ })
          })
        }
      }
)PS";
        script += LR"PS(      'preview' {
        $session = $sessions[[string]$request.session_id]
        if ($null -eq $session) { throw 'invalid session' }
        $proposal = Get-FullmagInstallerEnvPreview -Session $session -Values $request.values
        Write-Public (Get-PublicProposal $proposal $false)
      }
      'commit' {
        $session = $sessions[[string]$request.session_id]
        if ($null -eq $session) { throw 'invalid session' }
        $proposal = Commit-FullmagInstallerEnvProposal -Session $session -Values $request.values
        $sessions.Remove([string]$request.session_id)
        if (-not [bool]$proposal.valid) { throw 'commit was not valid' }
        $rebound = Get-FullmagInstallerEnvSession -CheckoutPath ([string]$session.requested_checkout)
        if ([string]$rebound.original_hash -ne [string]$proposal.proposed_hash) {
          throw 'the .env changed after commit; the environment session was not rebound'
        }
        $sessions[[string]$rebound.session_id] = $rebound
        Write-Public (Get-PublicProposal $proposal $true $rebound)
      }
      'cancel' {
        $session = $sessions[[string]$request.session_id]
        if ($null -eq $session) { throw 'invalid session' }
        $proposal = Cancel-FullmagInstallerEnvProposal -Session $session
        $sessions.Remove([string]$request.session_id)
        Write-Public ([ordered]@{
          schema = 'fullmag.windows-installer-env-proposal.v1'; state = 'canceled'; valid = $true
          can_commit = $false; changed_fields = @(); redacted_diff = ''; errors = @(); wrote = $false
        })
      }
)PS";
        script += LR"PS(      'setup' {
        $session = $sessions[[string]$request.session_id]
        if ($null -eq $session) { throw 'invalid session' }
        Assert-FullmagInstallerEnvSession -Session $session | Out-Null
        if (-not [string]::Equals([string]$request.checkout_path, [string]$session.requested_checkout,
            [System.StringComparison]::OrdinalIgnoreCase)) {
          throw 'setup checkout does not match the admitted session'
        }
        $scriptPath = Join-Path ([string]$session.requested_checkout) 'scripts\windows\setup_build_environment.ps1'
        $scriptPath = Assert-FullmagInstallerEnvInside -Path $scriptPath `
          -Root ([string]$session.requested_checkout) -Label 'setup script'
        Assert-FullmagInstallerEnvNoReparse -Path $scriptPath -Label 'setup script'
        if (-not [string]::Equals([string]$request.script_path, $scriptPath,
            [System.StringComparison]::OrdinalIgnoreCase)) { throw 'setup script is not canonical' }
        $proposal = Get-FullmagInstallerEnvPreview -Session $session -Values @{}
        if (-not [bool]$proposal.valid) { throw 'the committed environment no longer passes validation' }
        if (-not [string]::Equals([string]$request.storage_root, [string]$proposal.storage_root,
            [System.StringComparison]::OrdinalIgnoreCase)) { throw 'setup storage root changed after admission' }
        if (-not $request.storage_profile -or -not [string]::Equals(
            [string]$request.storage_profile, [string]$proposal.storage_profile,
            [System.StringComparison]::OrdinalIgnoreCase)) { throw 'setup storage profile changed after admission' }
        if (-not [string]::Equals([string]$request.lane, 'all', [System.StringComparison]::OrdinalIgnoreCase)) {
          throw 'installer scope must be all'
        }
        $requirementsPath = Join-Path ([string]$session.requested_checkout) 'windows_build_requirements.json'
        $requirementsPath = Assert-FullmagInstallerEnvInside -Path $requirementsPath `
          -Root ([string]$session.requested_checkout) -Label 'requirements manifest'
        Assert-FullmagInstallerEnvNoReparse -Path $requirementsPath -Label 'requirements manifest'
        $requirements = Get-Content -LiteralPath $requirementsPath -Raw -Encoding UTF8 |
          ConvertFrom-Json -ErrorAction Stop
        $expectedReportProfile = switch (([string]$request.lane).ToLowerInvariant()) {
          'all' { [string]$requirements.storage.build_profiles.fem_gpu; break }
          default { throw 'installer scope must be all' }
        }
        if ([string]::IsNullOrWhiteSpace($expectedReportProfile)) {
          throw 'requirements manifest has no storage profile for the selected setup lane'
        }
        if (-not $request.setup_hash -or
            (Get-FileHash -LiteralPath $scriptPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne
            ([string]$request.setup_hash).ToLowerInvariant()) {
          throw 'setup script changed after admission'
        }
        if (Get-Command Get-FullmagInstallerEnvInheritedSecretNames -ErrorAction SilentlyContinue) {
          foreach ($name in @(Get-FullmagInstallerEnvInheritedSecretNames)) {
            Remove-Item -Path ('Env:' + [string]$name) -ErrorAction SilentlyContinue
          }
        }
        $arguments = @('-Lane', [string]$request.lane, '-Json')
        if ($request.storage_root) { $arguments += @('-StorageRoot', [string]$request.storage_root) }
        if ([bool]$request.install) { $arguments += '-Install' }
        $setupPowerShell = Join-Path $PSHOME 'powershell.exe'
        $previousPath = $env:Path
        try {
          if ($session.git_command) {
            $env:Path = (Split-Path -Parent ([string]$session.git_command)) + [IO.Path]::PathSeparator + $env:Path
          }
          $raw = (& $setupPowerShell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $scriptPath @arguments 2>$null | Out-String)
        }
        finally { $env:Path = $previousPath }
        $exitCode = [int]$LASTEXITCODE
        $report = $raw | ConvertFrom-Json -ErrorAction Stop
        if (-not [string]::Equals([string]$report.storage_root, [string]$proposal.storage_root,
            [System.StringComparison]::OrdinalIgnoreCase) -or
            -not [string]::Equals([string]$report.storage_profile, $expectedReportProfile,
            [System.StringComparison]::OrdinalIgnoreCase)) {
          throw 'setup returned a different storage root or profile'
        }
        Write-Public ([ordered]@{
          schema = 'fullmag.windows-build-environment-report.v1'
          state = if ($exitCode -eq 0) { 'complete' } else { 'blocked' }
          readiness = [string]$report.readiness
          lane = [string]$report.lane
          storage_root = [string]$report.storage_root
          storage_profile = [string]$report.storage_profile
          checks = @($report.checks | ForEach-Object {
            [ordered]@{ id = [string]$_.id; status = [string]$_.status; detail = [string]$_.detail }
          })
          blockers = @($report.blockers | ForEach-Object { [string]$_ })
        })
      }
      default { throw 'unknown operation' }
    }
  } catch {
    $message = [string]$_.Exception.Message
    if ($message -match '(?i)admitted Git executable.*reparse point') {
      Write-Blocked -Blocker 'admitted_git_path_reparse' `
        -Message 'The selected Git executable uses a symbolic link, junction, or reparse point.'
    } elseif ($message -match '(?i)admitted Python executable.*reparse point') {
      Write-Blocked -Blocker 'admitted_python_path_reparse' `
        -Message 'The selected Python executable uses a symbolic link, junction, or reparse point.'
    } elseif ($message -match '(?i)(setup script|requirements manifest).*reparse point') {
      Write-Blocked -Blocker 'checkout_input_reparse' `
        -Message 'A selected checkout input uses a symbolic link, junction, or reparse point.'
    } else {
      Write-Blocked
    }
  }
}
)PS";
        return script;
    }
    std::mutex lock_;
    std::mutex io_lock_;
    std::mutex io_thread_lock_;
    HANDLE io_done_event_ = nullptr;
    HANDLE io_thread_ = nullptr;
    HANDLE process_ = nullptr;
    HANDLE job_ = nullptr;
    HANDLE stdin_ = nullptr;
    HANDLE stdout_ = nullptr;
    bool ready_ = false;
    std::atomic<bool> stop_requested_{false};
    std::atomic<bool> terminal_shutdown_{false};
};

} // namespace fullmag::installer

namespace {

HINSTANCE g_module = nullptr;

struct UiBrokerMessage {
    std::wstring json;
};

struct UiBrokerState {
    std::shared_ptr<fullmag::installer::FullmagInstallerUiBroker> broker;
    std::wstring checkout;
    std::wstring storageRoot;
    std::wstring valuesJson = L"{}";
    std::wstring lane;
    std::wstring activeRequestId;
    std::wstring activeOperation;
    uint64_t activeGeneration = 0;
    bool licenseAccepted = false;
    uint64_t generation = 0;
    uint64_t incomingRevision = 0;
    uint64_t outgoingRevision = 0;
};

std::mutex g_uiBrokerLock;
std::map<fullmag::installer::FullmagBootstrapperApplication*, UiBrokerState> g_uiBrokers;

UiBrokerState* FindUiBrokerState(
    fullmag::installer::FullmagBootstrapperApplication* application) {
    const auto found = g_uiBrokers.find(application);
    return found == g_uiBrokers.end() ? nullptr : &found->second;
}

std::shared_ptr<fullmag::installer::FullmagInstallerUiBroker> UiBrokerInstance(
    fullmag::installer::FullmagBootstrapperApplication* application) {
    std::lock_guard<std::mutex> guard(g_uiBrokerLock);
    const UiBrokerState* state = FindUiBrokerState(application);
    return state ? state->broker : nullptr;
}

void StopUiBroker(fullmag::installer::FullmagBootstrapperApplication* application) {
    // Copy the shared owner while holding the registry lock, then perform the
    // potentially blocking transport stop outside it.  The registry entry is
    // removed only after the BA UI thread has joined this broker.
    const auto broker = UiBrokerInstance(application);
    if (broker) broker->Stop();
}

void ShutdownUiBroker(fullmag::installer::FullmagBootstrapperApplication* application) {
    const auto broker = UiBrokerInstance(application);
    if (broker) broker->Shutdown();
}

std::wstring JsonCompactValue(const JsonReader::Value& value) {
    switch (value.kind) {
    case JsonReader::Kind::Null:
        return L"null";
    case JsonReader::Kind::Bool:
        return value.boolean ? L"true" : L"false";
    case JsonReader::Kind::Number:
        return value.number.empty() ? L"0" : value.number;
    case JsonReader::Kind::String:
        return JsonString(value.string);
    case JsonReader::Kind::Array: {
        std::wstring result = L"[";
        for (size_t index = 0; index < value.array.size(); ++index) {
            if (index != 0) result += L",";
            result += JsonCompactValue(value.array[index]);
        }
        return result + L"]";
    }
    case JsonReader::Kind::Object: {
        std::wstring result = L"{";
        bool first = true;
        for (const auto& entry : value.object) {
            if (!first) result += L",";
            first = false;
            result += JsonString(entry.first) + L":" + JsonCompactValue(entry.second);
        }
        return result + L"}";
    }
    }
    return L"null";
}

bool JsonUint64(const JsonReader::Value* value, uint64_t* result) {
    if (!value || value->kind != JsonReader::Kind::Number || value->number.empty() || !result) {
        return false;
    }
    uint64_t parsed = 0;
    for (const wchar_t character : value->number) {
        if (character < L'0' || character > L'9') return false;
        const uint64_t digit = static_cast<uint64_t>(character - L'0');
        if (parsed > (std::numeric_limits<uint64_t>::max() - digit) / 10) return false;
        parsed = parsed * 10 + digit;
    }
    *result = parsed;
    return true;
}

bool SendUiEnvelope(fullmag::installer::FullmagBootstrapperApplication* application,
                    const wchar_t* type, const std::wstring& payload,
                    const std::wstring& requestId = {},
                    const std::wstring& topLevelFields = {}) {
    std::shared_ptr<fullmag::installer::FullmagInstallerUiBroker> broker;
    uint64_t generation = 0;
    uint64_t revision = 0;
    {
        std::lock_guard<std::mutex> guard(g_uiBrokerLock);
        UiBrokerState* state = FindUiBrokerState(application);
        if (!state || !state->broker) return false;
        broker = state->broker;
        generation = state->generation;
        revision = ++state->outgoingRevision;
    }
    std::wstring message = L"{\"schema\":\"" +
        std::wstring(fullmag::installer::FullmagInstallerUiBroker::kProtocolSchema) +
        L"\",\"type\":" + JsonString(type ? type : L"state") +
        L",\"version\":\"" +
        std::wstring(fullmag::installer::FullmagInstallerUiBroker::kProtocolVersion) + L"\"" +
        L",\"generation\":" + std::to_wstring(generation) +
        L",\"revision\":" + std::to_wstring(revision);
    if (!requestId.empty()) message += L",\"request_id\":" + JsonString(requestId);
    message += topLevelFields;
    message += L",\"payload\":" + (payload.empty() ? L"{}" : payload) + L"}";
    std::wstring error;
    return broker->Send(message, &error);
}

bool UiBrokerRunning(fullmag::installer::FullmagBootstrapperApplication* application) {
    std::shared_ptr<fullmag::installer::FullmagInstallerUiBroker> broker;
    {
        std::lock_guard<std::mutex> guard(g_uiBrokerLock);
        const UiBrokerState* state = FindUiBrokerState(application);
        if (state) broker = state->broker;
    }
    return broker && broker->Running();
}

void SetUiBrokerGeneration(fullmag::installer::FullmagBootstrapperApplication* application,
                           uint64_t generation) {
    std::lock_guard<std::mutex> guard(g_uiBrokerLock);
    if (UiBrokerState* state = FindUiBrokerState(application)) state->generation = generation;
}

std::wstring UiBrokerCheckout(fullmag::installer::FullmagBootstrapperApplication* application) {
    std::lock_guard<std::mutex> guard(g_uiBrokerLock);
    if (const UiBrokerState* state = FindUiBrokerState(application)) return state->checkout;
    return {};
}

std::wstring UiBrokerStorageRoot(fullmag::installer::FullmagBootstrapperApplication* application) {
    std::lock_guard<std::mutex> guard(g_uiBrokerLock);
    if (const UiBrokerState* state = FindUiBrokerState(application)) return state->storageRoot;
    return {};
}

std::wstring UiBrokerValues(fullmag::installer::FullmagBootstrapperApplication* application) {
    std::lock_guard<std::mutex> guard(g_uiBrokerLock);
    if (const UiBrokerState* state = FindUiBrokerState(application)) return state->valuesJson;
    return L"{}";
}

bool UiBrokerLicenseAccepted(fullmag::installer::FullmagBootstrapperApplication* application) {
    std::lock_guard<std::mutex> guard(g_uiBrokerLock);
    const UiBrokerState* state = FindUiBrokerState(application);
    return state && state->licenseAccepted;
}

void SetUiBrokerActiveOperation(fullmag::installer::FullmagBootstrapperApplication* application,
                                const std::wstring& requestId, const std::wstring& operation,
                                uint64_t generation) {
    std::lock_guard<std::mutex> guard(g_uiBrokerLock);
    if (UiBrokerState* state = FindUiBrokerState(application)) {
        state->activeRequestId = requestId;
        state->activeOperation = operation;
        state->activeGeneration = generation;
    }
}

fullmag::installer::UiOperationContext UiBrokerActiveOperation(
    fullmag::installer::FullmagBootstrapperApplication* application) {
    std::lock_guard<std::mutex> guard(g_uiBrokerLock);
    if (const UiBrokerState* state = FindUiBrokerState(application)) {
        return {state->activeRequestId, state->activeOperation, state->activeGeneration,
                !state->activeRequestId.empty() && !state->activeOperation.empty()};
    }
    return {};
}

bool UiBrokerOperationCurrent(
    fullmag::installer::FullmagBootstrapperApplication* application,
    const fullmag::installer::UiOperationContext& context) {
    if (!context.valid || context.requestId.empty() || context.operation.empty()) return false;
    std::lock_guard<std::mutex> guard(g_uiBrokerLock);
    const UiBrokerState* state = FindUiBrokerState(application);
    return state && state->broker && state->activeRequestId == context.requestId &&
           state->activeOperation == context.operation &&
           state->activeGeneration == context.generation &&
           state->generation == context.generation;
}

void ClearUiBrokerActiveOperation(
    fullmag::installer::FullmagBootstrapperApplication* application,
    const fullmag::installer::UiOperationContext& context) {
    std::lock_guard<std::mutex> guard(g_uiBrokerLock);
    if (UiBrokerState* state = FindUiBrokerState(application);
        state && state->activeRequestId == context.requestId &&
        state->activeOperation == context.operation &&
        state->activeGeneration == context.generation) {
        state->activeRequestId.clear();
        state->activeOperation.clear();
        state->activeGeneration = 0;
    }
}

std::wstring UiBrokerTerminalPayload(
    const fullmag::installer::UiOperationContext& context,
    const std::wstring& response,
    const std::wstring& error) {
    JsonReader::Value payload;
    bool parsed = !response.empty() && JsonReader(response).Parse(&payload) &&
        payload.kind == JsonReader::Kind::Object;
    if (!parsed) {
        payload = JsonReader::Value{};
        payload.kind = JsonReader::Kind::Object;
        JsonReader::Value errors;
        errors.kind = JsonReader::Kind::Array;
        if (!error.empty()) {
            JsonReader::Value item;
            item.kind = JsonReader::Kind::String;
            item.string = error;
            errors.array.push_back(std::move(item));
        }
        payload.object[L"errors"] = std::move(errors);
    }
    JsonReader::Value operation;
    operation.kind = JsonReader::Kind::String;
    operation.string = context.operation;
    payload.object[L"operation"] = std::move(operation);
    return JsonCompactValue(payload);
}

bool SendUiTerminal(
    fullmag::installer::FullmagBootstrapperApplication* application,
    const fullmag::installer::UiOperationContext& context,
    bool ok, const wchar_t* state, const std::wstring& response,
    const std::wstring& error = {}) {
    if (!UiBrokerOperationCurrent(application, context)) return false;
    const std::wstring terminalState = state && *state ? state : (ok ? L"complete" : L"blocked");
    const std::wstring payload = UiBrokerTerminalPayload(context, response, error);
    const std::wstring topLevel = L",\"ok\":" + JsonBool(ok) +
        L",\"state\":" + JsonString(terminalState) +
        (error.empty() ? L"" : L",\"message\":" + JsonString(error));
    const bool sent = SendUiEnvelope(application, L"reply", payload, context.requestId, topLevel);
    if (sent) ClearUiBrokerActiveOperation(application, context);
    return sent;
}

struct BrokerCommand {
    std::wstring requestId;
    std::wstring operation;
    JsonReader::Value args;
    uint64_t generation = 0;
    uint64_t revision = 0;
};

std::wstring CanonicalBrokerOperation(std::wstring operation) {
    operation = Lower(std::move(operation));
    if (operation == L"preadmission") return L"bootstrap_preadmission";
    if (operation == L"prerequisites") return L"bootstrap_prerequisites";
    // The modern UI uses `initial_build` for the setup/receipt phase. Keep
    // the legacy spelling as an alias, but do not route it through the
    // dependency-only operation: that would make Burn initial-build/apply
    // unreachable and leave the UI without a terminal receipt.
    if (operation == L"setup") return L"initial_build";
    if (operation == L"launch_ui") return L"launch";
    if (operation == L"install") return L"apply";
    return operation;
}

bool ParseBrokerCommand(const std::wstring& text, BrokerCommand* command,
                        std::wstring* error) {
    if (error) error->clear();
    if (!command) return false;
    JsonReader::Value root;
    if (!JsonReader(text).Parse(&root) || root.kind != JsonReader::Kind::Object) {
        if (error) *error = L"The UI command is not a JSON object.";
        return false;
    }
    if (root.String(L"schema") != fullmag::installer::FullmagInstallerUiBroker::kProtocolSchema ||
        root.String(L"version") != fullmag::installer::FullmagInstallerUiBroker::kProtocolVersion) {
        if (error) *error = L"The UI command schema is unsupported.";
        return false;
    }
    const std::wstring type = root.String(L"type");
    if (type != L"command" && type != L"shutdown") {
        if (error) *error = L"The UI message is not a command.";
        return false;
    }
    command->requestId = root.String(L"request_id", root.String(L"correlation_id"));
    command->operation = type == L"shutdown" ? L"shutdown" : root.String(L"operation");
    const JsonReader::Value* payload = root.Get(L"payload");
    if (payload && payload->kind == JsonReader::Kind::Object) {
        if (type != L"shutdown" && command->operation.empty()) {
            command->operation = payload->String(L"operation", payload->String(L"op"));
        }
        const JsonReader::Value* args = payload->Get(L"args");
        command->args = args && args->kind == JsonReader::Kind::Object ? *args : *payload;
    } else {
        command->args.kind = JsonReader::Kind::Object;
    }
    command->operation = CanonicalBrokerOperation(command->operation);
    if (command->requestId.empty() || command->requestId.size() > 256 ||
        command->operation.empty()) {
        if (error) *error = L"The UI command request id or operation is invalid.";
        return false;
    }
    if (!JsonUint64(root.Get(L"generation"), &command->generation) ||
        !JsonUint64(root.Get(L"revision"), &command->revision)) {
        if (error) *error = L"The UI command is missing generation or revision.";
        return false;
    }
    return true;
}

bool ApplyBrokerInputs(fullmag::installer::FullmagBootstrapperApplication* application,
                       const JsonReader::Value& args, bool* checkoutChanged,
                       bool* storageChanged, bool* valuesChanged, bool* laneChanged) {
    if (checkoutChanged) *checkoutChanged = false;
    if (storageChanged) *storageChanged = false;
    if (valuesChanged) *valuesChanged = false;
    if (laneChanged) *laneChanged = false;
    std::lock_guard<std::mutex> guard(g_uiBrokerLock);
    UiBrokerState* state = FindUiBrokerState(application);
    if (!state || args.kind != JsonReader::Kind::Object) return false;
    const JsonReader::Value* checkoutValue = args.Get(L"checkout_path");
    if (!checkoutValue) checkoutValue = args.Get(L"checkout");
    const JsonReader::Value* storageValue = args.Get(L"storage_root");
    const JsonReader::Value* laneValue = args.Get(L"lane");
    const JsonReader::Value* acceptedValue = args.Get(L"license_accepted");
    if ((checkoutValue && checkoutValue->kind != JsonReader::Kind::String) ||
        (storageValue && storageValue->kind != JsonReader::Kind::String) ||
        (laneValue && laneValue->kind != JsonReader::Kind::String) ||
        (acceptedValue && acceptedValue->kind != JsonReader::Kind::Bool)) {
        return false;
    }
    const std::wstring checkout = checkoutValue ? checkoutValue->string : std::wstring{};
    const std::wstring storage = storageValue ? storageValue->string : std::wstring{};
    const std::wstring lane = laneValue ? Lower(laneValue->string) : std::wstring{};
    const JsonReader::Value* values = args.Get(L"values");
    if (values && values->kind != JsonReader::Kind::Object) return false;
    if (checkoutValue && checkout != state->checkout) {
        state->checkout = checkout;
        if (checkoutChanged) *checkoutChanged = true;
    }
    if (storageValue && storage != state->storageRoot) {
        state->storageRoot = storage;
        if (storageChanged) *storageChanged = true;
    }
    if (laneValue && lane != state->lane) {
        state->lane = lane;
        if (laneChanged) *laneChanged = true;
    }
    if (values && values->kind == JsonReader::Kind::Object) {
        const std::wstring serialized = JsonCompactValue(*values);
        if (serialized != state->valuesJson) {
            state->valuesJson = serialized;
            if (valuesChanged) *valuesChanged = true;
        }
    }
    if (acceptedValue) {
        state->licenseAccepted = acceptedValue->boolean;
    }
    return true;
}

void SendBrokerReply(fullmag::installer::FullmagBootstrapperApplication* application,
                     const BrokerCommand& command, bool ok, const wchar_t* state,
                     const std::wstring& message = {}) {
    std::wstring payload = L"{\"op\":" + JsonString(command.operation) +
        L",\"ok\":" + JsonBool(ok) + L",\"state\":" +
        JsonString(state ? state : (ok ? L"accepted" : L"blocked"));
    if (ok) payload += L",\"accepted\":true";
    if (!message.empty()) payload += L",\"message\":" + JsonString(message);
    payload += L"}";
    const std::wstring topLevel = L",\"ok\":" + JsonBool(ok) +
        L",\"state\":" + JsonString(state ? state : (ok ? L"accepted" : L"blocked")) +
        (message.empty() ? L"" : L",\"message\":" + JsonString(message));
    SendUiEnvelope(application, L"reply", payload, command.requestId, topLevel);
}

std::wstring PowerShellPath() {
    wchar_t systemDirectory[MAX_PATH]{};
    const UINT length = GetSystemDirectoryW(systemDirectory, ARRAYSIZE(systemDirectory));
    if (length == 0 || length >= ARRAYSIZE(systemDirectory)) return {};
    std::wstring path(systemDirectory, length);
    path += L"\\WindowsPowerShell\\v1.0\\powershell.exe";
    return path;
}

void EnableWindowIf(HWND window, bool enabled) {
    if (window) EnableWindow(window, enabled ? TRUE : FALSE);
}

void SetControlText(HWND control, const std::wstring& text) {
    if (control) SetWindowTextW(control, text.c_str());
}

} // namespace

namespace fullmag::installer {

FullmagBootstrapperApplication::FullmagBootstrapperApplication(
    IBootstrapperEngine* engine, const BOOTSTRAPPER_COMMAND* command)
    : engine_(engine), action_(command ? command->action : BOOTSTRAPPER_ACTION_UNKNOWN),
      uiReadyEvent_(CreateEventW(nullptr, TRUE, FALSE, nullptr)),
      brokerDispatchGate_(std::make_shared<UiBrokerDispatchGate>()),
      helper_(std::make_unique<HelperClient>()) {
    if (engine_) engine_->AddRef();
    std::lock_guard<std::mutex> guard(g_uiBrokerLock);
    UiBrokerState state;
    state.broker = std::make_shared<FullmagInstallerUiBroker>();
    state.generation = admissionGeneration_;
    g_uiBrokers.emplace(this, std::move(state));
}

FullmagBootstrapperApplication::~FullmagBootstrapperApplication() {
    shuttingDown_.store(true);
    {
        std::lock_guard<std::mutex> guard(stateMutex_);
        const HWND target = uiWindow_.load();
        if (target) PostMessageW(target, kUiClose, 0, 0);
    }
    // Shutdown makes the helper terminal before the destructor joins its
    // transport worker, so a racing Start cannot recreate the child process.
    if (helper_) helper_->Shutdown();
    ShutdownUiBroker(this);
    if (uiThread_.joinable()) uiThread_.join();
    // HandleHelperReply owns the other join path for helperThread_.  Wait for
    // the UI thread first so the two owners can never join it concurrently.
    if (helperThread_.joinable()) helperThread_.join();
    {
        std::lock_guard<std::mutex> guard(g_uiBrokerLock);
        g_uiBrokers.erase(this);
    }
    if (uiReadyEvent_) CloseHandle(uiReadyEvent_);
    if (engine_) engine_->Release();
}

void FullmagBootstrapperApplication::SendHelperAsync(
    const std::wstring& request,
    std::function<void(const std::wstring&, const std::wstring&)> completion) {
    if (shuttingDown_) return;
    if (helperRequestInFlight_.exchange(true)) {
        if (completion) completion({}, L"Another installer operation is still running.");
        return;
    }
    if (helperThread_.joinable()) helperThread_.join();

    HWND target = nullptr;
    {
        std::lock_guard<std::mutex> guard(stateMutex_);
        target = helperMessageWindow_.load();
        if (shuttingDown_ || !target) target = nullptr;
    }
    if (!target) {
        helperRequestInFlight_.store(false);
        if (completion) completion({}, L"The installer window is unavailable.");
        return;
    }
    helperThread_ = std::thread(
        [this, request, target, completion = std::move(completion)]() mutable {
            auto reply = std::make_unique<HelperReply>();
            if (shuttingDown_) {
                reply->error = L"The installer is shutting down.";
            } else {
                const std::wstring powershell = PowerShellPath();
                std::wstring startupError;
                const bool started = helper_ && !powershell.empty() &&
                    helper_->Start(powershell, &startupError);
                if (!started) {
                    reply->error = startupError.empty() ? L"PowerShell is unavailable." : startupError;
                } else if (!shuttingDown_ &&
                           (!helper_->Send(request, &reply->response, &reply->error))) {
                    if (reply->error.empty()) reply->error = L"The installer helper rejected the request.";
                }
            }
            reply->completion = std::move(completion);
            bool posted = false;
            {
                // Teardown clears the target while holding this mutex. Keep
                // the HWND validity check and PostMessage in one critical
                // section so a reply can never target a destroyed window.
                std::lock_guard<std::mutex> guard(stateMutex_);
                const HWND current = helperMessageWindow_.load();
                if (!shuttingDown_ && target && current == target) {
                    posted = PostMessageW(current, kUiReply, 0,
                                          reinterpret_cast<LPARAM>(reply.get())) != FALSE;
                }
            }
            if (posted) {
                reply.release();
            } else {
                helperRequestInFlight_.store(false);
            }
        });
}

void FullmagBootstrapperApplication::HandleHelperReply(HelperReply* reply) {
    std::unique_ptr<HelperReply> owned(reply);
    if (helperThread_.joinable()) helperThread_.join();
    helperRequestInFlight_.store(false);
    if (owned && !shuttingDown_ && owned->completion) {
        owned->completion(owned->response, owned->error);
    }
    MaybeSendPendingHelperCancel();
}

void FullmagBootstrapperApplication::MaybeSendPendingHelperCancel() {
    if (shuttingDown_ || helperRequestInFlight_.load() || pendingCancelSession_.empty()) return;
    const std::wstring session = std::move(pendingCancelSession_);
    pendingCancelSession_.clear();
    const UiOperationContext context = pendingCancelOperation_;
    pendingCancelOperation_ = {};
    const std::wstring request = L"{\"op\":\"cancel\",\"session_id\":" +
        JsonString(session) + L"}";
    SendHelperAsync(request,
        [this, context](const std::wstring& response, const std::wstring& error) {
            if (context.valid) {
                SendUiTerminal(this, context, error.empty(),
                               error.empty() ? L"canceled" : L"blocked", response,
                               error.empty() ? L"" : error);
            }
        });
}

void FullmagBootstrapperApplication::HandlePlanComplete(HRESULT status) {
    // Burn invokes OnPlanComplete on its callback thread. This method is
    // called only by WindowProc, so state, HWND, and Apply mutations stay on
    // the owning UI thread.
    if (shuttingDown_.load()) {
        installRequested_.store(false);
        return;
    }
    const bool cancelRequested = burnCancelRequested_.load();
    const UiOperationContext terminalContext =
        cancelRequested && burnCancelOperation_.valid ?
            burnCancelOperation_ : burnOperationContext_;
    if (FAILED(status)) {
        installRequested_.store(false);
        SetEnvironmentMutationLock(false);
        SetStatus(L"Burn could not plan the product payload: " + HresultText(status), true);
        SendUiTerminal(this, terminalContext, false,
                       cancelRequested ? L"canceled" : L"blocked", L"",
                       L"Burn could not plan the product payload: " + HresultText(status));
        burnOperationContext_ = {};
        burnCancelOperation_ = {};
        burnCancelRequested_.store(false);
        return;
    }

    if (cancelRequested) {
        installRequested_.store(false);
        SetEnvironmentMutationLock(false);
        SetStatus(L"Burn planning was canceled.", true);
        SendUiTerminal(this, terminalContext, true, L"canceled",
                       L"{\"canceled\":true,\"burn_cancel_requested\":true}");
        burnOperationContext_ = {};
        burnCancelOperation_ = {};
        burnCancelRequested_.store(false);
        return;
    }

    if (!burnApplyAfterPlan_) {
        installRequested_.store(false);
        SetEnvironmentMutationLock(false);
        SetStatus(L"Burn planning completed; no payload was applied.");
        SendUiTerminal(this, burnOperationContext_, true, L"complete",
                       L"{\"planned\":true,\"receipt_valid\":false,\"apply_started\":false}");
        burnOperationContext_ = {};
        return;
    }

    const HWND target = uiWindow_.load();
    if (installRequested_.load() && engine_ && target) {
        SetStatus(L"Applying the verified product payload...");
        const HRESULT apply = engine_->Apply(target);
        if (FAILED(apply)) {
            installRequested_.store(false);
            SetEnvironmentMutationLock(false);
            SetStatus(L"Burn could not apply the product payload: " + HresultText(apply), true);
            const bool canceled = burnCancelRequested_.load();
            const UiOperationContext applyContext =
                canceled && burnCancelOperation_.valid ?
                    burnCancelOperation_ : burnOperationContext_;
            SendUiTerminal(this, applyContext, false,
                           canceled ? L"canceled" : L"blocked", L"",
                           L"Burn could not apply the product payload: " + HresultText(apply));
            burnOperationContext_ = {};
            burnCancelOperation_ = {};
            burnCancelRequested_.store(false);
        }
    } else if (installRequested_.load()) {
        installRequested_.store(false);
        SetEnvironmentMutationLock(false);
        const bool canceled = burnCancelRequested_.load();
        const UiOperationContext applyContext =
            canceled && burnCancelOperation_.valid ?
                burnCancelOperation_ : burnOperationContext_;
        SendUiTerminal(this, applyContext, false,
                       canceled ? L"canceled" : L"blocked", L"",
                       L"The Burn window is unavailable; applying the payload is blocked.");
        burnOperationContext_ = {};
        burnCancelOperation_ = {};
        burnCancelRequested_.store(false);
    }
}

void FullmagBootstrapperApplication::HandleApplyComplete(HRESULT status) {
    // Burn invokes OnApplyComplete on its callback thread. This method is
    // called only by WindowProc, so all state and HWND mutations stay on the
    // GUI thread.
    installRequested_.store(false);
    const bool cancelRequested = burnCancelRequested_.load();
    const UiOperationContext terminalContext =
        cancelRequested && burnCancelOperation_.valid ?
            burnCancelOperation_ : burnOperationContext_;
    applyFinished_ = SUCCEEDED(status);
    if (applyFinished_) {
        if (sourceFirst_ && !ValidateSourceFirstReceipt()) {
            applyFinished_ = false;
            EnableWindowIf(launchButton_, false);
            SetEnvironmentMutationLock(false);
            SetStatus(L"Source-first completed without a trusted matching receipt; installation is blocked.", true);
            SendUiTerminal(this, terminalContext, false, L"blocked",
                           L"{\"receipt_valid\":false,\"apply_finished\":false}",
                           L"Source-first completed without a trusted matching receipt; installation is blocked.");
            burnOperationContext_ = {};
            burnCancelOperation_ = {};
            burnCancelRequested_.store(false);
            return;
        }
        SetProgress(100);
        const bool productPayloadInstalled = !sourceFirst_;
        const bool sourceFirstBrowserReady = sourceFirst_ &&
            EqualsInsensitive(requestedLane_, L"all") &&
            EqualsInsensitive(bootstrapMode_, L"initial-build");
        const bool sourceFirstSetupOnly = sourceFirst_ &&
            EqualsInsensitive(bootstrapMode_, L"setup-only");
        EnableWindowIf(launchButton_, productPayloadInstalled || sourceFirstBrowserReady);
        SetEnvironmentMutationLock(false);
        SetStatus(productPayloadInstalled ?
                      L"Product installation completed. Verify WebView2 before launch." :
                      (sourceFirstSetupOnly ?
                           L"Fullmag environment setup completed. Build the all-realizations package before launch." :
                           L"Fullmag setup completed. Launch Fullmag to open the browser."));
        const std::wstring payload = L"{\"receipt_valid\":" +
            JsonBool(!sourceFirst_ || applyFinished_) +
            L",\"apply_finished\":true,\"receipt_path\":" + JsonString(receiptPath_) +
            L",\"environment_committed\":" + JsonBool(environmentCommitted_) +
            L",\"all_runtime_ready\":" + JsonBool(productPayloadInstalled || sourceFirstBrowserReady) +
            (cancelRequested ? L",\"cancel_requested\":true,\"canceled\":false" : L"") + L"}";
        SendUiTerminal(this, terminalContext, true, L"complete", payload);
        burnOperationContext_ = {};
    } else {
        SetEnvironmentMutationLock(false);
        SetStatus(cancelRequested ? L"Product installation was canceled." :
                                   L"Product installation failed: " + HresultText(status), true);
        SendUiTerminal(this, terminalContext, false,
                       cancelRequested ? L"canceled" : L"blocked",
                       L"{\"receipt_valid\":false,\"apply_finished\":false}",
                       cancelRequested ? L"Burn installation was canceled." :
                           L"Product installation failed: " + HresultText(status));
        burnOperationContext_ = {};
    }
    burnCancelOperation_ = {};
    burnCancelRequested_.store(false);
}

STDMETHODIMP FullmagBootstrapperApplication::QueryInterface(REFIID riid, void** object) {
    if (!object) return E_POINTER;
    *object = nullptr;
    if (::IsEqualIID(riid, __uuidof(IUnknown)) ||
        ::IsEqualIID(riid, __uuidof(IBootstrapperApplication))) {
        *object = static_cast<IBootstrapperApplication*>(this);
        AddRef();
        return S_OK;
    }
    return E_NOINTERFACE;
}

STDMETHODIMP_(ULONG) FullmagBootstrapperApplication::AddRef() {
    return ++references_;
}

STDMETHODIMP_(ULONG) FullmagBootstrapperApplication::Release() {
    const ULONG references = --references_;
    if (references == 0) delete this;
    return references;
}

STDMETHODIMP FullmagBootstrapperApplication::OnStartup() {
    if (!engine_) return E_UNEXPECTED;
    uiThread_ = std::thread(&FullmagBootstrapperApplication::UiThreadMain, this);
    if (!uiReadyEvent_ || WaitForSingleObject(uiReadyEvent_, 15000) != WAIT_OBJECT_0 ||
        !uiWindow_.load() || !UiBrokerRunning(this)) {
        SetStatus(L"The hash-bound Avalonia installer UI could not be started.", true);
        return E_FAIL;
    }
    engine_->CloseSplashScreen();
    const HRESULT status = engine_->Detect(uiWindow_.load());
    if (FAILED(status)) SetStatus(L"Burn detection failed: " + HresultText(status), true);
    return status;
}

STDMETHODIMP_(int) FullmagBootstrapperApplication::OnShutdown() {
    if (burnCancelRequested_.load() && burnCancelOperation_.valid) {
        SendUiTerminal(this, burnCancelOperation_, true, L"canceled",
                       L"{\"canceled\":true,\"burn_cancel_requested\":true,\"engine_shutdown\":true}");
        burnCancelOperation_ = {};
        burnCancelRequested_.store(false);
    }
    shuttingDown_.store(true);
    {
        std::lock_guard<std::mutex> guard(stateMutex_);
        const HWND target = uiWindow_.load();
        if (target) PostMessageW(target, kUiClose, 0, 0);
    }
    if (helper_) helper_->Shutdown();
    ShutdownUiBroker(this);
    return IDNOACTION;
}

STDMETHODIMP_(int) FullmagBootstrapperApplication::OnSystemShutdown(DWORD, int) {
    return IDNOACTION;
}

void FullmagBootstrapperApplication::UiThreadMain() {
    const HRESULT comStatus = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    WNDCLASSEXW windowClass{sizeof(windowClass)};
    windowClass.lpfnWndProc = &FullmagBootstrapperApplication::WindowProc;
    windowClass.hInstance = g_module;
    windowClass.lpszClassName = kWindowClass;
    const ATOM registeredClass = RegisterClassExW(&windowClass);

    // Burn still requires an HWND for callback dispatch, but presentation is
    // owned entirely by the hash-bound x64 Avalonia payload.  This message-only
    // window is never shown and has no child controls, so the historical Win32
    // installer form cannot appear behind or in front of the modern UI.
    window_ = CreateWindowExW(0, kWindowClass, L"Fullmag Installer Broker", 0,
                              0, 0, 0, 0, HWND_MESSAGE, nullptr, g_module, this);
    if (!window_) {
        // OnStartup waits for this event before checking uiWindow_.  Signal it
        // even on creation failure so the owner can fail closed instead of
        // leaving this thread blocked in GetMessageW forever.
        shuttingDown_.store(true);
        {
            std::lock_guard<std::mutex> guard(stateMutex_);
            helperMessageWindow_.store(nullptr);
            uiWindow_.store(nullptr);
        }
        if (const auto dispatchGate = brokerDispatchGate_) {
            std::lock_guard<std::mutex> guard(dispatchGate->lock);
            dispatchGate->accepting = false;
            dispatchGate->target = nullptr;
        }
        if (uiReadyEvent_) SetEvent(uiReadyEvent_);
        if (registeredClass) UnregisterClassW(kWindowClass, g_module);
        if (comStatus == S_OK || comStatus == S_FALSE) CoUninitialize();
        return;
    }
    {
        std::lock_guard<std::mutex> guard(stateMutex_);
        helperMessageWindow_.store(window_);
        uiWindow_.store(window_);
    }
    if (const auto dispatchGate = brokerDispatchGate_) {
        std::lock_guard<std::mutex> guard(dispatchGate->lock);
        dispatchGate->target = window_;
        dispatchGate->accepting = window_ != nullptr;
    }

    sourceFirst_ = !FindPayload({L"fullmag-installer-environment.exe"}).empty();
    bootstrapMode_ = sourceFirst_ ? EngineVariable(L"FullmagBootstrapMode") : std::wstring{};
    receiptPath_ = sourceFirst_ ? EngineVariable(L"FullmagReceiptPath") : std::wstring{};
    bool sourceFirstModeValid = true;
    const std::wstring licensePath = FindPayload({L"LICENSE.txt", L"license.txt", L"LICENSE",
                                                  L"Fullmag-LICENSE.txt"});
    std::wstring license;
    licenseIsValid_ = !licensePath.empty() && ReadTextFile(licensePath, &license) && !license.empty();

    std::wstring uiPath;
    std::wstring uiHash;
    const std::wstring provenancePath = FindPayload({L"fullmag-installer-provenance.json"});
    std::wstring provenanceText;
    JsonReader::Value provenance;
    if (!provenancePath.empty() && ReadTextFile(provenancePath, &provenanceText) &&
        JsonReader(provenanceText).Parse(&provenance) && provenance.kind == JsonReader::Kind::Object) {
        const JsonReader::Value* ui = provenance.Get(L"avalonia_ui");
        uiPath = FindPayload({L"FullmagInstallerUi.exe"});
        if (ui) uiHash = ui->String(L"payload_sha256");
    }
    if (sourceFirst_) {
        const JsonReader::Value* source = provenance.Get(L"source_first");
        const std::wstring provenanceMode =
            source && source->kind == JsonReader::Kind::Object ? source->String(L"mode") :
                                                                  std::wstring{};
        const bool legalMode = EqualsInsensitive(provenanceMode, L"setup-only") ||
                               EqualsInsensitive(provenanceMode, L"initial-build");
        const bool modeMatchesBurn = bootstrapMode_.empty() ||
                                     EqualsInsensitive(bootstrapMode_, provenanceMode);
        sourceFirstModeValid = legalMode && modeMatchesBurn;
        if (sourceFirstModeValid && bootstrapMode_.empty()) bootstrapMode_ = provenanceMode;
        if (!sourceFirstModeValid) bootstrapMode_.clear();
    }
    requestedLane_ = sourceFirstModeValid ? RequestedLane() : std::wstring{};
    {
        std::lock_guard<std::mutex> guard(g_uiBrokerLock);
        if (UiBrokerState* state = FindUiBrokerState(this)) {
            state->lane = requestedLane_;
            state->generation = admissionGeneration_;
            state->outgoingRevision = 1;
        }
    }

    const auto provenanceRecord = [&](const wchar_t* key) -> std::wstring {
        const JsonReader::Value* record = provenance.Get(key);
        if (!record || record->kind != JsonReader::Kind::Object) return L"{}";
        return L"{\"filename\":" + JsonString(record->String(L"filename")) +
            L",\"sha256\":" + JsonString(record->String(L"sha256")) + L"}";
    };
    const auto provenanceScalar = [&](const wchar_t* key, const wchar_t* field) {
        const JsonReader::Value* record = provenance.Get(key);
        return record && record->kind == JsonReader::Kind::Object
            ? record->String(field) : std::wstring{};
    };
    const auto dispatchGate = brokerDispatchGate_;
    auto postBrokerMessage = [dispatchGate](const std::wstring& json) {
        auto* brokerMessage = new (std::nothrow) UiBrokerMessage{json};
        bool posted = false;
        if (dispatchGate) {
            std::lock_guard<std::mutex> guard(dispatchGate->lock);
            const HWND target = dispatchGate->target;
            posted = brokerMessage && dispatchGate->accepting && target &&
                PostMessageW(target, kUiBrokerMessage, 0,
                             reinterpret_cast<LPARAM>(brokerMessage)) != FALSE;
        }
        if (!posted) delete brokerMessage;
    };
    const std::wstring brokerEofMessage = L"{\"schema\":\"" +
        std::wstring(FullmagInstallerUiBroker::kProtocolSchema) +
        L"\",\"type\":\"eof\",\"version\":\"" +
        std::wstring(FullmagInstallerUiBroker::kProtocolVersion) + L"\"}";
    auto postBrokerClosed = [postBrokerMessage, brokerEofMessage]() {
        // ClosedHandler runs on the broker reader thread.  It only marshals a
        // bounded lifecycle message to the BA window; it must not call back
        // into the broker or wait for transport teardown.
        postBrokerMessage(brokerEofMessage);
    };
    std::wstring brokerError;
    const std::wstring initJson = L"{\"schema\":\"" +
        std::wstring(FullmagInstallerUiBroker::kProtocolSchema) +
        L"\",\"type\":\"init\",\"version\":\"" +
        std::wstring(FullmagInstallerUiBroker::kProtocolVersion) +
        L"\",\"request_id\":\"init-0\",\"generation\":" +
        std::to_wstring(admissionGeneration_) + L",\"revision\":1,\"payload\":{\"lane\":" +
        JsonString(requestedLane_) + L",\"profile\":" + JsonString(RuntimeStorageProfile()) +
        L",\"mode\":" + JsonString(bootstrapMode_) + L",\"source_first\":" +
        JsonBool(sourceFirst_) + L",\"license_valid\":" + JsonBool(licenseIsValid_) +
        L",\"license_text\":" + JsonString(license) +
        L",\"setup_script_path\":" +
            JsonString(provenanceScalar(L"prerequisite_setup", L"filename")) +
        L",\"setup_hash\":" +
            JsonString(provenanceScalar(L"prerequisite_setup", L"sha256")) +
        L",\"manifest_path\":" +
            JsonString(provenanceScalar(L"prerequisite_manifest", L"filename")) +
        L",\"manifest_hash\":" +
            JsonString(provenanceScalar(L"prerequisite_manifest", L"sha256")) +
        L",\"setup_script\":" + provenanceRecord(L"prerequisite_setup") +
        L",\"requirements_manifest\":" + provenanceRecord(L"prerequisite_manifest") +
        L",\"installer_env_module\":" + provenanceRecord(L"installer_env_module") + L"}}";
    bool brokerStarted = false;
    std::shared_ptr<FullmagInstallerUiBroker> broker;
    {
        std::lock_guard<std::mutex> guard(g_uiBrokerLock);
        if (UiBrokerState* state = FindUiBrokerState(this)) broker = state->broker;
    }
    if (!sourceFirstModeValid) {
        brokerError = L"The source-first bootstrap mode is missing, unsupported, or inconsistent with provenance.";
    } else if (broker && !uiPath.empty() && IsSha256(uiHash)) {
        brokerStarted = broker->Start(uiPath, uiHash, initJson,
                                      std::move(postBrokerMessage), &brokerError,
                                      std::move(postBrokerClosed));
    }
    if (!brokerStarted && brokerError.empty()) {
        brokerError = L"The hash-bound Avalonia installer payload is unavailable.";
    }
    if (uiReadyEvent_) SetEvent(uiReadyEvent_);
    if (!brokerStarted) SetStatus(brokerError, true);

    MSG message{};
    while (!shuttingDown_ && GetMessageW(&message, nullptr, 0, 0) > 0) {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
    if (window_) {
        if (const auto cleanupDispatchGate = brokerDispatchGate_) {
            std::lock_guard<std::mutex> guard(cleanupDispatchGate->lock);
            cleanupDispatchGate->accepting = false;
            cleanupDispatchGate->target = nullptr;
        }
        {
            std::lock_guard<std::mutex> guard(stateMutex_);
            helperMessageWindow_.store(nullptr);
            uiWindow_.store(nullptr);
        }
        DestroyWindow(window_);
        window_ = nullptr;
    }
    // Messages carrying heap-owned UI payloads may be queued behind the close
    // message. Once the target has been invalidated, dispose of them here;
    // workers only post while holding stateMutex_ and therefore cannot race
    // this drain.
    MSG pending{};
    while (PeekMessageW(&pending, nullptr, kUiReply, kUiReply, PM_REMOVE)) {
        delete reinterpret_cast<HelperReply*>(pending.lParam);
    }
    while (PeekMessageW(&pending, nullptr, kUiStatus, kUiStatus, PM_REMOVE)) {
        delete reinterpret_cast<std::wstring*>(pending.lParam);
    }
    while (PeekMessageW(&pending, nullptr, kUiApplyComplete, kUiApplyComplete, PM_REMOVE)) {
        delete reinterpret_cast<UiApplyCompleteMessage*>(pending.lParam);
    }
    while (PeekMessageW(&pending, nullptr, kUiPlanComplete, kUiPlanComplete, PM_REMOVE)) {
        delete reinterpret_cast<UiPlanCompleteMessage*>(pending.lParam);
    }
    while (PeekMessageW(&pending, nullptr, kUiBrokerMessage, kUiBrokerMessage, PM_REMOVE)) {
        delete reinterpret_cast<UiBrokerMessage*>(pending.lParam);
    }
    if (registeredClass) UnregisterClassW(kWindowClass, g_module);
    if (comStatus == S_OK || comStatus == S_FALSE) CoUninitialize();
}

void FullmagBootstrapperApplication::CreateUi(HWND window) {
    HFONT font = static_cast<HFONT>(GetStockObject(DEFAULT_GUI_FONT));
    auto make = [&](DWORD extendedStyle, LPCWSTR className, LPCWSTR title, DWORD style,
                    int x, int y, int width, int height, int id) -> HWND {
        HWND control = CreateWindowExW(extendedStyle, className, title, style,
                                       x, y, width, height, window, reinterpret_cast<HMENU>(id),
                                       g_module, nullptr);
        if (control) SendMessageW(control, WM_SETFONT, reinterpret_cast<WPARAM>(font), TRUE);
        return control;
    };

    make(0, L"STATIC", L"Install Fullmag for Windows", WS_CHILD | WS_VISIBLE,
         20, 16, 700, 28, 0);
    statusLabel_ = make(0, L"STATIC", L"Preparing installer...", WS_CHILD | WS_VISIBLE,
                        20, 48, 840, 22, kStatus);
    progressBar_ = make(0, PROGRESS_CLASSW, L"", WS_CHILD | WS_VISIBLE,
                        20, 76, 840, 20, kProgress);
    SendMessageW(progressBar_, PBM_SETRANGE, 0, MAKELPARAM(0, 100));

    make(0, L"STATIC", L"License", WS_CHILD | WS_VISIBLE,
         20, 112, 200, 22, 0);
    licenseText_ = make(WS_EX_CLIENTEDGE, L"EDIT", L"", WS_CHILD | WS_VISIBLE | WS_TABSTOP |
                        ES_MULTILINE | ES_READONLY | WS_VSCROLL | WS_HSCROLL,
                        20, 136, 840, 130, kLicense);
    licenseAccepted_ = make(0, L"BUTTON", L"I accept the Fullmag license", WS_CHILD | WS_VISIBLE |
                            BS_AUTOCHECKBOX | WS_TABSTOP, 20, 274, 350, 24, kLicenseAccepted);
    const std::wstring licensePath = FindPayload({L"LICENSE.txt", L"license.txt", L"LICENSE", L"Fullmag-LICENSE.txt"});
    std::wstring license;
    licenseIsValid_ = !licensePath.empty() && ReadTextFile(licensePath, &license) && !license.empty();
    if (licenseIsValid_) {
        SetControlText(licenseText_, license);
    } else {
        SetControlText(licenseText_, L"The bundled license payload was not provided. Installation is blocked.");
        EnableWindowIf(licenseAccepted_, false);
    }

    make(0, L"STATIC", L"Operator-selected Git checkout", WS_CHILD | WS_VISIBLE,
         20, 312, 300, 22, 0);
    checkoutEdit_ = make(WS_EX_CLIENTEDGE, L"EDIT", L"", WS_CHILD | WS_VISIBLE | WS_TABSTOP | ES_AUTOHSCROLL,
                         20, 336, 650, 26, kCheckout);
    browseButton_ = make(0, L"BUTTON", L"Browse...", WS_CHILD | WS_VISIBLE | WS_TABSTOP,
                         680, 336, 85, 26, kBrowse);
    discoverButton_ = make(0, L"BUTTON", L"Load settings", WS_CHILD | WS_VISIBLE | WS_TABSTOP,
                           775, 336, 85, 26, kDiscover);

    sourceFirst_ = !FindPayload({L"fullmag-installer-environment.exe"}).empty();
    bootstrapMode_ = sourceFirst_ ? EngineVariable(L"FullmagBootstrapMode") : std::wstring{};
    receiptPath_ = sourceFirst_ ? EngineVariable(L"FullmagReceiptPath") : std::wstring{};
    if (sourceFirst_ && bootstrapMode_.empty()) {
        const std::wstring provenance = FindPayload({L"fullmag-installer-provenance.json"});
        std::wstring provenanceText;
        JsonReader::Value provenanceRoot;
        if (!provenance.empty() && ReadTextFile(provenance, &provenanceText) &&
            JsonReader(provenanceText).Parse(&provenanceRoot)) {
            if (const JsonReader::Value* source = provenanceRoot.Get(L"source_first")) {
                bootstrapMode_ = source->String(L"mode");
            }
        }
    }
    requestedLane_ = RequestedLane();
    make(0, L"STATIC", L"Fields from .env.example and the requirements manifest", WS_CHILD | WS_VISIBLE,
         20, 374, 560, 22, 0);
    if (sourceFirst_) {
        // The public installer owns one physical all-realizations package.
        // Runtime backend/device selection happens in the application after
        // installation; there is no lane selector at this boundary.
        make(0, L"STATIC", L"Installation scope: all FDM/FEM CPU/GPU support",
             WS_CHILD | WS_VISIBLE, 600, 374, 260, 22, 0);
        laneCombo_ = nullptr;
        storageRootLabel_ = make(0, L"STATIC", L"Storage root (required before Git/Python bootstrap):",
                                 WS_CHILD | WS_VISIBLE, 20, 400, 460, 22, 0);
        storageRootEdit_ = make(WS_EX_CLIENTEDGE, L"EDIT", L"", WS_CHILD | WS_VISIBLE | WS_TABSTOP |
                                    ES_AUTOHSCROLL, 20, 424, 840, 26, kStorageRoot);
    } else {
        make(0, L"STATIC", (L"Requested lane: " + requestedLane_).c_str(), WS_CHILD | WS_VISIBLE,
             600, 374, 260, 22, 0);
    }

    const int fieldPanelTop = sourceFirst_ ? kFieldPanelSourceTop : kFieldPanelRuntimeTop;
    const int fieldPanelHeight = sourceFirst_ ? 100 : 160;
    fieldPanel_ = CreateWindowExW(WS_EX_CLIENTEDGE | WS_EX_CONTROLPARENT, kFieldPanelClass, L"",
                                  WS_CHILD | WS_VISIBLE | WS_VSCROLL | WS_TABSTOP |
                                      WS_CLIPCHILDREN,
                                  20, fieldPanelTop, 840, fieldPanelHeight, window, nullptr,
                                  g_module, this);
    if (!fieldPanel_) {
        fieldsTruncated_ = true;
    }

    summaryEdit_ = make(WS_EX_CLIENTEDGE, L"EDIT", L"No checkout has been read.",
                        WS_CHILD | WS_VISIBLE | WS_TABSTOP | ES_MULTILINE | ES_READONLY |
                            WS_VSCROLL | WS_HSCROLL,
                        20, 570, 840, 200, kSummary);

    previewButton_ = make(0, L"BUTTON", L"Preview .env", WS_CHILD | WS_VISIBLE | WS_TABSTOP,
                          20, 790, 120, 28, kPreview);
    commitButton_ = make(0, L"BUTTON", L"Save settings", WS_CHILD | WS_VISIBLE | WS_TABSTOP,
                         150, 790, 120, 28, kCommit);
    dependencyCheckButton_ = make(0, L"BUTTON", L"Check requirements", WS_CHILD | WS_VISIBLE | WS_TABSTOP,
                                  280, 790, 150, 28, kDependencyCheck);
    dependencyInstallButton_ = make(0, L"BUTTON",
                                    sourceFirst_ ? L"Prepare Git/Python" : L"Install dependencies",
                                    WS_CHILD | WS_VISIBLE | WS_TABSTOP,
                                    440, 790, 150, 28, kDependencyInstall);
    installButton_ = make(0, L"BUTTON", L"Install Fullmag", WS_CHILD | WS_VISIBLE | WS_TABSTOP,
                          600, 790, 120, 28, kInstall);
    launchButton_ = make(0, L"BUTTON", L"Launch Fullmag", WS_CHILD | WS_VISIBLE | WS_TABSTOP,
                         730, 790, 130, 28, kLaunch);
    for (const HWND control : {licenseText_, licenseAccepted_, checkoutEdit_, browseButton_,
                               discoverButton_, storageRootEdit_, laneCombo_, summaryEdit_,
                               previewButton_, commitButton_, dependencyCheckButton_,
                               dependencyInstallButton_, installButton_, launchButton_}) {
        SubclassContentControl(control);
    }
    EnableWindowIf(previewButton_, false);
    EnableWindowIf(commitButton_, false);
    UpdatePrerequisiteControls();
    EnableWindowIf(installButton_, false);
    EnableWindowIf(launchButton_, false);
    LayoutUi();
    SetStatus(requestedLane_.empty() ?
                  (sourceFirst_ ? L"Select your source folder before continuing." :
                   L"The runtime lane manifest is missing or inconsistent; installation is blocked.") :
                  L"Accept the license, select the main Git checkout, then read it.",
              requestedLane_.empty());
}

void FullmagBootstrapperApplication::DestroyUi() {
    for (const HWND label : fieldLabels_) {
        if (label) DestroyWindow(label);
    }
    fieldLabels_.clear();
    for (const auto& field : fieldControls_) {
        if (field.second) DestroyWindow(field.second);
    }
    fieldControls_.clear();
    if (fieldPanel_) {
        DestroyWindow(fieldPanel_);
        fieldPanel_ = nullptr;
    }
    fieldScrollOffset_ = 0;
    fieldContentHeight_ = 0;
}

LRESULT CALLBACK FullmagBootstrapperApplication::WindowProc(HWND window, UINT message,
                                                             WPARAM wParam, LPARAM lParam) {
    auto* application = reinterpret_cast<FullmagBootstrapperApplication*>(
        GetWindowLongPtrW(window, GWLP_USERDATA));
    if (message == WM_NCCREATE) {
        const auto* create = reinterpret_cast<CREATESTRUCTW*>(lParam);
        application = static_cast<FullmagBootstrapperApplication*>(create->lpCreateParams);
        SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(application));
    }
    if (!application) return DefWindowProcW(window, message, wParam, lParam);
    switch (message) {
    case WM_SIZE:
        application->LayoutUi();
        return 0;
    case WM_VSCROLL: {
        RECT client{};
        GetClientRect(window, &client);
        const int viewport = std::max(1, static_cast<int>(client.bottom - client.top));
        switch (LOWORD(wParam)) {
        case SB_LINEUP: application->ScrollContentBy(-kFieldRowHeight); break;
        case SB_LINEDOWN: application->ScrollContentBy(kFieldRowHeight); break;
        case SB_PAGEUP: application->ScrollContentBy(-viewport); break;
        case SB_PAGEDOWN: application->ScrollContentBy(viewport); break;
        case SB_TOP: application->ScrollContentTo(0); break;
        case SB_BOTTOM: application->ScrollContentTo(INT_MAX); break;
        case SB_THUMBPOSITION:
        case SB_THUMBTRACK:
            application->ScrollContentTo(static_cast<int>(HIWORD(wParam)));
            break;
        default: break;
        }
        return 0;
    }
    case WM_KEYDOWN:
        switch (wParam) {
        case VK_UP: application->ScrollContentBy(-kFieldRowHeight); return 0;
        case VK_DOWN: application->ScrollContentBy(kFieldRowHeight); return 0;
        case VK_PRIOR: application->ScrollContentBy(-160); return 0;
        case VK_NEXT: application->ScrollContentBy(160); return 0;
        case VK_HOME: application->ScrollContentTo(0); return 0;
        case VK_END: application->ScrollContentTo(INT_MAX); return 0;
        default: break;
        }
        break;
    case WM_COMMAND: {
        const WORD commandId = LOWORD(wParam);
        const WORD notification = HIWORD(wParam);
        if (commandId == kCheckout && notification == EN_CHANGE) {
            application->InvalidateEnvironmentAdmission(true);
            application->RebuildFieldControls();
            return 0;
        }
        if (commandId == kStorageRoot && notification == EN_CHANGE) {
            application->InvalidateEnvironmentAdmission(true);
            return 0;
        }
        if (commandId >= kFieldBase && notification == EN_CHANGE) {
            application->InvalidateEnvironmentAdmission(false);
            return 0;
        }
        if (commandId == kLaneCombo && notification == CBN_SELCHANGE) {
            application->InvalidateLaneAdmission();
            return 0;
        }
        if (notification == BN_CLICKED) application->HandleCommand(commandId);
        return 0;
    }
    case kUiBrokerMessage: {
        std::unique_ptr<UiBrokerMessage> brokerMessage(reinterpret_cast<UiBrokerMessage*>(lParam));
        if (!brokerMessage) return 0;
        if (application->shuttingDown_.load()) return 0;
        JsonReader::Value handshake;
        if (JsonReader(brokerMessage->json).Parse(&handshake) &&
            handshake.kind == JsonReader::Kind::Object &&
            handshake.String(L"type") == L"hello") {
            return 0;
        }
        JsonReader::Value lifecycle;
        if (JsonReader(brokerMessage->json).Parse(&lifecycle) &&
            lifecycle.kind == JsonReader::Kind::Object &&
            lifecycle.String(L"type") == L"eof") {
            if (lifecycle.String(L"schema") != FullmagInstallerUiBroker::kProtocolSchema ||
                lifecycle.String(L"version") != FullmagInstallerUiBroker::kProtocolVersion) {
                return 0;
            }
            const bool burnActive = application->installRequested_.load() ||
                application->environmentMutationLocked_ ||
                application->burnOperationContext_.valid ||
                application->burnCancelRequested_.load();
            const auto active = UiBrokerActiveOperation(application);
            application->CancelEnvironmentSession(active);
            application->MaybeSendPendingHelperCancel();
            if (!burnActive && application->engine_) {
                application->engine_->Quit(ERROR_CANCELLED);
            }
            StopUiBroker(application);
            const HWND target = application->uiWindow_.load();
            if (target) PostMessageW(target, kUiClose, 0, 0);
            return 0;
        }
        BrokerCommand command;
        std::wstring parseError;
        if (!ParseBrokerCommand(brokerMessage->json, &command, &parseError)) {
            SendUiEnvelope(application, L"error",
                           L"{\"ok\":false,\"state\":\"blocked\",\"message\":" +
                               JsonString(parseError.empty() ? L"Invalid UI command." : parseError) + L"}");
            return 0;
        }
        bool generationAccepted = false;
        {
            std::lock_guard<std::mutex> guard(g_uiBrokerLock);
            if (UiBrokerState* state = FindUiBrokerState(application)) {
                generationAccepted = command.generation == state->generation &&
                    command.revision > state->incomingRevision;
                if (generationAccepted) state->incomingRevision = command.revision;
            }
        }
        if (!generationAccepted) {
            SendBrokerReply(application, command, false, L"stale",
                            L"The UI command generation or revision is stale.");
            return 0;
        }
        const std::wstring requestedLane = Lower(command.args.String(L"lane"));
        if (!requestedLane.empty() && requestedLane != L"all") {
            SendBrokerReply(application, command, false, L"blocked", L"The installer scope must be all.");
            return 0;
        }
        // Capture the immutable operation before applying any command inputs.
        // A cancel must terminalize this request while its generation is still
        // current; otherwise the new cancel context can hide a pending UI
        // task whose completion would then be rejected as stale.
        const auto supersededOperation = UiBrokerActiveOperation(application);
        bool checkoutChanged = false;
        bool storageChanged = false;
        bool valuesChanged = false;
        bool laneChanged = false;
        if (!ApplyBrokerInputs(application, command.args, &checkoutChanged, &storageChanged,
                               &valuesChanged, &laneChanged)) {
            SendBrokerReply(application, command, false, L"blocked",
                            L"The UI command contains invalid input types.");
            return 0;
        }
        if (laneChanged) application->requestedLane_ = L"all";
        // CancelEnvironmentSession performs the single admission
        // invalidation below, after this old request has received its
        // canceled terminal. Do not advance the generation here first.
        if (command.operation != L"cancel") {
            if (checkoutChanged || storageChanged) {
                application->InvalidateEnvironmentAdmission(true);
            } else if (valuesChanged || laneChanged) {
                application->InvalidateEnvironmentAdmission(false);
            }
        }

        if (command.operation == L"status") {
            const std::wstring state = application->applyFinished_ ? L"complete" :
                (application->environmentMutationLocked_ ? L"running" : L"idle");
            const std::wstring payload = L"{\"op\":\"status\",\"ok\":true,\"state\":" +
                JsonString(state) + L",\"session_id\":" + JsonString(application->sessionId_) +
                L",\"lane\":" + JsonString(application->requestedLane_) +
                L",\"profile\":" + JsonString(application->RuntimeStorageProfile()) +
                L",\"source_first\":" + JsonBool(application->sourceFirst_) +
                L",\"environment_committed\":" + JsonBool(application->environmentCommitted_) +
                L",\"dependencies_ready\":" + JsonBool(application->dependenciesReady_) + L"}";
            SendUiEnvelope(application, L"reply", payload, command.requestId);
            return 0;
        }

        const std::vector<std::wstring> supported = {
            L"bootstrap_preadmission", L"discover", L"preview", L"commit",
            L"bootstrap_prerequisites", L"dependency_check", L"dependency_install",
            L"plan", L"apply", L"initial_build", L"launch", L"cancel", L"shutdown",
        };
        if (std::find(supported.begin(), supported.end(), command.operation) == supported.end()) {
            SendBrokerReply(application, command, false, L"blocked", L"The UI operation is unsupported.");
            return 0;
        }
        if (command.operation == L"cancel" && supersededOperation.valid) {
            // This terminal belongs to the old request_id.  The cancel
            // request receives its own terminal only after helper/Burn stop
            // confirmation, so it cannot be mistaken for a successful write
            // or completed receipt.
            SendUiTerminal(application, supersededOperation, false, L"canceled", L"",
                           L"The operation was canceled by the operator.");
        }
        if (command.operation == L"shutdown") {
            const bool burnActive = application->installRequested_.load() ||
                application->environmentMutationLocked_ ||
                application->burnOperationContext_.valid ||
                application->burnCancelRequested_.load();
            SendBrokerReply(application, command, true, L"complete",
                            L"The installer UI shutdown was accepted.");
            application->CancelEnvironmentSession(supersededOperation);
            application->MaybeSendPendingHelperCancel();
            if (!burnActive && application->engine_) {
                application->engine_->Quit(ERROR_CANCELLED);
            }
            StopUiBroker(application);
            const HWND target = application->uiWindow_.load();
            if (target) PostMessageW(target, kUiClose, 0, 0);
            return 0;
        }
        SetUiBrokerActiveOperation(application, command.requestId, command.operation,
                                   application->admissionGeneration_);
        SendBrokerReply(application, command, true, L"accepted");
        if (command.operation == L"bootstrap_preadmission") {
            application->BootstrapFreshHostPrerequisites();
        } else if (command.operation == L"discover") {
            application->DiscoverCheckout();
        } else if (command.operation == L"preview") {
            application->PreviewEnvironment(false);
        } else if (command.operation == L"commit") {
            application->PreviewEnvironment(true);
        } else if (command.operation == L"bootstrap_prerequisites") {
            application->BootstrapPrerequisites();
        } else if (command.operation == L"dependency_check") {
            application->RunDependencyCheck(false);
        } else if (command.operation == L"dependency_install") {
            application->RunDependencyCheck(true);
        } else if (command.operation == L"plan" || command.operation == L"apply" ||
                   command.operation == L"initial_build") {
            application->StartInstall(UiBrokerActiveOperation(application));
        } else if (command.operation == L"launch") {
            application->LaunchInstalledUi(UiBrokerActiveOperation(application));
        } else if (command.operation == L"cancel") {
            application->CancelEnvironmentSession(UiBrokerActiveOperation(application));
            application->MaybeSendPendingHelperCancel();
        }
        return 0;
    }
    case kUiStatus: {
        std::unique_ptr<std::wstring> status(reinterpret_cast<std::wstring*>(lParam));
        if (status) SetControlText(application->statusLabel_, *status);
        return 0;
    }
    case kUiProgress:
        if (application->progressBar_) SendMessageW(application->progressBar_, PBM_SETPOS, wParam, 0);
        return 0;
    case kUiReply:
        application->HandleHelperReply(reinterpret_cast<HelperReply*>(lParam));
        return 0;
    case kUiCancel:
        application->MaybeSendPendingHelperCancel();
        return 0;
    case kUiPlanComplete: {
        std::unique_ptr<UiPlanCompleteMessage> completion(
            reinterpret_cast<UiPlanCompleteMessage*>(lParam));
        if (completion) application->HandlePlanComplete(completion->status);
        return 0;
    }
    case kUiApplyComplete: {
        std::unique_ptr<UiApplyCompleteMessage> completion(
            reinterpret_cast<UiApplyCompleteMessage*>(lParam));
        if (completion) application->HandleApplyComplete(completion->status);
        return 0;
    }
    case kUiClose:
        PostQuitMessage(0);
        return 0;
    case WM_CLOSE:
        application->CancelEnvironmentSession();
        if (application->engine_) application->engine_->Quit(ERROR_CANCELLED);
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProcW(window, message, wParam, lParam);
}

LRESULT CALLBACK FullmagBootstrapperApplication::FieldPanelProc(HWND window, UINT message,
                                                                    WPARAM wParam, LPARAM lParam) {
    auto* application = reinterpret_cast<FullmagBootstrapperApplication*>(
        GetWindowLongPtrW(window, GWLP_USERDATA));
    if (message == WM_NCCREATE) {
        const auto* create = reinterpret_cast<CREATESTRUCTW*>(lParam);
        application = static_cast<FullmagBootstrapperApplication*>(create->lpCreateParams);
        SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(application));
    }
    if (!application) return DefWindowProcW(window, message, wParam, lParam);
    switch (message) {
    case WM_COMMAND:
        if (application->window_) {
            SendMessageW(application->window_, WM_COMMAND, wParam, lParam);
        }
        return 0;
    case WM_VSCROLL: {
        const int viewport = [&]() {
            RECT client{};
            GetClientRect(window, &client);
            return std::max(1, static_cast<int>(client.bottom - client.top));
        }();
        switch (LOWORD(wParam)) {
        case SB_LINEUP: application->ScrollFieldPanelBy(-kFieldRowHeight); break;
        case SB_LINEDOWN: application->ScrollFieldPanelBy(kFieldRowHeight); break;
        case SB_PAGEUP: application->ScrollFieldPanelBy(-viewport); break;
        case SB_PAGEDOWN: application->ScrollFieldPanelBy(viewport); break;
        case SB_TOP: application->ScrollFieldPanelTo(0); break;
        case SB_BOTTOM: application->ScrollFieldPanelTo(INT_MAX); break;
        case SB_THUMBPOSITION:
        case SB_THUMBTRACK:
            application->ScrollFieldPanelTo(static_cast<int>(HIWORD(wParam)));
            break;
        default: break;
        }
        return 0;
    }
    case WM_MOUSEWHEEL: {
        const int delta = static_cast<short>(HIWORD(wParam));
        if (delta != 0) {
            const int steps = delta / WHEEL_DELTA != 0 ? delta / WHEEL_DELTA : (delta > 0 ? 1 : -1);
            application->ScrollFieldPanelBy(-steps * kFieldRowHeight);
        }
        return 0;
    }
    case WM_KEYDOWN:
        switch (wParam) {
        case VK_UP: application->ScrollFieldPanelBy(-kFieldRowHeight); return 0;
        case VK_DOWN: application->ScrollFieldPanelBy(kFieldRowHeight); return 0;
        case VK_PRIOR: application->ScrollFieldPanelBy(-160); return 0;
        case VK_NEXT: application->ScrollFieldPanelBy(160); return 0;
        case VK_HOME: application->ScrollFieldPanelTo(0); return 0;
        case VK_END: application->ScrollFieldPanelTo(INT_MAX); return 0;
        default: break;
        }
        break;
    default:
        break;
    }
    return DefWindowProcW(window, message, wParam, lParam);
}

void FullmagBootstrapperApplication::SubclassContentControl(HWND control) {
    if (control) {
        SetWindowSubclass(control, &FullmagBootstrapperApplication::ContentControlSubclassProc,
                          static_cast<UINT_PTR>(reinterpret_cast<ULONG_PTR>(control)),
                          reinterpret_cast<DWORD_PTR>(this));
    }
}

LRESULT CALLBACK FullmagBootstrapperApplication::ContentControlSubclassProc(
    HWND window, UINT message, WPARAM wParam, LPARAM lParam, UINT_PTR subclassId,
    DWORD_PTR refData) {
    auto* application = reinterpret_cast<FullmagBootstrapperApplication*>(refData);
    if (application && message == WM_SETFOCUS) {
        application->EnsureContentVisible(window);
    }
    const LRESULT result = DefSubclassProc(window, message, wParam, lParam);
    if (message == WM_NCDESTROY) {
        RemoveWindowSubclass(window, &FullmagBootstrapperApplication::ContentControlSubclassProc,
                             subclassId);
    }
    return result;
}

LRESULT CALLBACK FullmagBootstrapperApplication::FieldEditSubclassProc(
    HWND window, UINT message, WPARAM wParam, LPARAM lParam, UINT_PTR subclassId,
    DWORD_PTR refData) {
    auto* application = reinterpret_cast<FullmagBootstrapperApplication*>(refData);
    if (application && message == WM_SETFOCUS) {
        application->EnsureFieldVisible(window);
        application->EnsureContentVisible(window);
    }
    if (application && message == WM_KEYDOWN) {
        switch (wParam) {
        case VK_PRIOR: application->ScrollFieldPanelBy(-160); return 0;
        case VK_NEXT: application->ScrollFieldPanelBy(160); return 0;
        case VK_HOME:
            if (GetKeyState(VK_CONTROL) < 0) {
                application->ScrollFieldPanelTo(0);
                return 0;
            }
            break;
        case VK_END:
            if (GetKeyState(VK_CONTROL) < 0) {
                application->ScrollFieldPanelTo(INT_MAX);
                return 0;
            }
            break;
        default: break;
        }
    }
    const LRESULT result = DefSubclassProc(window, message, wParam, lParam);
    if (message == WM_NCDESTROY) {
        RemoveWindowSubclass(window, &FullmagBootstrapperApplication::FieldEditSubclassProc, subclassId);
    }
    return result;
}

void FullmagBootstrapperApplication::LayoutUi() {
    if (!window_) return;
    RECT client{};
    if (!GetClientRect(window_, &client)) return;
    const int requestedContentOffset = contentScrollOffset_;
    ScrollContentTo(0);
    const int contentWidth = std::max(300, static_cast<int>(client.right) - 40);
    const int fieldTop = sourceFirst_ ? kFieldPanelSourceTop : kFieldPanelRuntimeTop;
    const int panelHeight = sourceFirst_ ? 100 : 160;
    constexpr int summaryTop = 570;
    constexpr int summaryHeight = 200;
    constexpr int buttonY = 790;
    const UINT flags = SWP_NOACTIVATE | SWP_NOZORDER;

    if (progressBar_) SetWindowPos(progressBar_, nullptr, 20, 76, contentWidth, 20, flags);
    if (licenseText_) SetWindowPos(licenseText_, nullptr, 20, 136, contentWidth, 130, flags);
    if (checkoutEdit_ || browseButton_ || discoverButton_) {
        const int checkoutWidth = std::max(250, contentWidth - 210);
        if (checkoutEdit_) SetWindowPos(checkoutEdit_, nullptr, 20, 336, checkoutWidth, 26, flags);
        if (browseButton_) SetWindowPos(browseButton_, nullptr, 30 + checkoutWidth, 336, 85, 26, flags);
        if (discoverButton_) SetWindowPos(discoverButton_, nullptr, 125 + checkoutWidth, 336, 85, 26, flags);
    }
    if (storageRootEdit_) SetWindowPos(storageRootEdit_, nullptr, 20, 424, contentWidth, 26, flags);
    if (fieldPanel_) SetWindowPos(fieldPanel_, nullptr, 20, fieldTop, contentWidth, panelHeight, flags);
    if (summaryEdit_) SetWindowPos(summaryEdit_, nullptr, 20, summaryTop, contentWidth, summaryHeight, flags);

    auto moveButton = [&](HWND button, int x, int width) {
        if (button) SetWindowPos(button, nullptr, x, buttonY, width, 28, flags);
    };
    std::array<int, 6> buttonWidths{120, 120, 150, 150, 120, 130};
    int buttonGap = 10;
    if (contentWidth < 840) {
        const std::array<int, 6> minimumWidths{90, 90, 110, 110, 90, 100};
        const int minimumTotal = 0 + minimumWidths[0] + minimumWidths[1] + minimumWidths[2] +
            minimumWidths[3] + minimumWidths[4] + minimumWidths[5];
        buttonGap = 4;
        const int extraBudget = std::max(0, contentWidth - 20 - buttonGap * 5 - minimumTotal);
        const std::array<int, 6> desiredExtra{30, 30, 40, 40, 30, 30};
        constexpr int desiredExtraTotal = 200;
        for (size_t index = 0; index < buttonWidths.size(); ++index) {
            buttonWidths[index] = minimumWidths[index] +
                extraBudget * desiredExtra[index] / desiredExtraTotal;
        }
        int assigned = 0;
        for (const int width : buttonWidths) assigned += width;
        buttonWidths.back() += std::max(0, contentWidth - 20 - buttonGap * 5 - assigned);
    }
    int buttonX = 20;
    moveButton(previewButton_, buttonX, buttonWidths[0]);
    buttonX += buttonWidths[0] + buttonGap;
    moveButton(commitButton_, buttonX, buttonWidths[1]);
    buttonX += buttonWidths[1] + buttonGap;
    moveButton(dependencyCheckButton_, buttonX, buttonWidths[2]);
    buttonX += buttonWidths[2] + buttonGap;
    moveButton(dependencyInstallButton_, buttonX, buttonWidths[3]);
    buttonX += buttonWidths[3] + buttonGap;
    moveButton(installButton_, buttonX, buttonWidths[4]);
    buttonX += buttonWidths[4] + buttonGap;
    moveButton(launchButton_, buttonX, buttonWidths[5]);
    contentHeight_ = std::max(buttonY + 28 + 20, summaryTop + summaryHeight + 20);
    ScrollFieldPanelTo(fieldScrollOffset_);
    ScrollContentTo(requestedContentOffset);
}

void FullmagBootstrapperApplication::UpdateContentScrollBar() {
    if (!window_) return;
    RECT client{};
    GetClientRect(window_, &client);
    const int viewport = std::max(0, static_cast<int>(client.bottom - client.top));
    const int maximumOffset = std::max(0, contentHeight_ - viewport);
    contentScrollOffset_ = std::min(std::max(contentScrollOffset_, 0), maximumOffset);
    SCROLLINFO info{};
    info.cbSize = sizeof(info);
    info.fMask = SIF_RANGE | SIF_PAGE | SIF_POS;
    info.nMin = 0;
    info.nMax = std::max(0, contentHeight_ - 1);
    info.nPage = static_cast<UINT>(viewport);
    info.nPos = contentScrollOffset_;
    SetScrollInfo(window_, SB_VERT, &info, TRUE);
}

void FullmagBootstrapperApplication::ScrollContentTo(int offset) {
    if (!window_) return;
    RECT client{};
    if (!GetClientRect(window_, &client)) return;
    const int viewport = std::max(0, static_cast<int>(client.bottom - client.top));
    const int maximumOffset = std::max(0, contentHeight_ - viewport);
    const int nextOffset = std::min(std::max(offset, 0), maximumOffset);
    const int delta = nextOffset - contentScrollOffset_;
    if (delta != 0) {
        for (HWND child = GetWindow(window_, GW_CHILD); child != nullptr;) {
            const HWND next = GetWindow(child, GW_HWNDNEXT);
            RECT childRect{};
            if (GetWindowRect(child, &childRect)) {
                POINT position{childRect.left, childRect.top};
                if (ScreenToClient(window_, &position)) {
                    SetWindowPos(child, nullptr, position.x, position.y - delta,
                                 childRect.right - childRect.left,
                                 childRect.bottom - childRect.top,
                                 SWP_NOACTIVATE | SWP_NOZORDER);
                }
            }
            child = next;
        }
    }
    contentScrollOffset_ = nextOffset;
    UpdateContentScrollBar();
}

void FullmagBootstrapperApplication::ScrollContentBy(int delta) {
    if (delta > 0 && contentScrollOffset_ > INT_MAX - delta) {
        ScrollContentTo(INT_MAX);
        return;
    }
    if (delta < 0 && contentScrollOffset_ < INT_MIN - delta) {
        ScrollContentTo(INT_MIN);
        return;
    }
    ScrollContentTo(contentScrollOffset_ + delta);
}

void FullmagBootstrapperApplication::EnsureContentVisible(HWND control) {
    if (!window_ || !control || !IsWindow(control)) return;
    RECT client{};
    RECT controlRect{};
    if (!GetClientRect(window_, &client) || !GetWindowRect(control, &controlRect)) return;
    POINT topLeft{controlRect.left, controlRect.top};
    POINT bottomRight{controlRect.right, controlRect.bottom};
    if (!ScreenToClient(window_, &topLeft) || !ScreenToClient(window_, &bottomRight)) return;
    const int viewportTop = client.top;
    const int viewportBottom = client.bottom;
    int delta = 0;
    if (topLeft.y < viewportTop) {
        delta = topLeft.y - viewportTop;
    } else if (bottomRight.y > viewportBottom) {
        delta = bottomRight.y - viewportBottom;
    }
    if (delta != 0) ScrollContentBy(delta);
}

void FullmagBootstrapperApplication::UpdateFieldPanelScrollBar() {
    if (!fieldPanel_) return;
    RECT client{};
    GetClientRect(fieldPanel_, &client);
    const int viewport = std::max(0, static_cast<int>(client.bottom - client.top));
    const int maximumOffset = std::max(0, fieldContentHeight_ - viewport);
    fieldScrollOffset_ = std::min(std::max(fieldScrollOffset_, 0), maximumOffset);
    SCROLLINFO info{sizeof(info), SIF_RANGE | SIF_PAGE | SIF_POS, 0, 0, 0, 0, 0};
    info.nMin = 0;
    info.nMax = std::max(0, fieldContentHeight_ - 1);
    info.nPage = static_cast<UINT>(viewport);
    info.nPos = fieldScrollOffset_;
    SetScrollInfo(fieldPanel_, SB_VERT, &info, TRUE);
}

void FullmagBootstrapperApplication::ScrollFieldPanelTo(int offset) {
    if (!fieldPanel_) return;
    RECT client{};
    GetClientRect(fieldPanel_, &client);
    const int viewport = std::max(0, static_cast<int>(client.bottom - client.top));
    const int maximumOffset = std::max(0, fieldContentHeight_ - viewport);
    const int nextOffset = std::min(std::max(offset, 0), maximumOffset);
    fieldScrollOffset_ = nextOffset;
    const int editWidth = std::max(180, static_cast<int>(client.right) - 320);
    for (size_t index = 0; index < fieldControls_.size(); ++index) {
        const int y = 6 + static_cast<int>(index) * kFieldRowHeight - fieldScrollOffset_;
        if (index < fieldLabels_.size() && fieldLabels_[index]) {
            SetWindowPos(fieldLabels_[index], nullptr, 8, y, 290, 22,
                         SWP_NOACTIVATE | SWP_NOZORDER);
        }
        if (fieldControls_[index].second) {
            SetWindowPos(fieldControls_[index].second, nullptr, 310, y - 2, editWidth, 26,
                         SWP_NOACTIVATE | SWP_NOZORDER);
        }
    }
    UpdateFieldPanelScrollBar();
    InvalidateRect(fieldPanel_, nullptr, TRUE);
    const HWND focused = GetFocus();
    if (focused && (focused == fieldPanel_ || IsChild(fieldPanel_, focused))) {
        EnsureContentVisible(focused);
    }
}

void FullmagBootstrapperApplication::ScrollFieldPanelBy(int delta) {
    ScrollFieldPanelTo(fieldScrollOffset_ + delta);
}

void FullmagBootstrapperApplication::EnsureFieldVisible(HWND edit) {
    if (!fieldPanel_ || !edit) return;
    const auto found = std::find_if(fieldControls_.begin(), fieldControls_.end(),
                                    [edit](const auto& field) { return field.second == edit; });
    if (found == fieldControls_.end()) return;
    const int index = static_cast<int>(std::distance(fieldControls_.begin(), found));
    RECT client{};
    GetClientRect(fieldPanel_, &client);
    const int viewport = std::max(0, static_cast<int>(client.bottom - client.top));
    const int top = 6 + index * kFieldRowHeight;
    const int bottom = top + 26;
    int nextOffset = fieldScrollOffset_;
    if (top < nextOffset) nextOffset = top;
    if (bottom > nextOffset + viewport) nextOffset = bottom - viewport;
    ScrollFieldPanelTo(nextOffset);
}

void FullmagBootstrapperApplication::SetStatus(const std::wstring& status, bool error) {
    const std::wstring decorated = error ? L"Error: " + status : status;
    auto* message = new (std::nothrow) std::wstring(decorated);
    bool posted = false;
    {
        std::lock_guard<std::mutex> guard(stateMutex_);
        const HWND target = uiWindow_.load();
        posted = message && target &&
            PostMessageW(target, kUiStatus, 0, reinterpret_cast<LPARAM>(message)) != FALSE;
    }
    if (!posted) {
        delete message;
    }
    const auto active = UiBrokerActiveOperation(this);
    const std::wstring payload = L"{\"phase\":\"status\",\"status\":" +
        JsonString(status) + L",\"message\":" + JsonString(decorated) +
        L",\"error\":" + JsonBool(error) +
        (active.operation.empty() ? L"" : L",\"operation\":" + JsonString(active.operation)) + L"}";
    const std::wstring topLevel = L",\"ok\":" + JsonBool(!error) +
        L",\"state\":" + JsonString(error ? L"blocked" : L"running") +
        L",\"message\":" + JsonString(decorated);
    SendUiEnvelope(this, L"state", payload, active.requestId, topLevel);
}

void FullmagBootstrapperApplication::SetProgress(DWORD progress) {
    {
        std::lock_guard<std::mutex> guard(stateMutex_);
        const HWND target = uiWindow_.load();
        if (target) PostMessageW(target, kUiProgress, std::min<DWORD>(progress, 100), 0);
    }
    const auto active = UiBrokerActiveOperation(this);
    const std::wstring payload = L"{\"phase\":\"burn\",\"status\":\"running\",\"progress\":" +
        std::to_wstring(std::min<DWORD>(progress, 100)) +
        (active.operation.empty() ? L"" : L",\"operation\":" + JsonString(active.operation)) + L"}";
    const std::wstring topLevel = L",\"ok\":true,\"state\":\"running\",\"progress\":" +
        std::to_wstring(std::min<DWORD>(progress, 100));
    SendUiEnvelope(this, L"burn", payload, active.requestId, topLevel);
}

std::wstring FullmagBootstrapperApplication::ModuleDirectory() const {
    wchar_t path[32768]{};
    const DWORD length = GetModuleFileNameW(g_module, path, ARRAYSIZE(path));
    if (length == 0 || length >= ARRAYSIZE(path)) return {};
    std::wstring full(path, length);
    const size_t separator = full.find_last_of(L"\\/");
    return separator == std::wstring::npos ? std::wstring{} : full.substr(0, separator);
}

std::wstring FullmagBootstrapperApplication::FindPayload(const std::vector<std::wstring>& names) const {
    const std::wstring directory = ModuleDirectory();
    if (directory.empty()) return {};
    for (const auto& name : names) {
        const std::wstring candidate = JoinPath(directory, name);
        if (IsRegularLocalFile(candidate)) return candidate;
    }
    return {};
}

std::wstring FullmagBootstrapperApplication::EngineVariable(const wchar_t* name) const {
    if (!engine_ || !name || !*name) return {};
    DWORD required = 0;
    HRESULT status = engine_->GetVariableString(name, nullptr, &required);
    if (status != HRESULT_FROM_WIN32(ERROR_INSUFFICIENT_BUFFER) && FAILED(status)) return {};
    std::wstring value(static_cast<size_t>(required) + 1, L'\0');
    DWORD capacity = static_cast<DWORD>(value.size());
    status = engine_->GetVariableString(name, value.data(), &capacity);
    if (FAILED(status)) return {};
    const size_t terminator = value.find(L'\0');
    if (terminator != std::wstring::npos) value.resize(terminator);
    return value;
}

bool FullmagBootstrapperApplication::IsRegularLocalFile(const std::wstring& path) const {
    if (path.empty() || path.size() < 3 || path[1] != L':') return false;
    if (path.rfind(L"\\\\", 0) == 0 || path.rfind(L"//", 0) == 0) return false;
    std::wstring cursor = path;
    while (!cursor.empty()) {
        if (HasReparsePoint(cursor)) return false;
        const size_t separator = cursor.find_last_of(L"\\/");
        if (separator == std::wstring::npos || separator <= 2) break;
        cursor.resize(separator);
    }
    const DWORD attributes = GetFileAttributesW(path.c_str());
    return attributes != INVALID_FILE_ATTRIBUTES &&
           (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0 &&
           (attributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0;
}

bool FullmagBootstrapperApplication::ReadTextFile(const std::wstring& path, std::wstring* text) const {
    if (!text || !IsRegularLocalFile(path)) return false;
    HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                              FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return false;
    LARGE_INTEGER size{};
    bool success = GetFileSizeEx(file, &size) && size.QuadPart >= 0 && size.QuadPart <= 16 * 1024 * 1024;
    std::string bytes;
    if (success) {
        bytes.resize(static_cast<size_t>(size.QuadPart));
        DWORD read = 0;
        success = bytes.empty() || (ReadFile(file, bytes.data(), static_cast<DWORD>(bytes.size()), &read, nullptr) &&
                                    read == bytes.size());
    }
    CloseHandle(file);
    if (!success) return false;
    if (bytes.size() >= 3 && static_cast<unsigned char>(bytes[0]) == 0xEF &&
        static_cast<unsigned char>(bytes[1]) == 0xBB && static_cast<unsigned char>(bytes[2]) == 0xBF) {
        bytes.erase(0, 3);
    }
    *text = Wide(bytes);
    if (text->empty() && !bytes.empty()) {
        const int characters = MultiByteToWideChar(CP_ACP, 0, bytes.data(),
                                                    static_cast<int>(bytes.size()), nullptr, 0);
        if (characters > 0) {
            text->resize(static_cast<size_t>(characters));
            MultiByteToWideChar(CP_ACP, 0, bytes.data(), static_cast<int>(bytes.size()),
                                text->data(), characters);
        }
    }
    return !text->empty();
}

std::wstring FullmagBootstrapperApplication::Sha256File(const std::wstring& path) const {
    if (!IsRegularLocalFile(path)) return {};
    HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                              FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return {};
    HCRYPTPROV provider = 0;
    HCRYPTHASH hash = 0;
    bool success = CryptAcquireContextW(&provider, nullptr, nullptr, PROV_RSA_AES, CRYPT_VERIFYCONTEXT) != FALSE;
    if (success) success = CryptCreateHash(provider, CALG_SHA_256, 0, 0, &hash) != FALSE;
    std::array<BYTE, 64 * 1024> buffer{};
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
        DWORD length = 0;
        success = CryptGetHashParam(hash, HP_HASHVAL, nullptr, &length, 0) != FALSE;
        std::vector<BYTE> digest(length);
        if (success) success = CryptGetHashParam(hash, HP_HASHVAL, digest.data(), &length, 0) != FALSE;
        if (success) {
            result.reserve(length * 2);
            for (DWORD index = 0; index < length; ++index) {
                wchar_t byte[3]{};
                swprintf_s(byte, L"%02x", digest[index]);
                result += byte;
            }
        }
    }
    if (hash) CryptDestroyHash(hash);
    if (provider) CryptReleaseContext(provider, 0);
    CloseHandle(file);
    return result;
}

std::wstring FullmagBootstrapperApplication::RequestedLane() const {
    const std::wstring sourceFirstHelper = FindPayload({L"fullmag-installer-environment.exe"});
    if (!sourceFirstHelper.empty()) {
        const std::wstring provenance = FindPayload({L"fullmag-installer-provenance.json"});
        std::wstring provenanceText;
        JsonReader::Value provenanceRoot;
        if (provenance.empty() || !ReadTextFile(provenance, &provenanceText) ||
            !JsonReader(provenanceText).Parse(&provenanceRoot) ||
            !EqualsInsensitive(provenanceRoot.String(L"route"), L"source-first")) return {};
        const JsonReader::Value* source = provenanceRoot.Get(L"source_first");
        if (!source || source->kind != JsonReader::Kind::Object) return {};
        const size_t separator = sourceFirstHelper.find_last_of(L"\\/");
        const std::wstring helperName = separator == std::wstring::npos ? sourceFirstHelper :
                                         sourceFirstHelper.substr(separator + 1);
        const std::wstring helperHash = Sha256File(sourceFirstHelper);
        if (!EqualsInsensitive(source->String(L"helper_filename"), helperName) ||
            source->String(L"helper_version").empty() || source->String(L"helper_sha256").empty() ||
            helperHash.empty() || !EqualsInsensitive(source->String(L"helper_sha256"), helperHash)) return {};
        const std::wstring provenanceMode = source->String(L"mode");
        const std::wstring requestedMode = EngineVariable(L"FullmagBootstrapMode");
        if (provenanceMode.empty() || (!requestedMode.empty() &&
            !EqualsInsensitive(provenanceMode, requestedMode))) return {};
        // A source-first bundle is admitted as one physical package.  The
        // persisted Burn profile is only a historical hint and may be empty
        // on a fresh install or retain an obsolete single-lane value.  The
        // application chooses an execution realization only after install.
        return L"all";
    }
    const std::wstring manifest = FindPayload({L"fullmag-msi-stage-manifest.json"});
    const std::wstring provenance = FindPayload({L"fullmag-installer-provenance.json"});
    if (manifest.empty() || provenance.empty()) return {};

    std::wstring manifestText;
    std::wstring provenanceText;
    if (!ReadTextFile(manifest, &manifestText) || !ReadTextFile(provenance, &provenanceText)) {
        return {};
    }
    JsonReader::Value manifestRoot;
    JsonReader::Value provenanceRoot;
    if (!JsonReader(manifestText).Parse(&manifestRoot) ||
        !JsonReader(provenanceText).Parse(&provenanceRoot)) {
        return {};
    }

    if (EqualsInsensitive(manifestRoot.String(L"schema"),
                          L"fullmag.windows-full-capability-package.v1") &&
        EqualsInsensitive(manifestRoot.String(L"state"), L"completed") &&
        EqualsInsensitive(manifestRoot.String(L"profile"),
                          RuntimeProfileForLane(L"all")) &&
        EqualsInsensitive(provenanceRoot.String(L"storage_profile"),
                          RuntimeProfileForLane(L"all"))) {
        return L"all";
    }
    return {};
}

void FullmagBootstrapperApplication::HandleCommand(WORD commandId) {
    switch (commandId) {
    case kBrowse: {
        BROWSEINFOW browse{};
        browse.hwndOwner = window_;
        browse.lpszTitle = L"Select the Fullmag Git checkout";
        browse.ulFlags = BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE;
        PIDLIST_ABSOLUTE list = SHBrowseForFolderW(&browse);
        if (list) {
            wchar_t path[MAX_PATH]{};
            if (SHGetPathFromIDListW(list, path)) SetControlText(checkoutEdit_, path);
            CoTaskMemFree(list);
        }
        break;
    }
    case kDiscover:
        DiscoverCheckout();
        break;
    case kPreview:
        PreviewEnvironment(false);
        break;
    case kCommit:
        PreviewEnvironment(true);
        break;
    case kDependencyCheck:
        RunDependencyCheck(false);
        break;
    case kDependencyInstall:
        RunDependencyCheck(true);
        break;
    case kInstall:
        StartInstall();
        break;
    case kLaunch:
        LaunchInstalledUi();
        break;
    default:
        break;
    }
}

bool FullmagBootstrapperApplication::CaptureAcceptedSourceIdentity(const std::wstring& response) {
    JsonReader::Value root;
    if (!JsonReader(response).Parse(&root) || root.kind != JsonReader::Kind::Object) return false;
    const std::wstring requestedCheckout = root.String(L"requested_checkout");
    const std::wstring mainCheckout = root.String(L"main_checkout");
    const std::wstring templatePath = root.String(L"template_path");
    const std::wstring manifestPath = root.String(L"manifest_path");
    const std::wstring resolverPath = root.String(L"resolver_script");
    const std::wstring expectedTemplate = JoinPath(acceptedRequestedCheckout_, L".env.example");
    const std::wstring expectedManifest = JoinPath(acceptedRequestedCheckout_,
                                                    L"windows_build_requirements.json");
    const std::wstring expectedResolver = JoinPath(acceptedRequestedCheckout_,
                                                   L"scripts\\fullmag_storage.py");
    if (requestedCheckout.empty() || mainCheckout.empty() || templatePath.empty() ||
        manifestPath.empty() || resolverPath.empty() ||
        !EqualsInsensitive(requestedCheckout, acceptedRequestedCheckout_) ||
        !EqualsInsensitive(mainCheckout, acceptedMainCheckout_) ||
        !EqualsInsensitive(templatePath, expectedTemplate) ||
        !EqualsInsensitive(manifestPath, expectedManifest) ||
        !EqualsInsensitive(resolverPath, expectedResolver)) {
        return false;
    }

    const std::wstring templateHash = root.String(L"template_hash");
    const std::wstring manifestHash = root.String(L"manifest_hash");
    const std::wstring resolverHash = root.String(L"resolver_hash");
    const std::wstring mainGitTop = root.String(L"git_top");
    const std::wstring mainGitHead = root.String(L"git_head");
    const std::wstring mainGitWorktreesHash = root.String(L"git_worktrees_hash");
    const std::wstring requestedGitTop = root.String(L"requested_git_top");
    const std::wstring requestedGitHead = root.String(L"requested_git_head");
    const std::wstring requestedGitWorktreesHash = root.String(L"requested_git_worktrees_hash");
    if (!IsSha256(templateHash) || !IsSha256(manifestHash) || !IsSha256(resolverHash) ||
        !IsSha256(mainGitWorktreesHash) || !IsSha256(requestedGitWorktreesHash) ||
        !IsGitCommit(mainGitHead) || !IsGitCommit(requestedGitHead) ||
        !EqualsInsensitive(mainGitTop, acceptedMainCheckout_) ||
        !EqualsInsensitive(requestedGitTop, acceptedRequestedCheckout_)) {
        return false;
    }
    acceptedTemplatePath_ = templatePath;
    acceptedTemplateHash_ = templateHash;
    acceptedManifestPath_ = manifestPath;
    acceptedManifestHash_ = manifestHash;
    acceptedResolverPath_ = resolverPath;
    acceptedResolverHash_ = resolverHash;
    acceptedMainGitTop_ = mainGitTop;
    acceptedMainGitHead_ = mainGitHead;
    acceptedMainGitWorktreesHash_ = mainGitWorktreesHash;
    acceptedRequestedGitTop_ = requestedGitTop;
    acceptedRequestedGitHead_ = requestedGitHead;
    acceptedRequestedGitWorktreesHash_ = requestedGitWorktreesHash;
    return true;
}

void FullmagBootstrapperApplication::InvalidateEnvironmentAdmission(bool cancelSession,
                                                                    bool cancelUiOperation) {
    if (cancelUiOperation) {
        const auto active = UiBrokerActiveOperation(this);
        if (active.valid) {
            SendUiTerminal(this, active, false, L"canceled", L"",
                           L"The operation was superseded by a new admission generation.");
        }
    }
    ++admissionGeneration_;
    SetUiBrokerGeneration(this, admissionGeneration_);
    if (cancelSession && !sessionId_.empty()) pendingCancelSession_ = sessionId_;
    if (cancelSession) {
        sessionId_.clear();
        acceptedRequestedCheckout_.clear();
        acceptedMainCheckout_.clear();
        acceptedSetupScriptPath_.clear();
        acceptedSetupHash_.clear();
        acceptedTemplatePath_.clear();
        acceptedTemplateHash_.clear();
        acceptedManifestPath_.clear();
        acceptedManifestHash_.clear();
        acceptedResolverPath_.clear();
        acceptedResolverHash_.clear();
        acceptedMainGitTop_.clear();
        acceptedMainGitHead_.clear();
        acceptedMainGitWorktreesHash_.clear();
        acceptedRequestedGitTop_.clear();
        acceptedRequestedGitHead_.clear();
        acceptedRequestedGitWorktreesHash_.clear();
        acceptedStorageProfile_.clear();
        lastSessionReply_.clear();
        bootstrapGitPath_.clear();
        bootstrapPythonPath_.clear();
    }
    lastPreview_.clear();
    committedEnvironmentHash_.clear();
    committedStorageRoot_.clear();
    committedRunsRoot_.clear();
    committedValuesJson_.clear();
    sourceAdmissionPath_.clear();
    sourceAdmissionHash_.clear();
    previewIsValid_ = false;
    environmentCommitted_ = false;
    dependenciesReady_ = false;
    EnableWindowIf(commitButton_, false);
    EnableWindowIf(installButton_, false);
    if (sourceFirst_ && sessionId_.empty()) {
        ShowWindow(storageRootLabel_, SW_SHOW);
        ShowWindow(storageRootEdit_, SW_SHOW);
    }
    UpdatePrerequisiteControls();
    // Defer cancellation to the message queue. This lets a replacement
    // discover/preview request be queued behind the old session cancellation
    // without ever blocking the UI thread or racing the helper worker.
    const HWND target = uiWindow_.load();
    if (!pendingCancelSession_.empty() && target && !shuttingDown_) {
        PostMessageW(target, kUiCancel, 0, 0);
    }
}

void FullmagBootstrapperApplication::SetEnvironmentMutationLock(bool locked) {
    environmentMutationLocked_ = locked;
    const std::array<HWND, 11> inputs = {
        checkoutEdit_, browseButton_, discoverButton_, storageRootEdit_, laneCombo_,
        previewButton_, commitButton_, dependencyCheckButton_, dependencyInstallButton_,
        installButton_, fieldPanel_,
    };
    for (const HWND input : inputs) EnableWindowIf(input, !locked);
    for (const auto& field : fieldControls_) EnableWindowIf(field.second, !locked);
    if (locked) return;

    UpdatePrerequisiteControls();
    EnableWindowIf(previewButton_, !fieldsTruncated_ && !sessionId_.empty());
    EnableWindowIf(commitButton_, previewIsValid_ && !sessionId_.empty());
    EnableWindowIf(installButton_, dependenciesReady_ && environmentCommitted_ && licenseIsValid_);
}

void FullmagBootstrapperApplication::UpdatePrerequisiteControls() {
    if (!dependencyCheckButton_ || !dependencyInstallButton_) return;
    if (environmentMutationLocked_) {
        EnableWindowIf(discoverButton_, false);
        EnableWindowIf(dependencyCheckButton_, false);
        EnableWindowIf(dependencyInstallButton_, false);
        return;
    }
    const bool sessionReady = !requestedLane_.empty() && !sessionId_.empty();
    if (sourceFirst_ && sessionId_.empty()) {
        const bool checkoutReady = !GetWindowTextValue(checkoutEdit_).empty();
        const bool storageReady = !GetWindowTextValue(storageRootEdit_).empty();
        SetControlText(dependencyInstallButton_, L"Prepare Git/Python");
        EnableWindowIf(discoverButton_, false);
        EnableWindowIf(dependencyCheckButton_, false);
        EnableWindowIf(dependencyInstallButton_, checkoutReady && storageReady &&
                                             !requestedLane_.empty());
        return;
    }
    SetControlText(dependencyInstallButton_, L"Install dependencies");
    EnableWindowIf(discoverButton_, true);
    EnableWindowIf(dependencyCheckButton_, sessionReady);
    EnableWindowIf(dependencyInstallButton_, sessionReady);
}

void FullmagBootstrapperApplication::InvalidateLaneAdmission() {
    if (!sourceFirst_) return;
    requestedLane_ = L"all";
    // The lane is part of the setup/runtime admission even though it is not a
    // .env field. Invalidate pending replies and the committed proposal so an
    // old lane/storage result cannot enable installation after a selection.
    InvalidateEnvironmentAdmission(false);
    dependenciesReady_ = false;
    applyFinished_ = false;
    sourceAdmissionPath_.clear();
    sourceAdmissionHash_.clear();
    UpdatePrerequisiteControls();
    EnableWindowIf(installButton_, false);
    if (sessionId_.empty()) {
        SetStatus(L"Enter the checkout and storage root, then prepare Git/Python before reading the checkout.");
    } else {
        SetStatus(L"Installation scope is all FDM/FEM CPU/GPU support; run dependency check again before installation.");
    }
}

std::wstring FullmagBootstrapperApplication::RuntimeStorageProfile() const {
    return RuntimeProfileForLane(requestedLane_);
}

void FullmagBootstrapperApplication::RevalidateCommittedEnvironmentAsync(
    std::function<void(bool)> completion) {
    if (!helper_ || sessionId_.empty() || committedEnvironmentHash_.empty() ||
        committedStorageRoot_.empty() || committedRunsRoot_.empty() ||
        acceptedStorageProfile_.empty()) {
        SetStatus(L"The committed environment admission is incomplete; installation is blocked.", true);
        if (completion) completion(false);
        return;
    }
    const uint64_t generation = admissionGeneration_;
    const std::wstring session = sessionId_;
    const std::wstring committedHash = committedEnvironmentHash_;
    const std::wstring storageRoot = committedStorageRoot_;
    const std::wstring runsRoot = committedRunsRoot_;
    const std::wstring storageProfile = acceptedStorageProfile_;
    const std::wstring request = L"{\"op\":\"preview\",\"session_id\":" +
        JsonString(session) + L",\"values\":{}}";
    SendHelperAsync(request,
        [this, generation, session, committedHash, storageRoot, runsRoot, storageProfile,
         completion = std::move(completion)](const std::wstring& response,
                                              const std::wstring& error) mutable {
            if (generation != admissionGeneration_ || session != sessionId_) {
                if (completion) completion(false);
                return;
            }
            if (response.empty()) {
                InvalidateEnvironmentAdmission(true);
                SetStatus(error.empty() ?
                              L"The committed environment session could not be revalidated." : error,
                          true);
                if (completion) completion(false);
                return;
            }
            JsonReader::Value root;
            if (!JsonReader(response).Parse(&root) || root.kind != JsonReader::Kind::Object ||
                !root.Bool(L"valid") ||
                !EqualsInsensitive(root.String(L"proposed_hash"), committedHash) ||
                !EqualsInsensitive(root.String(L"storage_root"), storageRoot) ||
                !EqualsInsensitive(root.String(L"runs_root"), runsRoot) ||
                !EqualsInsensitive(root.String(L"storage_profile"), storageProfile)) {
                InvalidateEnvironmentAdmission(true);
                SetStatus(L"The committed environment changed after admission; read and commit it again.", true);
                if (completion) completion(false);
                return;
            }
            if (completion) completion(true);
        });
}

std::wstring FullmagBootstrapperApplication::BuildSourceFirstAdmissionJson() const {
    const auto safeText = [](const std::wstring& value) {
        return !value.empty() && value.size() <= 32768 &&
               value.find(L'\0') == std::wstring::npos &&
               value.find(L'\r') == std::wstring::npos &&
               value.find(L'\n') == std::wstring::npos;
    };
    const std::array<std::wstring, 13> textValues = {
        sessionId_, acceptedRequestedCheckout_, acceptedMainCheckout_, committedStorageRoot_,
        committedRunsRoot_, acceptedStorageProfile_, RuntimeStorageProfile(), requestedLane_,
        bootstrapMode_, acceptedSetupScriptPath_, acceptedTemplatePath_, acceptedManifestPath_,
        acceptedResolverPath_,
    };
    if (std::any_of(textValues.begin(), textValues.end(), [&](const std::wstring& value) {
            return !safeText(value);
        }) || !IsSha256(committedEnvironmentHash_) || !IsSha256(acceptedSetupHash_) ||
        !IsSha256(acceptedTemplateHash_) || !IsSha256(acceptedManifestHash_) ||
        !IsSha256(acceptedResolverHash_) || !IsSha256(acceptedMainGitWorktreesHash_) ||
        !IsSha256(acceptedRequestedGitWorktreesHash_) || !IsGitCommit(acceptedMainGitHead_) ||
        !IsGitCommit(acceptedRequestedGitHead_) ||
        !EqualsInsensitive(acceptedMainGitTop_, acceptedMainCheckout_) ||
        !EqualsInsensitive(acceptedRequestedGitTop_, acceptedRequestedCheckout_)) {
        return {};
    }
    std::wstring result = L"{";
    bool first = true;
    const auto appendString = [&](const wchar_t* key, const std::wstring& value) {
        if (!first) result += L",";
        first = false;
        result += JsonString(key) + L":" + JsonString(value);
    };
    appendString(L"schema", L"fullmag.windows-installer-source-admission.v1");
    appendString(L"version", L"1.0.0");
    appendString(L"session_id", sessionId_);
    appendString(L"requested_checkout", acceptedRequestedCheckout_);
    appendString(L"main_checkout", acceptedMainCheckout_);
    appendString(L"storage_root", committedStorageRoot_);
    appendString(L"runs_root", committedRunsRoot_);
    appendString(L"storage_profile", acceptedStorageProfile_);
    appendString(L"runtime_profile", RuntimeStorageProfile());
    appendString(L"lane", requestedLane_);
    appendString(L"bootstrap_mode", bootstrapMode_);
    appendString(L"environment_hash", committedEnvironmentHash_);
    appendString(L"setup_script_path", acceptedSetupScriptPath_);
    appendString(L"setup_hash", acceptedSetupHash_);
    appendString(L"template_path", acceptedTemplatePath_);
    appendString(L"template_hash", acceptedTemplateHash_);
    appendString(L"manifest_path", acceptedManifestPath_);
    appendString(L"manifest_hash", acceptedManifestHash_);
    appendString(L"resolver_script", acceptedResolverPath_);
    appendString(L"resolver_hash", acceptedResolverHash_);
    appendString(L"git_top", acceptedMainGitTop_);
    appendString(L"git_head", acceptedMainGitHead_);
    appendString(L"git_worktrees_hash", acceptedMainGitWorktreesHash_);
    appendString(L"requested_git_top", acceptedRequestedGitTop_);
    appendString(L"requested_git_head", acceptedRequestedGitHead_);
    appendString(L"requested_git_worktrees_hash", acceptedRequestedGitWorktreesHash_);
    if (!first) result += L",";
    result += L"\"source_identity\":{";
    result += L"\"requested_checkout\":" + JsonString(acceptedRequestedCheckout_) + L",";
    result += L"\"main_checkout\":" + JsonString(acceptedMainCheckout_) + L",";
    result += L"\"template_hash\":" + JsonString(acceptedTemplateHash_) + L",";
    result += L"\"manifest_hash\":" + JsonString(acceptedManifestHash_) + L",";
    result += L"\"resolver_hash\":" + JsonString(acceptedResolverHash_) + L",";
    result += L"\"git_top\":" + JsonString(acceptedMainGitTop_) + L",";
    result += L"\"git_head\":" + JsonString(acceptedMainGitHead_) + L",";
    result += L"\"git_worktrees_hash\":" + JsonString(acceptedMainGitWorktreesHash_) + L",";
    result += L"\"requested_git_top\":" + JsonString(acceptedRequestedGitTop_) + L",";
    result += L"\"requested_git_head\":" + JsonString(acceptedRequestedGitHead_) + L",";
    result += L"\"requested_git_worktrees_hash\":" +
              JsonString(acceptedRequestedGitWorktreesHash_) + L",";
    result += L"\"setup_hash\":" + JsonString(acceptedSetupHash_) + L"}}";
    if (result.size() > kMaxSourceAdmissionBytes) return {};
    return result;
}

bool FullmagBootstrapperApplication::WriteSourceFirstAdmission() {
    if (!sourceFirst_ || committedRunsRoot_.empty()) return false;
    if (!sourceAdmissionPath_.empty()) {
        return IsRegularLocalFile(sourceAdmissionPath_) &&
               !sourceAdmissionHash_.empty() &&
               EqualsInsensitive(Sha256File(sourceAdmissionPath_), sourceAdmissionHash_);
    }
    std::wstring runsRoot = committedRunsRoot_;
    while (runsRoot.size() > 3 && (runsRoot.back() == L'\\' || runsRoot.back() == L'/')) {
        runsRoot.pop_back();
    }
    if (!IsPathInside(committedRunsRoot_, committedStorageRoot_) ||
        HasReparsePoint(committedRunsRoot_)) {
        SetStatus(L"The resolver-owned runs root is not a safe local directory; installation is blocked.", true);
        return false;
    }
    const std::wstring admissionDirectory = JoinPath(runsRoot, L"installer-source");
    DWORD directoryAttributes = GetFileAttributesW(admissionDirectory.c_str());
    if (directoryAttributes == INVALID_FILE_ATTRIBUTES) {
        if (!CreateDirectoryW(admissionDirectory.c_str(), nullptr)) {
            directoryAttributes = GetFileAttributesW(admissionDirectory.c_str());
            if (directoryAttributes == INVALID_FILE_ATTRIBUTES) {
                SetStatus(L"The source-first admission directory could not be created; installation is blocked.", true);
                return false;
            }
        } else {
            directoryAttributes = GetFileAttributesW(admissionDirectory.c_str());
        }
    }
    if ((directoryAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
        (directoryAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
        HasReparsePoint(admissionDirectory)) {
        SetStatus(L"The source-first admission directory is unsafe; installation is blocked.", true);
        return false;
    }

    GUID admissionId{};
    wchar_t admissionGuid[64]{};
    if (FAILED(CoCreateGuid(&admissionId)) || StringFromGUID2(admissionId, admissionGuid,
                                                               ARRAYSIZE(admissionGuid)) <= 0) {
        SetStatus(L"The source-first admission identity could not be generated; installation is blocked.", true);
        return false;
    }
    const std::wstring finalPath = JoinPath(admissionDirectory,
                                            std::wstring(admissionGuid) + L".admission.json");
    const std::wstring temporaryPath = finalPath + L".tmp";
    if (!IsPathInside(finalPath, runsRoot) || !IsPathInside(temporaryPath, runsRoot) ||
        GetFileAttributesW(finalPath.c_str()) != INVALID_FILE_ATTRIBUTES) {
        SetStatus(L"The source-first admission path is unsafe or already exists; installation is blocked.", true);
        return false;
    }
    const std::wstring json = BuildSourceFirstAdmissionJson();
    const std::string bytes = Utf8(json);
    if (bytes.empty() || bytes.size() > kMaxSourceAdmissionBytes) {
        SetStatus(L"The source-first admission record is invalid or too large; installation is blocked.", true);
        return false;
    }
    HANDLE file = CreateFileW(temporaryPath.c_str(), GENERIC_WRITE,
                              FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                              CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
        SetStatus(L"The source-first admission record could not be staged; installation is blocked.", true);
        return false;
    }
    bool success = ProtectPrivateFile(temporaryPath);
    DWORD written = 0;
    if (success) {
        success = WriteFile(file, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr) != FALSE &&
                  written == bytes.size();
    }
    if (success) success = FlushFileBuffers(file) != FALSE;
    CloseHandle(file);
    if (!success || !MoveFileExW(temporaryPath.c_str(), finalPath.c_str(), MOVEFILE_WRITE_THROUGH)) {
        DeleteFileW(temporaryPath.c_str());
        SetStatus(L"The source-first admission record could not be committed atomically; installation is blocked.", true);
        return false;
    }
    if (!IsRegularLocalFile(finalPath)) {
        DeleteFileW(finalPath.c_str());
        SetStatus(L"The source-first admission record failed local-file validation; installation is blocked.", true);
        return false;
    }
    const std::wstring finalHash = Sha256File(finalPath);
    if (!IsSha256(finalHash)) {
        DeleteFileW(finalPath.c_str());
        SetStatus(L"The source-first admission record could not be hashed; installation is blocked.", true);
        return false;
    }
    sourceAdmissionPath_ = finalPath;
    sourceAdmissionHash_ = finalHash;
    return true;
}

bool FullmagBootstrapperApplication::PrepareSourceFirstBurnVariables() {
    if (!sourceFirst_) return true;
    if (!engine_ || bootstrapMode_.empty() ||
        acceptedMainCheckout_.empty() || acceptedRequestedCheckout_.empty() ||
        committedStorageRoot_.empty() || committedRunsRoot_.empty() ||
        acceptedStorageProfile_.empty() || requestedLane_.empty()) {
        SetStatus(L"The source-first Burn variables are incomplete; installation is blocked.", true);
        return false;
    }
    const std::wstring runtimeProfile = RuntimeStorageProfile();
    if (runtimeProfile.empty()) {
        SetStatus(L"The selected source-first lane has no supported runtime profile; installation is blocked.", true);
        return false;
    }
    if (!IsRegularLocalFile(acceptedSetupScriptPath_) ||
        !EqualsInsensitive(Sha256File(acceptedSetupScriptPath_), acceptedSetupHash_) ||
        !IsRegularLocalFile(acceptedTemplatePath_) ||
        !EqualsInsensitive(Sha256File(acceptedTemplatePath_), acceptedTemplateHash_) ||
        !IsRegularLocalFile(acceptedManifestPath_) ||
        !EqualsInsensitive(Sha256File(acceptedManifestPath_), acceptedManifestHash_) ||
        !IsRegularLocalFile(acceptedResolverPath_) ||
        !EqualsInsensitive(Sha256File(acceptedResolverPath_), acceptedResolverHash_)) {
        SetStatus(L"An admitted source input changed before installation; read and commit the checkout again.", true);
        return false;
    }
    // Burn persists variables across sessions. A source-first attempt must
    // always receive a new receipt path so an old failed receipt cannot be
    // mistaken for the current admission.
    GUID receiptId{};
    wchar_t receiptGuid[64]{};
    if (FAILED(CoCreateGuid(&receiptId)) || StringFromGUID2(receiptId, receiptGuid,
                                                            ARRAYSIZE(receiptGuid)) <= 0) {
        SetStatus(L"The source-first receipt path could not be generated; installation is blocked.", true);
        return false;
    }
    receiptPath_ = JoinPath(committedRunsRoot_, L"installer-source\\" +
                            std::wstring(receiptGuid) + L".json");
    auto safeLocalPath = [](const std::wstring& path) {
        if (path.size() < 3 || path[1] != L':' || path.rfind(L"\\\\", 0) == 0 ||
            path.rfind(L"//", 0) == 0) return false;
        for (size_t index = 0; index < path.size();) {
            const size_t next = path.find_first_of(L"\\/", index);
            const std::wstring component = path.substr(index, next == std::wstring::npos ?
                std::wstring::npos : next - index);
            if (component == L"..") return false;
            if (next == std::wstring::npos) break;
            index = next + 1;
        }
        std::wstring cursor = path;
        while (!cursor.empty()) {
            if (HasReparsePoint(cursor)) return false;
            const size_t separator = cursor.find_last_of(L"\\/");
            if (separator == std::wstring::npos || separator <= 2) break;
            cursor.resize(separator);
        }
        const DWORD attributes = GetFileAttributesW(path.c_str());
        return attributes == INVALID_FILE_ATTRIBUTES ||
               (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0;
    };
    std::wstring storageRoot = committedStorageRoot_;
    while (storageRoot.size() > 3 && (storageRoot.back() == L'\\' || storageRoot.back() == L'/')) storageRoot.pop_back();
    std::wstring runsRoot = committedRunsRoot_;
    while (runsRoot.size() > 3 && (runsRoot.back() == L'\\' || runsRoot.back() == L'/')) runsRoot.pop_back();
    const bool runsInsideStorage = runsRoot.size() > storageRoot.size() &&
        _wcsnicmp(runsRoot.c_str(), storageRoot.c_str(), storageRoot.size()) == 0 &&
        (runsRoot[storageRoot.size()] == L'\\' || runsRoot[storageRoot.size()] == L'/');
    if (!safeLocalPath(runsRoot) || !runsInsideStorage || !safeLocalPath(receiptPath_) ||
        receiptPath_.size() <= runsRoot.size() ||
        _wcsnicmp(receiptPath_.c_str(), runsRoot.c_str(), runsRoot.size()) != 0 ||
        (receiptPath_[runsRoot.size()] != L'\\' && receiptPath_[runsRoot.size()] != L'/')) {
        SetStatus(L"The source-first receipt path is outside the resolver-owned runs root; installation is blocked.", true);
        return false;
    }
    if (!WriteSourceFirstAdmission() || sourceAdmissionPath_.empty() || sourceAdmissionHash_.empty() ||
        !IsPathInside(sourceAdmissionPath_, runsRoot)) {
        SetStatus(L"The private source-first admission record could not be created; installation is blocked.", true);
        return false;
    }
    auto setVariable = [&](const wchar_t* name, const std::wstring& value) {
        return !value.empty() && SUCCEEDED(engine_->SetVariableString(name, value.c_str()));
    };
    if (!setVariable(L"FullmagSourceCheckout", acceptedRequestedCheckout_) ||
        !setVariable(L"FullmagStorageRoot", committedStorageRoot_) ||
        !setVariable(L"FullmagStorageProfile", runtimeProfile) ||
        !setVariable(L"FullmagBootstrapMode", bootstrapMode_) ||
        !setVariable(L"FullmagReceiptPath", receiptPath_) ||
        !setVariable(L"FullmagSourceAdmissionPath", sourceAdmissionPath_) ||
        !setVariable(L"FullmagSourceAdmissionSha256", sourceAdmissionHash_)) {
        SetStatus(L"Burn rejected the trusted source-first admission variables; installation is blocked.", true);
        return false;
    }
    return true;
}

bool FullmagBootstrapperApplication::ValidateSourceFirstReceipt() const {
    if (!sourceFirst_ || receiptPath_.empty() || committedStorageRoot_.empty() ||
        committedRunsRoot_.empty() ||
        acceptedStorageProfile_.empty() || requestedLane_.empty() ||
        sourceAdmissionPath_.empty() || !IsSha256(sourceAdmissionHash_)) return false;
    std::wstring root = committedRunsRoot_;
    while (root.size() > 3 && (root.back() == L'\\' || root.back() == L'/')) root.pop_back();
    if (receiptPath_.size() <= root.size() ||
        _wcsnicmp(receiptPath_.c_str(), root.c_str(), root.size()) != 0 ||
        (receiptPath_[root.size()] != L'\\' && receiptPath_[root.size()] != L'/') ||
        !IsRegularLocalFile(receiptPath_) || !IsPathInside(sourceAdmissionPath_, root) ||
        !IsRegularLocalFile(sourceAdmissionPath_) ||
        !EqualsInsensitive(Sha256File(sourceAdmissionPath_), sourceAdmissionHash_)) return false;
    std::wstring text;
    JsonReader::Value receipt;
    if (!ReadTextFile(receiptPath_, &text) || !JsonReader(text).Parse(&receipt) ||
        receipt.kind != JsonReader::Kind::Object) return false;
    const std::wstring expectedState = EqualsInsensitive(bootstrapMode_, L"setup-only") ?
        L"setup_complete" : L"completed";
    const std::wstring receiptAdmissionPath = receipt.String(
        L"admission_path", receipt.String(L"source_admission_path"));
    const std::wstring receiptAdmissionHash = receipt.String(
        L"admission_sha256", receipt.String(L"source_admission_sha256"));
    const JsonReader::Value* receiptSession = receipt.Get(L"session");
    const std::wstring receiptSessionId = receipt.String(
        L"session_id", receiptSession ? receiptSession->String(L"session_id") : L"");
    const std::wstring receiptRunsRoot = receipt.String(L"runs_root");
    const std::wstring receiptEnvironmentHash = receipt.String(L"environment_hash");
    const std::wstring receiptLane = receipt.String(L"lane");
    const std::wstring receiptMode = receipt.String(L"bootstrap_mode", receipt.String(L"mode"));
    const std::wstring receiptCheckout = receipt.String(
        L"requested_checkout", receipt.String(L"checkout"));
    const JsonReader::Value* identity = receipt.Get(L"source_identity");
    if (!identity || identity->kind != JsonReader::Kind::Object) return false;
    const std::wstring identityRequestedCheckout = identity->String(
        L"requested_checkout", identity->String(L"checkout"));
    const std::wstring identityMainCheckout = identity->String(L"main_checkout");
    const std::wstring identityTemplateHash = identity->String(L"template_hash");
    const std::wstring identityManifestHash = identity->String(L"manifest_hash");
    const std::wstring identityResolverHash = identity->String(L"resolver_hash");
    const std::wstring identityMainGitTop = identity->String(
        L"git_top", identity->String(L"main_git_top", identityMainCheckout));
    const std::wstring identityMainGitHead = identity->String(
        L"git_head", identity->String(L"head"));
    const std::wstring identityMainGitWorktreesHash = identity->String(
        L"git_worktrees_hash", identity->String(L"worktree_listing_sha256"));
    const std::wstring identityRequestedGitTop = identity->String(
        L"requested_git_top", identityRequestedCheckout);
    const std::wstring identityRequestedGitHead = identity->String(L"requested_git_head");
    const std::wstring identityRequestedGitWorktreesHash = identity->String(
        L"requested_git_worktrees_hash");
    const std::wstring identitySetupHash = identity->String(L"setup_hash");
    const bool commonIdentity =
        EqualsInsensitive(receipt.String(L"state"), expectedState) &&
        EqualsInsensitive(receipt.String(L"profile"), RuntimeStorageProfile()) &&
        EqualsInsensitive(receiptSessionId, sessionId_) &&
        EqualsInsensitive(receiptRunsRoot, committedRunsRoot_) &&
        EqualsInsensitive(receiptEnvironmentHash, committedEnvironmentHash_) &&
        EqualsInsensitive(receiptLane, requestedLane_) &&
        EqualsInsensitive(receiptMode, bootstrapMode_) &&
        EqualsInsensitive(receipt.String(L"storage_root"), committedStorageRoot_) &&
        EqualsInsensitive(receipt.String(L"storage_profile"), acceptedStorageProfile_) &&
        EqualsInsensitive(receiptAdmissionPath, sourceAdmissionPath_) &&
        EqualsInsensitive(receiptAdmissionHash, sourceAdmissionHash_) &&
        EqualsInsensitive(receiptCheckout, acceptedRequestedCheckout_) &&
        EqualsInsensitive(receipt.String(L"main_checkout"), acceptedMainCheckout_) &&
        EqualsInsensitive(identityRequestedCheckout, acceptedRequestedCheckout_) &&
        EqualsInsensitive(identityMainCheckout, acceptedMainCheckout_) &&
        EqualsInsensitive(identityTemplateHash, acceptedTemplateHash_) &&
        EqualsInsensitive(identityManifestHash, acceptedManifestHash_) &&
        EqualsInsensitive(identityResolverHash, acceptedResolverHash_) &&
        EqualsInsensitive(identityMainGitTop, acceptedMainGitTop_) &&
        EqualsInsensitive(identityMainGitHead, acceptedMainGitHead_) &&
        EqualsInsensitive(identityMainGitWorktreesHash, acceptedMainGitWorktreesHash_) &&
        EqualsInsensitive(identityRequestedGitTop, acceptedRequestedGitTop_) &&
        EqualsInsensitive(identityRequestedGitHead, acceptedRequestedGitHead_) &&
        EqualsInsensitive(identityRequestedGitWorktreesHash, acceptedRequestedGitWorktreesHash_) &&
        EqualsInsensitive(identitySetupHash, acceptedSetupHash_) &&
        receipt.Bool(L"sanitized_output");
    if (!commonIdentity) return false;
    if (EqualsInsensitive(bootstrapMode_, L"setup-only")) {
        const JsonReader::Value* initialBuild = receipt.Get(L"initial_build");
        const JsonReader::Value* fullRuntime = receipt.Get(L"full_runtime");
        return EqualsInsensitive(receipt.String(L"schema"),
                                 L"fullmag.windows-installer-environment-receipt.v2") &&
               receipt.String(L"scope").empty() &&
               initialBuild && initialBuild->kind == JsonReader::Kind::Object &&
               !initialBuild->Bool(L"requested", true) &&
               EqualsInsensitive(initialBuild->String(L"state"), L"not_requested") &&
               (!fullRuntime || fullRuntime->kind == JsonReader::Kind::Null);
    }
    if (!EqualsInsensitive(requestedLane_, L"all")) {
        return EqualsInsensitive(receipt.String(L"schema"),
                                 L"fullmag.windows-installer-environment-receipt.v1");
    }
    if (!EqualsInsensitive(receipt.String(L"schema"),
                            L"fullmag.windows-installer-environment-receipt.v2") ||
        !EqualsInsensitive(receipt.String(L"scope"), L"all")) return false;
    const JsonReader::Value* fullRuntime = receipt.Get(L"full_runtime");
    const JsonReader::Value* support = fullRuntime ? fullRuntime->Get(L"installed_support") : nullptr;
    if (!fullRuntime || fullRuntime->kind != JsonReader::Kind::Object ||
        !support || support->kind != JsonReader::Kind::Array) return false;
    std::set<std::wstring> capabilities;
    for (const auto& entry : support->array) {
        if (entry.kind != JsonReader::Kind::String) return false;
        capabilities.insert(Lower(entry.string));
    }
    const std::set<std::wstring> expectedCapabilities = {
        L"fdm_cpu", L"fdm_gpu", L"fem_cpu", L"fem_gpu"};
    if (capabilities != expectedCapabilities ||
        !EqualsInsensitive(fullRuntime->String(L"scope"), L"all")) return false;
    const std::wstring manifestPath = fullRuntime->String(L"capability_manifest_path");
    const std::wstring manifestSha = fullRuntime->String(L"capability_manifest_sha256");
    const std::wstring aggregateSha = fullRuntime->String(L"aggregate_manifest_sha256");
    const JsonReader::Value* initialBuild = receipt.Get(L"initial_build");
    if (!IsSha256(manifestSha) || !EqualsInsensitive(manifestSha, aggregateSha) ||
        !initialBuild || initialBuild->kind != JsonReader::Kind::Object ||
        !EqualsInsensitive(manifestSha, initialBuild->String(L"expected_build_id")) ||
        !IsPathInside(manifestPath, committedStorageRoot_) ||
        !IsRegularLocalFile(manifestPath) || !EqualsInsensitive(Sha256File(manifestPath), manifestSha)) {
        return false;
    }
    const JsonReader::Value* sourceEnvironment = fullRuntime->Get(L"source_environment_receipt");
    if (!sourceEnvironment || sourceEnvironment->kind != JsonReader::Kind::Object) return false;
    const std::wstring sourceReceiptPath = sourceEnvironment->String(L"path");
    const std::wstring sourceReceiptSha = sourceEnvironment->String(L"sha256");
    return IsSha256(sourceReceiptSha) &&
           EqualsInsensitive(sourceReceiptPath, sourceAdmissionPath_) &&
           EqualsInsensitive(sourceReceiptSha, sourceAdmissionHash_) &&
           IsPathInside(sourceReceiptPath, committedRunsRoot_) &&
           IsRegularLocalFile(sourceReceiptPath) &&
           EqualsInsensitive(Sha256File(sourceReceiptPath), sourceReceiptSha);
}

void FullmagBootstrapperApplication::DiscoverCheckout() {
    const std::wstring checkout = checkoutEdit_ ? GetWindowTextValue(checkoutEdit_) :
                                                   UiBrokerCheckout(this);
    if (checkout.empty()) {
        SetStatus(L"Select an operator-owned Git checkout first.", true);
        return;
    }
    const std::wstring admittedGitPath = bootstrapGitPath_;
    const std::wstring admittedPythonPath = bootstrapPythonPath_;
    const auto requestedOperation = UiBrokerActiveOperation(this);
    InvalidateEnvironmentAdmission(true, false);
    if (requestedOperation.valid) {
        SetUiBrokerActiveOperation(this, requestedOperation.requestId,
                                   requestedOperation.operation, admissionGeneration_);
    }
    // InvalidateEnvironmentAdmission clears admission-bound tool paths. Keep
    // the preadmission result for this one immediate discover request; any
    // checkout edit clears it before a later manual request.
    bootstrapGitPath_ = admittedGitPath;
    bootstrapPythonPath_ = admittedPythonPath;
    RebuildFieldControls();
    SetStatus(L"Reading the checkout and admitting the canonical main repository...");
    const auto brokerContext = UiBrokerActiveOperation(this);
    const std::wstring helperPath = FindPayload({L"installer_env.ps1"});
    if (helperPath.empty()) {
        SetStatus(L"The installer helper payload is unavailable.", true);
        SendUiTerminal(this, brokerContext, false, L"blocked", L"",
                       L"The installer helper payload is unavailable.");
        return;
    }
    std::wstring request = L"{\"op\":\"discover\",\"helper_path\":" + JsonString(helperPath) +
        L",\"checkout_path\":" + JsonString(checkout);
    if (!bootstrapGitPath_.empty()) {
        request += L",\"git_path\":" + JsonString(bootstrapGitPath_);
    }
    if (!bootstrapPythonPath_.empty()) {
        request += L",\"python_path\":" + JsonString(bootstrapPythonPath_);
    }
    request += L"}";
    const uint64_t generation = admissionGeneration_;
    SetEnvironmentMutationLock(true);
    SendHelperAsync(request,
        [this, generation, brokerContext](const std::wstring& response, const std::wstring& error) {
            const auto unlock = [this]() { SetEnvironmentMutationLock(false); };
            if (generation != admissionGeneration_) {
                unlock();
                return;
            }
            if (response.empty()) {
                SetStatus(error.empty() ? L"The installer helper rejected the checkout." : error, true);
                SendUiTerminal(this, brokerContext, false, L"blocked", response,
                               error.empty() ? L"The installer helper rejected the checkout." : error);
                unlock();
                return;
            }
            JsonReader::Value root;
            if (!JsonReader(response).Parse(&root) || root.kind != JsonReader::Kind::Object) {
                SetStatus(L"The installer helper returned an invalid public response.", true);
                SendUiTerminal(this, brokerContext, false, L"blocked", response,
                               L"The installer helper returned an invalid public response.");
                unlock();
                return;
            }
            if (root.String(L"state") == L"blocked" || root.String(L"session_id").empty()) {
                std::wstring safeBlocker;
                if (const JsonReader::Value* blockers = root.Get(L"blockers");
                    blockers && blockers->kind == JsonReader::Kind::Array) {
                    for (const auto& blocker : blockers->array) {
                        if (blocker.kind != JsonReader::Kind::String) continue;
                        safeBlocker = SafeHelperBlockerMessage(blocker.string);
                        if (!safeBlocker.empty()) break;
                    }
                }
                const std::wstring status = safeBlocker.empty() ?
                    L"The checkout could not be admitted by the installer helper." : safeBlocker;
                SetStatus(status, true);
                SetControlText(summaryEdit_, L"Checkout admission was blocked. No .env write was attempted.\r\n" + status);
                SendUiTerminal(this, brokerContext, false, L"blocked", response, status);
                unlock();
                return;
            }
            sessionId_ = root.String(L"session_id");
            acceptedRequestedCheckout_ = root.String(L"requested_checkout");
            if (acceptedRequestedCheckout_.empty()) {
                SendUiTerminal(this, brokerContext, false, L"blocked", response,
                               L"The helper returned no canonical selected checkout.");
                InvalidateEnvironmentAdmission(true, false);
                SetStatus(L"The helper returned no canonical selected checkout.", true);
                unlock();
                return;
            }
            acceptedMainCheckout_ = root.String(L"main_checkout");
            const DWORD checkoutAttributes = GetFileAttributesW(acceptedMainCheckout_.c_str());
            if (acceptedMainCheckout_.empty() || checkoutAttributes == INVALID_FILE_ATTRIBUTES ||
                (checkoutAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
                (checkoutAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
                SendUiTerminal(this, brokerContext, false, L"blocked", response,
                               L"The helper returned an unsafe main checkout path.");
                InvalidateEnvironmentAdmission(true, false);
                SetStatus(L"The helper returned an unsafe main checkout path.", true);
                unlock();
                return;
            }
            acceptedStorageProfile_ = root.String(L"storage_profile");
            if (acceptedStorageProfile_.empty()) {
                SendUiTerminal(this, brokerContext, false, L"blocked", response,
                               L"The helper returned no storage profile for the admitted checkout.");
                InvalidateEnvironmentAdmission(true, false);
                SetStatus(L"The helper returned no storage profile for the admitted checkout.", true);
                unlock();
                return;
            }
            const DWORD requestedAttributes = GetFileAttributesW(acceptedRequestedCheckout_.c_str());
            if (requestedAttributes == INVALID_FILE_ATTRIBUTES ||
                (requestedAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
                (requestedAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
                SendUiTerminal(this, brokerContext, false, L"blocked", response,
                               L"The helper returned an unsafe selected checkout path.");
                InvalidateEnvironmentAdmission(true, false);
                SetStatus(L"The helper returned an unsafe selected checkout path.", true);
                unlock();
                return;
            }
            if (!CaptureAcceptedSourceIdentity(response)) {
                SendUiTerminal(this, brokerContext, false, L"blocked", response,
                               L"The helper did not return a complete source identity for the selected checkout.");
                InvalidateEnvironmentAdmission(true, false);
                SetStatus(L"The helper did not return a complete source identity for the selected checkout.", true);
                unlock();
                return;
            }
            acceptedSetupScriptPath_ = JoinPath(acceptedRequestedCheckout_, L"scripts\\windows\\setup_build_environment.ps1");
            acceptedSetupHash_ = Sha256File(acceptedSetupScriptPath_);
            if (acceptedSetupHash_.empty()) {
                SendUiTerminal(this, brokerContext, false, L"blocked", response,
                               L"The accepted checkout has no safe setup script.");
                InvalidateEnvironmentAdmission(true, false);
                SetStatus(L"The accepted checkout has no safe setup script.", true);
                unlock();
                return;
            }
            lastSessionReply_ = response;
            previewIsValid_ = false;
            environmentCommitted_ = false;
            dependenciesReady_ = false;
            committedStorageRoot_.clear();
            committedValuesJson_.clear();
            ShowWindow(storageRootLabel_, SW_HIDE);
            ShowWindow(storageRootEdit_, SW_HIDE);
            RebuildFieldControls();
            EnableWindowIf(previewButton_, !fieldsTruncated_);
            EnableWindowIf(commitButton_, false);
            EnableWindowIf(installButton_, false);
            UpdatePrerequisiteControls();
            std::wstring summary = L"Main checkout:\r\n" + root.String(L"main_checkout") +
                L"\r\nStorage profile: " + root.String(L"storage_profile") +
                L"\r\nManaged fields: " + std::to_wstring(fieldControls_.size()) +
                L"\r\n\r\nSecret values remain in the helper process and are never returned to the BA.";
            SetControlText(summaryEdit_, summary);
            SetStatus(root.Bool(L"python_available", true) ?
                          L"Checkout admitted. Review the fields and preview the redacted .env diff." :
                          L"Checkout admitted, but Python is missing. Use Install dependencies before previewing the .env diff.");
            SendUiTerminal(this, brokerContext, true, L"complete", response);
            unlock();
        });
}

void FullmagBootstrapperApplication::RebuildFieldControls(bool preserveValues) {
    std::map<std::wstring, std::wstring> preservedValues;
    if (preserveValues) {
        for (const auto& field : fieldControls_) {
            preservedValues.emplace(field.first, GetWindowTextValue(field.second));
        }
    }
    fieldsTruncated_ = false;
    for (const HWND label : fieldLabels_) {
        if (label) DestroyWindow(label);
    }
    fieldLabels_.clear();
    for (const auto& field : fieldControls_) {
        if (field.second) DestroyWindow(field.second);
    }
    fieldControls_.clear();
    fieldScrollOffset_ = 0;
    fieldContentHeight_ = 0;
    if (!fieldPanel_) {
        // The modern Avalonia payload owns presentation.  The BA keeps the
        // admitted field descriptor in lastSessionReply_ and receives edited
        // values over the broker; an absent legacy field panel is therefore a
        // valid headless dispatch state rather than an installation blocker.
        fieldsTruncated_ = false;
        return;
    }

    JsonReader::Value root;
    if (!JsonReader(lastSessionReply_).Parse(&root)) {
        UpdateFieldPanelScrollBar();
        return;
    }
    const JsonReader::Value* fields = root.Get(L"fields");
    if (!fields || fields->kind != JsonReader::Kind::Array || fields->array.empty()) {
        fieldsTruncated_ = true;
        EnableWindowIf(previewButton_, false);
        EnableWindowIf(commitButton_, false);
        SetStatus(L"The admitted checkout returned no editable .env fields; installation is blocked.", true);
        return;
    }

    HFONT font = static_cast<HFONT>(GetStockObject(DEFAULT_GUI_FONT));
    size_t fieldIndex = 0;
    for (const auto& field : fields->array) {
        const std::wstring key = field.String(L"key");
        if (key.empty()) {
            fieldsTruncated_ = true;
            break;
        }
        const int y = 6 + static_cast<int>(fieldIndex) * kFieldRowHeight;
        HWND label = CreateWindowExW(0, L"STATIC", key.c_str(), WS_CHILD | WS_VISIBLE,
                                     8, y, 290, 22, fieldPanel_, nullptr, g_module, nullptr);
        HWND edit = CreateWindowExW(WS_EX_CLIENTEDGE, L"EDIT", L"",
                                    WS_CHILD | WS_VISIBLE | WS_TABSTOP | ES_AUTOHSCROLL |
                                        (field.Bool(L"secret") ? ES_PASSWORD : 0),
                                    310, y - 2, 510, 26, fieldPanel_,
                                    reinterpret_cast<HMENU>(kFieldBase + static_cast<int>(fieldIndex)),
                                    g_module, nullptr);
        const bool subclassed = edit && SetWindowSubclass(
            edit, &FullmagBootstrapperApplication::FieldEditSubclassProc,
            static_cast<UINT_PTR>(kFieldBase + static_cast<int>(fieldIndex)),
            reinterpret_cast<DWORD_PTR>(this)) != FALSE;
        if (!label || !edit || !subclassed) {
            if (edit) DestroyWindow(edit);
            if (label) DestroyWindow(label);
            fieldsTruncated_ = true;
            break;
        }
        SendMessageW(label, WM_SETFONT, reinterpret_cast<WPARAM>(font), TRUE);
        SendMessageW(edit, WM_SETFONT, reinterpret_cast<WPARAM>(font), TRUE);
        const auto preserved = preservedValues.find(key);
        if (preserved != preservedValues.end()) {
            // Rebinding after prerequisite setup must retain values typed in this
            // process, including secrets. They never enter the public reply or log.
            SetControlText(edit, preserved->second);
        } else {
            const std::wstring current = field.String(L"current_value");
            if (!field.Bool(L"secret") && current != L"<unset>") SetControlText(edit, current);
        }
        fieldLabels_.push_back(label);
        fieldControls_.emplace_back(key, edit);
        ++fieldIndex;
    }
    fieldContentHeight_ = 6 + static_cast<int>(fieldControls_.size()) * kFieldRowHeight + 4;
    ScrollFieldPanelTo(0);
    if (fieldsTruncated_) {
        EnableWindowIf(previewButton_, false);
        EnableWindowIf(commitButton_, false);
        SetStatus(L"The admitted checkout declares a field the GUI could not display; installation is blocked.", true);
    }
    if (environmentMutationLocked_) SetEnvironmentMutationLock(true);
}

std::wstring FullmagBootstrapperApplication::CollectFieldValuesJson() const {
    if (!fieldPanel_ && fieldControls_.empty()) {
        return UiBrokerValues(const_cast<FullmagBootstrapperApplication*>(this));
    }
    std::wstring result = L"{";
    bool first = true;
    for (const auto& field : fieldControls_) {
        const std::wstring value = GetWindowTextValue(field.second);
        const JsonReader::Value* descriptor = nullptr;
        JsonReader::Value root;
        if (JsonReader(lastSessionReply_).Parse(&root)) {
            if (const JsonReader::Value* fields = root.Get(L"fields")) {
                for (const auto& candidate : fields->array) {
                    if (candidate.String(L"key") == field.first) {
                        descriptor = &candidate;
                        break;
                    }
                }
            }
        }
        const bool secret = descriptor && descriptor->Bool(L"secret");
        // An empty secret means "keep the current secret" in installer_env.ps1.
        if (secret && value.empty()) continue;
        if (!first) result += L",";
        first = false;
        result += JsonString(field.first) + L":" + JsonString(value);
    }
    result += L"}";
    return result;
}

void FullmagBootstrapperApplication::PreviewEnvironment(bool commit) {
    if (sessionId_.empty()) {
        SetStatus(L"Read a checkout before editing .env.", true);
        return;
    }
    if (fieldsTruncated_) {
        SetStatus(L"The .env field list does not fit the current GUI; installation is blocked.", true);
        return;
    }
    if (commit && environmentMutationLocked_) return;
    if (commit) SetEnvironmentMutationLock(true);
    SetStatus(commit ? L"Validating the .env proposal before confirmation..." :
                     L"Validating the .env proposal and storage root...");
    const uint64_t generation = admissionGeneration_;
    const std::wstring session = sessionId_;
    const std::wstring valuesJson = CollectFieldValuesJson();
    const auto brokerContext = UiBrokerActiveOperation(this);
    const std::wstring request = L"{\"op\":\"preview\",\"session_id\":" +
        JsonString(session) + L",\"values\":" +
        valuesJson + L"}";
    SendHelperAsync(request,
        [this, commit, generation, session, valuesJson, brokerContext](
            const std::wstring& response, const std::wstring& error) {
            const auto unlock = [this, commit]() {
                if (commit) SetEnvironmentMutationLock(false);
            };
            if (generation != admissionGeneration_ || session != sessionId_) {
                unlock();
                return;
            }
            if (response.empty()) {
                SetStatus(error.empty() ? L"The installer helper rejected the proposal." : error, true);
                SendUiTerminal(this, brokerContext, false, L"blocked", response,
                               error.empty() ? L"The installer helper rejected the proposal." : error);
                unlock();
                return;
            }
            JsonReader::Value root;
            if (!JsonReader(response).Parse(&root) || root.kind != JsonReader::Kind::Object) {
                SetStatus(L"The installer helper returned an invalid proposal response.", true);
                SendUiTerminal(this, brokerContext, false, L"blocked", response,
                               L"The installer helper returned an invalid proposal response.");
                unlock();
                return;
            }
            const bool valid = root.Bool(L"valid");
            const std::wstring state = root.String(L"state");
            const std::wstring diff = root.String(L"redacted_diff");
            std::wstring summary = L"State: " + state + L"\r\nValidation: " +
                (valid ? L"passed" : L"blocked") + L"\r\nStorage root: " + root.String(L"storage_root") +
                L"\r\n\r\nRedacted diff:\r\n" + diff;
            SetControlText(summaryEdit_, summary);
            lastPreview_ = response;
            // A valid proposal with no changed fields is still an admissible commit:
            // the helper returns state=unchanged and performs no write in that case.
            previewIsValid_ = valid;
            if (!commit) {
                EnableWindowIf(commitButton_, previewIsValid_);
                SetStatus(valid ? L"Preview passed. Commit only after checking the redacted diff." :
                                  L"Preview blocked. No .env write was attempted.", !valid);
                SendUiTerminal(this, brokerContext, valid, valid ? L"complete" : L"blocked", response,
                               valid ? L"" : L"The proposal is not eligible for commit.");
                return;
            }
            if (!valid) {
                SetStatus(L"The proposal is not eligible for commit.", true);
                SendUiTerminal(this, brokerContext, false, L"blocked", response,
                               L"The proposal is not eligible for commit.");
                unlock();
                return;
            }
            // The modern broker UI owns confirmation.  Keep the native prompt
            // only for the dormant compatibility form; the active message-only
            // HWND must never surface a second Win32 dialog.
            if (fieldPanel_ &&
                MessageBoxW(window_, L"Commit this redacted .env proposal to the main checkout?",
                            L"Confirm .env transaction", MB_YESNO | MB_ICONQUESTION) != IDYES) {
                SetStatus(L".env transaction canceled; no file was changed.");
                SendUiTerminal(this, brokerContext, false, L"canceled", response,
                               L".env transaction canceled; no file was changed.");
                unlock();
                return;
            }
            // The controls stay disabled from the initial commit request until
            // the replacement session is reconciled. A changed field cannot
            // cause the helper to commit an obsolete valuesJson unnoticed.
            if (generation != admissionGeneration_ || session != sessionId_ ||
                valuesJson != CollectFieldValuesJson()) {
                SendUiTerminal(this, brokerContext, false, L"canceled", L"",
                               L"The .env editor changed during validation; no stale proposal was committed.");
                InvalidateEnvironmentAdmission(true, false);
                SetStatus(L"The .env editor changed during validation; no stale proposal was committed.", true);
                unlock();
                return;
            }
            // Send the same values after explicit confirmation. The helper re-checks
            // the optimistic hash and owns backup plus atomic replacement.
            const std::wstring commitRequest = L"{\"op\":\"commit\",\"session_id\":" +
                JsonString(session) + L",\"values\":" + valuesJson + L"}";
            SendHelperAsync(commitRequest,
                [this, generation, session, valuesJson, brokerContext](
                    const std::wstring& committedResponse, const std::wstring& commitError) {
                    const auto unlock = [this]() { SetEnvironmentMutationLock(false); };
                    JsonReader::Value committed;
                    const bool parsed = !committedResponse.empty() &&
                        JsonReader(committedResponse).Parse(&committed) &&
                        committed.kind == JsonReader::Kind::Object;
                    if (generation != admissionGeneration_ || session != sessionId_) {
                        // A commit may already have replaced .env when an
                        // unexpected external mutation invalidated this UI
                        // generation. Reconcile the returned session by
                        // cancelling it, then require a fresh read instead of
                        // leaving a stale BA session active.
                        const std::wstring rebound = parsed ? committed.String(L"session_id") : L"";
                        InvalidateEnvironmentAdmission(true, false);
                        if (!rebound.empty()) {
                            pendingCancelSession_ = rebound;
                            const HWND target = uiWindow_.load();
                            if (target && !shuttingDown_) PostMessageW(target, kUiCancel, 0, 0);
                        }
                        SetStatus(L"The .env transaction completed after the editor changed; read the checkout again before continuing.", true);
                        unlock();
                        return;
                    }
                    if (committedResponse.empty()) {
                        SendUiTerminal(this, brokerContext, false, L"blocked", committedResponse,
                                       commitError.empty() ? L"The .env transaction was rejected." : commitError);
                        InvalidateEnvironmentAdmission(true, false);
                        SetStatus(commitError.empty() ? L"The .env transaction was rejected." : commitError,
                                  true);
                        unlock();
                        return;
                    }
                    if (!parsed ||
                        !committed.Bool(L"valid") ||
                        (committed.String(L"state") != L"committed" &&
                         committed.String(L"state") != L"unchanged")) {
                        SendUiTerminal(this, brokerContext, false, L"blocked", committedResponse,
                                       L"The .env transaction was rejected; product installation is blocked.");
                        InvalidateEnvironmentAdmission(true, false);
                        SetStatus(L"The .env transaction was rejected; product installation is blocked.", true);
                        unlock();
                        return;
                    }
                    const std::wstring reboundSessionId = committed.String(L"session_id");
                    const std::wstring committedStorageRoot = committed.String(L"storage_root");
                    const std::wstring committedRunsRoot = committed.String(L"runs_root");
                    const std::wstring committedStorageProfile = committed.String(L"storage_profile");
                    const std::wstring committedHash = committed.String(L"proposed_hash");
                    if (reboundSessionId.empty() || committedHash.empty() || committedStorageRoot.empty() ||
                        committedRunsRoot.empty() ||
                        !EqualsInsensitive(committedStorageProfile, acceptedStorageProfile_)) {
                        SendUiTerminal(this, brokerContext, false, L"blocked", committedResponse,
                                       L"The committed environment session or storage identity was not rebound safely.");
                        InvalidateEnvironmentAdmission(true, false);
                        SetStatus(L"The committed environment session or storage identity was not rebound safely.", true);
                        unlock();
                        return;
                    }
                    if (!CaptureAcceptedSourceIdentity(committedResponse)) {
                        SendUiTerminal(this, brokerContext, false, L"blocked", committedResponse,
                                       L"The committed session did not preserve the accepted source identity; installation is blocked.");
                        InvalidateEnvironmentAdmission(true, false);
                        SetStatus(L"The committed session did not preserve the accepted source identity; installation is blocked.", true);
                        unlock();
                        return;
                    }
                    sessionId_ = reboundSessionId;
                    committedEnvironmentHash_ = committedHash;
                    committedStorageRoot_ = committedStorageRoot;
                    committedRunsRoot_ = committedRunsRoot;
                    committedValuesJson_ = valuesJson;
                    environmentCommitted_ = true;
                    previewIsValid_ = false;
                    EnableWindowIf(commitButton_, false);
                    EnableWindowIf(installButton_, dependenciesReady_ && licenseIsValid_);
                    SetControlText(summaryEdit_, L".env transaction complete.\r\n" +
                        committed.String(L"redacted_diff"));
                    SetStatus(committed.String(L"state") == L"committed" ?
                              L".env was committed atomically with a verified backup." :
                              L".env already matched the accepted proposal.");
                    SendUiTerminal(this, brokerContext, true, L"complete", committedResponse);
                    unlock();
                });
        });
}

bool FullmagBootstrapperApplication::ValidateBootstrapPayloads(
    std::wstring* setupPath, std::wstring* manifestPath,
    std::wstring* setupHash, std::wstring* manifestHash) const {
    if (!setupPath || !manifestPath || !setupHash || !manifestHash) return false;
    const std::wstring setupPayload = FindPayload({
        L"scripts\\windows\\setup_build_environment.ps1",
        L"setup_build_environment.ps1",
    });
    const std::wstring manifestPayload = FindPayload({
        L"windows_build_requirements.json",
        L"scripts\\windows\\windows_build_requirements.json",
    });
    const std::wstring provenancePath = FindPayload({L"fullmag-installer-provenance.json"});
    if (setupPayload.empty() || manifestPayload.empty() || provenancePath.empty() ||
        !IsRegularLocalFile(setupPayload) || !IsRegularLocalFile(manifestPayload) ||
        !IsRegularLocalFile(provenancePath)) {
        return false;
    }

    std::wstring provenanceText;
    JsonReader::Value provenance;
    if (!ReadTextFile(provenancePath, &provenanceText) ||
        !JsonReader(provenanceText).Parse(&provenance) || provenance.kind != JsonReader::Kind::Object) {
        return false;
    }
    const JsonReader::Value* source = provenance.Get(L"source_first");
    if (!source || source->kind != JsonReader::Kind::Object) return false;
    const auto record = [&](const wchar_t* primary, const wchar_t* alias) -> const JsonReader::Value* {
        const JsonReader::Value* value = source->Get(primary);
        return value ? value : source->Get(alias);
    };
    // The producer keeps these records at the provenance root because the
    // same payloads are also part of the MSI route. Accept older nested
    // aliases only for bundles produced during the source-first transition.
    const JsonReader::Value* setupRecord = provenance.Get(L"prerequisite_setup");
    if (!setupRecord) setupRecord = record(L"setup_build_environment", L"setup_build_environment_script");
    const JsonReader::Value* manifestRecord = provenance.Get(L"prerequisite_manifest");
    if (!manifestRecord) manifestRecord = record(L"build_requirements_manifest", L"windows_build_requirements");
    if (!setupRecord || setupRecord->kind != JsonReader::Kind::Object ||
        !manifestRecord || manifestRecord->kind != JsonReader::Kind::Object) {
        return false;
    }
    const auto recordName = [](const JsonReader::Value* value) {
        return value->String(L"filename", value->String(L"name"));
    };
    const auto basename = [](const std::wstring& path) {
        const size_t separator = path.find_last_of(L"\\/");
        return separator == std::wstring::npos ? path : path.substr(separator + 1);
    };
    const std::wstring expectedSetupHash = setupRecord->String(L"sha256");
    const std::wstring expectedManifestHash = manifestRecord->String(L"sha256");
    if (!IsSha256(expectedSetupHash) || !IsSha256(expectedManifestHash) ||
        !EqualsInsensitive(basename(recordName(setupRecord)), basename(setupPayload)) ||
        !EqualsInsensitive(basename(recordName(manifestRecord)), basename(manifestPayload))) {
        return false;
    }
    const std::wstring actualSetupHash = Sha256File(setupPayload);
    const std::wstring actualManifestHash = Sha256File(manifestPayload);
    if (!EqualsInsensitive(actualSetupHash, expectedSetupHash) ||
        !EqualsInsensitive(actualManifestHash, expectedManifestHash)) {
        return false;
    }
    *setupPath = setupPayload;
    *manifestPath = manifestPayload;
    *setupHash = expectedSetupHash;
    *manifestHash = expectedManifestHash;
    return true;
}

bool FullmagBootstrapperApplication::BootstrapFreshHostPrerequisites() {
    if (!sourceFirst_) {
        SetStatus(L"Fresh-host prerequisite bootstrap is available only for the source-first route.", true);
        return false;
    }
    bootstrapGitPath_.clear();
    bootstrapPythonPath_.clear();
    const std::wstring rawCheckout = checkoutEdit_ ? GetWindowTextValue(checkoutEdit_) :
                                                     UiBrokerCheckout(this);
    const std::wstring rawStorageRoot = storageRootEdit_ ? GetWindowTextValue(storageRootEdit_) :
                                                            UiBrokerStorageRoot(this);
    auto normalizeLocalPath = [](const std::wstring& raw, bool allowMissing) {
        if (raw.empty() || raw.size() >= 32768 ||
            raw.find(L'\r') != std::wstring::npos || raw.find(L'\n') != std::wstring::npos ||
            raw.find(L'\0') != std::wstring::npos || raw.size() < 3 || raw[1] != L':' ||
            raw.rfind(L"\\\\", 0) == 0 || raw.rfind(L"//", 0) == 0) {
            return std::wstring{};
        }
        for (size_t cursor = 0; cursor < raw.size();) {
            const size_t end = raw.find_first_of(L"\\/", cursor);
            const std::wstring component = raw.substr(
                cursor, end == std::wstring::npos ? std::wstring::npos : end - cursor);
            if (component == L"..") return std::wstring{};
            if (end == std::wstring::npos) break;
            cursor = end + 1;
        }
        wchar_t fullPath[32768]{};
        const DWORD length = GetFullPathNameW(raw.c_str(), ARRAYSIZE(fullPath), fullPath, nullptr);
        if (length == 0 || length >= ARRAYSIZE(fullPath)) return std::wstring{};
        std::wstring value(fullPath, length);
        while (value.size() > 3 && (value.back() == L'\\' || value.back() == L'/')) value.pop_back();
        if (value.size() <= 3 && value[1] == L':' &&
            (value[2] == L'\\' || value[2] == L'/')) return std::wstring{};
        const DWORD attributes = GetFileAttributesW(value.c_str());
        if (attributes == INVALID_FILE_ATTRIBUTES) {
            if (!allowMissing) return std::wstring{};
        } else if ((attributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
                   (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
            return std::wstring{};
        }
        std::wstring probe = value;
        while (!probe.empty()) {
            if (HasReparsePoint(probe)) return std::wstring{};
            const size_t separator = probe.find_last_of(L"\\/");
            if (separator == std::wstring::npos || separator <= 2) break;
            probe.resize(separator);
        }
        return value;
    };
    const std::wstring checkout = normalizeLocalPath(rawCheckout, false);
    const std::wstring storageRoot = normalizeLocalPath(rawStorageRoot, true);
    if (checkout.empty() || storageRoot.empty()) {
        SetStatus(L"Enter an existing local Git checkout and an explicit local storage root before bootstrapping.", true);
        return false;
    }
    const DWORD gitMetadata = GetFileAttributesW(JoinPath(checkout, L".git").c_str());
    if (gitMetadata == INVALID_FILE_ATTRIBUTES || (gitMetadata & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
        SetStatus(L"The selected checkout has no safe .git metadata; no prerequisite installation was attempted.", true);
        return false;
    }

    std::wstring setupPayload;
    std::wstring manifestPayload;
    std::wstring setupHash;
    std::wstring manifestHash;
    if (!ValidateBootstrapPayloads(&setupPayload, &manifestPayload, &setupHash, &manifestHash)) {
        SetStatus(L"The bundled setup script or requirements manifest is missing or failed provenance verification.", true);
        return false;
    }
    const std::wstring checkoutSetup = JoinPath(checkout, L"scripts\\windows\\setup_build_environment.ps1");
    const std::wstring checkoutManifest = JoinPath(checkout, L"windows_build_requirements.json");
    if (!IsRegularLocalFile(checkoutSetup) || !IsRegularLocalFile(checkoutManifest) ||
        !EqualsInsensitive(Sha256File(checkoutSetup), setupHash) ||
        !EqualsInsensitive(Sha256File(checkoutManifest), manifestHash)) {
        SetStatus(L"The selected checkout does not match the hash-bound bundled bootstrap inputs; no installation was attempted.", true);
        return false;
    }
    const std::wstring helperPath = FindPayload({L"installer_env.ps1"});
    if (helperPath.empty()) {
        SetStatus(L"The installer helper payload is unavailable.", true);
        return false;
    }
    SetStatus(L"Installing the minimum Git/Python prerequisites before reading the checkout...");
    const std::wstring request = L"{\"op\":\"bootstrap_preadmission\",\"helper_path\":" +
        JsonString(helperPath) + L",\"checkout_path\":" + JsonString(checkout) +
        L",\"setup_path\":" + JsonString(checkoutSetup) + L",\"setup_hash\":" +
        JsonString(setupHash) + L",\"manifest_path\":" + JsonString(checkoutManifest) +
        L",\"manifest_hash\":" + JsonString(manifestHash) + L",\"storage_root\":" +
        JsonString(storageRoot) + L",\"lane\":" + JsonString(requestedLane_) + L"}";
    const uint64_t generation = admissionGeneration_;
    const std::wstring lane = requestedLane_;
    const auto brokerContext = UiBrokerActiveOperation(this);
    SetEnvironmentMutationLock(true);
    SendHelperAsync(request,
        [this, generation, lane, storageRoot, setupHash, manifestHash, brokerContext](
            const std::wstring& response, const std::wstring& error) {
            const auto unlock = [this]() { SetEnvironmentMutationLock(false); };
            if (generation != admissionGeneration_) {
                unlock();
                return;
            }
            if (response.empty()) {
                SetStatus(error.empty() ? L"The prerequisite bootstrap failed." : error, true);
                SendUiTerminal(this, brokerContext, false, L"blocked", response,
                               error.empty() ? L"The prerequisite bootstrap failed." : error);
                unlock();
                return;
            }
            JsonReader::Value report;
            if (!JsonReader(response).Parse(&report) || report.kind != JsonReader::Kind::Object) {
                SetStatus(L"The prerequisite bootstrap returned an invalid public report.", true);
                SendUiTerminal(this, brokerContext, false, L"blocked", response,
                               L"The prerequisite bootstrap returned an invalid public report.");
                unlock();
                return;
            }
            const JsonReader::Value* tools = report.Get(L"tools");
            const JsonReader::Value* git = tools ? tools->Get(L"git") : nullptr;
            const JsonReader::Value* python = tools ? tools->Get(L"python") : nullptr;
            const JsonReader::Value* sourceAdmitted = report.Get(L"source_admitted");
            const JsonReader::Value* envWrite = report.Get(L"env_write");
            const bool reportSafe = sourceAdmitted && sourceAdmitted->kind == JsonReader::Kind::Bool &&
                !sourceAdmitted->boolean && envWrite && envWrite->kind == JsonReader::Kind::Bool &&
                !envWrite->boolean && report.String(L"storage_resolver") == L"not_run" &&
                report.Bool(L"project_owned_writes", false) == false;
            const std::wstring gitPath = git ? git->String(L"path") : std::wstring{};
            const std::wstring pythonPath = python ? python->String(L"path") : std::wstring{};
            const bool reportComplete =
                report.String(L"schema") == L"fullmag.windows-installer-preadmission.v1" &&
                report.String(L"state") == L"complete" &&
                report.String(L"readiness") == L"prerequisites_ready" && reportSafe &&
                EqualsInsensitive(report.String(L"lane"), lane) &&
                EqualsInsensitive(report.String(L"storage_root"), storageRoot) &&
                !report.String(L"storage_profile").empty() &&
                EqualsInsensitive(report.String(L"setup_hash"), setupHash) &&
                EqualsInsensitive(report.String(L"manifest_hash"), manifestHash) &&
                report.String(L"session_id").empty() &&
                IsRegularLocalFile(gitPath) && IsRegularLocalFile(pythonPath);
            if (!reportComplete) {
                std::wstring summary = L"Fresh-host prerequisite bootstrap: " + report.String(L"state") +
                    L"\r\nSource admitted: false\r\n.env write: false\r\n";
                if (const JsonReader::Value* blockers = report.Get(L"blockers");
                    blockers && blockers->kind == JsonReader::Kind::Array) {
                    for (const auto& blocker : blockers->array) {
                        if (blocker.kind != JsonReader::Kind::String) continue;
                        const std::wstring safeBlocker = SafeHelperBlockerMessage(blocker.string);
                        if (!safeBlocker.empty()) summary += L"- " + safeBlocker + L"\r\n";
                    }
                }
                SetControlText(summaryEdit_, summary);
                SetStatus(L"Fresh-host prerequisites were not admitted; no .env write was attempted.", true);
                SendUiTerminal(this, brokerContext, false, L"blocked", response,
                               L"Fresh-host prerequisites were not admitted; no .env write was attempted.");
                unlock();
                return;
            }
            bootstrapGitPath_ = gitPath;
            bootstrapPythonPath_ = pythonPath;
            SetControlText(summaryEdit_, L"Fresh-host prerequisites ready.\r\nGit: " + gitPath +
                L"\r\nPython: " + pythonPath +
                L"\r\n\r\nSource admitted: false\r\n.env write: false\r\nStorage resolver: not_run");
            SetStatus(L"Git/Python prerequisites are ready. Reading the selected checkout now...");
            if (brokerContext.valid) {
                SendUiTerminal(this, brokerContext, true, L"complete", response);
                unlock();
                return;
            }
            unlock();
            DiscoverCheckout();
        });
    return true;
}

void FullmagBootstrapperApplication::BootstrapPrerequisites() {
    if (sourceFirst_ && sessionId_.empty()) {
        BootstrapFreshHostPrerequisites();
        return;
    }
    if (sessionId_.empty() || acceptedMainCheckout_.empty() || acceptedRequestedCheckout_.empty() ||
        requestedLane_.empty()) {
        SetStatus(L"Read a Git checkout and choose a build lane before installing prerequisites.", true);
        return;
    }
    if (fieldsTruncated_) {
        SetStatus(L"The .env field list does not fit the current GUI; prerequisite installation is blocked.", true);
        return;
    }
    SetStatus(L"Installing the minimum Git/Python prerequisites for the accepted checkout...");
    const uint64_t generation = admissionGeneration_;
    const std::wstring session = sessionId_;
    const std::wstring checkout = acceptedRequestedCheckout_;
    const std::wstring lane = requestedLane_;
    const std::wstring setupPath = acceptedSetupScriptPath_;
    const std::wstring setupHash = acceptedSetupHash_;
    const std::wstring valuesJson = CollectFieldValuesJson();
    const std::wstring request = L"{\"op\":\"bootstrap_prerequisites\",\"session_id\":" +
        JsonString(session) + L",\"checkout_path\":" + JsonString(checkout) +
        L",\"lane\":" + JsonString(lane) + L",\"setup_path\":" +
        JsonString(setupPath) + L",\"setup_hash\":" + JsonString(setupHash) +
        L",\"values\":" + valuesJson + L"}";
    const auto brokerContext = UiBrokerActiveOperation(this);
    SetEnvironmentMutationLock(true);
    SendHelperAsync(request,
        [this, generation, session, lane, checkout, setupHash, brokerContext](
            const std::wstring& response, const std::wstring& error) {
            const auto unlock = [this]() { SetEnvironmentMutationLock(false); };
            if (generation != admissionGeneration_ || session != sessionId_) {
                unlock();
                return;
            }
            if (response.empty()) {
                SetStatus(error.empty() ? L"The prerequisite bootstrap failed." : error, true);
                SendUiTerminal(this, brokerContext, false, L"blocked", response,
                               error.empty() ? L"The prerequisite bootstrap failed." : error);
                unlock();
                return;
            }
            JsonReader::Value report;
            if (!JsonReader(response).Parse(&report) || report.kind != JsonReader::Kind::Object) {
                SetStatus(L"The prerequisite bootstrap returned an invalid public report.", true);
                SendUiTerminal(this, brokerContext, false, L"blocked", response,
                               L"The prerequisite bootstrap returned an invalid public report.");
                unlock();
                return;
            }
            if (report.String(L"state") != L"complete") {
                std::wstring summary = L"Prerequisite bootstrap: " + report.String(L"state") + L"\r\n";
                if (const JsonReader::Value* blockers = report.Get(L"blockers");
                    blockers && blockers->kind == JsonReader::Kind::Array) {
                    for (const auto& blocker : blockers->array) {
                        if (blocker.kind != JsonReader::Kind::String) continue;
                        const std::wstring safeBlocker = SafeHelperBlockerMessage(blocker.string);
                        if (!safeBlocker.empty()) summary += L"- " + safeBlocker + L"\r\n";
                    }
                }
                SetControlText(summaryEdit_, summary);
                SetStatus(L"Git/Python prerequisite bootstrap is blocked; no .env write was attempted.", true);
                SendUiTerminal(this, brokerContext, false, L"blocked", response,
                               L"Git/Python prerequisite bootstrap is blocked; no .env write was attempted.");
                unlock();
                return;
            }
            const JsonReader::Value* tools = report.Get(L"tools");
            const JsonReader::Value* git = tools ? tools->Get(L"git") : nullptr;
            const JsonReader::Value* python = tools ? tools->Get(L"python") : nullptr;
            if (!tools || !git || !python ||
                !EqualsInsensitive(report.String(L"lane"), lane) ||
                !EqualsInsensitive(report.String(L"storage_profile"), acceptedStorageProfile_) ||
                report.String(L"storage_root").empty() ||
                python->String(L"path").empty() || git->String(L"path").empty()) {
                SetStatus(L"Prerequisite bootstrap returned an incomplete or mismatched report.", true);
                SendUiTerminal(this, brokerContext, false, L"blocked", response,
                               L"Prerequisite bootstrap returned an incomplete or mismatched report.");
                unlock();
                return;
            }
            const std::wstring reboundSession = report.String(L"session_id");
            if (reboundSession.empty() || !CaptureAcceptedSourceIdentity(response)) {
                SetStatus(L"Prerequisites were installed, but the checkout session could not be rebound safely.", true);
                SendUiTerminal(this, brokerContext, false, L"blocked", response,
                               L"Prerequisites were installed, but the checkout session could not be rebound safely.");
                unlock();
                return;
            }
            sessionId_ = reboundSession;
            acceptedSetupScriptPath_ = JoinPath(checkout, L"scripts\\windows\\setup_build_environment.ps1");
            acceptedSetupHash_ = Sha256File(acceptedSetupScriptPath_);
            if (acceptedSetupHash_.empty() ||
                !EqualsInsensitive(acceptedSetupHash_, setupHash)) {
                SetStatus(L"The rebound checkout has no safe setup script.", true);
                SendUiTerminal(this, brokerContext, false, L"blocked", response,
                               L"The rebound checkout has no safe setup script.");
                unlock();
                return;
            }
            lastSessionReply_ = response;
            previewIsValid_ = false;
            environmentCommitted_ = false;
            dependenciesReady_ = false;
            committedStorageRoot_.clear();
            committedRunsRoot_.clear();
            committedValuesJson_.clear();
            sourceAdmissionPath_.clear();
            sourceAdmissionHash_.clear();
            dependenciesReady_ = true;
            RebuildFieldControls(true);
            EnableWindowIf(previewButton_, !fieldsTruncated_);
            EnableWindowIf(commitButton_, false);
            EnableWindowIf(installButton_, false);
            std::wstring summary = L"Prerequisites are ready.\r\nGit: " +
                git->String(L"path") + L"\r\nPython: " + python->String(L"path") +
                L"\r\n\r\nPreview the .env proposal again; the read-only resolver still must admit the selected storage root.";
            SetControlText(summaryEdit_, summary);
            SetStatus(L"Git/Python prerequisites are ready. Preview the .env proposal again.");
            SendUiTerminal(this, brokerContext, true, L"complete", response);
            unlock();
        });
}

void FullmagBootstrapperApplication::RunDependencyCheck(bool install) {
    const auto brokerContext = UiBrokerActiveOperation(this);
    const auto block = [this, &brokerContext](const std::wstring& message) {
        SetStatus(message, true);
        SendUiTerminal(this, brokerContext, false, L"blocked", L"", message);
    };
    if (sourceFirst_ && sessionId_.empty() && install) {
        BootstrapFreshHostPrerequisites();
        return;
    }
    if (sessionId_.empty() || acceptedMainCheckout_.empty() || acceptedRequestedCheckout_.empty() ||
        acceptedStorageProfile_.empty() || requestedLane_.empty()) {
        block(L"Read and admit a Git checkout before checking dependencies.");
        return;
    }
    if (!environmentCommitted_) {
        if (install) BootstrapPrerequisites();
        else block(L"Commit the validated .env proposal before checking full dependencies. Use Install dependencies first if Python is missing.");
        return;
    }
    if (committedStorageRoot_.empty() || committedValuesJson_.empty()) {
        block(L"The committed environment admission is incomplete; read and commit the checkout again.");
        return;
    }
    const std::wstring expectedSetupProfile = SetupProfileForLane(requestedLane_);
    if (expectedSetupProfile.empty()) {
        block(L"The selected build lane has no supported storage profile; installation is blocked.");
        return;
    }
    std::wstring editedCheckout = checkoutEdit_ ? GetWindowTextValue(checkoutEdit_) :
                                                   UiBrokerCheckout(this);
    wchar_t canonicalEditedCheckout[32768]{};
    const DWORD canonicalLength = GetFullPathNameW(editedCheckout.c_str(),
                                                   ARRAYSIZE(canonicalEditedCheckout),
                                                   canonicalEditedCheckout, nullptr);
    if (canonicalLength > 0 && canonicalLength < ARRAYSIZE(canonicalEditedCheckout)) {
        editedCheckout.assign(canonicalEditedCheckout, canonicalLength);
        while (editedCheckout.size() > 3 &&
               (editedCheckout.back() == L'\\' || editedCheckout.back() == L'/')) {
            editedCheckout.pop_back();
        }
    }
    if (!EqualsInsensitive(editedCheckout, acceptedRequestedCheckout_)) {
        block(L"The checkout field changed after admission; read it again before setup.");
        return;
    }
    const DWORD checkoutAttributes = GetFileAttributesW(acceptedMainCheckout_.c_str());
    const DWORD requestedAttributes = GetFileAttributesW(acceptedRequestedCheckout_.c_str());
    if (checkoutAttributes == INVALID_FILE_ATTRIBUTES ||
        (checkoutAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
        (checkoutAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
        requestedAttributes == INVALID_FILE_ATTRIBUTES ||
        (requestedAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
        (requestedAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
        !IsRegularLocalFile(acceptedSetupScriptPath_) ||
        Sha256File(acceptedSetupScriptPath_) != acceptedSetupHash_) {
        block(L"The admitted checkout or setup script changed; read the checkout again.");
        return;
    }
    SetStatus(install ? L"Installing the accepted Windows dependencies..." :
                       L"Checking the accepted Windows dependencies...");
    const uint64_t generation = admissionGeneration_;
    const std::wstring session = sessionId_;
    const std::wstring lane = requestedLane_;
    const std::wstring storageRoot = committedStorageRoot_;
    const std::wstring storageProfile = acceptedStorageProfile_;
    const std::wstring setupPath = acceptedSetupScriptPath_;
    const std::wstring setupHash = acceptedSetupHash_;
    std::wstring request = L"{\"op\":\"setup\",\"session_id\":" + JsonString(session) +
        L",\"script_path\":" + JsonString(setupPath) +
        L",\"checkout_path\":" + JsonString(acceptedRequestedCheckout_) + L",\"lane\":" +
        JsonString(lane) + L",\"install\":" + JsonBool(install) +
        L",\"setup_hash\":" + JsonString(setupHash) +
        L",\"storage_root\":" + JsonString(storageRoot) +
        L",\"storage_profile\":" + JsonString(storageProfile) + L"}";
    SetEnvironmentMutationLock(true);
    SendHelperAsync(request,
        [this, generation, session, lane, storageRoot, expectedSetupProfile, install, brokerContext](
            const std::wstring& response, const std::wstring& error) {
            const auto unlock = [this]() { SetEnvironmentMutationLock(false); };
            if (generation != admissionGeneration_ || session != sessionId_) {
                unlock();
                return;
            }
            if (response.empty()) {
                SetStatus(error.empty() ? L"The dependency setup failed." : error, true);
                SendUiTerminal(this, brokerContext, false, L"blocked", response,
                               error.empty() ? L"The dependency setup failed." : error);
                unlock();
                return;
            }
            JsonReader::Value report;
            if (!JsonReader(response).Parse(&report) || report.kind != JsonReader::Kind::Object) {
                SetStatus(L"The dependency setup returned an invalid public report.", true);
                SendUiTerminal(this, brokerContext, false, L"blocked", response,
                               L"The dependency setup returned an invalid public report.");
                unlock();
                return;
            }
            const std::wstring reportedLane = report.String(L"lane");
            const bool laneMatches = EqualsInsensitive(reportedLane, lane);
            const bool storageMatches = EqualsInsensitive(report.String(L"storage_root"), storageRoot);
            const bool profileMatches = EqualsInsensitive(report.String(L"storage_profile"), expectedSetupProfile);
            const std::wstring readiness = report.String(L"readiness");
            const bool readinessAccepted = readiness == L"ready" ||
                (sourceFirst_ && EqualsInsensitive(bootstrapMode_, L"setup-only") &&
                 readiness == L"compiler_ready_provider_pending");
            const bool complete = report.String(L"state") == L"complete" &&
                                  readinessAccepted && laneMatches &&
                                  storageMatches && profileMatches;
            dependenciesReady_ = complete;
            std::wstring summary = L"Dependency report: " + report.String(L"state") +
                L"\r\nReadiness: " + readiness +
                L"\r\nLane: " + reportedLane +
                L" (requested " + lane + L")" +
                L"\r\nProfile: " + report.String(L"storage_profile") +
                L" (expected " + expectedSetupProfile + L")\r\n";
            if (const JsonReader::Value* blockers = report.Get(L"blockers");
                blockers && blockers->kind == JsonReader::Kind::Array) {
                summary += L"\r\nBlockers:\r\n";
                for (const auto& blocker : blockers->array) {
                    if (blocker.kind != JsonReader::Kind::String) continue;
                    const std::wstring safeBlocker = SafeHelperBlockerMessage(blocker.string);
                    if (!safeBlocker.empty()) summary += L"- " + safeBlocker + L"\r\n";
                }
            }
            SetControlText(summaryEdit_, summary);
            EnableWindowIf(installButton_, dependenciesReady_ && environmentCommitted_ && licenseIsValid_);
            SetStatus(complete ? (install ? L"Dependencies are ready after setup." :
                                  L"Dependency check passed.") :
                      (laneMatches && storageMatches && profileMatches ?
                           L"Dependency setup is incomplete; product installation remains blocked." :
                           L"Dependency setup returned a different lane or storage configuration. CPU fallback is blocked. Installation is blocked."),
                      !complete);
            SendUiTerminal(this, brokerContext, complete, complete ? L"complete" : L"blocked", response,
                           complete ? L"" : L"Dependency setup is incomplete; product installation remains blocked.");
            unlock();
        });
}

bool FullmagBootstrapperApplication::IsWebView2Installed() const {
    const std::vector<REGSAM> views = {KEY_WOW64_64KEY, KEY_WOW64_32KEY, 0};
    const std::vector<HKEY> roots = {HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    for (HKEY root : roots) {
        for (REGSAM view : views) {
            HKEY clients = nullptr;
            if (RegOpenKeyExW(root, L"SOFTWARE\\Microsoft\\EdgeUpdate\\Clients", 0,
                              KEY_READ | view, &clients) != ERROR_SUCCESS) continue;
            DWORD index = 0;
            wchar_t keyName[256]{};
            DWORD keyNameLength = ARRAYSIZE(keyName);
            while (RegEnumKeyExW(clients, index++, keyName, &keyNameLength, nullptr,
                                 nullptr, nullptr, nullptr) == ERROR_SUCCESS) {
                HKEY client = nullptr;
                if (RegOpenKeyExW(clients, keyName, 0, KEY_READ, &client) == ERROR_SUCCESS) {
                    wchar_t name[256]{};
                    DWORD nameLength = sizeof(name);
                    DWORD type = 0;
                    const LONG nameStatus = RegQueryValueExW(client, L"name", nullptr, &type,
                                                              reinterpret_cast<BYTE*>(name), &nameLength);
                    wchar_t version[128]{};
                    DWORD versionLength = sizeof(version);
                    const LONG versionStatus = RegQueryValueExW(client, L"pv", nullptr, &type,
                                                                 reinterpret_cast<BYTE*>(version), &versionLength);
                    const std::wstring product = Lower(name);
                    if (nameStatus == ERROR_SUCCESS && versionStatus == ERROR_SUCCESS &&
                        !product.empty() && product.find(L"webview2") != std::wstring::npos &&
                        version[0] != L'\0') {
                        RegCloseKey(client);
                        RegCloseKey(clients);
                        return true;
                    }
                    RegCloseKey(client);
                }
                keyNameLength = ARRAYSIZE(keyName);
            }
            RegCloseKey(clients);
        }
    }
    return false;
}

void FullmagBootstrapperApplication::StartInstall(const UiOperationContext& requestedContext) {
    const UiOperationContext context = requestedContext.valid ? requestedContext :
        UiBrokerActiveOperation(this);
    const auto block = [this, &context](const std::wstring& message) {
        SetStatus(message, true);
        SendUiTerminal(this, context, false, L"blocked", L"", message);
    };
    const bool licenseAccepted = licenseAccepted_ ?
        SendMessageW(licenseAccepted_, BM_GETCHECK, 0, 0) == BST_CHECKED :
        UiBrokerLicenseAccepted(this);
    if (!licenseIsValid_ || !licenseAccepted) {
        block(L"Accept the license before installation.");
        return;
    }
    if (sessionId_.empty() || !environmentCommitted_) {
        block(L"Commit the validated .env proposal before installation.");
        return;
    }
    if (!dependenciesReady_) {
        block(L"Run dependency check/install before installing the product.");
        return;
    }
    if (!engine_) {
        block(L"The Burn engine is unavailable; installation is blocked.");
        return;
    }
    burnOperationContext_ = context;
    burnApplyAfterPlan_ = context.operation != L"plan";
    burnCancelRequested_ = false;
    SetEnvironmentMutationLock(true);
    SetStatus(L"Revalidating the accepted .env transaction before installation...");
    RevalidateCommittedEnvironmentAsync([this, context](bool valid) {
        if (!valid || shuttingDown_ || !engine_) {
            SetEnvironmentMutationLock(false);
            if (valid || !shuttingDown_) {
                SendUiTerminal(this, context, false, L"blocked", L"",
                               L"The committed environment could not be revalidated; installation is blocked.");
            }
            return;
        }
        if (!PrepareSourceFirstBurnVariables()) {
            SetEnvironmentMutationLock(false);
            SendUiTerminal(this, context, false, L"blocked", L"",
                           L"The trusted source-first admission could not be prepared.");
            return;
        }
        installRequested_.store(true);
        SetStatus(sourceFirst_ ? L"Planning the verified source-first environment payload..." :
                                L"Planning the verified MSI payload...");
        const HRESULT status = engine_->Plan(BOOTSTRAPPER_ACTION_INSTALL);
        if (FAILED(status)) {
            installRequested_.store(false);
            SetEnvironmentMutationLock(false);
            SetStatus(L"Burn could not plan the product payload: " + HresultText(status), true);
            SendUiTerminal(this, context, false, L"blocked", L"",
                           L"Burn could not plan the product payload: " + HresultText(status));
        }
    });
}

bool FullmagBootstrapperApplication::LaunchSourceFirstUi(const UiOperationContext& requestedContext) {
    const UiOperationContext context = requestedContext.valid ? requestedContext :
        UiBrokerActiveOperation(this);
    const auto block = [this, &context](const std::wstring& message) {
        SetStatus(message, true);
        SendUiTerminal(this, context, false, L"blocked", L"", message);
    };
    if (!applyFinished_) {
        block(L"Complete the Fullmag setup before launching it.");
        return false;
    }
    if (!EqualsInsensitive(bootstrapMode_, L"initial-build") ||
        !EqualsInsensitive(requestedLane_, L"all")) {
        block(L"The browser launch requires the completed all-realizations setup.");
        return false;
    }
    if (!ValidateSourceFirstReceipt()) {
        block(L"The completed all-realizations setup could not be verified; launch is blocked.");
        return false;
    }
    const std::wstring helperPath = FindPayload({L"fullmag-installer-environment.exe"});
    if (helperPath.empty() || !IsRegularLocalFile(helperPath) ||
        acceptedRequestedCheckout_.empty() || committedStorageRoot_.empty() ||
        receiptPath_.empty() || sourceAdmissionPath_.empty() || sourceAdmissionHash_.empty()) {
        block(L"The source-first launcher payload is unavailable; launch is blocked.");
        return false;
    }
    std::wstring commandLine = QuoteWindowsArgument(helperPath) +
        L" --checkout " + QuoteWindowsArgument(acceptedRequestedCheckout_) +
        L" --storage-root " + QuoteWindowsArgument(committedStorageRoot_) +
        L" --profile " + QuoteWindowsArgument(RuntimeStorageProfile()) +
        L" --mode launch-ui" +
        L" --receipt " + QuoteWindowsArgument(receiptPath_) +
        L" --admission-path " + QuoteWindowsArgument(sourceAdmissionPath_) +
        L" --admission-sha256 " + QuoteWindowsArgument(sourceAdmissionHash_);
    std::vector<wchar_t> mutableCommand(commandLine.begin(), commandLine.end());
    mutableCommand.push_back(L'\0');
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION processInfo{};
    const BOOL created = CreateProcessW(
        helperPath.c_str(), mutableCommand.data(), nullptr, nullptr, FALSE,
        CREATE_NEW_CONSOLE | CREATE_UNICODE_ENVIRONMENT, nullptr,
        acceptedRequestedCheckout_.c_str(), &startup, &processInfo);
    if (!created) {
        block(L"The source-first launcher could not be started.");
        return false;
    }
    CloseHandle(processInfo.hThread);
    CloseHandle(processInfo.hProcess);
    SetStatus(L"Launch requested; startup status is shown in the console.");
    SendUiTerminal(this, context, true, L"complete",
                   L"{\"launch_requested\":true,\"receipt_valid\":true}");
    EnableWindowIf(launchButton_, false);
    return true;
}

void FullmagBootstrapperApplication::LaunchInstalledUi(const UiOperationContext& requestedContext) {
    const UiOperationContext context = requestedContext.valid ? requestedContext :
        UiBrokerActiveOperation(this);
    const auto block = [this, &context](const std::wstring& message) {
        SetStatus(message, true);
        SendUiTerminal(this, context, false, L"blocked", L"", message);
    };
    if (sourceFirst_) {
        LaunchSourceFirstUi(context);
        return;
    }
    if (!applyFinished_) {
        block(L"Install the product successfully before launching it.");
        return;
    }
    if (!IsWebView2Installed()) {
        block(L"Microsoft Edge WebView2 Runtime is not installed; launch is blocked.");
        return;
    }
    std::vector<std::wstring> programFilesRoots;
    wchar_t programFilesW6432[MAX_PATH]{};
    const DWORD w6432Length = GetEnvironmentVariableW(
        L"ProgramW6432", programFilesW6432, ARRAYSIZE(programFilesW6432));
    if (w6432Length > 0 && w6432Length < ARRAYSIZE(programFilesW6432)) {
        programFilesRoots.emplace_back(programFilesW6432, w6432Length);
    }
    wchar_t programFiles[MAX_PATH]{};
    if (SHGetFolderPathW(nullptr, CSIDL_PROGRAM_FILES, nullptr, SHGFP_TYPE_CURRENT,
                         programFiles) == S_OK) {
        const std::wstring fallback(programFiles);
        if (std::find(programFilesRoots.begin(), programFilesRoots.end(), fallback) ==
            programFilesRoots.end()) {
            programFilesRoots.push_back(fallback);
        }
    }
    std::wstring uiPath;
    for (const auto& root : programFilesRoots) {
        const std::wstring candidate = JoinPath(root, L"Fullmag\\bin\\fullmag-ui.exe");
        if (IsRegularLocalFile(candidate)) {
            uiPath = candidate;
            break;
        }
    }
    if (uiPath.empty()) {
        block(L"The installed UI executable is missing; launch is blocked.");
        return;
    }
    const HINSTANCE result = ShellExecuteW(window_, L"open", uiPath.c_str(), nullptr,
                                           nullptr, SW_SHOWNORMAL);
    if (reinterpret_cast<INT_PTR>(result) <= 32) {
        block(L"The installed UI could not be launched.");
        return;
    }
    SetStatus(L"Fullmag UI launched after WebView2 verification.");
    SendUiTerminal(this, context, true, L"complete",
                   L"{\"launch_requested\":true,\"receipt_valid\":true}");
}

void FullmagBootstrapperApplication::CancelEnvironmentSession(const UiOperationContext& requestedContext) {
    const UiOperationContext context = requestedContext.valid ? requestedContext :
        UiBrokerActiveOperation(this);
    const bool burnActive = installRequested_.load() || environmentMutationLocked_ ||
        burnOperationContext_.valid;
    const bool helperSessionActive = !sessionId_.empty();

    // Invalidate the admission without allowing the generation change to
    // consume the cancel request.  Rebind the cancel context to the new
    // generation so its terminal acknowledgement cannot be mistaken for the
    // operation that was just invalidated.
    const std::wstring session = sessionId_;
    InvalidateEnvironmentAdmission(true, false);
    UiOperationContext cancelContext = context;
    if (cancelContext.valid) {
        SetUiBrokerActiveOperation(this, cancelContext.requestId,
                                   cancelContext.operation, admissionGeneration_);
        cancelContext.generation = admissionGeneration_;
    }

    if (!session.empty()) {
        pendingCancelSession_ = session;
        pendingCancelOperation_ = cancelContext;
    }

    if (burnActive) {
        burnCancelOperation_ = cancelContext;
        burnCancelRequested_.store(true);
        if (engine_) {
            const HRESULT quit = engine_->Quit(ERROR_CANCELLED);
            if (FAILED(quit)) {
                burnCancelRequested_.store(false);
                SendUiTerminal(this, cancelContext, false, L"blocked", L"",
                               L"Burn could not be canceled: " + HresultText(quit));
                burnCancelOperation_ = {};
            } else {
                SetStatus(L"Burn cancellation requested; waiting for the engine to finish...");
            }
        } else {
            burnCancelRequested_.store(false);
            SendUiTerminal(this, cancelContext, false, L"blocked", L"",
                           L"The Burn engine is unavailable; cancellation is blocked.");
            burnCancelOperation_ = {};
        }
        pendingCancelSession_.clear();
        pendingCancelOperation_ = {};
        return;
    }

    if (!helperSessionActive && cancelContext.valid) {
        SendUiTerminal(this, cancelContext, true, L"canceled",
                       L"{\"canceled\":true,\"session_cancel_requested\":false}");
    }
}

void FullmagBootstrapperApplication::ShowPublicReply(const std::wstring& reply, bool error) {
    JsonReader::Value root;
    if (!JsonReader(reply).Parse(&root)) {
        SetStatus(L"The helper returned an invalid public response.", true);
        return;
    }
    const std::wstring state = root.String(L"state");
    SetStatus(state.empty() ? L"The helper completed." : state, error);
}

STDMETHODIMP_(int) FullmagBootstrapperApplication::OnDetectBegin(BOOL, DWORD) { return IDNOACTION; }
STDMETHODIMP_(int) FullmagBootstrapperApplication::OnDetectForwardCompatibleBundle(
    LPCWSTR, BOOTSTRAPPER_RELATION_TYPE, LPCWSTR, BOOL, DWORD64, int) { return IDNOACTION; }
STDMETHODIMP_(int) FullmagBootstrapperApplication::OnDetectUpdateBegin(LPCWSTR, int) { return IDNOACTION; }
STDMETHODIMP_(int) FullmagBootstrapperApplication::OnDetectUpdate(
    LPCWSTR, DWORD64, DWORD64, LPCWSTR, LPCWSTR, LPCWSTR, LPCWSTR, int) { return IDNOACTION; }
STDMETHODIMP_(void) FullmagBootstrapperApplication::OnDetectUpdateComplete(HRESULT, LPCWSTR) {}
STDMETHODIMP_(int) FullmagBootstrapperApplication::OnDetectRelatedBundle(
    LPCWSTR, BOOTSTRAPPER_RELATION_TYPE, LPCWSTR, BOOL, DWORD64, BOOTSTRAPPER_RELATED_OPERATION) {
    return IDNOACTION;
}
STDMETHODIMP_(int) FullmagBootstrapperApplication::OnDetectPackageBegin(LPCWSTR) { return IDNOACTION; }
STDMETHODIMP_(int) FullmagBootstrapperApplication::OnDetectCompatiblePackage(LPCWSTR, LPCWSTR) { return IDNOACTION; }
STDMETHODIMP_(int) FullmagBootstrapperApplication::OnDetectRelatedMsiPackage(
    LPCWSTR, LPCWSTR, BOOL, DWORD64, BOOTSTRAPPER_RELATED_OPERATION) { return IDNOACTION; }
STDMETHODIMP_(int) FullmagBootstrapperApplication::OnDetectTargetMsiPackage(
    LPCWSTR, LPCWSTR, BOOTSTRAPPER_PACKAGE_STATE) { return IDNOACTION; }
STDMETHODIMP_(int) FullmagBootstrapperApplication::OnDetectMsiFeature(
    LPCWSTR, LPCWSTR, BOOTSTRAPPER_FEATURE_STATE) { return IDNOACTION; }
STDMETHODIMP_(void) FullmagBootstrapperApplication::OnDetectPackageComplete(
    LPCWSTR, HRESULT, BOOTSTRAPPER_PACKAGE_STATE) {}
STDMETHODIMP_(void) FullmagBootstrapperApplication::OnDetectComplete(HRESULT status) {
    if (IsHresultSuccess(status) && requestedLane_.empty()) {
        SetStatus(sourceFirst_ ?
                      L"Choose your source folder to continue." :
                      L"The runtime lane manifest is missing or inconsistent; installation is blocked.",
                  !sourceFirst_);
    } else if (IsHresultSuccess(status)) {
        SetStatus(L"Burn detection completed. Select the checkout to continue.");
    }
    else SetStatus(L"Burn detection failed: " + HresultText(status), true);
}
STDMETHODIMP_(int) FullmagBootstrapperApplication::OnPlanBegin(DWORD) { return IDNOACTION; }
STDMETHODIMP_(int) FullmagBootstrapperApplication::OnPlanRelatedBundle(
    LPCWSTR, BOOTSTRAPPER_REQUEST_STATE*) { return IDNOACTION; }
STDMETHODIMP_(int) FullmagBootstrapperApplication::OnPlanPackageBegin(
    LPCWSTR, BOOTSTRAPPER_REQUEST_STATE*) { return IDNOACTION; }
STDMETHODIMP_(int) FullmagBootstrapperApplication::OnPlanCompatiblePackage(
    LPCWSTR, BOOTSTRAPPER_REQUEST_STATE*) { return IDNOACTION; }
STDMETHODIMP_(int) FullmagBootstrapperApplication::OnPlanTargetMsiPackage(
    LPCWSTR, LPCWSTR, BOOTSTRAPPER_REQUEST_STATE*) { return IDNOACTION; }
STDMETHODIMP_(int) FullmagBootstrapperApplication::OnPlanMsiFeature(
    LPCWSTR, LPCWSTR, BOOTSTRAPPER_FEATURE_STATE*) { return IDNOACTION; }
STDMETHODIMP_(void) FullmagBootstrapperApplication::OnPlanPackageComplete(
    LPCWSTR, HRESULT, BOOTSTRAPPER_PACKAGE_STATE, BOOTSTRAPPER_REQUEST_STATE,
    BOOTSTRAPPER_ACTION_STATE, BOOTSTRAPPER_ACTION_STATE) {}
STDMETHODIMP_(void) FullmagBootstrapperApplication::OnPlanComplete(HRESULT status) {
    auto* completion = new (std::nothrow) UiPlanCompleteMessage{status};
    bool posted = false;
    {
        std::lock_guard<std::mutex> guard(stateMutex_);
        const HWND target = uiWindow_.load();
        posted = completion && !shuttingDown_.load() && target &&
            PostMessageW(target, kUiPlanComplete, 0,
                         reinterpret_cast<LPARAM>(completion)) != FALSE;
    }
    if (!posted) {
        delete completion;
    }
}
STDMETHODIMP_(int) FullmagBootstrapperApplication::OnApplyBegin() {
    SetProgress(0);
    SetStatus(L"Applying product payload...");
    return IDNOACTION;
}
STDMETHODIMP_(void) FullmagBootstrapperApplication::OnApplyPhaseCount(DWORD) {}
STDMETHODIMP_(int) FullmagBootstrapperApplication::OnElevate() { return IDNOACTION; }
STDMETHODIMP_(int) FullmagBootstrapperApplication::OnProgress(DWORD progress, DWORD overallProgress) {
    SetProgress(overallProgress);
    return IDNOACTION;
}
STDMETHODIMP_(int) FullmagBootstrapperApplication::OnError(
    BOOTSTRAPPER_ERROR_TYPE, LPCWSTR, DWORD, LPCWSTR, DWORD, DWORD, LPCWSTR*, int) {
    SetStatus(L"Burn reported an installation error; the operation will fail closed.", true);
    return IDNOACTION;
}
STDMETHODIMP_(int) FullmagBootstrapperApplication::OnRegisterBegin() { return IDNOACTION; }
STDMETHODIMP_(void) FullmagBootstrapperApplication::OnRegisterComplete(HRESULT) {}
STDMETHODIMP_(int) FullmagBootstrapperApplication::OnCacheBegin() { return IDNOACTION; }
STDMETHODIMP_(int) FullmagBootstrapperApplication::OnCachePackageBegin(LPCWSTR, DWORD, DWORD64) {
    return IDNOACTION;
}
STDMETHODIMP_(int) FullmagBootstrapperApplication::OnCacheAcquireBegin(
    LPCWSTR, LPCWSTR, BOOTSTRAPPER_CACHE_OPERATION, LPCWSTR) { return IDNOACTION; }
STDMETHODIMP_(int) FullmagBootstrapperApplication::OnCacheAcquireProgress(
    LPCWSTR, LPCWSTR, DWORD64, DWORD64, DWORD overallProgress) {
    SetProgress(overallProgress);
    return IDNOACTION;
}
STDMETHODIMP_(int) FullmagBootstrapperApplication::OnResolveSource(
    LPCWSTR, LPCWSTR, LPCWSTR, LPCWSTR) { return IDNOACTION; }
STDMETHODIMP_(int) FullmagBootstrapperApplication::OnCacheAcquireComplete(
    LPCWSTR, LPCWSTR, HRESULT, int) { return IDNOACTION; }
STDMETHODIMP_(int) FullmagBootstrapperApplication::OnCacheVerifyBegin(LPCWSTR, LPCWSTR) {
    return IDNOACTION;
}
STDMETHODIMP_(int) FullmagBootstrapperApplication::OnCacheVerifyComplete(
    LPCWSTR, LPCWSTR, HRESULT, int) { return IDNOACTION; }
STDMETHODIMP_(int) FullmagBootstrapperApplication::OnCachePackageComplete(LPCWSTR, HRESULT, int) {
    return IDNOACTION;
}
STDMETHODIMP_(void) FullmagBootstrapperApplication::OnCacheComplete(HRESULT status) {
    if (FAILED(status)) SetStatus(L"Burn could not cache the product payload: " + HresultText(status), true);
}
STDMETHODIMP_(int) FullmagBootstrapperApplication::OnExecuteBegin(DWORD) { return IDNOACTION; }
STDMETHODIMP_(int) FullmagBootstrapperApplication::OnExecutePackageBegin(LPCWSTR, BOOL) {
    return IDNOACTION;
}
STDMETHODIMP_(int) FullmagBootstrapperApplication::OnExecutePatchTarget(LPCWSTR, LPCWSTR) {
    return IDNOACTION;
}
STDMETHODIMP_(int) FullmagBootstrapperApplication::OnExecuteProgress(
    LPCWSTR, DWORD, DWORD overallProgress) {
    SetProgress(overallProgress);
    return IDNOACTION;
}
STDMETHODIMP_(int) FullmagBootstrapperApplication::OnExecuteMsiMessage(
    LPCWSTR, INSTALLMESSAGE, UINT, LPCWSTR, DWORD, LPCWSTR*, int) { return IDNOACTION; }
STDMETHODIMP_(int) FullmagBootstrapperApplication::OnExecuteFilesInUse(LPCWSTR, DWORD, LPCWSTR*) {
    return IDNOACTION;
}
STDMETHODIMP_(int) FullmagBootstrapperApplication::OnExecutePackageComplete(
    LPCWSTR, HRESULT, BOOTSTRAPPER_APPLY_RESTART, int) { return IDNOACTION; }
STDMETHODIMP_(void) FullmagBootstrapperApplication::OnExecuteComplete(HRESULT status) {
    if (FAILED(status)) SetStatus(L"Product installation failed: " + HresultText(status), true);
}
STDMETHODIMP_(void) FullmagBootstrapperApplication::OnUnregisterBegin() {}
STDMETHODIMP_(void) FullmagBootstrapperApplication::OnUnregisterComplete(HRESULT) {}
STDMETHODIMP_(int) FullmagBootstrapperApplication::OnApplyComplete(
    HRESULT status, BOOTSTRAPPER_APPLY_RESTART) {
    auto* completion = new (std::nothrow) UiApplyCompleteMessage{status};
    bool posted = false;
    {
        std::lock_guard<std::mutex> guard(stateMutex_);
        const HWND target = uiWindow_.load();
        posted = completion && !shuttingDown_.load() && target &&
            PostMessageW(target, kUiApplyComplete, 0,
                         reinterpret_cast<LPARAM>(completion)) != FALSE;
    }
    if (!posted) {
        delete completion;
    }
    return IDNOACTION;
}
STDMETHODIMP_(int) FullmagBootstrapperApplication::OnLaunchApprovedExeBegin() { return IDNOACTION; }
STDMETHODIMP_(void) FullmagBootstrapperApplication::OnLaunchApprovedExeComplete(HRESULT status, DWORD) {
    if (FAILED(status)) SetStatus(L"Burn could not launch the approved executable.", true);
}

} // namespace fullmag::installer

extern "C" HRESULT WINAPI BootstrapperApplicationCreate(
    IBootstrapperEngine* engine, const BOOTSTRAPPER_COMMAND* command,
    IBootstrapperApplication** application) {
    if (!engine || !application) return E_INVALIDARG;
    *application = nullptr;
    auto* created = new (std::nothrow) fullmag::installer::FullmagBootstrapperApplication(engine, command);
    if (!created) return E_OUTOFMEMORY;
    *application = created;
    return S_OK;
}

extern "C" void WINAPI BootstrapperApplicationDestroy() {}

BOOL WINAPI DllMain(HINSTANCE module, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        g_module = module;
        DisableThreadLibraryCalls(module);
    }
    return TRUE;
}
