import numpy as np

from app.mathlib import (
    EwmaReference,
    chi2_sf,
    classification_metrics,
    compute_pca,
    confusion_matrix,
    hotelling,
    jacobi_eigh,
    percentile,
    risk_label,
)


def test_confusion_and_metrics():
    cm = confusion_matrix(np.array([0, 0, 1, 2, 0]), np.array([0, 0, 2, 2, 1]))
    assert cm.sum() == 5
    m = classification_metrics(np.array([0, 0, 1, 2, 0]), np.array([0, 0, 2, 2, 1]))
    assert m["accuracy"] == 3 / 5
    assert 0 <= m["precision"] <= 1
    assert 0 <= m["recall"] <= 1
    assert 0 <= m["f1"] <= 1
    assert len(m["confusion"]) == 3
    perfect = classification_metrics(np.array([0, 0, 1, 2]), np.array([0, 0, 1, 2]))
    assert perfect["accuracy"] == 1.0
    assert perfect["f1"] == 1.0


def test_percentile_basic():
    assert percentile([], 95) == 0.0
    assert percentile([1, 2, 3, 4, 5], 50) == 3.0
    assert percentile(list(range(100)), 95) == 94.05


def test_chi2_sf_matches_table():
    assert abs(chi2_sf(1, 3.841) - 0.05) < 0.01
    assert abs(chi2_sf(2, 5.991) - 0.05) < 0.01
    assert abs(chi2_sf(1, 0.0) - 1.0) < 1e-9
    assert chi2_sf(2, 100.0) < 1e-6


def test_jacobi_eigh_recovers_known_eigenvalues():
    a = np.array([[4.0, 1.0, 0.0],
                  [1.0, 3.0, 1.0],
                  [0.0, 1.0, 2.0]])
    eig, vecs = jacobi_eigh(a)
    # exact eigenvalues: 4.7320508, 3.0, 1.2679492 (trace 9, det 18)
    assert abs(eig[0] - 4.73205) < 1e-3
    assert abs(eig[1] - 3.0) < 1e-3
    assert abs(eig[2] - 1.26795) < 1e-3
    # reconstruct A
    recon = (vecs * eig) @ vecs.T
    assert np.allclose(recon, a, atol=1e-6)
    # orthonormal
    assert np.allclose(vecs.T @ vecs, np.eye(3), atol=1e-9)


def test_jacobi_eigh_identity():
    eig, vecs = jacobi_eigh(np.eye(4))
    assert np.allclose(eig, 1.0)


def test_ewma_updates_and_standardizes():
    ref = EwmaReference(2, decay=0.5)
    z1 = ref.update(np.array([1.0, 2.0]))
    # first sample => sigma forced to 1, z = 0
    assert np.allclose(z1, 0.0)
    assert ref.n == 1
    z2 = ref.update(np.array([3.0, 4.0]))
    # mu = 0.5*[1,2]+0.5*[3,4] = [2,3]; s2 = 0.5*[1,4]+0.5*[9,16]=[5,10]
    # var = [1,1]; z = [1,1]
    assert np.allclose(z2, [1.0, 1.0])
    assert ref.n == 2


def test_pca_returns_descending_components():
    # 20 windows, 4 features, strong axis relationship
    base = np.random.default_rng(42).normal(size=(20, 4))
    mat = base.copy()
    mat[:, 1] = mat[:, 0] * 2.0 + mat[:, 1]
    result = compute_pca(mat, 4)
    assert result is not None
    loadings, eigen, scores = result
    assert loadings.shape == (4, 4)
    assert eigen.shape == (4,)
    assert scores.shape == (20, 4)
    # eigenvalues descending
    assert np.all(np.diff(eigen) <= 1e-9 + abs(eigen).max() * 1e-9)
    # total variance preserved (bias=True cov, so compare biased variance)
    assert abs(float(eigen.sum()) - float(np.var(mat, axis=0).sum())) < 1e-3


def test_risk_label_rule():
    assert risk_label(np.array([0.1, -0.2]), 1.0, 1.5) == "normal"
    assert risk_label(np.array([1.2, -1.3]), 1.0, 1.5) == "watch"
    assert risk_label(np.array([0.4, -1.7]), 1.0, 1.5) == "high"
    assert risk_label(np.array([1.5, 0.0]), 1.0, 1.5) == "high"
    assert risk_label(np.array([3.0, 0.0]), 1.0, 1.5) == "high"
    # only top-3 considered
    big = np.array([0.1, 0.2, 0.3, 9.0])
    assert risk_label(big, 1.0, 1.5) == "normal"


def test_hotelling_ordering():
    t1, p1 = hotelling(np.array([0.2, 0.3]))
    t2, p2 = hotelling(np.array([2.0, 3.0]))
    assert float(t2) > float(t1)
    assert float(p2) < float(p1)
    assert 0 <= float(p1) <= 1