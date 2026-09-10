"""Pure-Python numeric kernel: EWMA reference, Jacobi eigen-decomposition,
PCA, Hotelling T² (χ² tail via continued fraction), risk labeling.

No scipy — only numpy + stdlib math.
"""

from __future__ import annotations

import math

import numpy as np


def percentile(vals: list[float], p: float) -> float:
    if not vals:
        return 0.0
    arr = sorted(vals)
    idx = (len(arr) - 1) * (p / 100.0)
    lo = math.floor(idx)
    hi = math.ceil(idx)
    if lo == hi:
        return arr[lo]
    return arr[lo] * (hi - idx) + arr[hi] * (idx - lo)


EPS = 1e-30


def _lower_gamma_series(a: float, x: float) -> float:
    dl = 1.0 / a
    d = dl
    s = dl
    for i in range(1, 1000):
        d = d * x / (a + i)
        s += d
        if abs(d) < abs(s) * 1e-15:
            break
    return s * math.exp(-x + a * math.log(x) - math.lgamma(a))


def _upper_gamma_cf(a: float, x: float) -> float:
    b = x + 1.0 - a
    c = 1e30
    d = 1.0 / b if abs(b) > EPS else 1e30
    h = d
    for i in range(1, 1000):
        an = -i * (i - a)
        b += 2.0
        d = an * d + b
        if abs(d) < EPS:
            d = EPS
        c = b + an / c
        if abs(c) < EPS:
            c = EPS
        d = 1.0 / d
        delta = d * c
        h *= delta
        if abs(delta - 1.0) < 1e-14:
            break
    return math.exp(-x + a * math.log(x) - math.lgamma(a)) * h


def gammaincc(a: float, x: float) -> float:
    """Upper regularized incomplete gamma Q(a, x)."""
    if x <= 0.0 or a <= 0.0:
        return 1.0
    if x < a + 1.0:
        return 1.0 - _lower_gamma_series(a, x)
    return _upper_gamma_cf(a, x)


def chi2_sf(df: float, x: float) -> float:
    """Survival function 1 - CDF of χ²(df) at x (Hotelling T² p-value)."""
    if x <= 0.0:
        return 1.0
    return gammaincc(df / 2.0, x / 2.0)


def jacobi_eigh(a: np.ndarray, tol: float = 1e-13, max_iter: int = 50):
    """Eigen-decomposition of a real symmetric matrix (Jacobi rotations).

    Returns (eigenvalues, eigenvectors) with eigenvalues in descending order
    and eigenvectors as the columns of the second result.
    """
    n = a.shape[0]
    b = np.array(a, dtype=float, copy=True)
    v = np.eye(n)
    for _ in range(max_iter):
        off = np.abs(np.triu(b, k=1))
        idx = int(np.argmax(off))
        p, q = divmod(idx, n)
        if p >= q:
            p, q = q, p
        if off[p, q] < tol:
            break
        app = float(b[p, p])
        aqq = float(b[q, q])
        apq = float(b[p, q])
        theta = (aqq - app) / (2.0 * apq) if apq != 0.0 else 1e300
        t = math.copysign(1.0, theta) / (abs(theta) + math.sqrt(theta * theta + 1.0))
        c = 1.0 / math.sqrt(t * t + 1.0)
        s = t * c
        for k in range(n):
            if k != p and k != q:
                akp = float(b[k, p])
                akq = float(b[k, q])
                b[k, p] = b[p, k] = c * akp - s * akq
                b[k, q] = b[q, k] = s * akp + c * akq
        b[p, p] = app - t * apq
        b[q, q] = aqq + t * apq
        b[p, q] = b[q, p] = 0.0
        for k in range(n):
            vkp = float(v[k, p])
            vkq = float(v[k, q])
            v[k, p] = c * vkp - s * vkq
            v[k, q] = s * vkp + c * vkq
    eigenvalues = np.array([float(b[i, i]) for i in range(n)])
    order = np.argsort(eigenvalues)[::-1]
    return eigenvalues[order], v[:, order]


class EwmaReference:
    """Adaptive per-feature mean/second-moment reference with decay."""

    def __init__(self, dim: int, decay: float):
        self.dim = dim
        self.decay = decay
        self.mu = np.zeros(dim, dtype=float)
        self.s2 = np.zeros(dim, dtype=float)
        self.n = 0

    def load(self, mu: np.ndarray, s2: np.ndarray, n: int) -> None:
        self.mu = np.asarray(mu, dtype=float)
        self.s2 = np.asarray(s2, dtype=float)
        self.n = int(n)

    def has_counts(self) -> bool:
        return self.n >= 1

    def update(self, x: np.ndarray) -> np.ndarray:
        """Fold x into the reference, return z = (x − μ)/σ."""
        x = np.asarray(x, dtype=float)
        alpha = self.decay
        if self.n == 0:
            self.mu = x.copy()
            self.s2 = x * x
            self.n = 1
        else:
            self.mu = (1 - alpha) * self.mu + alpha * x
            self.s2 = (1 - alpha) * self.s2 + alpha * x * x
            self.n += 1
        var = np.maximum(self.s2 - self.mu * self.mu, 1e-8)
        sigma = np.sqrt(var)
        if self.n < 2:
            sigma = np.ones(self.dim, dtype=float)
        return (x - self.mu) / sigma

    def sigma(self) -> np.ndarray:
        return np.sqrt(np.maximum(self.s2 - self.mu * self.mu, 1e-8))


def compute_pca(windows: np.ndarray, n_components: int):
    """PCA over rows-of-windows standardized matrix.

    windows: (W x P) float array. Returns (loadings, eigen, scores)
    or None when fewer than 2 windows.
    """
    w, p = windows.shape
    if w < 2:
        return None
    cov = np.cov(windows, rowvar=False, bias=True)
    cov = cov + np.eye(p) * 1e-9
    eigen, vecs = jacobi_eigh(cov)
    k = min(max(1, n_components), p)
    loadings = vecs[:, :k]
    return loadings, eigen[:k], windows @ loadings


def risk_label(pcz: np.ndarray, watch_z: float = 1.0, high_z: float = 1.5) -> str:
    """Top-3-PC direction-aware ±σ label: high / watch / normal."""
    top = pcz[: min(3, len(pcz))]
    if top.size == 0:
        return "normal"
    if np.any(np.abs(top) >= high_z):
        return "high"
    if np.any(np.abs(top) >= watch_z):
        return "watch"
    return "normal"


def hotelling(pcz: np.ndarray) -> tuple[float, float]:
    """Hotelling T² over retained components and asymptotic χ² tail."""
    t2 = float(np.sum(pcz * pcz))
    p = float(chi2_sf(max(int(len(pcz)), 1), t2))
    return t2, p


def label_from_p(p: float | None, p_watch: float = 0.10, p_high: float = 0.05) -> str:
    """Three-tier drift label from the Hotelling T² p-value (lower p = more drift).

    p >= watch → normal (no significant drift), high <= p < watch → watch
    (significant at the 90% tier), p < high → high (significant at 95%).
    A missing/invalid p stays normal for safety.
    """
    if p is None:
        return "normal"
    p = float(p)
    if p < p_high:
        return "high"
    if p < p_watch:
        return "watch"
    return "normal"


def confusion_matrix(y_true: np.ndarray, y_pred: np.ndarray, n: int = 3) -> np.ndarray:
    """n×n confusion matrix from integer class labels."""
    cm = np.zeros((n, n), dtype=int)
    for t, p in zip(y_true.astype(int), y_pred.astype(int)):
        if 0 <= int(t) < n and 0 <= int(p) < n:
            cm[int(t), int(p)] += 1
    return cm


def classification_metrics(y_true: np.ndarray, y_pred: np.ndarray, n: int = 3) -> dict:
    """precision/recall/F1 (per-class + macro), accuracy, and confusion matrix."""
    cm = confusion_matrix(y_true, y_pred, n)
    acc = float(np.trace(cm)) / max(int(cm.sum()), 1)
    classes = []
    for i in range(n):
        tp = int(cm[i, i])
        fp = int(cm[:, i].sum()) - tp
        fn = int(cm[i].sum()) - tp
        precision = tp / max(tp + fp, 1)
        recall = tp / max(tp + fn, 1)
        f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) > 0 else 0.0
        classes.append({"class": i, "precision": precision, "recall": recall, "f1": f1})
    macro = {
        "precision": float(np.mean([c["precision"] for c in classes])),
        "recall": float(np.mean([c["recall"] for c in classes])),
        "f1": float(np.mean([c["f1"] for c in classes])),
    }
    return {
        "accuracy": acc,
        "precision": macro["precision"],
        "recall": macro["recall"],
        "f1": macro["f1"],
        "classes": classes,
        "confusion": cm.tolist(),
    }