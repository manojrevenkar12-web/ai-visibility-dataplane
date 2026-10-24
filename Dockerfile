# One image, four processes (api, worker, scheduler, shipper): the command picks the role.
FROM oven/bun:1.4.2-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.2-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY config ./config
COPY migrations ./migrations
COPY src ./src
USER bun
EXPOSE 3000 9101
HEALTHCHECK CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT ?? 3000) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["bun", "run", "src/cmd/api.ts"]
