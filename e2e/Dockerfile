# sparecrow E2E clean-room test image.
# Multi-stage: build stage compiles the project; runtime stage installs docker-ce-cli and runs tests.

# ---------------------------------------------------------------------------
# Stage 1: Build
# ---------------------------------------------------------------------------
FROM node:lts AS build

WORKDIR /build

COPY package.json package-lock.json tsconfig.json tsup.config.ts ./
RUN npm ci

COPY src/ ./src/
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2: Runtime
# ---------------------------------------------------------------------------
FROM node:lts AS runtime

# Install docker-ce-cli, jq, and git.
# node:lts is Debian-based — use Docker's official apt repo for docker-ce-cli.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      gnupg \
      lsb-release \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg \
       | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
  && chmod a+r /etc/apt/keyrings/docker.gpg \
  && echo \
       "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
       https://download.docker.com/linux/debian \
       $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
       | tee /etc/apt/sources.list.d/docker.list > /dev/null \
  && apt-get update \
  && apt-get install -y --no-install-recommends docker-ce-cli jq git \
  && rm -rf /var/lib/apt/lists/*

# Build-time args for host user identity.
ARG HOST_UID=1000
ARG HOST_GID=1000
ARG HOST_HOME=/home/testuser

# Create a user whose /etc/passwd entry maps HOST_UID → HOST_HOME so that
# os.homedir() inside sparecrow returns the host's home path (used for
# credential and binary mount assembly).  Root guard: skip useradd when the
# host already runs as root (HOST_HOME=/root).
RUN if [ "${HOST_HOME}" = "/root" ]; then \
      echo "Using existing root user"; \
    else \
      EXISTING_USER=$(getent passwd "${HOST_UID}" 2>/dev/null | cut -d: -f1 || echo ""); \
      if [ -n "$EXISTING_USER" ]; then \
        userdel -r "$EXISTING_USER" 2>/dev/null || userdel "$EXISTING_USER" 2>/dev/null || true; \
      fi; \
      EXISTING_GROUP=$(getent group "${HOST_GID}" 2>/dev/null | cut -d: -f1 || echo ""); \
      if [ -n "$EXISTING_GROUP" ] && [ "$EXISTING_GROUP" != "root" ]; then \
        groupdel "$EXISTING_GROUP" 2>/dev/null || true; \
      fi; \
      groupadd -g "${HOST_GID}" testuser 2>/dev/null || true; \
      useradd -m -d "${HOST_HOME}" -u "${HOST_UID}" -g "${HOST_GID}" -s /bin/bash testuser; \
      mkdir -p "${HOST_HOME}/.local"; \
      chown "${HOST_UID}:${HOST_GID}" "${HOST_HOME}/.local"; \
    fi

# Add the test user to the docker group so it can reach the forwarded socket.
# group_add in docker-compose handles the actual socket GID — this is belt-and-suspenders.
RUN TARGET_USER=$([ "${HOST_HOME}" = "/root" ] && echo "root" || echo "testuser"); \
    groupadd -f docker && \
    usermod -aG docker "$TARGET_USER"

# Copy dist and install production dependencies.
# tsup does not inline all packages — env-paths and other ESM-only deps remain
# as bare-specifier imports that Node resolves from node_modules at runtime.
# Use npm ci --omit=dev to install only production deps (excludes typescript,
# vitest, etc.) keeping the image lean.
COPY --from=build /build/dist /usr/local/lib/sparecrow/dist
COPY --from=build /build/package.json /usr/local/lib/sparecrow/package.json
COPY --from=build /build/package-lock.json /usr/local/lib/sparecrow/package-lock.json
RUN cd /usr/local/lib/sparecrow && npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# Expose CLI binaries as sparecrow and scrow.
RUN chmod +x /usr/local/lib/sparecrow/dist/index.js \
  && ln -s /usr/local/lib/sparecrow/dist/index.js /usr/local/bin/sparecrow \
  && ln -s /usr/local/bin/sparecrow /usr/local/bin/scrow

# Copy the container-side test script.
COPY e2e/test.sh /usr/local/bin/sparecrow-e2e-test
RUN chmod +x /usr/local/bin/sparecrow-e2e-test

# Use numeric UID so this works regardless of whether HOST_HOME=/root (which
# skips useradd).  docker-compose also sets user: "${HOST_UID}:${HOST_GID}",
# keeping both consistent.
USER ${HOST_UID}
WORKDIR ${HOST_HOME}

ENTRYPOINT ["sparecrow-e2e-test"]
