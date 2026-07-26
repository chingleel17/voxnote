FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/root/.cache/huggingface

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 以 uv 管理 Python 版本與相依，不依賴系統 apt 的 Python（Ubuntu 22.04 系統 python3 為
# 3.10，onnxruntime 等相依僅提供 3.11/3.12 wheel，故由 uv 自行下載 3.11）
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/
ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python
RUN uv python install 3.11

WORKDIR /app

# 先複製相依宣告以善用 layer 快取
COPY pyproject.toml ./
RUN uv sync --no-dev --python 3.11

COPY app.py ./

EXPOSE 8000

CMD ["uv", "run", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
