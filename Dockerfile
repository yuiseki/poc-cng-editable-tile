FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci --omit=dev
COPY src/ ./src/

FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache tini
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY package.json ./
COPY data/base.mbtiles ./data/base.mbtiles

ENV PORT=8080
ENV HOST=0.0.0.0
ENV BASE_MBTILES_PATH=/app/data/base.mbtiles
ENV EDITS_SQLITE_PATH=/edits/edits.sqlite
ENV BUILDINGS_LAYER_NAME=buildings

EXPOSE 8080
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
