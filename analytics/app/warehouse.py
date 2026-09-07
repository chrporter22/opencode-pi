from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

import numpy as np


def _blob(arr: np.ndarray) -> bytes:
    return np.asarray(arr, dtype=np.float32).astype(">f4").tobytes() if arr is not None else None


def _unblob(data: bytes | None, shape: tuple | None = None) -> np.ndarray | None:
    if not data:
        return None
    arr = np.frombuffer(bytes(data), dtype=">f4").astype(np.float32)
    if shape is not None:
        arr = arr.reshape(shape)
    return arr


SCHEMA = """
CREATE TABLE IF NOT EXISTS windows(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  window_start INTEGER NOT NULL,
  feature_vec BLOB,
  context BLOB,
  pcs BLOB,
  loadings BLOB,
  eigen BLOB,
  risk TEXT,
  t2 REAL,
  p_value REAL,
  compute_ms REAL,
  nn_latency_ms REAL,
  nn_risk TEXT,
  nn_prob TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS requests(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  feature_vec BLOB,
  embedding BLOB,
  error INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS reference(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  updated_at INTEGER NOT NULL,
  mu BLOB,
  s2 BLOB,
  n INTEGER
);
CREATE TABLE IF NOT EXISTS training_runs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  state TEXT NOT NULL,
  rows INTEGER,
  epochs INTEGER,
  model_file TEXT,
  error TEXT,
  hp TEXT,
  metrics TEXT,
  confusion TEXT,
  best INTEGER,
  watermark INTEGER,
  seconds REAL,
  metadata TEXT
);
CREATE TABLE IF NOT EXISTS config(
  id INTEGER PRIMARY KEY CHECK (id = 1),
  updated_at INTEGER NOT NULL,
  doc TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS models(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'future',
  enabled INTEGER NOT NULL DEFAULT 1,
  filter TEXT,
  sampling TEXT,
  metadata TEXT,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_windows_start ON windows(window_start);
CREATE INDEX IF NOT EXISTS idx_requests_start ON requests(started_at);
"""


class SqliteStore:
    def __init__(self, path: str):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self.conn.executescript(SCHEMA)
        self._migrate()
        self.conn.commit()

    def _migrate(self) -> None:
        win_cols = {r[1] for r in self.conn.execute("PRAGMA table_info(windows)").fetchall()}
        for name, ddl in {
            "nn_latency_ms": "REAL DEFAULT NULL",
            "nn_risk": "TEXT DEFAULT NULL",
            "nn_prob": "TEXT DEFAULT NULL",
        }.items():
            if name not in win_cols:
                self.conn.execute(f"ALTER TABLE windows ADD COLUMN {name} {ddl}")
        train_cols = {r[1] for r in self.conn.execute("PRAGMA table_info(training_runs)").fetchall()}
        for name, ddl in {
            "hp": "TEXT DEFAULT NULL",
            "metrics": "TEXT DEFAULT NULL",
            "confusion": "TEXT DEFAULT NULL",
            "best": "INTEGER DEFAULT 0",
            "watermark": "INTEGER DEFAULT NULL",
            "seconds": "REAL DEFAULT NULL",
            "metadata": "TEXT DEFAULT NULL",
        }.items():
            if name not in train_cols:
                self.conn.execute(f"ALTER TABLE training_runs ADD COLUMN {name} {ddl}")
        model_cols = {r[1] for r in self.conn.execute("PRAGMA table_info(models)").fetchall()}
        for name, ddl in {
            "metadata": "TEXT DEFAULT NULL",
            "deleted_at": "INTEGER DEFAULT NULL",
        }.items():
            if name not in model_cols:
                self.conn.execute(f"ALTER TABLE models ADD COLUMN {name} {ddl}")

    def close(self) -> None:
        self.conn.close()

    def insert_window(self, window_start: int, feature_vec, context, pcs, loadings, eigen,
                      risk, t2, p_value, compute_ms, created_at: int,
                      nn_latency_ms: float | None = None, nn_risk: str | None = None,
                      nn_prob: list[float] | None = None) -> None:
        self.conn.execute(
            "INSERT INTO windows(window_start, feature_vec, context, pcs, loadings, eigen,"
            " risk, t2, p_value, compute_ms, nn_latency_ms, nn_risk, nn_prob, created_at)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (window_start, _blob(feature_vec), _blob(context), _blob(pcs),
             _blob(loadings) if loadings is not None else None, _blob(eigen),
             risk, t2, p_value, compute_ms, nn_latency_ms, nn_risk,
             json.dumps(nn_prob) if nn_prob is not None else None, created_at),
        )
        self.conn.commit()

    def insert_request(self, started_at: int, error: int, feature_vec) -> None:
        self.conn.execute(
            "INSERT INTO requests(started_at, feature_vec, embedding, error) VALUES(?,?,?,?)",
            (started_at, _blob(feature_vec), None, error),
        )
        self.conn.commit()

    def save_reference(self, mu, s2, n: int, updated_at: int) -> None:
        self.conn.execute(
            "INSERT INTO reference(updated_at, mu, s2, n) VALUES(?,?,?,?)",
            (updated_at, _blob(mu), _blob(s2), n),
        )
        self.conn.commit()

    def load_reference(self) -> tuple[np.ndarray, np.ndarray, int] | None:
        row = self.conn.execute(
            "SELECT mu, s2, n FROM reference ORDER BY id DESC LIMIT 1"
        ).fetchone()
        if row is None:
            return None
        mu = _unblob(row[0])
        s2 = _unblob(row[1])
        if mu is None or s2 is None:
            return None
        return mu, s2, int(row[2] or 0)

    def count_windows(self) -> int:
        return int(self.conn.execute("SELECT COUNT(*) FROM windows").fetchone()[0])

    def count_requests(self) -> int:
        return int(self.conn.execute("SELECT COUNT(*) FROM requests").fetchone()[0])

    def latest_window(self) -> dict | None:
        row = self.conn.execute(
            "SELECT id, window_start, risk, t2, p_value, compute_ms FROM windows"
            " ORDER BY window_start DESC LIMIT 1"
        ).fetchone()
        if row is None:
            return None
        return {
            "id": row[0],
            "windowStart": row[1],
            "risk": row[2],
            "t2": row[3],
            "pValue": row[4],
            "computeMs": row[5],
        }

    def latest_pca(self) -> dict | None:
        row = self.conn.execute(
            "SELECT window_start, pcs, loadings, eigen, risk FROM windows"
            " WHERE pcs IS NOT NULL ORDER BY window_start DESC LIMIT 1"
        ).fetchone()
        if row is None:
            return None
        pcs = _unblob(row[1])
        loadings = _unblob(row[2])
        eigen = _unblob(row[3])
        return {
            "windowStart": row[0],
            "pcs": pcs.tolist() if pcs is not None else [],
            "loadings": loadings.tolist() if loadings is not None else [],
            "eigen": eigen.tolist() if eigen is not None else [],
            "risk": row[4],
        }

    def training_features(self, limit: int | None = None, since: int | None = None) -> tuple[list, list]:
        """Labeled training rows from the windows table.

        Returns (features list-of-lists, labels list-of-str). Numeric only.
        Incremental callers pass `since` (a window_start watermark) to get only
        rows newer than the last trained watermark.
        """
        sql = "SELECT feature_vec, pcs, risk FROM windows WHERE risk IS NOT NULL"
        if since is not None:
            sql += " AND window_start > ?"
        sql += " ORDER BY window_start ASC"
        params: list = []
        if since is not None:
            params.append(int(since))
        if limit:
            sql += f" LIMIT {int(limit)}"
        rows = self.conn.execute(sql, params).fetchall()
        features = []
        labels = []
        for feat, _pcs, risk in rows:
            f = _unblob(feat)
            if f is None or risk not in {"normal", "watch", "high"}:
                continue
            features.append(f.tolist())
            labels.append(risk)
        return features, labels

    def training_max_window_start(self) -> int | None:
        row = self.conn.execute(
            "SELECT MAX(window_start) FROM windows WHERE risk IS NOT NULL"
        ).fetchone()
        return int(row[0]) if row and row[0] is not None else None

    def save_config_doc(self, doc: dict | None) -> None:
        if doc is None:
            return
        self.conn.execute(
            "INSERT INTO config(id, updated_at, doc) VALUES(1, ?, ?)"
            " ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, doc=excluded.doc",
            (now_ms(), json.dumps(doc)),
        )
        self.conn.commit()

    def load_config_doc(self) -> dict | None:
        row = self.conn.execute(
            "SELECT doc FROM config WHERE id = 1"
        ).fetchone()
        if row is None or not row[0]:
            return None
        try:
            return json.loads(row[0])
        except ValueError:
            return None

    def list_models(self, include_deleted: bool = False) -> list[dict]:
        rows = self.conn.execute(
            "SELECT id, name, kind, enabled, filter, sampling, metadata, deleted_at, created_at"
            " FROM models ORDER BY id ASC").fetchall()
        out = []
        for row in rows:
            if not include_deleted and row[7] is not None:
                continue
            out.append(self._model_dict(row))
        return out

    def _model_dict(self, row) -> dict:
        return {
            "id": row[0],
            "name": row[1],
            "kind": row[2],
            "enabled": bool(row[3]),
            "filter": json.loads(row[4]) if row[4] else None,
            "sampling": json.loads(row[5]) if row[5] else None,
            "metadata": json.loads(row[6]) if row[6] else None,
            "deletedAt": row[7],
            "createdAt": row[8],
        }

    def get_model(self, model_id: int) -> dict | None:
        row = self.conn.execute(
            "SELECT id, name, kind, enabled, filter, sampling, metadata, deleted_at, created_at"
            " FROM models WHERE id = ?", (int(model_id),)
        ).fetchone()
        if row is None or row[7] is not None:
            return None
        return self._model_dict(row)

    def get_active_risk_model(self) -> dict | None:
        row = self.conn.execute(
            "SELECT id, name, kind, enabled, filter, sampling, metadata, deleted_at, created_at"
            " FROM models WHERE kind = 'risk' AND deleted_at IS NULL AND enabled = 1"
            " ORDER BY id DESC LIMIT 1").fetchone()
        if row is None:
            return None
        return self._model_dict(row)

    def upsert_model(self, name: str, kind: str = "future", enabled: bool = True,
                     filter_: list | None = None, sampling: dict | None = None,
                     metadata: dict | None = None) -> int:
        existing = self.conn.execute(
            "SELECT id FROM models WHERE name = ?", (name,)
        ).fetchone()
        if existing is not None:
            self.conn.execute(
                "UPDATE models SET kind=?, enabled=?, filter=?, sampling=?, metadata=?,"
                " deleted_at=NULL WHERE id=?",
                (kind, 1 if enabled else 0,
                 json.dumps(filter_) if filter_ else None,
                 json.dumps(sampling) if sampling else None,
                 json.dumps(metadata) if metadata else None,
                 existing[0]),
            )
            self.conn.commit()
            return int(existing[0])
        self.conn.execute(
            "INSERT INTO models(name, kind, enabled, filter, sampling, metadata, created_at)"
            " VALUES(?,?,?,?,?,?,?)",
            (name, kind, 1 if enabled else 0,
             json.dumps(filter_) if filter_ else None,
             json.dumps(sampling) if sampling else None,
             json.dumps(metadata) if metadata else None,
             now_ms()),
        )
        self.conn.commit()
        return int(self.conn.execute("SELECT last_insert_rowid()").fetchone()[0])

    def set_model(self, model_id: int, enabled: bool | None = None,
                  filter_: list | None = None, sampling: dict | None = None) -> bool:
        sets = []
        params: list = []
        if enabled is not None:
            sets.append("enabled=?")
            params.append(1 if enabled else 0)
        if filter_ is not None:
            sets.append("filter=?")
            params.append(json.dumps(filter_))
        if sampling is not None:
            sets.append("sampling=?")
            params.append(json.dumps(sampling))
        if not sets:
            return True
        params.append(int(model_id))
        cur = self.conn.execute(
            f"UPDATE models SET {', '.join(sets)} WHERE id=? AND deleted_at IS NULL", params)
        self.conn.commit()
        return cur.rowcount > 0

    def delete_model(self, model_id: int) -> bool:
        """Soft delete: marks deleted_at, never removes rows."""
        cur = self.conn.execute(
            "UPDATE models SET deleted_at=? WHERE id=? AND deleted_at IS NULL",
            (now_ms(), int(model_id)),
        )
        self.conn.commit()
        return cur.rowcount > 0

    def history_windows(self, limit: int = 120) -> list[dict]:
        rows = self.conn.execute(
            "SELECT window_start, pcs, t2, risk FROM windows"
            " WHERE pcs IS NOT NULL ORDER BY window_start DESC LIMIT ?",
            (int(limit),),
        ).fetchall()
        result = []
        for window_start, pcs, t2, risk in rows:
            scores = _unblob(pcs)
            result.append({
                "window_start": window_start,
                "pcs": scores if scores is not None else [],
                "t2": float(t2) if t2 is not None else 0.0,
                "risk": risk,
            })
        return result

    def insert_training_run(self, started_at: int, state: str, rows: int, epochs: int,
                            model_file: str | None, finished_at: int | None, error: str | None,
                            hp: dict | None = None, metrics: dict | None = None,
                            confusion: list | None = None, best: bool = False,
                            watermark: int | None = None, seconds: float | None = None,
                            metadata: dict | None = None) -> None:
        self.conn.execute(
            "INSERT INTO training_runs(started_at, finished_at, state, rows, epochs, model_file,"
            " error, hp, metrics, confusion, best, watermark, seconds, metadata)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (started_at, finished_at, state, rows, epochs, model_file, error,
             json.dumps(hp) if hp is not None else None,
             json.dumps(metrics) if metrics is not None else None,
             json.dumps(confusion) if confusion is not None else None,
             1 if best else 0, watermark, seconds,
             json.dumps(metadata) if metadata else None),
        )
        self.conn.commit()

    def training_runs(self, limit: int = 20) -> list[dict]:
        rows = self.conn.execute(
            "SELECT started_at, finished_at, state, rows, epochs, model_file, error, hp,"
            " metrics, confusion, best, watermark, seconds, metadata"
            " FROM training_runs ORDER BY id DESC LIMIT ?",
            (int(limit),),
        ).fetchall()
        out = []
        for r in rows:
            out.append({
                "startedAt": r[0],
                "finishedAt": r[1],
                "state": r[2],
                "rows": r[3],
                "epochs": r[4],
                "modelFile": r[5],
                "error": r[6],
                "hp": json.loads(r[7]) if r[7] else None,
                "metrics": json.loads(r[8]) if r[8] else None,
                "confusion": json.loads(r[9]) if r[9] else None,
                "best": bool(r[10]),
                "watermark": r[11],
                "seconds": r[12],
                "metadata": json.loads(r[13]) if r[13] else None,
            })
        return out

    def last_training_run(self) -> dict | None:
        row = self.conn.execute(
            "SELECT started_at, finished_at, state, rows, epochs, model_file, error, hp,"
            " metrics, confusion, best, watermark, seconds, metadata"
            " FROM training_runs ORDER BY id DESC LIMIT 1"
        ).fetchone()
        if row is None:
            return None
        return {
            "startedAt": row[0],
            "finishedAt": row[1],
            "state": row[2],
            "rows": row[3],
            "epochs": row[4],
            "modelFile": row[5],
            "error": row[6],
            "hp": json.loads(row[7]) if row[7] else None,
            "metrics": json.loads(row[8]) if row[8] else None,
            "confusion": json.loads(row[9]) if row[9] else None,
            "best": bool(row[10]),
            "watermark": row[11],
            "seconds": row[12],
            "metadata": json.loads(row[13]) if row[13] else None,
        }

    def sql_status(self) -> dict:
        db_path = self.conn.execute("PRAGMA database_list").fetchone()[2]
        try:
            size = Path(db_path).stat().st_size
        except OSError:
            size = 0
        tables = []
        for (name,) in self.conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall():
            count = self.conn.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0]
            tables.append({"table": name, "rows": count})
        latest = self.latest_window()
        return {
            "engine": "sqlite",
            "path": db_path,
            "sizeBytes": size,
            "tables": tables,
            "windows": self.count_windows(),
            "requests": self.count_requests(),
            "latestWindowStart": latest["windowStart"] if latest else None,
            "latestRisk": latest["risk"] if latest else None,
        }

    def query(self, sql: str, limit: int = 200) -> dict:
        """Run a read-only SQL statement against the warehouse (SELECT/WITH/EXPLAIN
        or a small PRAGMA whitelist). Opens a dedicated `mode=ro` connection so
        nothing can be modified, and caps the returned row count."""
        stmt = " ".join(str(sql or "").split())
        if not stmt:
            raise ValueError("empty query")
        lowered = stmt.lower()
        proc = None
        try:
            if lowered.startswith("pragma"):
                allowed = stmt.lower().startswith((
                    "pragma table_info", "pragma index_info",
                    "pragma index_list", "pragma foreign_key_list"))
                if not allowed:
                    raise ValueError("pragma not allowed (read-only console)")
                proc = self.conn
            elif lowered.startswith(("select", "with", "explain")):
                db_path = self.conn.execute("PRAGMA database_list").fetchone()[2]
                proc = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
            else:
                raise ValueError("only SELECT/WITH/EXPLAIN read-only queries allowed")
            cur = proc.execute(stmt)
            cols = [d[0] for d in cur.description] if cur.description else []
            fetched = cur.fetchmany(limit + 1)
            truncated = len(fetched) > limit
            rows = fetched[:limit]

            def cell(v):
                if isinstance(v, bytes):
                    arr = _unblob(v)
                    if arr is not None and arr.size <= 48:
                        head = ", ".join(f"{x:.4g}" for x in arr[:16])
                        return "[" + head + (", …" if arr.size > 16 else "") + "]"
                    return f"<blob {len(v)}B>"
                if isinstance(v, float):
                    return round(v, 6)
                return v

            return {
                "columns": cols,
                "rows": [[cell(v) for v in r] for r in rows],
                "rowCount": len(rows),
                "truncated": truncated,
                "error": None,
            }
        finally:
            if proc is not None and proc is not self.conn:
                proc.close()

    def raw_windows(self, limit: int = 25) -> list[dict]:
        rows = self.conn.execute(
            "SELECT id, window_start, feature_vec, risk, t2, p_value, compute_ms,"
            " nn_latency_ms, nn_risk, created_at"
            " FROM windows ORDER BY window_start DESC LIMIT ?",
            (int(limit),),
        ).fetchall()
        out = []
        for rid, ws, fv, risk, t2, pv, cms, nn_ms, nn_risk, ca in rows:
            arr = _unblob(fv)
            out.append({
                "id": rid,
                "windowStart": ws,
                "features": [round(float(x), 4) for x in arr] if arr is not None else None,
                "risk": risk,
                "t2": round(float(t2), 4) if t2 is not None else None,
                "pValue": round(float(pv), 6) if pv is not None else None,
                "computeMs": round(float(cms), 3) if cms is not None else None,
                "nnMs": round(float(nn_ms), 3) if nn_ms is not None else None,
                "nnRisk": nn_risk,
                "createdAt": ca,
            })
        return out

    def raw_requests(self, limit: int = 25) -> list[dict]:
        rows = self.conn.execute(
            "SELECT id, started_at, feature_vec, error FROM requests"
            " ORDER BY started_at DESC LIMIT ?",
            (int(limit),),
        ).fetchall()
        out = []
        for rid, ts, fv, err in rows:
            arr = _unblob(fv)
            out.append({
                "id": rid,
                "startedAt": ts,
                "features": [round(float(x), 4) for x in arr] if arr is not None else None,
                "error": bool(err),
            })
        return out

    def pca_cloud(self, limit: int = 300) -> list[dict]:
        """Per-window PCA z-scores + features + risk + NN fields for the plot.
        Rows guard (ascending) so the explorer can build a stable cloud."""
        rows = self.conn.execute(
            "SELECT window_start, feature_vec, pcs, risk, t2, p_value, compute_ms,"
            " nn_latency_ms, nn_risk FROM windows WHERE pcs IS NOT NULL"
            " ORDER BY window_start DESC LIMIT ?",
            (int(limit),),
        ).fetchall()
        out = []
        for ws, fv, pcs, risk, t2, pv, cms, nn_ms, nn_risk in reversed(rows):
            arr = _unblob(fv)
            scores = _unblob(pcs)
            out.append({
                "windowStart": ws,
                "features": [round(float(x), 4) for x in arr] if arr is not None else None,
                "pcs": scores.tolist() if scores is not None else [],
                "risk": risk,
                "t2": round(float(t2), 4) if t2 is not None else None,
                "pValue": round(float(pv), 6) if pv is not None else None,
                "computeMs": round(float(cms), 3) if cms is not None else None,
                "nnMs": round(float(nn_ms), 3) if nn_ms is not None else None,
                "nnRisk": nn_risk,
            })
        return out

    def latency_history(self, limit: int = 120) -> list[dict]:
        rows = self.conn.execute(
            "SELECT window_start, compute_ms, nn_latency_ms FROM windows"
            " WHERE (compute_ms IS NOT NULL OR nn_latency_ms IS NOT NULL)"
            " ORDER BY window_start ASC LIMIT ?",
            (int(limit),),
        ).fetchall()
        out = []
        for ws, cms, nn_ms in rows:
            out.append({
                "ts": ws,
                "computeMs": round(float(cms), 3) if cms is not None else None,
                "nnMs": round(float(nn_ms), 3) if nn_ms is not None else None,
            })
        return out


class RedisStore:
    """Optional Redis backing: score cache + training state. Degrades gracefully."""

    def __init__(self, url: str | None, enabled: bool = True):
        self.client = None
        self.enabled = enabled
        if enabled and url:
            try:
                import redis  # noqa: PLC0415

                self.client = redis.Redis.from_url(url, decode_responses=True)
                self.client.ping()
            except Exception:
                self.client = None

    def available(self) -> bool:
        return self.client is not None

    def set_score(self, payload: dict) -> None:
        if self.client:
            try:
                self.client.set("score:latest", json.dumps(payload))
                self.client.expire("score:latest", 60 * 60 * 24)
            except Exception:
                pass

    def get_score(self) -> dict | None:
        if not self.client:
            return None
        try:
            raw = self.client.get("score:latest")
        except Exception:
            return None
        try:
            return json.loads(raw) if raw else None
        except ValueError:
            return None

    def set_training_state(self, payload: dict) -> None:
        if self.client:
            try:
                self.client.set("train:state", json.dumps(payload))
            except Exception:
                pass

    def get_training_state(self) -> dict | None:
        if not self.client:
            return None
        try:
            raw = self.client.get("train:state")
        except Exception:
            return None
        try:
            return json.loads(raw) if raw else None
        except ValueError:
            return None

    def status(self) -> dict:
        if not self.client:
            return {"available": False, "engine": "redis", "keys": 0, "memoryBytes": 0}
        try:
            info = self.client.info("memory")
            keys = []
            for key in self.client.scan_iter("score:*"):
                keys.append({"key": key, "type": self.client.type(key), "ttl": self.client.ttl(key)})
            for key in self.client.scan_iter("train:*"):
                keys.append({"key": key, "type": self.client.type(key), "ttl": self.client.ttl(key)})
            return {
                "available": True,
                "engine": "redis",
                "keys": keys,
                "memoryBytes": int(info.get("used_memory", 0)),
                "persistence": self.client.info("persistence").get("aof_enabled", 0) == 1,
            }
        except Exception as exc:
            return {"available": False, "engine": "redis", "error": str(exc)}


def now_ms() -> int:
    return int(time.time() * 1000)