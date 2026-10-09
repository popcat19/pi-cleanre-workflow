# Purpose: Build the pinned worker runtime without importing host Pi resources.
# Supply BASE_IMAGE as a reviewed repository@sha256 digest.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/cleanre
COPY package.json package-lock.json tsconfig.json Containerfile ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN mkdir -p /workspace /worker /broker /input
ENV NODE_ENV=production
ENTRYPOINT ["/usr/local/bin/node", "/opt/cleanre/node_modules/tsx/dist/cli.mjs", "/opt/cleanre/src/worker.ts"]
