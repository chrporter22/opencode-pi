FROM python:3.11-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends libgomp1 \
  && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app

COPY analytics/requirements.txt ./requirements.txt
COPY analytics/requirements-dev.txt ./requirements-dev.txt
RUN uv pip install --system --no-cache -r requirements.txt
RUN uv pip install --system --no-cache -r requirements-dev.txt

# Route tf.keras to the Keras 2 compatibility package (see requirements.txt)
ENV TF_USE_LEGACY_KERAS=1

COPY analytics/app ./app
COPY analytics/tests ./tests

EXPOSE 8081

CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8081"]