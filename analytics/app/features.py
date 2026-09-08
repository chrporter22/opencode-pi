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

# Per-request feature order (matches the gateway pusher's request array):
REQUEST_FEATURE_NAMES = [
    "log1p_promptTokens",
    "log1p_completionTokens",
    "log1p_totalTokens",
    "log1p_tokensPerSecond",
    "log1p_durationMs",
    "error",
]