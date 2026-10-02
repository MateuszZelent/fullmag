#!/usr/bin/env python3
"""Regression tests for Control Room listener port selection."""

from __future__ import annotations

import socket
import unittest

from control_room_port import first_bindable_pair, first_bindable_port, is_bindable


class ControlRoomPortTests(unittest.TestCase):
    def test_wildcard_probe_rejects_port_occupied_on_wildcard(self) -> None:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as occupied:
            occupied.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            occupied.bind(("0.0.0.0", 0))
            occupied.listen(1)
            port = occupied.getsockname()[1]

            self.assertFalse(is_bindable("0.0.0.0", port))
            self.assertNotEqual(
                first_bindable_port("0.0.0.0", (port, port + 1)), port
            )

    def test_picker_uses_the_requested_bind_host(self) -> None:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as occupied:
            occupied.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            occupied.bind(("0.0.0.0", 0))
            occupied.listen(1)
            port = occupied.getsockname()[1]

            self.assertEqual(
                first_bindable_port("127.0.0.1", (port, port + 1)), port + 1
            )

    def test_pair_moves_both_services_when_the_preferred_ui_is_occupied(self) -> None:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as occupied:
            occupied.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            occupied.bind(("0.0.0.0", 0))
            occupied.listen(1)
            web_port = occupied.getsockname()[1]
            api_port = web_port + 1
            pair = first_bindable_pair(
                "0.0.0.0", (api_port, api_port + 1),
                "0.0.0.0", (web_port, web_port + 1),
            )

            # The API port was free at rank zero, but must move together with
            # the occupied UI port instead of being reused independently.
            self.assertEqual(pair.api_port, api_port + 1)
            self.assertEqual(pair.web_port, web_port + 1)

    def test_pair_moves_both_services_when_the_preferred_api_is_occupied(self) -> None:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as occupied:
            occupied.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            occupied.bind(("0.0.0.0", 0))
            occupied.listen(1)
            api_port = occupied.getsockname()[1]
            web_port = api_port + 1
            pair = first_bindable_pair(
                "0.0.0.0", (api_port, api_port + 1),
                "0.0.0.0", (web_port, web_port + 1),
            )

            self.assertEqual(pair.api_port, api_port + 1)
            self.assertEqual(pair.web_port, web_port + 1)

if __name__ == "__main__":
    unittest.main()
