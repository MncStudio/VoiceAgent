ARG NODE_IMAGE=node:22.23.3-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ARG NPM_REGISTRY=https://registry.npmjs.org
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --registry="$NPM_REGISTRY"
COPY . .
RUN npm run build \
    && npx tsup scripts/doctor.ts --format esm --platform node --out-dir dist/diagnostics --external @livekit/rtc-node \
    && npm prune --omit=dev --no-audit --no-fund \
    && rm -rf /app/dist/web/models /app/dist/web/vendor

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.title="VoiceAgent" \
      org.opencontainers.image.revision="${SOURCE_REVISION}"
ENV NODE_ENV=production HOST=127.0.0.1 PORT=3001
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/public ./web/public
RUN mkdir .runtime && chown node:node .runtime \
    && node --input-type=module -e "await import('@livekit/rtc-node'); console.log('Native RTC import OK')"
USER node
EXPOSE 3001
HEALTHCHECK --interval=20s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server/index.js"]
