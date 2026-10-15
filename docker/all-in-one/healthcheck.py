"""Read-only readiness of the actual container process tree."""
import json
import os
import urllib.request
import urllib.error

if os.environ.get("FULLMAG_DOCKER_ROLE") != "frontend":
    with urllib.request.urlopen("http://127.0.0.1:8081/healthz", timeout=2) as response:
        assert response.status == 200
    with urllib.request.urlopen("http://127.0.0.1:8081/v2/platform/runtime-service", timeout=2) as response:
        status = json.load(response)
        assert status["state"] == "ready" and status["configured"] is True
if os.environ.get("FULLMAG_DOCKER_FRONTEND") == "dev":
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args):
            return None
    opener = urllib.request.build_opener(NoRedirect())
    request = urllib.request.Request("http://127.0.0.1:8080/", method="HEAD")
    try:
        with opener.open(request, timeout=2) as response:
            assert 200 <= response.status < 400
    except urllib.error.HTTPError as error:
        if not 300 <= error.code < 400:
            raise
