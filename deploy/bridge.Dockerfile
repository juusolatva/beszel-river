# Bridge image. Build from the repository root:
#   docker build -f deploy/bridge.Dockerfile -t beszel-river-bridge .
# Configuration comes from the environment at run time (bridge/.env via compose); .dockerignore keeps
# .env and mix.json out of the build context, so the image holds no secrets.

FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS build
WORKDIR /app
# npm ci needs every workspace manifest the lockfile names, even for one workspace.
COPY package.json package-lock.json .npmrc ./
COPY shared/package.json shared/
COPY bridge/package.json bridge/
COPY frontend/package.json frontend/
RUN npm ci -w @beszel-river/bridge --include-workspace-root --ignore-scripts
COPY tsconfig.base.json ./
COPY shared/ shared/
COPY bridge/ bridge/
RUN npm run build -w @beszel-river/bridge

FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY shared/package.json shared/
COPY bridge/package.json bridge/
COPY frontend/package.json frontend/
RUN npm ci -w @beszel-river/bridge --omit=dev --ignore-scripts

FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules node_modules/
COPY --from=deps /app/package.json ./
COPY --from=deps /app/bridge/package.json bridge/
COPY --from=build /app/bridge/dist bridge/dist/
COPY bridge/mix.example.json bridge/
WORKDIR /app/bridge
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s CMD wget -q -O /dev/null http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "dist/main.js"]
