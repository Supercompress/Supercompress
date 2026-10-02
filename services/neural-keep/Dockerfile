FROM python:3.11-slim-bookworm

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Real RTK (Rust Token Killer) binary for the Compression Arena comparator.
RUN set -eux; \
    arch="$(uname -m)"; \
    case "$arch" in \
      x86_64) asset="rtk-x86_64-unknown-linux-musl.tar.gz" ;; \
      aarch64) asset="rtk-aarch64-unknown-linux-gnu.tar.gz" ;; \
      *) echo "unsupported arch $arch" && exit 1 ;; \
    esac; \
    # Pin release (not floating /latest) for reproducible builds — audit #19
    curl -fsSL -o /tmp/rtk.tar.gz "https://github.com/rtk-ai/rtk/releases/download/v0.51.0/$asset"; \
    tar -xzf /tmp/rtk.tar.gz -C /usr/local/bin; \
    chmod +x /usr/local/bin/rtk; \
    rm /tmp/rtk.tar.gz; \
    rtk --version

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY inference.py server.py ./
# Product weights: sc-keep-crossencoder-v4-large (~395.8M). Bake locally before fly deploy
# (dir is gitignored). Do not ship the base-distill as the live product model.
COPY model/ /app/model/

ENV SC_NEURAL_DIR=/app/model
ENV PYTHONUNBUFFERED=1
ENV OMP_NUM_THREADS=2
ENV MKL_NUM_THREADS=2
ENV OPENBLAS_NUM_THREADS=2
ENV TORCH_NUM_THREADS=2
ENV SC_ARENA=0
ENV SC_NEURAL_BATCH=12
ENV SC_NEURAL_MAX_LINES=384
ENV SC_NEURAL_MAX_LENGTH=160
ENV SC_NEURAL_INFER_TIMEOUT_S=120
# int8 collapses ModernBERT-large keep probs — leave off (cost via batch/threads).
ENV SC_NEURAL_QUANTIZE=0
ENV SC_NEURAL_THRESHOLD=0.42
ENV SC_NEURAL_CHECKPOINT=sc-keep-crossencoder-v4-large
ENV SC_NEURAL_EXPECTED_BYTES=1583351632
ENV SC_NEURAL_EXPECTED_PARAMS_M=395.83

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=120s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=2)" || exit 1

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080", \
     "--workers", "1", "--limit-concurrency", "64", "--timeout-keep-alive", "75"]
