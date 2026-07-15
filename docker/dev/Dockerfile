FROM rust:1.86-bookworm

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_MAJOR=24
ENV PNPM_HOME=/pnpm
ENV PATH=/root/.cargo/bin:${PNPM_HOME}:${PATH}

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    build-essential \
    ca-certificates \
    clang \
    cmake \
    curl \
    git \
    gnupg \
    libgl1 \
    libglu1-mesa \
    libxcursor1 \
    libxft2 \
    libxinerama1 \
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

RUN git config --global --add safe.directory /workspace
RUN corepack enable && corepack prepare pnpm@10.8.1 --activate

WORKDIR /workspace
