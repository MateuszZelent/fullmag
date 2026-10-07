"""Real pipe regression for the private incomplete-input fixture."""
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import unittest

from windows.candidate_helper_probe import ACK_SCHEMA, REQUEST_SCHEMA


class CandidateHelperFixtureChecks(unittest.TestCase):
    def test_ack_means_stdin_is_closed_before_tail_write(self):
        repo = Path(__file__).resolve().parents[1]
        request = json.dumps({"schema": REQUEST_SCHEMA, "case": "incomplete_stdin",
                              "padding": "x" * 16200}, separators=(",", ":")).encode()
        marker = b'"padding":"'
        split = request.index(marker) + len(marker)
        env = {**os.environ, "FULLMAG_DEVELOPMENT_OWNER_PROBE": "1",
               "FULLMAG_DEVELOPMENT_RESTART_PROBE_CASE": "preparation-faults",
               "FULLMAG_CANDIDATE_HELPER_PROBE_CASE": "incomplete_stdin"}
        process = subprocess.Popen([sys.executable, "-B",
                                    str(repo / "scripts/windows/candidate_helper_probe.py"),
                                    "--repo-root", str(repo)], env=env,
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE)
        observed = queue.Queue(maxsize=1)
        reader = threading.Thread(target=lambda: observed.put(process.stdout.readline(256)),
                                  daemon=True)
        reader.start()
        try:
            process.stdin.write(request[:split])
            process.stdin.flush()
            acknowledgement = json.loads(observed.get(timeout=5))
            self.assertEqual(acknowledgement, {"schema": ACK_SCHEMA, "case": "incomplete_stdin"})
            with self.assertRaises(OSError):
                process.stdin.write(request[split:])
                process.stdin.flush()
            self.assertEqual(process.wait(timeout=5), 0)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            reader.join(timeout=1)
            self.assertFalse(reader.is_alive())
            for stream in (process.stdin, process.stdout, process.stderr):
                try:
                    stream.close()
                except OSError:
                    pass


if __name__ == "__main__":
    unittest.main()
