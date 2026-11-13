# Compiled as the npm package is, so the image runs the same dist/. JavaScript is the same on every
# platform, so this runs once, on the build machine.
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src src
RUN npm run build

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-alpine
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY package.json ./

# The image's own node user, by uid so runAsNonRoot can check it. The code stays root-owned and read-only to it.
RUN mkdir /config /data && chown 1000:1000 /data
USER 1000:1000

# mcp.json, models.json and APPEND_SYSTEM.md are read from the working directory when present.
WORKDIR /config
ENV DATA_DIR=/data NODE_ENV=production
VOLUME /data

CMD ["node", "/app/dist/index.js"]
