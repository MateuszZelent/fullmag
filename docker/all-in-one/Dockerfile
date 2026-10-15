ARG RUNTIME_BASE
FROM ${RUNTIME_BASE}
USER root
COPY source/ /opt/fullmag/source/
COPY package/ /opt/fullmag/package/
COPY provenance.json /opt/fullmag/provenance.json
COPY entrypoint.py /opt/fullmag/entrypoint.py
COPY windows_folder_probe.py /opt/fullmag/windows_folder_probe.py
COPY runtime_service.py /opt/fullmag/runtime_service.py
COPY frontend_dev.py /opt/fullmag/frontend_dev.py
COPY healthcheck.py /opt/fullmag/healthcheck.py
# The pinned builder already prepared pnpm 10.8.1. Publish that immutable tool
# for the unprivileged frontend instead of extracting it into Windows per run.
RUN mkdir -p /opt/fullmag/tooling && \
    cp -a /root/.cache/node/corepack/v1/pnpm/10.8.1 /opt/fullmag/tooling/pnpm && \
    ln -sf /opt/fullmag/tooling/pnpm/bin/pnpm.cjs /usr/local/bin/pnpm && \
    chmod -R a+rX /opt/fullmag/tooling && \
    chmod 755 /opt/fullmag/tooling/pnpm/bin/pnpm.cjs && \
    test "$(/usr/local/bin/pnpm --version)" = "10.8.1"
RUN mkdir -p /opt/fullmag/source/.fullmag /state /run/fullmag && chown 65532:65532 /state && \
    ln -s /opt/fullmag/package /opt/fullmag/source/.fullmag/local && \
    chmod -R a+rX /opt/fullmag && \
    chmod 755 /opt/fullmag/package/bin/* && \
    for binary in fullmag-api fullmag-bin fullmag-runtime-service \
        fullmag-api-resource-pool fullmag-api-preparation-resource-pool \
        fullmag-api-accepted-scheduler fullmag-api-accepted-fem-preparation-scheduler \
        fullmag-api-accepted-worker fullmag-api-accepted-supervisor \
        fullmag-api-accepted-fem-preparer fullmag-api-accepted-fem-preparation-supervisor \
        fullmag-api-preparation-retry; do \
        test -x "/opt/fullmag/package/bin/$binary" || exit 1; \
    done
LABEL org.fullmag.runtime="docker-all-gpu-v1" \
      org.fullmag.development="two-container-hmr-v1"
ENV FULLMAG_REPO_ROOT=/opt/fullmag/source \
    FULLMAG_STATE_ROOT=/state/.fullmag \
    FULLMAG_STATE_DIR=/state/.fullmag \
    HOME=/state \
    FULLMAG_PROJECT_STORAGE_ROOT=/state \
    FULLMAG_RUNS_ROOT=/state/runs/docker-all \
    FULLMAG_WORKTREE_ID=docker-all \
    FULLMAG_RUNTIME_SERVICE_CONFIG=/state/.fullmag/runtime-service/docker-all.json \
    FULLMAG_RUNTIME_ROOT=/opt/fullmag/package \
    FULLMAG_WEB_STATIC_DIR=/opt/fullmag/package/web \
    FULLMAG_API_PORT=8081 \
    FULLMAG_PYTHON=/usr/local/bin/python3 \
    PYTHONPATH=/opt/fullmag/source/packages/fullmag-py/src:/opt/fullmag/package \
    PYTHONDONTWRITEBYTECODE=1 \
    LD_LIBRARY_PATH=/opt/fullmag/package/lib:/opt/fullmag-deps/lib:/usr/local/cuda/lib64:${LD_LIBRARY_PATH} \
    FULLMAG_DISABLE_MANAGED_FEM_GPU_RUNTIME=1 \
    FULLMAG_FORCE_LOCAL_FEM_GPU=1 \
    FULLMAG_FEM_REQUIRE_GPU=0 \
    FULLMAG_FEM_REQUIRE_CEED=1 \
    FULLMAG_FEM_MFEM_DEVICE="" \
    FULLMAG_FEM_MESH_CACHE_DIR=/state/.fullmag/mesh-cache \
    CUDA_CACHE_PATH=/state/cuda-cache \
    OMP_NUM_THREADS=4 \
    FULLMAG_CPU_THREADS=4
ENV PATH=/opt/fullmag/source/.fullmag/local/bin:/opt/fullmag-deps/bin:/usr/local/cuda/bin:/usr/local/bin:/usr/bin:/bin
WORKDIR /state
USER 65532:65532
EXPOSE 8080 8081
ENTRYPOINT ["/usr/local/bin/python3", "/opt/fullmag/entrypoint.py"]
HEALTHCHECK --interval=5s --timeout=5s --start-period=30s --retries=6 \
    CMD /usr/local/bin/python3 /opt/fullmag/healthcheck.py
