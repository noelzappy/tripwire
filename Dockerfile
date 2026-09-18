FROM oven/bun:1.4-slim
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY policies ./policies
ENV PORT=8787
EXPOSE 8787
CMD ["bun", "run", "src/proxy.ts"]
