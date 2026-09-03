ARG FULLMAG_CUDA_BASE_IMAGE="nvidia/cuda:12.4.1-devel-ubuntu20.04"

FROM ${FULLMAG_CUDA_BASE_IMAGE} AS cuda-base-normalized

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

COPY --chmod=755 docker/fem-gpu/normalize_cuda_dpkg_lists.sh /usr/local/sbin/
RUN /usr/local/sbin/normalize_cuda_dpkg_lists.sh && \
    if [[ -f /var/lib/dpkg/info/.fullmag-cuda-dpkg-reinstall-required ]]; then \
      reinstall_packages=( \
        cuda-libraries-12-4 cuda-nvrtc-12-4 cuda-nvtx-12-4 cuda-opencl-12-4 \
        libcublas-12-4 libcufft-12-4 libcufile-12-4 libcurand-12-4 \
        libcusolver-12-4 libcusparse-12-4 libnccl2 libnpp-12-4 \
        libnvfatbin-12-4 libnvjitlink-12-4 libnvjpeg-12-4 \
      ) && \
      reinstall_specs=() && \
      for package in "${reinstall_packages[@]}"; do \
        reinstall_specs+=("${package}=$(dpkg-query -W -f='${Version}' "${package}")"); \
      done && \
      apt-get update && \
      apt-get install -y --no-install-recommends --reinstall "${reinstall_specs[@]}" && \
      rm /var/lib/dpkg/info/.fullmag-cuda-dpkg-reinstall-required && \
      rm -rf /var/lib/apt/lists/*; \
    fi && \
    rm /usr/local/sbin/normalize_cuda_dpkg_lists.sh

COPY --chmod=755 docker/fem-gpu/nvidia-entrypoint/nvidia_entrypoint.sh /opt/nvidia/nvidia_entrypoint.sh
COPY --chmod=644 docker/fem-gpu/nvidia-entrypoint/entrypoint.d/ /opt/nvidia/entrypoint.d/

FROM cuda-base-normalized AS deps

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG FULLMAG_CUDA_ARCHITECTURES="80-real;89-real;90-real;90-virtual"
ARG FULLMAG_HYPRE_GPU_ARCHITECTURES="60 70 80 89 90"
ARG FULLMAG_MFEM_REF="v4.9"
ARG FULLMAG_LIBCEED_REF="v0.12.0"
ARG FULLMAG_HYPRE_REF="v3.1.0"
ARG FULLMAG_PETSC_REF="v3.24.6"
ARG FULLMAG_SLEPC_REF="v3.24.3"
ENV DEBIAN_FRONTEND=noninteractive
ENV CMAKE_VERSION=3.30.5
ENV MFEM_REF=${FULLMAG_MFEM_REF}
ENV LIBCEED_REF=${FULLMAG_LIBCEED_REF}
ENV HYPRE_REF=${FULLMAG_HYPRE_REF}
ENV PETSC_REF=${FULLMAG_PETSC_REF}
ENV SLEPC_REF=${FULLMAG_SLEPC_REF}
ENV INSTALL_PREFIX=/opt/fullmag-deps
ENV CUDA_HOME=/usr/local/cuda
ENV CUDA_PATH=/usr/local/cuda
ENV CC=gcc
ENV CXX=g++
ENV FC=gfortran
ENV NVCC=/usr/local/cuda/bin/nvcc
ENV PATH=/usr/local/cuda/bin:${INSTALL_PREFIX}/bin:/root/.cargo/bin:$PATH
ENV LD_LIBRARY_PATH=/usr/local/cuda/lib64:${INSTALL_PREFIX}/lib:${LD_LIBRARY_PATH}
ENV FULLMAG_FEM_MFEM_DEVICE=ceed-cuda:/gpu/cuda/shared
ENV FULLMAG_CUDA_ARCHITECTURES=${FULLMAG_CUDA_ARCHITECTURES}
ENV FULLMAG_HYPRE_GPU_ARCHITECTURES=${FULLMAG_HYPRE_GPU_ARCHITECTURES}
ENV CMAKE_PREFIX_PATH=${INSTALL_PREFIX}:${CMAKE_PREFIX_PATH}
ENV PKG_CONFIG_PATH=${INSTALL_PREFIX}/lib/pkgconfig:${INSTALL_PREFIX}/lib64/pkgconfig:${PKG_CONFIG_PATH}

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    build-essential \
    ca-certificates \
    curl \
    gfortran \
    git \
    libblas-dev \
    liblapack-dev \
    openmpi-bin \
    libopenmpi-dev \
    ninja-build \
    pkg-config \
    python3 \
    python3-dev \
    python3-pip \
    python3-venv \
    wget \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir cmake==${CMAKE_VERSION}

RUN curl https://sh.rustup.rs -sSf | bash -s -- -y --default-toolchain nightly

WORKDIR /tmp/build

RUN git clone --depth 1 --branch ${MFEM_REF} https://github.com/mfem/mfem.git
RUN git clone --depth 1 --branch ${LIBCEED_REF} https://github.com/CEED/libCEED.git /tmp/build/libCEED

RUN make -C /tmp/build/libCEED CUDA_DIR=${CUDA_HOME} -j"$(nproc)" && \
    make -C /tmp/build/libCEED CUDA_DIR=${CUDA_HOME} install prefix=${INSTALL_PREFIX}

# S10: Build hypre (serial + CUDA) — required for CG+AMG Poisson solver
ENV UMPIRE_REF=v2024.07.0
ARG FULLMAG_HYPRE_MEMORY_VARIANT="baseline"
ENV FULLMAG_HYPRE_MEMORY_VARIANT=${FULLMAG_HYPRE_MEMORY_VARIANT}
RUN if [ "${FULLMAG_HYPRE_MEMORY_VARIANT}" = "umpire" ]; then \
      umpire_cuda_archs="${FULLMAG_HYPRE_GPU_ARCHITECTURES// /;}"; \
      git clone --depth 1 --branch "${UMPIRE_REF}" --recursive \
        https://github.com/LLNL/Umpire.git /tmp/build/umpire; \
      cmake -S /tmp/build/umpire -B /tmp/build/umpire/build -G Ninja \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX=${INSTALL_PREFIX} \
        -DCMAKE_INSTALL_LIBDIR=lib \
        -DBUILD_SHARED_LIBS=ON \
        -DUMPIRE_ENABLE_C=ON \
        -DUMPIRE_ENABLE_TOOLS=OFF \
        -DENABLE_CUDA=ON \
        -DENABLE_HIP=OFF \
        -DENABLE_BENCHMARKS=OFF \
        -DENABLE_EXAMPLES=OFF \
        -DENABLE_DOCS=OFF \
        -DENABLE_TESTS=OFF \
        -DCMAKE_CUDA_ARCHITECTURES="${umpire_cuda_archs}"; \
      cmake --build /tmp/build/umpire/build -j"$(nproc)"; \
      cmake --install /tmp/build/umpire/build; \
    fi

RUN git clone --depth 1 --branch ${HYPRE_REF} https://github.com/hypre-space/hypre.git /tmp/build/hypre && \
    cd /tmp/build/hypre/src && \
    base_flags=( \
      --prefix=${INSTALL_PREFIX} \
      --enable-shared \
      --with-openmp \
      --with-cuda \
      --with-gpu-arch="${FULLMAG_HYPRE_GPU_ARCHITECTURES}" \
    ) && \
    case "${FULLMAG_HYPRE_MEMORY_VARIANT}" in \
      baseline) variant_flags=(--without-umpire) ;; \
      umpire) variant_flags=( \
        --with-umpire \
        --with-umpire-device \
        --with-umpire-include=${INSTALL_PREFIX}/include \
        --with-umpire-lib-dirs=${INSTALL_PREFIX}/lib \
        --with-umpire-libs="umpire camp" \
      ) ;; \
      cuda_async) variant_flags=(--without-umpire --enable-device-malloc-async) ;; \
      thrust_async) variant_flags=(--without-umpire --enable-thrust-async) ;; \
      *) echo "unsupported FULLMAG_HYPRE_MEMORY_VARIANT=${FULLMAG_HYPRE_MEMORY_VARIANT}" >&2; exit 2 ;; \
    esac && \
    configure_help="$(./configure --help)" && \
    for flag in "${variant_flags[@]}"; do \
      option="${flag%%=*}"; \
      if [[ "${option}" == --with-* || "${option}" == --enable-* ]] && \
         ! grep -Fq -- "${option}" <<<"${configure_help}"; then \
        echo "required HYPRE configure flag is unavailable: ${option}" >&2; \
        exit 2; \
      fi; \
    done && \
    configure_flags=("${base_flags[@]}" "${variant_flags[@]}") && \
    CC=mpicc CXX=mpicxx FC=mpifort ./configure "${configure_flags[@]}" && \
    make -j"$(nproc)" && \
    make install && \
    mkdir -p ${INSTALL_PREFIX}/share/fullmag && \
    HYPRE_MEMORY_VARIANT="${FULLMAG_HYPRE_MEMORY_VARIANT}" \
    HYPRE_GPU_ARCHITECTURES="${FULLMAG_HYPRE_GPU_ARCHITECTURES}" \
    HYPRE_CONFIGURE_FLAGS="$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "${configure_flags[@]}")" \
    python3 -c 'import hashlib,json,os,re; from pathlib import Path; p=Path(os.environ["INSTALL_PREFIX"])/"include/HYPRE_config.h"; s=p.read_text(); names=("HYPRE_USING_UMPIRE","HYPRE_USING_UMPIRE_DEVICE","HYPRE_USING_DEVICE_MALLOC_ASYNC","HYPRE_USING_THRUST_ASYNC"); macros={n: bool(re.search(r"^#define\s+"+re.escape(n)+r"\s+1(?:\s|$)",s,re.M)) for n in names}; out={"hypre_gpu_architectures":os.environ["HYPRE_GPU_ARCHITECTURES"],"hypre_memory_variant":os.environ["HYPRE_MEMORY_VARIANT"],"hypre_configure_flags":json.loads(os.environ["HYPRE_CONFIGURE_FLAGS"]),"hypre_config_macros":macros,"hypre_config_header_sha256":hashlib.sha256(p.read_bytes()).hexdigest()}; q=Path(os.environ["INSTALL_PREFIX"])/"share/fullmag/hypre-build-metadata.json"; q.write_text(json.dumps(out,indent=2,sort_keys=True)+chr(10))'

# Task 9 modal GPU contract: PETSc and SLEPc must use the same CUDA-enabled
# real/double dependency stack as MFEM and hypre.  Ubuntu's distro packages
# are CPU-only and bind a second, incompatible hypre, so build the qualified
# pair from source into the shared managed prefix.
COPY docker/fem-gpu/patches/petsc-3.24.6-multiarch-nvcc.diff /tmp/build/petsc-3.24.6-multiarch-nvcc.diff
RUN git clone --depth 1 --branch ${PETSC_REF} https://gitlab.com/petsc/petsc.git /tmp/build/petsc && \
    cd /tmp/build/petsc && \
    git apply /tmp/build/petsc-3.24.6-multiarch-nvcc.diff && \
    python3 ./configure \
      PETSC_ARCH=arch-linux-cuda \
      --prefix=${INSTALL_PREFIX} \
      --with-cc=mpicc \
      --with-cxx=mpicxx \
      --with-fc=mpifort \
      COPTFLAGS=-O3 \
      CXXOPTFLAGS=-O3 \
      FOPTFLAGS=-O3 \
      CUDAOPTFLAGS="-O3 -lineinfo" \
      --with-debugging=0 \
      --with-shared-libraries=1 \
      --with-scalar-type=real \
      --with-precision=double \
      --with-cuda=1 \
      --with-cuda-dir=${CUDA_HOME} \
      --with-cuda-arch=80,89,90 \
      --with-hypre=1 \
      --with-hypre-dir=${INSTALL_PREFIX} && \
    make PETSC_DIR=/tmp/build/petsc PETSC_ARCH=arch-linux-cuda -j"$(nproc)" all && \
    make PETSC_DIR=/tmp/build/petsc PETSC_ARCH=arch-linux-cuda install

RUN git clone --depth 1 --branch ${SLEPC_REF} https://gitlab.com/slepc/slepc.git /tmp/build/slepc && \
    cd /tmp/build/slepc && \
    PETSC_DIR=${INSTALL_PREFIX} python3 ./configure --prefix=${INSTALL_PREFIX} && \
    make SLEPC_DIR=/tmp/build/slepc PETSC_DIR=${INSTALL_PREFIX} -j"$(nproc)" all && \
    make SLEPC_DIR=/tmp/build/slepc PETSC_DIR=${INSTALL_PREFIX} install

RUN cmake -S /tmp/build/mfem -B /tmp/build/mfem/build \
      -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_INSTALL_PREFIX=${INSTALL_PREFIX} \
      -DBUILD_SHARED_LIBS=ON \
      -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
      -DMFEM_USE_MPI=YES \
      -DMFEM_USE_OPENMP=YES \
      -DMFEM_USE_METIS=NO \
      -DMFEM_USE_CUDA=YES \
      -DCMAKE_CUDA_ARCHITECTURES="${FULLMAG_CUDA_ARCHITECTURES}" \
      -DMFEM_USE_CEED=YES \
      -DCEED_DIR=${INSTALL_PREFIX} \
      -DMFEM_USE_HYPRE=YES \
      -DHYPRE_DIR=${INSTALL_PREFIX} && \
    cmake --build /tmp/build/mfem/build -j"$(nproc)" && \
    cmake --install /tmp/build/mfem/build

FROM cuda-base-normalized AS fem-gpu-dev

ARG FULLMAG_CUDA_ARCHITECTURES="80-real;89-real;90-real;90-virtual"
ARG NODE_VERSION=24.18.0
ARG NODE_SHA256_AMD64=55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742
ARG NODE_SHA256_ARM64=58c9520501f6ae2b52d5b210444e24b9d0c029a58c5011b797bc1fe7105886f6
ARG PYTHON_VERSION=3.10.21
ARG PYTHON_SHA256=a0da1e72132e950154eca0f6f47d5db828454700de20e5113667940d81e0db04

ENV DEBIAN_FRONTEND=noninteractive
ENV PNPM_HOME=/pnpm
ENV INSTALL_PREFIX=/opt/fullmag-deps
ENV CUDA_HOME=/usr/local/cuda
ENV CUDA_PATH=/usr/local/cuda
ENV PATH=/usr/local/cuda/bin:/root/.cargo/bin:${PNPM_HOME}:${INSTALL_PREFIX}/bin:${PATH}
ENV CMAKE_PREFIX_PATH=${INSTALL_PREFIX}:${CMAKE_PREFIX_PATH}
ENV LD_LIBRARY_PATH=/usr/local/cuda/lib64:${INSTALL_PREFIX}/lib:${LD_LIBRARY_PATH}
ENV PKG_CONFIG_PATH=${INSTALL_PREFIX}/lib/pkgconfig:${INSTALL_PREFIX}/lib64/pkgconfig:${PKG_CONFIG_PATH}
ENV PETSC_DIR=${INSTALL_PREFIX}
ENV SLEPC_DIR=${INSTALL_PREFIX}
ENV FULLMAG_FEM_MFEM_DEVICE=ceed-cuda:/gpu/cuda/shared
ENV FULLMAG_CUDA_ARCHITECTURES=${FULLMAG_CUDA_ARCHITECTURES}
# Build contract: require MFEM stack, CUDA backend, and libCEED so that
# `cargo build --features fem-gpu` inside this container never silently
# produces a stub backend.
ENV FULLMAG_USE_MFEM_STACK=ON
ENV FULLMAG_FEM_REQUIRE_GPU=1
ENV FULLMAG_FEM_REQUIRE_CEED=1

RUN apt-get update && \
    slepc_dev_package=libslepc-real-dev && \
    if ! apt-cache show "${slepc_dev_package}" >/dev/null 2>&1; then \
      slepc_dev_package=libslepc-real3.12-dev; \
    fi && \
    apt-get install -y --no-install-recommends \
    bash \
    build-essential \
    ca-certificates \
    clang \
    curl \
    git \
    libblas3 \
    libboost-dev \
    libbz2-dev \
    libffi-dev \
    libgl1 \
    libglu1-mesa \
    libhdf5-dev \
    liblapack3 \
    liblzma-dev \
    libopenmpi-dev \
    libpetsc-real-dev \
    libreadline-dev \
    libsqlite3-dev \
    "${slepc_dev_package}" \
    libopenmpi-dev \
    libsm6 \
    libssl-dev \
    libx11-6 \
    libxcursor1 \
    libxext6 \
    libxft2 \
    libxi6 \
    libxinerama1 \
    libxrender1 \
    pkg-config \
    python3 \
    python3-dev \
    python3-pip \
    python3-venv \
    xz-utils \
    zlib1g-dev \
    && architecture="$(dpkg --print-architecture)" \
    && case "${architecture}" in \
         amd64) node_arch="x64"; node_sha256="${NODE_SHA256_AMD64}" ;; \
         arm64) node_arch="arm64"; node_sha256="${NODE_SHA256_ARM64}" ;; \
         *) echo "Unsupported Node architecture: ${architecture}" >&2; exit 1 ;; \
       esac \
    && node_archive="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
    && curl -fsSLo "/tmp/${node_archive}" "https://nodejs.org/dist/v${NODE_VERSION}/${node_archive}" \
    && echo "${node_sha256}  /tmp/${node_archive}" | sha256sum -c - \
    && tar -xJf "/tmp/${node_archive}" -C /usr/local --strip-components=1 \
    && rm -f "/tmp/${node_archive}" \
    && rm -rf /var/lib/apt/lists/*

RUN python_archive="Python-${PYTHON_VERSION}.tar.xz" && \
    curl -fsSLo "/tmp/${python_archive}" \
      "https://www.python.org/ftp/python/${PYTHON_VERSION}/${python_archive}" && \
    echo "${PYTHON_SHA256}  /tmp/${python_archive}" | sha256sum -c - && \
    mkdir -p /tmp/python-build && \
    tar -xJf "/tmp/${python_archive}" -C /tmp/python-build --strip-components=1 && \
    cd /tmp/python-build && \
    ./configure --prefix=/usr/local --enable-shared --with-ensurepip=install && \
    make -j"$(nproc)" && \
    make altinstall && \
    ldconfig && \
    ln -sfn /usr/local/bin/python3.10 /usr/local/bin/python3 && \
    ln -sfn /usr/local/bin/pip3.10 /usr/local/bin/pip3 && \
    python3 --version && \
    rm -rf /tmp/python-build "/tmp/${python_archive}"

RUN python3 -m pip install --no-cache-dir cmake==3.30.5
RUN python3 -m pip install --no-cache-dir numpy gmsh meshio trimesh scipy h5py zarr
RUN curl https://sh.rustup.rs -sSf | bash -s -- -y --default-toolchain nightly
RUN corepack enable && corepack prepare pnpm@10.8.1 --activate

COPY --from=deps /opt/fullmag-deps /opt/fullmag-deps

# Nsight Systems/Compute are capture-time capabilities, not build prerequisites.
# The managed runtime must remain buildable when the optional profiler packages
# are absent; the capture harness performs its own bounded preflight instead.
RUN if command -v nsys >/dev/null 2>&1; then nsys --version; else echo "profiler tools are optional: nsys unavailable"; fi && \
    if command -v ncu >/dev/null 2>&1; then ncu --version; else echo "profiler tools are optional: ncu unavailable"; fi

ARG FULLMAG_HYPRE_MEMORY_VARIANT="baseline"
ENV FULLMAG_HYPRE_MEMORY_VARIANT=${FULLMAG_HYPRE_MEMORY_VARIANT}

WORKDIR /workspace
RUN git config --global --add safe.directory /workspace

CMD ["sleep", "infinity"]
