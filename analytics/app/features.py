"""Feature vector contract shared by the live analysis + training paths.

The order here must match the gateway pusher's FEATURE_NAMES array
(gateway/src/modules/analytics/pusher.ts).
"""

FEATURE_NAMES = [
    "log1p_requestsPerMinute",
    "errorRate",
    "log1p_p95LatMs",
    "log1p_p99LatMs",
    "log1p_p95TokPerSec",
    "log1p_p99TokPerSec",
    "cpuFrac",
    "memFrac",
    "tempC",
    "diskFrac",
]