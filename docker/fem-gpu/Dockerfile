FROM nvidia/cuda:12.4.1-devel-ubuntu22.04 AS deps

ENV DEBIAN_FRONTEND=noninteractive
ENV CMAKE_VERSION=3.30.5
ENV MFEM_REF=v4.7
ENV INSTALL_PREFIX=/opt/fullmag-deps
ENV CUDA_HOME=/usr/local/cuda
ENV CUDA_PATH=/usr/local/cuda
ENV CC=gcc
ENV CXX=g++
ENV FC=gfortran
ENV NVCC=/usr/local/cuda/bin/nvcc
ENV PATH=/usr/local/cuda/bin:${INSTALL_PREFIX}/bin:/root/.cargo/bin:$PATH
ENV LD_LIBRARY_PATH=/usr/local/cuda/lib64:${INSTALL_PREFIX}/lib:${LD_LIBRARY_PATH}
ENV CMAKE_PREFIX_PATH=${INSTALL_PREFIX}:${CMAKE_PREFIX_PATH}

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    build-essential \
    ca-certificates \
    curl \
    gfortran \
    git \
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
RUN cmake -S /tmp/build/mfem -B /tmp/build/mfem/build \
      -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_INSTALL_PREFIX=${INSTALL_PREFIX} \
      -DBUILD_SHARED_LIBS=ON \
      -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
      -DMFEM_USE_MPI=NO \
      -DMFEM_USE_METIS=NO \
      -DMFEM_USE_CUDA=YES \
      -DMFEM_USE_CEED=NO \
      -DMFEM_USE_HYPRE=NO && \
    cmake --build /tmp/build/mfem/build -j"$(nproc)" && \
    cmake --install /tmp/build/mfem/build

FROM nvidia/cuda:12.4.1-devel-ubuntu22.04 AS fem-gpu-dev

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_MAJOR=22
ENV PNPM_HOME=/pnpm
ENV INSTALL_PREFIX=/opt/fullmag-deps
ENV CUDA_HOME=/usr/local/cuda
ENV CUDA_PATH=/usr/local/cuda
ENV PATH=/usr/local/cuda/bin:/root/.cargo/bin:${PNPM_HOME}:${INSTALL_PREFIX}/bin:${PATH}
ENV CMAKE_PREFIX_PATH=${INSTALL_PREFIX}:${CMAKE_PREFIX_PATH}
ENV LD_LIBRARY_PATH=/usr/local/cuda/lib64:${INSTALL_PREFIX}/lib:${LD_LIBRARY_PATH}

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    build-essential \
    ca-certificates \
    clang \
    curl \
    git \
    gnupg \
    libgl1 \
    libglu1-mesa \
    libsm6 \
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
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir cmake==3.30.5
RUN pip3 install --no-cache-dir numpy gmsh meshio trimesh
RUN curl https://sh.rustup.rs -sSf | bash -s -- -y --default-toolchain nightly
RUN corepack enable && corepack prepare pnpm@10.8.1 --activate

COPY --from=deps /opt/fullmag-deps /opt/fullmag-deps

WORKDIR /workspace
RUN git config --global --add safe.directory /workspace

CMD ["sleep", "infinity"]
