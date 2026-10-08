FROM ubuntu:22.04 AS deps

ARG FULLMAG_FEM_CPU_BUILD_JOBS=auto
ARG FULLMAG_FEM_CPU_WITH_SLEPC=OFF

ENV DEBIAN_FRONTEND=noninteractive
ENV CMAKE_VERSION=3.30.5
ENV MFEM_REF=v4.10
ENV MFEM_SOURCE_COMMIT=d964264cdb9a13e94a201b6c236c7721e0c8765f
ENV HYPRE_REF=v2.32.0
ENV PETSC_REF=v3.24.6
ENV PETSC_SOURCE_COMMIT=1467453aedb62826efc970ceafc4bd6dab8229ab
ENV SLEPC_REF=v3.24.3
ENV SLEPC_SOURCE_COMMIT=4c754d7d3ae067837670828a304512798334fb3a
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

RUN git clone --depth 1 --branch ${MFEM_REF} https://github.com/mfem/mfem.git && \
    test "$(git -C mfem rev-parse HEAD)" = "${MFEM_SOURCE_COMMIT}"
RUN git clone --depth 1 --branch ${HYPRE_REF} https://github.com/hypre-space/hypre.git

RUN set -eu; \
    mfem_observed="$(git -C /tmp/build/mfem rev-parse HEAD)"; \
    test "$mfem_observed" = "${MFEM_SOURCE_COMMIT}"; \
    hypre_observed="$(git -C /tmp/build/hypre rev-parse HEAD)"; \
    build_jobs="${FULLMAG_FEM_CPU_BUILD_JOBS}"; \
    if [ "$build_jobs" = auto ]; then build_jobs="$(nproc)"; fi; \
    case "$build_jobs" in ''|*[!0-9]*) echo "FULLMAG_FEM_CPU_BUILD_JOBS must be auto or a positive integer" >&2; exit 2 ;; esac; \
    [ "$build_jobs" -gt 0 ]; \
    mkdir -p "${INSTALL_PREFIX}/share/fullmag"; \
    printf '{"schema":"fullmag.fem.cpu_image_build_inputs.v1","base_image":"ubuntu:22.04","mfem_ref":"%s","mfem_source_commit_expected":"%s","mfem_source_commit_observed":"%s","hypre_ref":"%s","hypre_source_commit_observed":"%s","cmake_version":"%s","dependency_build_jobs":%s}\n' \
      "${MFEM_REF}" "${MFEM_SOURCE_COMMIT}" "$mfem_observed" "${HYPRE_REF}" "$hypre_observed" "${CMAKE_VERSION}" "$build_jobs" \
      > "${INSTALL_PREFIX}/share/fullmag/fem-cpu-build-inputs.json"

# This dependency prefix is immutable input to Fullmag's native configure.
# Both hypre and MFEM are built explicitly without accelerator support.
RUN build_jobs="${FULLMAG_FEM_CPU_BUILD_JOBS}"; \
    if [ "$build_jobs" = auto ]; then build_jobs="$(nproc)"; fi; \
    case "$build_jobs" in ''|*[!0-9]*) echo "FULLMAG_FEM_CPU_BUILD_JOBS must be auto or a positive integer" >&2; exit 2 ;; esac; \
    [ "$build_jobs" -gt 0 ] && \
    cd /tmp/build/hypre/src && \
    CC=mpicc CXX=mpicxx FC=mpifort \
    ./configure \
      --prefix=${INSTALL_PREFIX} \
      --enable-shared \
      --with-openmp \
      --without-cuda \
      --without-umpire && \
    make -j"$build_jobs" && \
    make install

RUN build_jobs="${FULLMAG_FEM_CPU_BUILD_JOBS}"; \
    if [ "$build_jobs" = auto ]; then build_jobs="$(nproc)"; fi; \
    case "$build_jobs" in ''|*[!0-9]*) echo "FULLMAG_FEM_CPU_BUILD_JOBS must be auto or a positive integer" >&2; exit 2 ;; esac; \
    [ "$build_jobs" -gt 0 ] && \
    cmake -S /tmp/build/mfem -B /tmp/build/mfem/build \
      -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_CXX_STANDARD=17 \
      -DCMAKE_INSTALL_PREFIX=${INSTALL_PREFIX} \
      -DBUILD_SHARED_LIBS=ON \
      -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
      -DMFEM_USE_MPI=YES \
      -DMFEM_USE_OPENMP=YES \
      -DMFEM_USE_METIS=NO \
      -DMFEM_USE_CUDA=NO \
      -DMFEM_USE_CEED=NO \
      -DMFEM_USE_HYPRE=YES \
      -DHYPRE_DIR=${INSTALL_PREFIX} \
      -DMFEM_ENABLE_TESTING=OFF && \
    cmake --build /tmp/build/mfem/build --target mfem -j"$build_jobs" && \
    cmake --install /tmp/build/mfem/build

# SLEPc is opt-in for the CPU source-contract route. Build it against this
# image's existing CPU HYPRE/MFEM prefix; never borrow the CUDA image prefix.
RUN if [ "${FULLMAG_FEM_CPU_WITH_SLEPC}" = ON ]; then \
      apt-get update && \
      apt-get install -y --no-install-recommends libblas-dev liblapack-dev && \
      rm -rf /var/lib/apt/lists/*; \
    fi

# Prefix-based SLEPc config resolves its temporary PETSC_ARCH from generated
# slepcvariables; keep it unset so make can load that value.
RUN set -eu; \
    case "${FULLMAG_FEM_CPU_WITH_SLEPC}" in ON|OFF) ;; *) echo "FULLMAG_FEM_CPU_WITH_SLEPC must be ON or OFF" >&2; exit 2 ;; esac; \
    if [ "${FULLMAG_FEM_CPU_WITH_SLEPC}" = ON ]; then \
      build_jobs="${FULLMAG_FEM_CPU_BUILD_JOBS}"; \
      if [ "$build_jobs" = auto ]; then build_jobs="$(nproc)"; fi; \
      case "$build_jobs" in ''|*[!0-9]*) echo "FULLMAG_FEM_CPU_BUILD_JOBS must be auto or a positive integer" >&2; exit 2 ;; esac; \
      [ "$build_jobs" -gt 0 ]; \
      export FULLMAG_FEM_CPU_RESOLVED_BUILD_JOBS="$build_jobs"; \
      git clone --depth 1 --branch "${PETSC_REF}" https://gitlab.com/petsc/petsc.git /tmp/build/petsc-cpu; \
      petsc_observed="$(git -C /tmp/build/petsc-cpu rev-parse HEAD)"; \
      test "$petsc_observed" = "${PETSC_SOURCE_COMMIT}"; \
      cd /tmp/build/petsc-cpu; \
      PETSC_DIR=/tmp/build/petsc-cpu PETSC_ARCH=arch-linux-cpu python3 ./configure \
        PETSC_ARCH=arch-linux-cpu \
        --prefix="${INSTALL_PREFIX}" \
        --with-cc=mpicc --with-cxx=mpicxx --with-fc=mpifort \
        COPTFLAGS=-O3 CXXOPTFLAGS=-O3 FOPTFLAGS=-O3 \
        --with-debugging=0 --with-shared-libraries=1 \
        --with-scalar-type=real --with-precision=double \
        --with-cuda=0 --with-hip=0 --with-sycl=0 --with-opencl=0 \
        --with-blaslapack-lib="-llapack -lblas" \
        --with-hypre=1 --with-hypre-dir="${INSTALL_PREFIX}"; \
      make PETSC_DIR=/tmp/build/petsc-cpu PETSC_ARCH=arch-linux-cpu -j"$build_jobs" all; \
      make PETSC_DIR=/tmp/build/petsc-cpu PETSC_ARCH=arch-linux-cpu install; \
      git clone --depth 1 --branch "${SLEPC_REF}" https://gitlab.com/slepc/slepc.git /tmp/build/slepc-cpu; \
      slepc_observed="$(git -C /tmp/build/slepc-cpu rev-parse HEAD)"; \
      test "$slepc_observed" = "${SLEPC_SOURCE_COMMIT}"; \
      cd /tmp/build/slepc-cpu; \
      unset PETSC_ARCH; \
      SLEPC_DIR=/tmp/build/slepc-cpu PETSC_DIR="${INSTALL_PREFIX}" \
        python3 ./configure --prefix="${INSTALL_PREFIX}"; \
      slepc_variables="/tmp/build/slepc-cpu/lib/slepc/conf/slepcvariables"; \
      slepc_build_arch="$(sed -n 's/^PETSC_ARCH[[:space:]]*=[[:space:]]*//p' "$slepc_variables" | head -n 1)"; \
      [ -n "$slepc_build_arch" ]; \
      case "$slepc_build_arch" in installed-arch-*) ;; *) echo "SLEPc prefix configure did not resolve an installed-PETSc arch" >&2; exit 2 ;; esac; \
      test -f "/tmp/build/slepc-cpu/$slepc_build_arch/lib/slepc/conf/slepcvariables"; \
      test -f "/tmp/build/slepc-cpu/$slepc_build_arch/lib/slepc/conf/slepcrules"; \
      test -z "${PETSC_ARCH+x}"; \
      make SLEPC_DIR=/tmp/build/slepc-cpu PETSC_DIR="${INSTALL_PREFIX}" -j"$build_jobs" all; \
      make SLEPC_DIR=/tmp/build/slepc-cpu PETSC_DIR="${INSTALL_PREFIX}" install; \
      export PETSC_DIR="${INSTALL_PREFIX}" SLEPC_DIR="${INSTALL_PREFIX}"; \
      export PKG_CONFIG_PATH="${INSTALL_PREFIX}/lib/pkgconfig:${INSTALL_PREFIX}/lib64/pkgconfig"; \
      petscconf="${INSTALL_PREFIX}/include/petscconf.h"; \
      grep -Eq '^#define PETSC_USE_REAL_DOUBLE 1$' "$petscconf"; \
      if grep -Eq '^#define PETSC_USE_COMPLEX([[:space:]]|$)' "$petscconf"; then echo "CPU PETSc unexpectedly uses complex scalars" >&2; exit 2; fi; \
      test "$(pkg-config --modversion PETSc)" = "3.24.6"; \
      test "$(pkg-config --modversion SLEPc)" = "3.24.3"; \
      test -f "${INSTALL_PREFIX}/lib/libpetsc.so"; \
      test -f "${INSTALL_PREFIX}/lib/libslepc.so"; \
      export PETSC_OBSERVED_COMMIT="$petsc_observed" SLEPC_OBSERVED_COMMIT="$slepc_observed"; \
      export HYPRE_OBSERVED_COMMIT="$(git -C /tmp/build/hypre rev-parse HEAD)"; \
      export PETSC_VERSION="$(pkg-config --modversion PETSc)" SLEPC_VERSION="$(pkg-config --modversion SLEPc)"; \
      export PETSC_PKGCONFIG_DIR="$(pkg-config --variable=pcfiledir PETSc)" SLEPC_PKGCONFIG_DIR="$(pkg-config --variable=pcfiledir SLEPc)"; \
      export BLAS_DEV_PACKAGE_VERSION="$(dpkg-query -W -f='${Version}' libblas-dev)"; \
      export LAPACK_DEV_PACKAGE_VERSION="$(dpkg-query -W -f='${Version}' liblapack-dev)"; \
      export SLEPC_RESOLVED_BUILD_ARCH="$slepc_build_arch"; \
      export PETSC_CONF_SHA256="$(sha256sum "$petscconf" | awk '{print $1}')"; \
      python3 -c "import json,os; data={'schema':'fullmag.fem.cpu_slepc_build_inputs.v1','petsc_ref':os.environ['PETSC_REF'],'petsc_source_commit_expected':os.environ['PETSC_SOURCE_COMMIT'],'petsc_source_commit_observed':os.environ['PETSC_OBSERVED_COMMIT'],'petsc_version':os.environ['PETSC_VERSION'],'petsc_arch':'arch-linux-cpu','petsc_prefix':os.environ['INSTALL_PREFIX'],'petsc_configure_flags':['--with-cc=mpicc','--with-cxx=mpicxx','--with-fc=mpifort','COPTFLAGS=-O3','CXXOPTFLAGS=-O3','FOPTFLAGS=-O3','--with-debugging=0','--with-shared-libraries=1','--with-scalar-type=real','--with-precision=double','--with-cuda=0','--with-hip=0','--with-sycl=0','--with-opencl=0','--with-blaslapack-lib=-llapack -lblas','--with-hypre=1','--with-hypre-dir='+os.environ['INSTALL_PREFIX']],'petsc_scalar_type':'real','petsc_precision':'double','petsc_accelerators':{'cuda':False,'hip':False,'sycl':False,'opencl':False},'petsc_use_real_double_macro':True,'petsc_use_complex_macro':False,'petscconf_sha256':os.environ['PETSC_CONF_SHA256'],'petsc_pkgconfig_dir':os.environ['PETSC_PKGCONFIG_DIR'],'blas_lapack_provider':'system-ubuntu','blas_build_package':'libblas-dev','blas_build_package_version':os.environ['BLAS_DEV_PACKAGE_VERSION'],'lapack_build_package':'liblapack-dev','lapack_build_package_version':os.environ['LAPACK_DEV_PACKAGE_VERSION'],'slepc_ref':os.environ['SLEPC_REF'],'slepc_source_commit_expected':os.environ['SLEPC_SOURCE_COMMIT'],'slepc_source_commit_observed':os.environ['SLEPC_OBSERVED_COMMIT'],'slepc_version':os.environ['SLEPC_VERSION'],'slepc_prefix':os.environ['INSTALL_PREFIX'],'slepc_petsc_dir':os.environ['INSTALL_PREFIX'],'slepc_petsc_arch_environment_set':False,'slepc_petsc_arch_environment_value':None,'slepc_resolved_build_arch':os.environ['SLEPC_RESOLVED_BUILD_ARCH'],'slepc_resolved_build_arch_directory_verified':True,'slepc_configure_flags':['--prefix='+os.environ['INSTALL_PREFIX']],'slepc_pkgconfig_dir':os.environ['SLEPC_PKGCONFIG_DIR'],'hypre_ref':os.environ['HYPRE_REF'],'hypre_source_commit_observed':os.environ['HYPRE_OBSERVED_COMMIT'],'dependency_build_jobs':int(os.environ['FULLMAG_FEM_CPU_RESOLVED_BUILD_JOBS'])}; path=os.path.join(os.environ['INSTALL_PREFIX'],'share/fullmag/fem-cpu-slepc-build-inputs.json'); open(path,'w',encoding='utf-8').write(json.dumps(data,indent=2,sort_keys=True)+'\\n')"; \
      rm -rf /tmp/build/petsc-cpu /tmp/build/slepc-cpu; \
    fi

FROM ubuntu:22.04 AS fem-cpu-dev

ARG FULLMAG_FEM_CPU_WITH_SLEPC=OFF
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

RUN if [ "${FULLMAG_FEM_CPU_WITH_SLEPC}" = ON ]; then \
      apt-get update && \
      apt-get install -y --no-install-recommends libblas3 liblapack3 && \
      rm -rf /var/lib/apt/lists/*; \
    fi

RUN pip3 install --no-cache-dir cmake==3.30.5
RUN pip3 install --no-cache-dir numpy gmsh meshio trimesh scipy h5py zarr
RUN curl https://sh.rustup.rs -sSf | bash -s -- -y --default-toolchain stable
RUN corepack enable && corepack prepare pnpm@10.8.1 --activate

COPY --from=deps /opt/fullmag-deps /opt/fullmag-deps

WORKDIR /workspace
RUN git config --global --add safe.directory /workspace

CMD ["sleep", "infinity"]
