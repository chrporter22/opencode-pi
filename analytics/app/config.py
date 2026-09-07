import os
from dataclasses import dataclass
from pathlib import Path


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Config:
    port: int
    ingest_secret: str
    gateway_url: str
    redis_url: str | None
    db_file: str
    feature_window_sec: int
    context_windows: int
    ewma_decay: float
    pca_components: int
    watch_z: float
    high_z: float
    ml_dir: str
    model_name: str
    train_min_rows: int
    train_epochs: int
    train_batch: int
    train_trials: int
    train_validation: float
    train_seed: int
    embed_enabled: bool


def load_config(env: dict | None = None) -> Config:
    env = env or os.environ
    ml_dir = env.get("ANALYTICS_ML_DIR", "/opt/qwen-ml")

    return Config(
        port=int(env.get("ANALYTICS_PORT", "8081")),
        ingest_secret=env.get("INGEST_SECRET", ""),
        gateway_url=env.get("ANALYTICS_GATEWAY_URL", "http://gateway-dev:8080"),
        redis_url=env.get("REDIS_URL") or None,
        db_file=env.get("ANALYTICS_DB_FILE", "/data/analytics.db"),
        feature_window_sec=int(env.get("ANALYTICS_FEATURE_WINDOW_SEC", "60")),
        context_windows=int(env.get("ANALYTICS_CONTEXT_WINDOWS", "12")),
        ewma_decay=float(env.get("ANALYTICS_EWMA_DECAY", "0.1")),
        pca_components=int(env.get("ANALYTICS_PCA_COMPONENTS", "6")),
        watch_z=float(env.get("ANALYTICS_PCA_WATCH_Z", "1.0")),
        high_z=float(env.get("ANALYTICS_PCA_HIGH_Z", "1.5")),
        ml_dir=ml_dir,
        model_name=env.get("ANALYTICS_EMBED_MODEL", "risk.net"),
        train_min_rows=int(env.get("ANALYTICS_TRAIN_MIN_ROWS", "4000")),
        train_epochs=int(env.get("ANALYTICS_TRAIN_EPOCHS", "10")),
        train_batch=int(env.get("ANALYTICS_TRAIN_BATCH", "64")),
        train_trials=int(env.get("ANALYTICS_TRAIN_TRIALS", "5")),
        train_validation=float(env.get("ANALYTICS_TRAIN_VALIDATION", "0.2")),
        train_seed=int(env.get("ANALYTICS_TRAIN_SEED", "7")),
        embed_enabled=_env_bool("ANALYTICS_EMBED_ENABLED", False),
    )


def models_dir(cfg: Config) -> Path:
    path = Path(cfg.ml_dir)
    path.mkdir(parents=True, exist_ok=True)
    return path


def model_savedmodel_path(cfg: Config) -> Path:
    return models_dir(cfg) / f"{cfg.model_name}.keras"


def model_tflite_path(cfg: Config) -> Path:
    return models_dir(cfg) / f"{cfg.model_name}.tflite"