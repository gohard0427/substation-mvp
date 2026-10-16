# syntax=docker/dockerfile:1
FROM python:3.12-slim-bookworm
WORKDIR /app
# Optional CA secret is used only in this managed build environment, never copied.
RUN --mount=type=secret,id=system_ca \
    apt-get update && apt-get install -y --no-install-recommends fonts-noto-cjk gosu ca-certificates && rm -rf /var/lib/apt/lists/*
COPY requirements.lock ./
RUN --mount=type=secret,id=system_ca \
    if [ -f /run/secrets/system_ca ]; then export PIP_CERT=/run/secrets/system_ca; fi; \
    pip install --no-cache-dir -r requirements.lock
RUN groupadd --gid 10001 app && useradd --uid 10001 --gid app --no-create-home app && mkdir /var/data && chown app:app /var/data
COPY server.py vision.py asgi.py ./
COPY static ./static
COPY scripts/entrypoint.sh /app/entrypoint.sh
RUN chmod 755 /app/entrypoint.sh && chmod -R a+rX /app
ENV PYTHONUNBUFFERED=1 DATA_DIR=/var/data COOKIE_SECURE=1 PORT=8000
EXPOSE 8000
ENTRYPOINT ["/app/entrypoint.sh"]
