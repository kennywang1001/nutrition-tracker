# build 階段固定跑在「建置機器本身」的架構（$BUILDPLATFORM）：產出的 dist 是
# 純靜態檔、跟 CPU 架構無關。CI 做 arm64 映像時，npm ci／vite build 因此不用
# 在 QEMU 模擬下跑（慢好幾倍）；只有最後的 caddy 階段是目標架構。
FROM --platform=$BUILDPLATFORM node:24-slim AS build
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/. .
RUN npm run build

FROM caddy:2-alpine
COPY --from=build /build/dist /srv
COPY caddy/Caddyfile /etc/caddy/Caddyfile
