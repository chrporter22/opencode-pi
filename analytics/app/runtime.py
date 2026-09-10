"""Runtime configuration: env defaults overlaid with a durable, UI-editable doc.

The stored document lives in the `config` table (single JSON row). Values not set
in the doc fall back to the env-derived `Config`, so every knob is tunable from
the dashboard without restarting.
"""

from __future__ import annotations

import copy

from .config import Config
from .features import FEATURE_NAMES
from .warehouse import SqliteStore

_DEFAULT_TRAIN = {
    "minRows": None,
    "epochs": None,
    "batch": None,
    "trials": None,
    "validation": None,
    "seed": None,
    "lrChoices": [1e-3, 3e-4, 1e-2],
    "unitsChoices": [12, 24, 48],
    "layersChoices": [1, 2],
    "dropoutChoices": [0.0, 0.1, 0.3],
    "kinds": ["mlr", "mlp"],
    "regChoices": [0.0, 1e-3, 3e-3],
}

_DEFAULT_DOC = {
    "schemaVersion": 1,
    "ingestEnabled": True,
    "ewmaDecay": None,
    "contextWindows": None,
    "pcaComponents": None,
    "watchZ": None,
    "highZ": None,
    "labelPWatch": None,
    "labelPHigh": None,
    "labelMode": "p_value",
    "featureFilter": [True] * len(FEATURE_NAMES),
    "cron": None,
    "watermark": None,
    "updatedAt": None,
    "train": dict(_DEFAULT_TRAIN),
}


def _clean_filter(value) -> list[bool]:
    if not isinstance(value, list) or not value:
        return list(_DEFAULT_DOC["featureFilter"])
    mask = []
    for flag in value:
        flag = bool(flag) if isinstance(flag, bool) else str(flag).strip().lower() in {"1", "true", "yes", "on"}
        mask.append(flag)
    mask = (mask * len(FEATURE_NAMES))[: len(FEATURE_NAMES)]
    return mask


def _clean_num(value, default, conv=float):
    try:
        return conv(value) if value is not None and value != "" else default
    except (TypeError, ValueError):
        return default


def _clean_num_list(value, default):
    if not isinstance(value, list) or not value:
        return list(default)
    out = []
    for item in value:
        try:
            out.append(float(item))
        except (TypeError, ValueError):
            continue
    return out or list(default)


class RuntimeConfig:
    def __init__(self, cfg: Config, store: SqliteStore):
        self.cfg = cfg
        self.store = store
        self.doc: dict = store.load_config_doc() or {}
        self._normalize()

    def _normalize(self) -> None:
        merged = copy.deepcopy(_DEFAULT_DOC)
        for key, value in (self.doc or {}).items():
            if key == "train" and isinstance(value, dict):
                merged["train"].update(value)
            else:
                merged[key] = value
        merged["featureFilter"] = _clean_filter(merged.get("featureFilter"))
        merged["cron"] = merged.get("cron") or None
        self.doc = merged

    def effective(self) -> dict:
        t = self.doc["train"]
        return {
            "schemaVersion": self.doc["schemaVersion"],
            "ingestEnabled": bool(self.doc["ingestEnabled"]),
            "ewmaDecay": self.ewma_decay,
            "contextWindows": self.context_windows,
            "pcaComponents": self.pca_components,
            "watchZ": self.watch_z,
            "highZ": self.high_z,
            "labelPWatch": self.label_p_watch,
            "labelPHigh": self.label_p_high,
            "labelMode": self.label_mode,
            "featureFilter": self.feature_filter,
            "cron": self.cron,
            "watermark": self.watermark,
            "updatedAt": self.doc.get("updatedAt"),
            "train": {
                "minRows": self.train_min_rows,
                "epochs": self.train_epochs,
                "batch": self.train_batch,
                "trials": self.train_trials,
                "validation": self.train_validation,
                "seed": self.train_seed,
                "lrChoices": self.train_lr,
                "unitsChoices": self.train_units,
                "layersChoices": self.train_layers,
                "dropoutChoices": self.train_dropout,
                "kinds": self.train_kinds,
                "regChoices": self.train_reg,
            },
        }

    # --- inference knobs -------------------------------------------------
    @property
    def ingest_enabled(self) -> bool:
        return bool(self.doc.get("ingestEnabled", True))

    @property
    def feature_filter(self) -> list[bool]:
        return list(self.doc["featureFilter"])

    @property
    def filtered_dim(self) -> int:
        return sum(1 for flag in self.feature_filter if flag)

    @property
    def ewma_decay(self) -> float:
        return _clean_num(self.doc.get("ewmaDecay"), self.cfg.ewma_decay)

    @property
    def context_windows(self) -> int:
        return int(_clean_num(self.doc.get("contextWindows"), self.cfg.context_windows, int))

    @property
    def pca_components(self) -> int:
        return int(_clean_num(self.doc.get("pcaComponents"), self.cfg.pca_components, int))

    @property
    def watch_z(self) -> float:
        return _clean_num(self.doc.get("watchZ"), self.cfg.watch_z)

    @property
    def high_z(self) -> float:
        return _clean_num(self.doc.get("highZ"), self.cfg.high_z)

    @property
    def label_p_watch(self) -> float:
        """T² p-value tier for watch (significant below this)."""
        return _clean_num(self.doc.get("labelPWatch"), self.cfg.label_p_watch)

    @property
    def label_p_high(self) -> float:
        """T² p-value tier for high (significant below this)."""
        return _clean_num(self.doc.get("labelPHigh"), self.cfg.label_p_high)

    @property
    def label_mode(self) -> str:
        """Label mode: 'p_value' (default) or 'z_score'."""
        val = str(self.doc.get("labelMode") or "p_value").lower()
        return val if val in ("p_value", "z_score") else "p_value"

    @property
    def cron(self) -> str | None:
        return self.doc.get("cron") or None

    @property
    def watermark(self) -> int | None:
        return self.doc.get("watermark") or None

    # --- training knobs ---------------------------------------------------
    @property
    def train_min_rows(self) -> int:
        return int(_clean_num(self.doc["train"].get("minRows"), self.cfg.train_min_rows, int))

    @property
    def train_epochs(self) -> int:
        return int(_clean_num(self.doc["train"].get("epochs"), self.cfg.train_epochs, int))

    @property
    def train_batch(self) -> int:
        return int(_clean_num(self.doc["train"].get("batch"), self.cfg.train_batch, int))

    @property
    def train_trials(self) -> int:
        return int(_clean_num(self.doc["train"].get("trials"), self.cfg.train_trials, int))

    @property
    def train_validation(self) -> float:
        return _clean_num(self.doc["train"].get("validation"), self.cfg.train_validation)

    @property
    def train_seed(self) -> int:
        return int(_clean_num(self.doc["train"].get("seed"), self.cfg.train_seed, int))

    @property
    def train_lr(self) -> list[float]:
        return _clean_num_list(self.doc["train"].get("lrChoices"), _DEFAULT_TRAIN["lrChoices"])

    @property
    def train_units(self) -> list[int]:
        return [int(v) for v in _clean_num_list(self.doc["train"].get("unitsChoices"), _DEFAULT_TRAIN["unitsChoices"])]

    @property
    def train_layers(self) -> list[int]:
        return [int(v) for v in _clean_num_list(self.doc["train"].get("layersChoices"), _DEFAULT_TRAIN["layersChoices"])]

    @property
    def train_dropout(self) -> list[float]:
        return _clean_num_list(self.doc["train"].get("dropoutChoices"), _DEFAULT_TRAIN["dropoutChoices"])

    @property
    def train_kinds(self) -> list[str]:
        kinds = self.doc["train"].get("kinds") or list(_DEFAULT_TRAIN["kinds"])
        if isinstance(kinds, list):
            cleaned = [k for k in kinds if k in {"mlr", "mlp"}]
            if cleaned:
                return cleaned
        return list(_DEFAULT_TRAIN["kinds"])

    @property
    def train_reg(self) -> list[float]:
        return _clean_num_list(self.doc["train"].get("regChoices"), _DEFAULT_TRAIN["regChoices"])

    # --- persistence ------------------------------------------------------
    def save(self, patch: dict) -> dict:
        doc = copy.deepcopy(self.doc)
        for key, value in patch.items():
            if key in {"train", "featureFilter"}:
                if key == "train" and isinstance(value, dict):
                    doc["train"].update(value)
                elif key == "featureFilter":
                    doc["featureFilter"] = _clean_filter(value)
            elif key in self.doc:
                doc[key] = value
        doc["updatedAt"] = int(__import__("time").time() * 1000)
        self.doc = doc
        self._normalize()
        self.store.save_config_doc(self.doc)
        return self.effective()

    def set_watermark(self, watermark: int | None) -> None:
        self.save({"watermark": watermark})