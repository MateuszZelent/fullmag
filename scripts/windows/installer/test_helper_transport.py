"""Transport checks for the embedded Windows installer PowerShell helper.

The native check launches only the embedded protocol with harmless unknown
operations.  It does not configure CMake, compile C++, install dependencies,
or run the installer.  It writes the payload and several requests in one
operation so a bootstrap reader that buffers past its first newline is caught.
"""

from __future__ import annotations

import base64
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[3]
CPP = ROOT / "scripts/windows/installer/FullmagBootstrapperApplication/FullmagBootstrapperApplication.cpp"
READY = "fullmag.windows-installer-helper-ready.v1"


def _raw_function(source: str, name: str) -> str:
    start = source.find(f"static std::wstring {name}() {{")
    if start < 0:
        raise AssertionError(f"missing {name}()")
    if name == "BootstrapScript":
        end = source.find("    static std::wstring ProtocolScript()", start)
    else:
        end = source.find("    std::mutex lock_;", start)
    if end < 0:
        raise AssertionError(f"unterminated {name}()")
    return source[start:end]


def _raw_script(source: str, name: str) -> str:
    body = _raw_function(source, name)
    chunks = re.findall(r'LR"PS\((.*?)\)PS"', body, flags=re.DOTALL)
    if not chunks:
        raise AssertionError(f"missing raw PowerShell body for {name}()")
    return "".join(chunks)


class HelperTransportContract(unittest.TestCase):
    def setUp(self) -> None:
        self.source = CPP.read_text(encoding="utf-8")
        self.helper = self.source[self.source.index("class HelperClient") : self.source.index(
            "} // namespace fullmag::installer", self.source.index("class HelperClient")
        )]

    def test_full_protocol_is_pipe_payload_and_bootstrap_is_short(self) -> None:
        protocol = _raw_script(self.source, "ProtocolScript")
        bootstrap = _raw_script(self.source, "BootstrapScript")
        protocol_payload = base64.b64encode(protocol.encode("utf-16le"))
        bootstrap_payload = base64.b64encode(bootstrap.encode("utf-16le"))
        self.assertGreater(len(protocol_payload), 32767)
        self.assertLess(len(bootstrap_payload), 4096)
        self.assertIn("const std::wstring bootstrapEncoded = Base64Utf16(BootstrapScript());", self.helper)
        self.assertIn("const std::wstring protocolEncoded = Base64Utf16(ProtocolScript());", self.helper)
        command_line = self.helper[self.helper.index("std::wstring commandLine") : self.helper.index(
            "std::vector<wchar_t> mutableCommand", self.helper.index("std::wstring commandLine")
        )]
        self.assertIn("bootstrapEncoded", command_line)
        self.assertNotIn("protocolEncoded", command_line)
        self.assertIn('const std::string payload = Utf8(protocolEncoded) + "\\n";', self.helper)
        self.assertIn("OpenStandardInput()", bootstrap)
        self.assertIn("ReadByte()", bootstrap)
        self.assertNotIn("Console]::In.ReadLine", bootstrap)

    def test_ready_marker_follows_encoding_setup_and_transport_is_cancelable(self) -> None:
        protocol = _raw_script(self.source, "ProtocolScript")
        self.assertIn("[Console]::InputEncoding", protocol)
        self.assertLess(protocol.index("[Console]::InputEncoding"), protocol.index(READY))
        self.assertIn("[Console]::Out.Flush()", protocol)
        self.assertIn("constexpr size_t kMaxHelperRequestBytes = 2 * 1024 * 1024;", self.source)
        self.assertIn("bytes.size() > kMaxHelperRequestBytes", self.helper)
        self.assertIn("CreateJobObjectW", self.helper)
        self.assertIn("JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE", self.helper)
        self.assertIn("SetInformationJobObject", self.helper)
        self.assertIn("AssignProcessToJobObject", self.helper)
        self.assertIn("CREATE_SUSPENDED", self.helper)
        self.assertIn("ResumeThread", self.helper)
        self.assertIn("STARTUPINFOEXW", self.helper)
        self.assertIn("PROC_THREAD_ATTRIBUTE_HANDLE_LIST", self.helper)
        self.assertIn("UpdateProcThreadAttribute", self.helper)
        self.assertIn("SetHandleInformation(stdinWrite", self.helper)
        self.assertIn("SetHandleInformation(stdoutRead", self.helper)
        self.assertIn("CancelIoEx", self.helper)
        self.assertIn("CancelSynchronousIo", self.helper)
        self.assertIn("WaitForSingleObject(io_done_event_, 2000)", self.helper)
        self.assertIn("stop_requested_", self.helper)
        self.assertIn("terminal_shutdown_", self.helper)
        self.assertIn("io_thread_", self.helper)
        self.assertIn("bool HasCurrentIoThread()", self.helper)
        self.assertIn("WriteAll", self.helper)
        self.assertIn("ReadLine", self.helper)
        send = self.helper[self.helper.index("bool Send(") : self.helper.index("void Stop()")]
        self.assertIn("std::lock_guard<std::mutex> ioGuard(io_lock_)", send)
        self.assertIn("input = stdin_;\n            output = stdout_;\n        }", send)
        self.assertIn("if (!RegisterCurrentIoThread())", send)

        stop = self.helper[self.helper.index("void Stop()") : self.helper.index("private:")]
        self.assertIn("const bool ioStopped = CancelCurrentIoThread();", stop)
        self.assertIn("if (ioStopped)", stop)
        self.assertIn("if (!HasCurrentIoThread())", stop)
        self.assertIn("StopProcessUnlocked();", stop)
        timeout_wait = stop.index("WaitForSingleObject(io_done_event_, 2000)")
        self.assertGreater(stop.index("CloseIf(stdin_);", timeout_wait), timeout_wait)
        self.assertIn("const BOOL canceled = CancelSynchronousIo(duplicate);", self.helper)
        self.assertIn("const DWORD cancelError = canceled ? ERROR_SUCCESS : GetLastError();", self.helper)
        self.assertIn("bool hadIoThread = false;", self.helper)
        self.assertIn("if (hadIoThread &&", self.helper)
        self.assertIn("if (!hadIoThread) return true;", self.helper)
        self.assertIn("if (!duplicate) return false;", self.helper)
        cancel_fallback = self.helper[self.helper.index("if (!canceled && cancelError") : self.helper.index(
            "const DWORD wait =", self.helper.index("if (!canceled && cancelError")
        )]
        self.assertIn("std::lock_guard<std::mutex> guard(lock_);", cancel_fallback)
        self.assertIn("if (stdin_) CancelIoEx(stdin_, nullptr);", cancel_fallback)
        self.assertIn("if (stdout_) CancelIoEx(stdout_, nullptr);", cancel_fallback)
        self.assertNotIn("input = stdin_", cancel_fallback)
        self.assertNotIn("output = stdout_", cancel_fallback)

        shutdown = self.helper[self.helper.index("void Shutdown()") : self.helper.index("void Stop()")]
        self.assertIn("terminal_shutdown_.store(true);", shutdown)
        self.assertIn("stop_requested_.store(true);", shutdown)

    def test_process_launch_restricts_inherited_handles_and_uses_a_job(self) -> None:
        start = self.helper[self.helper.index("bool Start(") : self.helper.index("bool Send(")]
        self.assertLess(start.index("CREATE_SUSPENDED"), start.index("AssignProcessToJobObject"))
        self.assertLess(start.index("AssignProcessToJobObject"), start.index("ResumeThread"))
        self.assertLess(start.index("process_ = processInfo.hProcess"), start.index("ResumeThread"))
        self.assertLess(start.index("job_ = job"), start.index("ResumeThread"))
        process_call = start.index("CreateProcessW(powershellPath")
        self.assertLess(start.index("SetHandleInformation(stdinWrite"), process_call)
        self.assertLess(start.index("UpdateProcThreadAttribute"), process_call)
        self.assertIn("HANDLE inheritedHandles[] = {stdinRead, stdoutWrite, stderrHandle};", start)
        self.assertIn("EXTENDED_STARTUPINFO_PRESENT", start)
        self.assertIn("DeleteProcThreadAttributeList", start)

    @unittest.skipUnless(os.name == "nt", "native PowerShell transport check is Windows-only")
    def test_native_payload_and_three_rpc_lines_before_ready(self) -> None:
        powershell = shutil.which("powershell.exe") or shutil.which("powershell")
        if powershell is None:
            self.skipTest("Windows PowerShell is unavailable")
        bootstrap = _raw_script(self.source, "BootstrapScript")
        protocol = _raw_script(self.source, "ProtocolScript")
        encoded_bootstrap = base64.b64encode(bootstrap.encode("utf-16le")).decode("ascii")
        encoded_protocol = base64.b64encode(protocol.encode("utf-16le")).decode("ascii")
        requests = b"".join(b'{"op":"unknown"}\n' for _ in range(3))
        result = subprocess.run(
            [
                powershell,
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-EncodedCommand",
                encoded_bootstrap,
            ],
            input=(encoded_protocol + "\n").encode("ascii") + requests,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=15,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
        lines = result.stdout.decode("utf-8").splitlines()
        self.assertGreaterEqual(len(lines), 4, result.stdout)
        self.assertEqual(lines[0], READY)
        replies = [json.loads(line) for line in lines[1:4]]
        self.assertEqual([reply.get("state") for reply in replies], ["blocked"] * 3)


if __name__ == "__main__":
    unittest.main()
