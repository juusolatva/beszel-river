# River image: the bridge serving the built page next to /stream, in one process. From the repository root:
#   docker build -f deploy/Dockerfile -t beszel-river .
# Configuration comes from the environment at run time (.env via compose.yml) and the recipe from a
# bind-mounted /config/mix.json; .dockerignore keeps .env and mix.json out of the build context.
#
# The build and deps stages run on the build machine's platform: their output is plain JS. The final
# stage has no RUN step, so building it for another architecture needs no emulation. Adding one there
# means adding QEMU to multi-arch builds.

FROM --platform=$BUILDPLATFORM node:26.12.1-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS build
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

FROM --platform=$BUILDPLATFORM node:26.12.1-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS deps
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

FROM node:26.12.1-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/juusolatva/beszel-river" \
      org.opencontainers.image.description="Live host metrics from a Beszel hub as an abstract river" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.revision="$REVISION"
# Defaults for a plain docker run; compose.yml sets the same values so .env cannot change them.
ENV NODE_ENV=production BIND_HOST=0.0.0.0 BIND_PORT=8095 STATIC_DIR=/app/frontend HEALTH_PORT=8788 \
    MIX_FILE=/config/mix.json
WORKDIR /app
# Owned by root and read-only to the node user.
COPY --from=deps /app/node_modules node_modules/
COPY --from=deps /app/package.json ./
COPY --from=deps /app/bridge/package.json bridge/
COPY --from=build /app/bridge/dist bridge/dist/
COPY --from=build /app/frontend/dist frontend/
# Only for an explicit MIX_FILE=mix.example.json smoke test; its recipe is public.
COPY bridge/mix.example.json bridge/
WORKDIR /app/bridge
USER node
EXPOSE 8095
# Shell form, so it follows a HEALTH_PORT set at run time (compose.host-network.yml moves it).
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --start-interval=2s \
    CMD wget -q -O /dev/null "http://127.0.0.1:${HEALTH_PORT}/healthz" || exit 1
CMD ["node", "dist/main.js"]
