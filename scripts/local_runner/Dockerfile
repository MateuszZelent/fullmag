# Diagnostic worker only. This image contains no Fullmag build toolchain.
ARG BASE_IMAGE=python@sha256:db3ff2e1800a8581e2c48a27c3995339d47bdf046da21c7627accd3d51053a93
FROM ${BASE_IMAGE}
COPY --chmod=0555 worker_entrypoint.py /opt/fullmag-runner/worker_entrypoint.py
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER 65532:65532
ENTRYPOINT ["/opt/fullmag-runner/worker_entrypoint.py"]
