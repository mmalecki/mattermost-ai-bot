FROM node:24-alpine AS build
# pi-ate-scheduler is installed from GitHub.
RUN apk add --no-cache git
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-alpine
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY package.json ./
COPY src src

# The image's own node user, by uid so runAsNonRoot can check it. The code stays root-owned and read-only to it.
RUN mkdir /config /data && chown 1000:1000 /data
USER 1000:1000

# mcp.json, models.json and APPEND_SYSTEM.md are read from the working directory when present.
WORKDIR /config
ENV DATA_DIR=/data NODE_ENV=production
VOLUME /data

CMD ["node", "/app/src/index.ts"]
