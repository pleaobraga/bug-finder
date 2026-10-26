# The player's workspace. Mirrors SupportDesk's .devcontainer/Dockerfile (same Node image, "node"
# user, /workspaces/supportdesk), plus Git settings and a port forwarder for the Vite dev server.
FROM node:26.12.1-bookworm

# The snapshot imports and the player's work keep LF line endings, whatever the host settings are.
RUN git config --system core.autocrlf false \
 && git config --system core.eol lf \
 && git config --system --add safe.directory /workspaces/supportdesk \
 && git config --system init.defaultBranch main

COPY forward.mjs /usr/local/lib/bugdetective/forward.mjs

# The named volumes copy ownership from these folders the first time they are mounted.
RUN mkdir -p /workspaces/supportdesk /home/node/.vscode-server \
 && chown -R node:node /workspaces /home/node/.vscode-server

USER node
WORKDIR /workspaces/supportdesk
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

# 15173 forwards to the Vite dev server (which only listens on localhost); 3001 is the API.
EXPOSE 15173 3001
CMD ["node", "/usr/local/lib/bugdetective/forward.mjs"]
