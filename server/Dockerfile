# 不使用 nvidia/cuda 系列 base image：PyPI 的 torch wheel（cu128）已自帶完整
# CUDA runtime 與 cuDNN（site-packages/nvidia/* 約 4.1 GB），與 base image 內建的
# 版本重複，且實際載入的是前者——base image 的 CUDA 從未被使用。改用純 Ubuntu
# 後 image 由 18.2 GB 降至 12.8 GB，已實測 ctranslate2 與 torch 皆能正常使用 GPU
# （int8 與 float16 皆驗證通過）。
#
# GPU 存取由 NVIDIA Container Toolkit 於執行期注入驅動，不需 base image 提供。
# CUDA 版本因此完全由 torch wheel 決定：升級 torch 等同升級 CUDA。
FROM ubuntu:22.04

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
