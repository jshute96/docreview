# Stage 1: Install dependencies
FROM node:20-alpine AS deps
WORKDIR /app
RUN npm install -g pnpm@11.22.0
# pnpm-workspace.yaml carries the allowBuilds list, without which pnpm skips
# Prisma's postinstall and the query engine never lands in node_modules.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# --node-linker=hoisted produces a flat node_modules like npm's.  pnpm's
# default layout symlinks each package into .pnpm/, and the stage-3 COPYs of
# node_modules/{.prisma,@prisma,prisma} would then copy dangling symlinks.
RUN pnpm install --frozen-lockfile --node-linker=hoisted

# Stage 2: Build the application
FROM node:20-alpine AS builder
WORKDIR /app
RUN npm install -g pnpm@11.22.0
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate Prisma client
RUN pnpm exec prisma generate

# Build the Next.js app
RUN pnpm build

# Stage 3: Production runner
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy standalone build output
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Copy public assets (after standalone so they aren't overwritten)
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Copy Prisma schema, migrations, and CLI for runtime migrate
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/prisma ./node_modules/prisma

# Prisma query engine needs OpenSSL
RUN apk add --no-cache openssl

# Create writable logs directory for the app
RUN mkdir -p /app/logs && chown nextjs:nodejs /app/logs

# Entrypoint script
COPY --chown=nextjs:nodejs docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

USER nextjs

EXPOSE 8080

ENTRYPOINT ["./docker-entrypoint.sh"]
