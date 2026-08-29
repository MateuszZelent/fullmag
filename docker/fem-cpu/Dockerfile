FROM ubuntu:22.04 AS deps

ENV DEBIAN_FRONTEND=noninteractive
ENV CMAKE_VERSION=3.30.5
ENV MFEM_REF=v4.7
ENV HYPRE_REF=v2.32.0
ENV INSTALL_PREFIX=/opt/fullmag-deps
ENV CC=gcc
ENV CXX=g++
ENV FC=gfortran
ENV PATH=${INSTALL_PREFIX}/bin:/root/.cargo/bin:${PATH}
ENV LD_LIBRARY_PATH=${INSTALL_PREFIX}/lib:${LD_LIBRARY_PATH}
ENV CMAKE_PREFIX_PATH=${INSTALL_PREFIX}:${CMAKE_PREFIX_PATH}

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    build-essential \
    ca-certificates \
    curl \
    gfortran \
    git \
    libopenmpi-dev \
    ninja-build \
    openmpi-bin \
    pkg-config \
    python3 \
    python3-dev \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir cmake==${CMAKE_VERSION}

WORKDIR /tmp/build

RUN git clone --depth 1 --branch ${MFEM_REF} https://github.com/mfem/mfem.git
RUN git clone --depth 1 --branch ${HYPRE_REF} https://github.com/hypre-space/hypre.git

# This dependency prefix is immutable input to Fullmag's native configure.
# Both hypre and MFEM are built explicitly without accelerator support.
RUN cd /tmp/build/hypre/src && \
    CC=mpicc CXX=mpicxx FC=mpifort \
    ./configure \
      --prefix=${INSTALL_PREFIX} \
      --enable-shared \
      --with-openmp \
      --without-cuda \
      --without-umpire && \
    make -j"$(nproc)" && \
    make install

RUN cmake -S /tmp/build/mfem -B /tmp/build/mfem/build \
      -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_INSTALL_PREFIX=${INSTALL_PREFIX} \
      -DBUILD_SHARED_LIBS=ON \
      -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
      -DMFEM_USE_MPI=YES \
      -DMFEM_USE_OPENMP=YES \
      -DMFEM_USE_METIS=NO \
      -DMFEM_USE_CUDA=NO \
      -DMFEM_USE_CEED=NO \
      -DMFEM_USE_HYPRE=YES \
      -DHYPRE_DIR=${INSTALL_PREFIX} && \
    cmake --build /tmp/build/mfem/build -j"$(nproc)" && \
    cmake --install /tmp/build/mfem/build

FROM ubuntu:22.04 AS fem-cpu-dev

ARG NODE_VERSION=24.18.0
ARG NODE_SHA256_AMD64=55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742
ARG NODE_SHA256_ARM64=58c9520501f6ae2b52d5b210444e24b9d0c029a58c5011b797bc1fe7105886f6

ENV DEBIAN_FRONTEND=noninteractive
ENV PNPM_HOME=/pnpm
ENV INSTALL_PREFIX=/opt/fullmag-deps
ENV PATH=/root/.cargo/bin:${PNPM_HOME}:${INSTALL_PREFIX}/bin:${PATH}
ENV CMAKE_PREFIX_PATH=${INSTALL_PREFIX}:${CMAKE_PREFIX_PATH}
ENV LD_LIBRARY_PATH=${INSTALL_PREFIX}/lib:${LD_LIBRARY_PATH}
ENV FULLMAG_MANAGED_FEM_DEVICE=cpu
ENV FULLMAG_USE_MFEM_STACK=ON
ENV FULLMAG_FEM_REQUIRE_GPU=0
ENV FULLMAG_FEM_REQUIRE_CEED=0
ENV FULLMAG_FEM_WITH_SLEPC=OFF

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    build-essential \
    ca-certificates \
    curl \
    git \
    gfortran \
    libboost-dev \
    libgl1 \
    libglu1-mesa \
    libopenmpi-dev \
    libsm6 \
    libx11-6 \
    libxcursor1 \
    libxext6 \
    libxft2 \
    libxi6 \
    libxinerama1 \
    libxrender1 \
    openmpi-bin \
    pkg-config \
    python3 \
    python3-dev \
    python3-pip \
    xz-utils \
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

RUN pip3 install --no-cache-dir cmake==3.30.5
RUN pip3 install --no-cache-dir numpy gmsh meshio trimesh scipy h5py zarr
RUN curl https://sh.rustup.rs -sSf | bash -s -- -y --default-toolchain stable
RUN corepack enable && corepack prepare pnpm@10.8.1 --activate

COPY --from=deps /opt/fullmag-deps /opt/fullmag-deps

WORKDIR /workspace
RUN git config --global --add safe.directory /workspace

CMD ["sleep", "infinity"]
