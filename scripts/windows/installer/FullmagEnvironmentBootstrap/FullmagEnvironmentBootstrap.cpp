#include <windows.h>
#include "resource.h"

#include <algorithm>
#include <cwctype>
#include <cwchar>
#include <map>
#include <set>
#include <string>
#include <vector>

namespace {

struct Options {
  std::wstring checkout;
  std::wstring storageRoot;
  std::wstring profile;
  std::wstring mode;
  std::wstring receipt;
  std::wstring sourceAdmission;
  std::wstring sourceAdmissionSha256;
};

void Blocked() {
  fwprintf(stderr, L"Fullmag installer environment bootstrap blocked\n");
}

bool StartsWithInsensitive(const std::wstring& value, const std::wstring& prefix) {
  return value.size() >= prefix.size() &&
         _wcsnicmp(value.c_str(), prefix.c_str(), prefix.size()) == 0;
}

bool EqualsInsensitive(const std::wstring& left, const std::wstring& right) {
  return left.size() == right.size() &&
         _wcsicmp(left.c_str(), right.c_str()) == 0;
}

std::wstring Lowercase(const std::wstring& value) {
  std::wstring result = value;
  std::transform(result.begin(), result.end(), result.begin(), [](wchar_t c) {
    return static_cast<wchar_t>(towlower(c));
  });
  return result;
}

bool IsControlCharacter(const std::wstring& value) {
  return std::any_of(value.begin(), value.end(), [](wchar_t c) {
    return c == L'\0' || c == L'\r' || c == L'\n' || c == L'\t' || c < 0x20;
  });
}

bool IsSha256(const std::wstring& value) {
  if (value.size() != 64) return false;
  return std::all_of(value.begin(), value.end(), [](wchar_t c) {
    return (c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f') ||
           (c >= L'A' && c <= L'F');
  });
}

std::wstring TrimTrailingSeparators(std::wstring value) {
  while (value.size() > 3 && !value.empty() &&
         (value.back() == L'\\' || value.back() == L'/')) {
    value.pop_back();
  }
  return value;
}

bool HasParentSegment(const std::wstring& value) {
  std::wstring segment;
  for (size_t i = 0; i <= value.size(); ++i) {
    const wchar_t c = i < value.size() ? value[i] : L'\\';
    if (c == L'\\' || c == L'/') {
      if (segment == L"..") return true;
      segment.clear();
    } else {
      segment.push_back(c);
    }
  }
  return false;
}

bool IsLocalAbsolutePath(const std::wstring& value) {
  if (value.size() < 3 || !((value[0] >= L'A' && value[0] <= L'Z') ||
                            (value[0] >= L'a' && value[0] <= L'z')) ||
      value[1] != L':' || (value[2] != L'\\' && value[2] != L'/')) {
    return false;
  }
  if (value.size() >= 2 && value[0] == L'\\' && value[1] == L'\\') return false;
  if (value.size() >= 2 && value[0] == L'/' && value[1] == L'/') return false;
  return !IsControlCharacter(value) && !HasParentSegment(value);
}

std::wstring FullPath(const std::wstring& value) {
  DWORD required = GetFullPathNameW(value.c_str(), 0, nullptr, nullptr);
  if (required == 0) return {};
  std::vector<wchar_t> buffer(required + 1, L'\0');
  DWORD length = GetFullPathNameW(value.c_str(), static_cast<DWORD>(buffer.size()),
                                  buffer.data(), nullptr);
  if (length == 0 || length >= buffer.size()) return {};
  return TrimTrailingSeparators(std::wstring(buffer.data(), length));
}

bool ParentPath(const std::wstring& value, std::wstring* parent) {
  if (value.size() <= 3 && value.size() >= 2 && value[1] == L':') return false;
  const size_t separator = value.find_last_of(L"\\/");
  if (separator == std::wstring::npos) return false;
  if (separator <= 2 && value.size() >= 2 && value[1] == L':') {
    *parent = value.substr(0, 3);
  } else if (separator == 0) {
    *parent = value.substr(0, 1);
  } else {
    *parent = value.substr(0, separator);
  }
  return !parent->empty() && *parent != value;
}

bool ValidateNoReparseAncestors(const std::wstring& path) {
  std::wstring cursor = path;
  while (!cursor.empty()) {
    const DWORD attributes = GetFileAttributesW(cursor.c_str());
    if (attributes != INVALID_FILE_ATTRIBUTES &&
        (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
      return false;
    }
    if (attributes == INVALID_FILE_ATTRIBUTES) {
      const DWORD error = GetLastError();
      if (error != ERROR_FILE_NOT_FOUND && error != ERROR_PATH_NOT_FOUND &&
          error != ERROR_INVALID_NAME) {
        return false;
      }
    }
    std::wstring parent;
    if (!ParentPath(cursor, &parent)) break;
    cursor = parent;
  }
  return true;
}

bool IsDirectory(const std::wstring& path) {
  const DWORD attributes = GetFileAttributesW(path.c_str());
  return attributes != INVALID_FILE_ATTRIBUTES &&
         (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0 &&
         (attributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0;
}

bool IsRegularFile(const std::wstring& path) {
  const DWORD attributes = GetFileAttributesW(path.c_str());
  return attributes != INVALID_FILE_ATTRIBUTES &&
         (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0 &&
         (attributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0;
}

bool IsInside(const std::wstring& path, const std::wstring& root) {
  const std::wstring candidate = TrimTrailingSeparators(path);
  const std::wstring base = TrimTrailingSeparators(root);
  if (EqualsInsensitive(candidate, base)) return false;
  if (base.size() == 3 && base[1] == L':' && base[2] == L'\\') {
    return candidate.size() > base.size() && StartsWithInsensitive(candidate, base);
  }
  return candidate.size() > base.size() && StartsWithInsensitive(candidate, base) &&
         (candidate[base.size()] == L'\\' || candidate[base.size()] == L'/');
}

bool ParseOptions(int argc, wchar_t** argv, Options* options) {
  if (argc < 15 || argc % 2 == 0) return false;
  std::set<std::wstring> seen;
  for (int i = 1; i < argc; i += 2) {
    const std::wstring name = argv[i];
    const std::wstring value = argv[i + 1];
    if (value.empty() || value.rfind(L"--", 0) == 0 || !seen.insert(name).second) return false;
    if (name == L"--checkout") options->checkout = value;
    else if (name == L"--storage-root") options->storageRoot = value;
    else if (name == L"--profile") options->profile = value;
    else if (name == L"--mode") options->mode = value;
    else if (name == L"--receipt") options->receipt = value;
    else if (name == L"--admission-path") options->sourceAdmission = value;
    else if (name == L"--admission-sha256") options->sourceAdmissionSha256 = value;
    else return false;
  }
  return !options->checkout.empty() && !options->storageRoot.empty() &&
         !options->profile.empty() && !options->mode.empty() && !options->receipt.empty() &&
         !options->sourceAdmission.empty() && !options->sourceAdmissionSha256.empty() &&
         seen.size() == 7;
}

bool ValidateOptions(Options* options) {
  if (options->profile != L"windows-native-fdm-cpu" &&
      options->profile != L"windows-native-fem-cpu" &&
      options->profile != L"windows-native-fem-gpu") return false;
  if (options->mode != L"setup-only" && options->mode != L"initial-build" &&
      options->mode != L"launch-ui") return false;
  if (!IsLocalAbsolutePath(options->checkout) ||
      !IsLocalAbsolutePath(options->storageRoot) ||
      !IsLocalAbsolutePath(options->receipt) ||
      !IsLocalAbsolutePath(options->sourceAdmission) ||
      !IsSha256(options->sourceAdmissionSha256)) return false;
  options->checkout = FullPath(options->checkout);
  options->storageRoot = FullPath(options->storageRoot);
  options->receipt = FullPath(options->receipt);
  options->sourceAdmission = FullPath(options->sourceAdmission);
  if (options->checkout.empty() || options->storageRoot.empty() || options->receipt.empty() ||
      options->sourceAdmission.empty()) return false;
  if (!IsDirectory(options->checkout) || !ValidateNoReparseAncestors(options->checkout) ||
      !ValidateNoReparseAncestors(options->storageRoot) ||
      !ValidateNoReparseAncestors(options->receipt) ||
      !ValidateNoReparseAncestors(options->sourceAdmission) ||
      !IsRegularFile(options->sourceAdmission)) return false;
  if (options->mode == L"launch-ui" && !IsRegularFile(options->receipt)) return false;
  return IsInside(options->receipt, options->storageRoot) &&
         IsInside(options->sourceAdmission, options->storageRoot);
}

bool ReadEmbeddedWorkflow(std::wstring* workflow) {
  HRSRC resource = FindResourceW(nullptr, MAKEINTRESOURCEW(IDR_FULLMAG_WORKFLOW), RT_RCDATA);
  if (!resource) return false;
  HGLOBAL loaded = LoadResource(nullptr, resource);
  if (!loaded) return false;
  const DWORD size = SizeofResource(nullptr, resource);
  const void* data = LockResource(loaded);
  if (!data || size == 0) return false;
  const auto* bytes = static_cast<const unsigned char*>(data);
  size_t offset = (size >= 3 && bytes[0] == 0xef && bytes[1] == 0xbb && bytes[2] == 0xbf) ? 3 : 0;
  const int sourceLength = static_cast<int>(size - offset);
  const int characters = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                                              reinterpret_cast<const char*>(bytes + offset),
                                              sourceLength, nullptr, 0);
  if (characters <= 0) return false;
  workflow->resize(static_cast<size_t>(characters));
  return MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                             reinterpret_cast<const char*>(bytes + offset), sourceLength,
                             workflow->data(), characters) == characters;
}

bool IsAllowedInheritedEnvironmentName(const std::wstring& name) {
  static const wchar_t* exact[] = {
      L"PATH", L"PATHEXT", L"SYSTEMROOT", L"WINDIR", L"COMSPEC", L"TEMP", L"TMP",
      L"USERPROFILE", L"HOMEDRIVE", L"HOMEPATH", L"APPDATA", L"LOCALAPPDATA", L"PROGRAMDATA",
      L"PROGRAMFILES", L"PROGRAMFILES(X86)", L"COMMONPROGRAMFILES", L"COMMONPROGRAMFILES(X86)",
      L"PSMODULEPATH", L"OS", L"PUBLIC", L"USERNAME", L"USERDOMAIN", L"NUMBER_OF_PROCESSORS",
      L"PROCESSOR_ARCHITECTURE", L"PROCESSOR_IDENTIFIER", L"PROCESSOR_LEVEL", L"PROCESSOR_REVISION",
      L"CUDA_PATH", L"CMAKE_PREFIX_PATH", L"VCTOOLSINSTALLDIR", L"VCINSTALLDIR",
      L"WINDOWSSDKDIR", L"WINDOWSSDKVERSION", L"VSINSTALLDIR", L"MSMPI_BIN", L"MSMPI_LIB64",
      L"MSMPI_INC", L"CUDACXX"};
  const std::wstring lowered = Lowercase(name);
  for (const auto* item : exact) {
    if (lowered == Lowercase(item)) return true;
  }
  return StartsWithInsensitive(name, L"CUDA_PATH_") ||
         StartsWithInsensitive(name, L"MSMPI_") ||
         StartsWithInsensitive(name, L"VSCMD_ARG_");
}

bool BuildEnvironment(const Options& options, std::vector<wchar_t>* block) {
  std::map<std::wstring, std::pair<std::wstring, std::wstring>> values;
  LPWCH environment = GetEnvironmentStringsW();
  if (!environment) return false;
  for (const wchar_t* cursor = environment; *cursor != L'\0';) {
    const std::wstring item(cursor);
    cursor += item.size() + 1;
    const size_t separator = item.find(L'=');
    if (separator == std::wstring::npos || separator == 0) continue;
    const std::wstring name = item.substr(0, separator);
    if (!IsAllowedInheritedEnvironmentName(name) || StartsWithInsensitive(name, L"FULLMAG_")) continue;
    values[Lowercase(name)] = {name, item.substr(separator + 1)};
  }
  FreeEnvironmentStringsW(environment);

  const std::pair<std::wstring, std::wstring> controlled[] = {
      {L"FULLMAG_BOOTSTRAP_CHECKOUT", options.checkout},
      {L"FULLMAG_BOOTSTRAP_STORAGE_ROOT", options.storageRoot},
      {L"FULLMAG_BOOTSTRAP_PROFILE", options.profile},
      {L"FULLMAG_BOOTSTRAP_MODE", options.mode},
      {L"FULLMAG_BOOTSTRAP_RECEIPT", options.receipt},
      {L"FULLMAG_BOOTSTRAP_SOURCE_ADMISSION", options.sourceAdmission},
      {L"FULLMAG_BOOTSTRAP_SOURCE_ADMISSION_SHA256", options.sourceAdmissionSha256},
      {L"FULLMAG_BOOTSTRAP_WORKFLOW_VERSION", L"1.0.0"}};
  for (const auto& item : controlled) {
    values[Lowercase(item.first)] = item;
  }
  block->clear();
  for (const auto& item : values) {
    block->insert(block->end(), item.second.first.begin(), item.second.first.end());
    block->push_back(L'=');
    block->insert(block->end(), item.second.second.begin(), item.second.second.end());
    block->push_back(L'\0');
  }
  block->push_back(L'\0');
  return true;
}

std::wstring PowerShellPath() {
  wchar_t windowsDirectory[MAX_PATH] = {};
  const UINT length = GetWindowsDirectoryW(windowsDirectory, ARRAYSIZE(windowsDirectory));
  if (length == 0 || length >= ARRAYSIZE(windowsDirectory)) return {};
  const std::wstring root(windowsDirectory, length);
  const std::wstring sysnative = root + L"\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe";
  if (IsRegularFile(sysnative) && ValidateNoReparseAncestors(sysnative)) return sysnative;
  wchar_t systemDirectory[MAX_PATH] = {};
  const UINT systemLength = GetSystemDirectoryW(systemDirectory, ARRAYSIZE(systemDirectory));
  if (systemLength == 0 || systemLength >= ARRAYSIZE(systemDirectory)) return {};
  const std::wstring systemPath(systemDirectory, systemLength);
  const std::wstring fallback = systemPath + L"\\WindowsPowerShell\\v1.0\\powershell.exe";
  if (!IsRegularFile(fallback) || !ValidateNoReparseAncestors(fallback)) return {};
  return fallback;
}

bool MaterializeWorkflow(const std::wstring& workflow, std::wstring* path, HANDLE* heldFile) {
  wchar_t temporaryDirectory[MAX_PATH] = {};
  const DWORD length = GetTempPathW(ARRAYSIZE(temporaryDirectory), temporaryDirectory);
  if (length == 0 || length >= ARRAYSIZE(temporaryDirectory)) return false;
  const std::wstring directory = FullPath(temporaryDirectory);
  if (directory.empty() || !IsDirectory(directory) || !ValidateNoReparseAncestors(directory)) return false;

  wchar_t temporary[MAX_PATH] = {};
  if (GetTempFileNameW(directory.c_str(), L"fm", 0, temporary) == 0) return false;
  const std::wstring candidate = FullPath(temporary);
  if (candidate.empty() || !IsRegularFile(candidate) || !ValidateNoReparseAncestors(candidate)) {
    DeleteFileW(candidate.c_str());
    return false;
  }
  HANDLE file = CreateFileW(candidate.c_str(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ,
                            nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) {
    DeleteFileW(candidate.c_str());
    return false;
  }

  std::vector<BYTE> bytes;
  bytes.reserve(2 + workflow.size() * sizeof(wchar_t));
  bytes.push_back(0xff);
  bytes.push_back(0xfe);
  const auto* wide = reinterpret_cast<const BYTE*>(workflow.data());
  bytes.insert(bytes.end(), wide, wide + workflow.size() * sizeof(wchar_t));
  DWORD written = 0;
  const BOOL wrote = WriteFile(file, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr);
  if (!wrote || written != bytes.size() || !FlushFileBuffers(file)) {
    CloseHandle(file);
    DeleteFileW(candidate.c_str());
    return false;
  }
  *path = candidate;
  *heldFile = file;
  return true;
}

bool RunWorkflow(const Options& options, const std::wstring& workflow) {
  const std::wstring powershell = PowerShellPath();
  if (powershell.empty()) return false;
  std::vector<wchar_t> environment;
  if (!BuildEnvironment(options, &environment)) return false;

  std::wstring workflowPath;
  HANDLE workflowFile = INVALID_HANDLE_VALUE;
  if (!MaterializeWorkflow(workflow, &workflowPath, &workflowFile)) return false;

  std::wstring command = L"\"" + powershell + L"\" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + workflowPath + L"\"";
  std::vector<wchar_t> commandLine(command.begin(), command.end());
  commandLine.push_back(L'\0');

  SECURITY_ATTRIBUTES security = {};
  security.nLength = sizeof(security);
  security.bInheritHandle = TRUE;
  HANDLE input = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                             &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  HANDLE output = CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                              &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (input == INVALID_HANDLE_VALUE || output == INVALID_HANDLE_VALUE) {
    if (input != INVALID_HANDLE_VALUE) CloseHandle(input);
    if (output != INVALID_HANDLE_VALUE) CloseHandle(output);
    CloseHandle(workflowFile);
    DeleteFileW(workflowPath.c_str());
    return false;
  }

  STARTUPINFOW startup = {};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = input;
  startup.hStdOutput = output;
  startup.hStdError = output;
  PROCESS_INFORMATION process = {};
  const BOOL created = CreateProcessW(
      powershell.c_str(), commandLine.data(), nullptr, nullptr, TRUE,
      CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW, nullptr, nullptr, &startup, &process);
  CloseHandle(input);
  CloseHandle(output);
  if (!created) {
    CloseHandle(workflowFile);
    DeleteFileW(workflowPath.c_str());
    return false;
  }
  const DWORD waitResult = WaitForSingleObject(process.hProcess, INFINITE);
  DWORD exitCode = 1;
  if (waitResult == WAIT_OBJECT_0) GetExitCodeProcess(process.hProcess, &exitCode);
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  CloseHandle(workflowFile);
  DeleteFileW(workflowPath.c_str());
  return waitResult == WAIT_OBJECT_0 && exitCode == 0;
}

bool ReadReceiptBytes(const std::wstring& path, const std::wstring& storageRoot,
                      std::vector<char>* contents) {
  if (!IsInside(path, storageRoot) || !IsRegularFile(path) || !ValidateNoReparseAncestors(path)) return false;
  HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                            FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return false;
  LARGE_INTEGER size = {};
  if (!GetFileSizeEx(file, &size) || size.QuadPart <= 0 || size.QuadPart > 1024 * 1024) {
    CloseHandle(file);
    return false;
  }
  contents->assign(static_cast<size_t>(size.QuadPart), '\0');
  DWORD read = 0;
  const bool readOk = ReadFile(file, contents->data(), static_cast<DWORD>(contents->size()), &read, nullptr) &&
                      read == contents->size();
  CloseHandle(file);
  return readOk;
}

bool ReceiptIsSafe(const std::wstring& path, const std::wstring& storageRoot,
                   const std::wstring& mode, const std::wstring& profile) {
  std::vector<char> bytes;
  if (!ReadReceiptBytes(path, storageRoot, &bytes)) return false;
  const std::string text(bytes.data(), bytes.data() + bytes.size());
  const bool fullPackage = profile == L"windows-native-fem-gpu";
  const char* schema = fullPackage ?
      "fullmag.windows-installer-environment-receipt.v2" :
      "fullmag.windows-installer-environment-receipt.v1";
  if (text.find(schema) == std::string::npos ||
      text.find("\"admission_path\"") == std::string::npos ||
      text.find("\"admission_sha256\"") == std::string::npos ||
      text.find("\"source_identity\"") == std::string::npos ||
      text.find("\"sanitized_output\": true") == std::string::npos) {
    return false;
  }
  if (fullPackage &&
      (text.find("\"scope\": \"all\"") == std::string::npos ||
       text.find("\"full_runtime\"") == std::string::npos ||
       text.find("\"fdm_cpu\"") == std::string::npos ||
       text.find("\"fdm_gpu\"") == std::string::npos ||
       text.find("\"fem_cpu\"") == std::string::npos ||
       text.find("\"fem_gpu\"") == std::string::npos)) {
    return false;
  }
  if (mode == L"launch-ui") {
    return text.find("\"state\": \"completed\"") != std::string::npos &&
           text.find("\"mode\": \"initial-build\"") != std::string::npos &&
           text.find("\"initial_build\"") != std::string::npos;
  }
  return true;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  Options options;
  if (!ParseOptions(argc, argv, &options) || !ValidateOptions(&options)) {
    Blocked();
    return 2;
  }
  std::vector<char> receiptBefore;
  if (options.mode == L"launch-ui" && !ReadReceiptBytes(options.receipt, options.storageRoot, &receiptBefore)) {
    Blocked();
    return 2;
  }
  std::wstring workflow;
  if (!ReadEmbeddedWorkflow(&workflow) || !RunWorkflow(options, workflow) ||
      !ReceiptIsSafe(options.receipt, options.storageRoot, options.mode, options.profile)) {
    Blocked();
    return 2;
  }
  if (options.mode == L"launch-ui") {
    std::vector<char> receiptAfter;
    if (!ReadReceiptBytes(options.receipt, options.storageRoot, &receiptAfter) ||
        receiptBefore != receiptAfter) {
      Blocked();
      return 2;
    }
  }
  return 0;
}
