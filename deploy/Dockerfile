# River image: the bridge serving the built page next to /stream, in one process. From the repository root:
#   docker build -f deploy/Dockerfile -t beszel-river .
# Configuration comes from the environment at run time (.env via compose.yml) and the recipe from a
# bind-mounted /config/mix.json; .dockerignore keeps .env and mix.json out of the build context.
#
# The build and deps stages run on the build machine's platform: their output is plain JS. The final
# stage has no RUN step, so building it for another architecture needs no emulation. Adding one there
# means adding QEMU to multi-arch builds.
#
# The final stage is plain Alpine with only the node binary and the two C++ runtime libraries it links
# against, copied from the Node image for the target platform: no npm, npx, yarn or corepack, which the
# service never runs but which image scanners report. Both images must be on the same Alpine release
# (checked in the deps stage), so both tags name it: moving to a new Alpine release changes both lines,
# and Dependabot proposes only updates within it.

FROM alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a AS runtime

FROM node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS node

FROM --platform=$BUILDPLATFORM node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS build
WORKDIR /app
# npm ci needs every workspace manifest the lockfile names.
COPY package.json package-lock.json .npmrc ./
COPY shared/package.json shared/
COPY bridge/package.json bridge/
COPY frontend/package.json frontend/
RUN npm ci --ignore-scripts
COPY tsconfig.base.json ./
COPY shared/ shared/
COPY bridge/ bridge/
COPY frontend/ frontend/
RUN npm run build

FROM --platform=$BUILDPLATFORM node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS deps
# node is built against its image's musl and libstdc++, so the runtime base must be the same Alpine
# release (patch levels may differ). Checked here because the final stage cannot run anything.
COPY --from=runtime /etc/alpine-release /tmp/runtime-alpine-release
RUN node=$(cut -d. -f1,2 /etc/alpine-release) runtime=$(cut -d. -f1,2 /tmp/runtime-alpine-release) && \
    [ "$node" = "$runtime" ] || \
    { echo "Node image is on Alpine $node, the runtime base on $runtime; update both" >&2; exit 1; }
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY shared/package.json shared/
COPY bridge/package.json bridge/
COPY frontend/package.json frontend/
RUN npm ci -w @beszel-river/bridge --omit=dev --ignore-scripts
# These modules are installed for the build machine. A native addon would ship its binary in every
# architecture's image, so stop here instead: such a dependency needs a per-architecture install.
RUN ! find node_modules \( -name '*.node' -o -name binding.gyp \) | grep . || \
    { echo "native addon in production dependencies; see the comment above" >&2; exit 1; }

FROM runtime
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/juusolatva/beszel-river" \
      org.opencontainers.image.description="Live host metrics from a Beszel hub as an abstract river" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.revision="$REVISION"
# Defaults for a plain docker run; compose.yml sets the same values so .env cannot change them.
ENV NODE_ENV=production BIND_HOST=0.0.0.0 BIND_PORT=8787 STATIC_DIR=/app/frontend HEALTH_PORT=8788 \
    MIX_FILE=/config/mix.json
COPY --from=node /usr/local/bin/node /usr/local/bin/
COPY --from=node /usr/lib/libstdc++.so.6 /usr/lib/libgcc_s.so.1 /usr/lib/
WORKDIR /app
# Owned by root and read-only to uid 1000.
COPY --from=deps /app/node_modules node_modules/
COPY --from=deps /app/package.json ./
COPY --from=deps /app/bridge/package.json bridge/
COPY --from=build /app/bridge/dist bridge/dist/
COPY --from=build /app/frontend/dist frontend/
# Only for an explicit MIX_FILE=mix.example.json smoke test; its recipe is public.
COPY bridge/mix.example.json bridge/
WORKDIR /app/bridge
# The Node image's node user; Alpine has no account for it, and nothing here needs the name.
USER 1000:1000
EXPOSE 8787
# Shell form, so it follows a HEALTH_PORT set at run time (compose.host-network.yml moves it).
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --start-interval=2s \
    CMD wget -q -O /dev/null "http://127.0.0.1:${HEALTH_PORT}/healthz" || exit 1
CMD ["node", "dist/main.js"]
