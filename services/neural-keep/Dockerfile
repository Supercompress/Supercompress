FROM python:3.11-slim-bookworm

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Real RTK (Rust Token Killer) binary for the Compression Arena comparator.
# Pre-built musl binary from rtk-ai/rtk releases; arch-aware.
RUN set -eux; \
    arch="$(uname -m)"; \
    case "$arch" in \
      x86_64) asset="rtk-x86_64-unknown-linux-musl.tar.gz" ;; \
      aarch64) asset="rtk-aarch64-unknown-linux-gnu.tar.gz" ;; \
      *) echo "unsupported arch $arch" && exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/rtk.tar.gz "https://github.com/rtk-ai/rtk/releases/latest/download/$asset"; \
    tar -xzf /tmp/rtk.tar.gz -C /usr/local/bin; \
    chmod +x /usr/local/bin/rtk; \
    rm /tmp/rtk.tar.gz; \
    rtk --version

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY inference.py server.py ./

ENV SC_NEURAL_DIR=/data/model
ENV PYTHONUNBUFFERED=1
ENV OMP_NUM_THREADS=4
ENV MKL_NUM_THREADS=4
ENV OPENBLAS_NUM_THREADS=4
ENV TORCH_NUM_THREADS=4
ENV SC_ARENA=0
ENV SC_NEURAL_BATCH=32
ENV SC_NEURAL_MAX_LINES=128
ENV SC_NEURAL_MAX_LENGTH=128
ENV SC_NEURAL_INFER_TIMEOUT_S=90

EXPOSE 8080

# Container-local HTTP health (Docker only). Fly uses TCP checks in fly.toml.
HEALTHCHECK --interval=30s --timeout=3s --start-period=180s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=2)" || exit 1

# Single worker — model is ~1.5G + runtime; multi-worker OOMs the 8GB VM.
# High limit-concurrency: app serializes compress itself. A low uvicorn cap
# (was 4) made /health 503 under API retry storms ("Exceeded concurrency limit").
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080", \
     "--workers", "1", "--limit-concurrency", "64", "--timeout-keep-alive", "75"]
