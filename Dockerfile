# ---------- Stage 1: build client ----------
FROM node:20-slim AS client-build
WORKDIR /app/client
COPY client/package.json ./
RUN npm install
COPY client/ ./
RUN npm run build

# ---------- Stage 2: server ----------
FROM node:20-slim AS server
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ gosu \
    && rm -rf /var/lib/apt/lists/*

# dedicated non-root user to run the app as
RUN groupadd -r ammar && useradd -r -g ammar -d /app -s /usr/sbin/nologin ammar

WORKDIR /app
COPY server/package.json ./
RUN npm install --omit=dev
COPY server/ ./
COPY --from=client-build /app/client/dist ./public
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && chown -R ammar:ammar /app

ENV NODE_ENV=production
EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "index.js"]
