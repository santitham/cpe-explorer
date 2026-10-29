ARG NODE_IMAGE=node:20-alpine
FROM ${NODE_IMAGE}
LABEL org.opencontainers.image.source="https://github.com/santitham/cpe-explorer" \
      org.opencontainers.image.title="CPE Explorer" \
      org.opencontainers.image.description="KMUTT Computer Engineering course explorer game with a self-hosted scoreboard"
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DATA_DIR=/app/data
COPY package.json server.js ./
COPY public ./public
# The data folder is usually bind-mounted from the host (./data). At start-up we make it writable
# for the unprivileged "node" user, then run the server as that user.
RUN mkdir -p /app/data && chown -R node:node /app/data \
 && printf '#!/bin/sh\nchown -R node:node /app/data 2>/dev/null\nexec su node -s /bin/sh -c "exec node /app/server.js"\n' > /entrypoint.sh \
 && chmod +x /entrypoint.sh
EXPOSE 8080
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["/entrypoint.sh"]
