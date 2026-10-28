# syntax=docker/dockerfile:1
# Optional Linux development environment. It contains system libraries/Rust,
# not application code, credentials or an alternative test runner.
FROM rust:1.99.0-bookworm
RUN --mount=type=secret,id=system_ca \
    if [ -f /run/secrets/system_ca ]; then export SSL_CERT_FILE=/run/secrets/system_ca; fi; \
    apt-get update && \
    apt-get install -y --no-install-recommends libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf xvfb xauth dbus-x11 fonts-liberation && \
    rm -rf /var/lib/apt/lists/*
ARG DEVELOPMENT_UID=1000
RUN useradd --create-home --uid "$DEVELOPMENT_UID" developer
USER developer
ENV DISPLAY=:99
WORKDIR /project
