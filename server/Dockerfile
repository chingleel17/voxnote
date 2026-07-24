FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/root/.cache/huggingface

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 ffmpeg curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 以 uv 管理 Python 相依，建立隔離環境，不使用全域 pip
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

WORKDIR /app

# 先複製相依宣告以善用 layer 快取
COPY pyproject.toml ./
RUN uv sync --no-dev

COPY app.py ./

EXPOSE 8000

CMD ["uv", "run", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
