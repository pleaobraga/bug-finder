# Isolated QA runner: Node 26, Playwright Chromium and the SupportDesk QA CLI (without stages:
# each run mounts the stage package read-only at /package).
FROM node:26.12.1-bookworm

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    CI=1

WORKDIR /opt/qa
COPY cli/package.json cli/package-lock.json ./
# The CLI's postinstall would download Chromium without its system libraries; install both here.
RUN npm ci --ignore-scripts --no-audit --no-fund \
 && npx --no-install playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm

COPY cli/ ./
RUN mkdir -p /cache \
 && chown -R node:node /opt/qa /cache /ms-playwright

USER node
ENTRYPOINT ["node", "/opt/qa/run.ts"]
