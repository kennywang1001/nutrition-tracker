FROM node:24-slim AS build
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/. .
RUN npm run build

FROM caddy:2-alpine
COPY --from=build /build/dist /srv
COPY caddy/Caddyfile /etc/caddy/Caddyfile
