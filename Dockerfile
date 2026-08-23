# Sift runs as one small Node process with a SQLite file on a mounted volume.
# That is the whole deployment: no queue, no worker fleet, no external database.
FROM node:22-slim

WORKDIR /app

# tsx runs the TypeScript directly, so there is no build step to go wrong.
# Installed before the app files so this layer is cached across code changes.
RUN npm install -g tsx@4

# .npmrc pins the public registry, so builds do not depend on local npm config.
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force

# Config and prompts are part of the image; edit them and redeploy to change
# editorial behaviour. Nothing here contains a secret.
COPY src ./src
COPY prompts ./prompts
COPY config ./config
COPY tsconfig.json ./

# The database lives on a volume so it survives redeploys. Losing it would mean
# losing read history, feedback and the learned weights.
ENV SIFT_DB_PATH=/data/sift.db
ENV NODE_ENV=production
ENV PORT=8787
VOLUME ["/data"]

EXPOSE 8787

# Serves the feeds and runs the pipeline on an interval, in one process.
CMD ["tsx", "src/cli/serve-and-schedule.ts"]
