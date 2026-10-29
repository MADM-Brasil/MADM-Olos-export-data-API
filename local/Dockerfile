FROM node:24-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
FROM base AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY local/package*.json ./local/
RUN npm ci --prefix local
COPY tsconfig*.json ./
COPY src ./src
COPY local ./local
RUN npm --prefix local run generate && npm --prefix local run build

FROM base
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package*.json ./
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/local ./local
USER node
CMD ["node", "local/dist/local/src/main.js", "status"]
