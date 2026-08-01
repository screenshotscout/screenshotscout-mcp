# syntax=docker/dockerfile:1

ARG NODE_VERSION=22.23.2

FROM node:${NODE_VERSION}-alpine3.24 AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

FROM node:${NODE_VERSION}-alpine3.24 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM alpine:3.24.1 AS runtime
LABEL org.opencontainers.image.title="Screenshot Scout MCP Server" \
      org.opencontainers.image.description="Capture screenshots of webpages as images or PDFs with Screenshot Scout." \
      org.opencontainers.image.url="https://screenshotscout.com/mcp" \
      org.opencontainers.image.documentation="https://screenshotscout.com/docs/mcp" \
      org.opencontainers.image.source="https://github.com/screenshotscout/screenshotscout-mcp" \
      org.opencontainers.image.licenses="MIT"

RUN apk add --no-cache libstdc++ \
    && addgroup -g 1000 node \
    && adduser -u 1000 -G node -s /bin/sh -D node

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json LICENSE ./
COPY --from=build --chown=node:node /app/dist ./dist

USER node
ENTRYPOINT ["node", "dist/stdio.js"]
