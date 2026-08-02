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

ENV DEBIAN_FRONTEND=noninteractive
ENV INSTALL_PREFIX=/opt/fullmag-deps
ENV PATH=/root/.cargo/bin:${INSTALL_PREFIX}/bin:${PATH}
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
    libopenmpi-dev \
    openmpi-bin \
    pkg-config \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir cmake==3.30.5
RUN curl https://sh.rustup.rs -sSf | bash -s -- -y --default-toolchain stable

COPY --from=deps /opt/fullmag-deps /opt/fullmag-deps

WORKDIR /workspace
RUN git config --global --add safe.directory /workspace

CMD ["sleep", "infinity"]
