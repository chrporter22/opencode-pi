import { Card } from "./ui";

const ENDPOINTS: [string, string, string, string][] = [
  ["GET", "/health", "none", "Liveness probe used by the gateway connection check"],
  ["GET", "/v1/models", "inference", "Model list for OpenAI-compatible clients (ID aliased to Qwen2.5-Coder-3B-Instruct)"],
  ["POST", "/v1/chat/completions", "inference", "Chat completions forwarded to llama-server"],
  ["GET", "/api/status", "admin", "Gateway / llama / model status snapshot"],
  ["GET", "/api/model", "admin", "Model metadata + live llama args"],
  ["POST", "/api/model/restart", "admin", "Restart llama-server (reloads context flags)"],
  ["POST", "/api/model/update", "admin", "Re-download / verify / install the model GGUF"],
  ["GET", "/api/system", "admin", "Live CPU / memory / temp / disk metrics"],
  ["GET", "/api/system/host", "admin", "Host identity, disk, and NVMe/mount info"],
  ["GET", "/api/metrics", "admin", "Sampled metrics history for the sparkline charts"],
  ["GET", "/api/analytics/risk", "admin", "Live risk scorecard: level, Hotelling T², p-value, per-PC z-scores, log-reg risk"],
  ["GET/PUT", "/api/analytics/config", "admin", "Effective config (context windows, EWMA decay, PCA, thresholds, cron, train knobs, feature filter)"],
  ["GET", "/api/analytics/meta", "admin", "Meta: model activity, tflite/savedmodel sizes, latency, input vector feeding the TF model"],
  ["POST", "/api/analytics/infer", "admin", "Run TFLite inference on the latest stored window"],
  ["POST", "/api/analytics/infer/current", "srv", "Live per-sample TFLite inference (gateway → analytics, read-only)"],
  ["POST", "/api/analytics/training/start", "admin", "Force a TF training run (auto-train also triggers on drift)"],
  ["GET", "/api/analytics/training/status", "admin", "Training state, row counts, artifacts, watermark (trainedUpTo)"],
  ["GET", "/api/analytics/training/runs", "admin", "History of training runs with metrics + hyperparams"],
  ["GET", "/api/analytics/models", "admin", "Registered risk models (id, kind, enabled, filter, metadata incl. watermark)"],
  ["POST", "/api/analytics/rebaseline", "admin", "Reset the EWMA reference distribution to the current window"],
  ["GET", "/api/analytics/pca/cloud", "admin", "Per-window PCA projections + z-scores + features for the 3D explorer"],
  ["GET", "/api/analytics/historic/windows", "admin", "Recent scored windows (timestamp, projection, T² drift, risk)"],
  ["GET", "/api/analytics/latency/history", "admin", "Compute + log-reg latency time series"],
  ["GET", "/api/analytics/reference", "admin", "EWMA reference snapshot (μ, σ², n)"],
  ["GET", "/api/analytics/warehouse/sql", "admin", "SQLite tables, row counts, size, file path"],
  ["GET", "/api/analytics/warehouse/redis", "admin", "Redis backing status (keys, memory, AOF)"],
  ["POST", "/api/analytics/warehouse/query", "admin", "Read-only SQL execution against the warehouse DB"],
  ["GET", "/api/analytics/warehouse/raw/windows", "admin", "Raw window rows with named features + per-window z-scores"],
  ["GET", "/api/analytics/warehouse/raw/requests", "admin", "Raw request rows (6 request features)"],
  ["GET", "/api/logs", "admin", "Recent structured log entries"],
  ["GET", "/api/requests", "admin", "Rendered request ring buffer"],
  ["WS", "/ws?key=…", "admin", "Realtime event stream (status, requests, logs, metrics)"],
];

const ENV: [string, string, string][] = [
  ["GATEWAY_HOST", "Gateway bind address", "0.0.0.0"],
  ["GATEWAY_PORT", "Gateway listen port", "8080"],
  ["INFERENCE_API_KEY", "Key for /v1/* (opencode agent, playground)", "required"],
  ["ADMIN_API_KEY", "Key for /api/* and /ws", "required"],
  ["LLAMA_HOST", "llama-server bind address", "127.0.0.1"],
  ["LLAMA_PORT", "llama-server port", "8000"],
  ["LLAMA_BIN", "llama-server path in the container", "/opt/llama/llama-server"],
  ["LLAMA_CONTEXT_SIZE", "Context window (Qwen2.5-Coder-3B-Instruct max 32768)", "32768"],
  ["LLAMA_THREADS", "CPU threads", "unset (llama decides)"],
  ["LLAMA_BATCH_SIZE", "Prompt batch size", "unset"],
  ["LLAMA_PARALLEL", "Parallel sequences", "unset"],
  ["LLAMA_EXTRA_ARGS", "Additional llama-server flags", "unset"],
  ["MODEL_NAME", "Display name / alias exposed by /v1", "Qwen2.5-Coder-3B-Instruct"],
  ["MODEL_URL", "GGUF download URL", "required"],
  ["MODEL_FILE", "Active filename under /models", "current.gguf"],
  ["MODEL_SHA256", "Expected download checksum", "optional"],
  ["MODEL_QUANT", "Quantization label (Q4_K_M)", "—"],
  ["MODEL_DIR", "Host model directory (NVMe)", "/opt/qwen-model"],
  ["AUTO_UPDATE_MODEL", "Opt-in automatic model updates", "false"],
  ["AUTO_UPDATE_INTERVAL", "Model update cadence", "24h"],
  ["ANALYTICS_URL", "Analytics microservice URL (gateway proxy target)", "http://analytics:8081"],
  ["INGEST_SECRET", "Shared auth secret for analytics ingest + stream", "required"],
  ["ANALYTICS_FEATURE_WINDOW_SEC", "Telemetry window length for feature extraction", "60"],
  ["ANALYTICS_PORT", "Analytics container listen port", "8081"],
  ["ANALYTICS_DB_FILE", "Warehouse SQLite file (NVMe, survives compose down -v)", "/opt/qwen-ml/analytics.db"],
  ["ANALYTICS_CONTEXT_WINDOWS", "Windows held in Redis for feature extraction", "12"],
  ["ANALYTICS_EWMA_DECAY", "Reference EWMA decay (0..1)", "0.1"],
  ["ANALYTICS_PCA_COMPONENTS", "Active PCA components for scoring", "6"],
  ["ANALYTICS_PCA_WATCH_Z · HIGH_Z", "Watch / high risk z thresholds", "1.0 / 1.5"],
  ["ANALYTICS_ML_DIR", "ML artifacts dir (models, tflite, logs)", "/opt/qwen-ml"],
  ["ANALYTICS_TRAIN_MIN_ROWS / EPOCHS / BATCH", "TF auto-train defaults", "4000 / 10 / 64"],
  ["REDIS_URL", "Redis backing store URL", "redis://redis:6379/0"],
];

export function Documents() {
  return (
    <div className="grid gap-4 grid-cols-1">
      <Card cls="ac-wh" title="Overview">
        <div className="prose">
          opencode-pi is a local AI gateway on a Raspberry Pi. The <b>opencode agent</b> points its
          OpenAI-compatible provider at the gateway's <span className="k mono">/v1</span> endpoint
          (<span className="method">localhost:8080 /v1/chat/completions</span>, bearer{" "}
          <span className="k mono">INFERENCE_API_KEY</span>) and the gateway runs{" "}
          <span className="k mono">llama-server</span> (llama.cpp) inside its Docker container to serve{" "}
          <span className="k mono">Qwen2.5-Coder-3B-Instruct</span> (4-bit Q4_K_M, context 32768).
          <ul>
            <li><span className="k">Control plane</span> — admin API under <span className="method">/api/*</span> plus the realtime <span className="method">/ws</span> stream; key via <span className="k mono">x-api-key</span>.</li>
            <li><span className="k">Inference plane</span> — OpenAI-compatible <span className="method">/v1/*</span>; key via <span className="k mono">Authorization: Bearer</span> or <span className="k mono">x-api-key</span>.</li>
            <li><span className="k">Provisioning</span> — <span className="k mono">scripts/install.sh</span> installs llama-server + the 4-bit model, <span className="k mono">scripts/update.sh</span> swaps llama.cpp and the model, <span className="k mono">scripts/cleanup.sh</span> removes old artifacts.</li>
            <li><span className="k">Storage</span> — model GGUF lives on NVMe at <span className="k mono">/opt/qwen-model</span>, mounted into the container at <span className="k mono">/models</span>. ML artifacts and the warehouse SQLite DB live on NVMe at <span className="k mono">/opt/qwen-ml</span> (sqlite file <span className="k mono">analytics.db</span>, persists across <span className="k mono">docker compose down -v</span>).</li>
            <li><span className="k">Analytics</span> — an analytics microservice (Python/FastAPI, container <span className="k mono">analytics</span>) windows the gateway telemetry every 60s, scores each window against an EWMA reference (Hotelling T² + z-scores), exposes the live scorecard under <span className="method">/api/analytics/*</span>, and auto-trains a TF risk classifier (saved-model → TFLite → live inference on every scored window). Training is gated on new labeled windows past the watermark, so re-training only happens when the distribution drifts.</li>
          </ul>
        </div>
      </Card>

      <Card cls="ac-pg" title="Endpoints">
        <div className="overflow-x-auto">
          <table className="doc">
            <thead>
              <tr><th>Method</th><th>Path</th><th>Auth</th><th>Purpose</th></tr>
            </thead>
            <tbody>
              {ENDPOINTS.map(([m, p, a, u], i) => (
                <tr key={i}>
                  <td className="method">{m}</td>
                  <td className="mono">{p}</td>
                  <td>{a}</td>
                  <td>{u}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card cls="ac-conn" title="Environment variables">
        <div className="overflow-x-auto">
          <table className="doc">
            <thead>
              <tr><th>Variable</th><th>Purpose</th><th>Default</th></tr>
            </thead>
            <tbody>
              {ENV.map(([v, p, d], i) => (
                <tr key={i}>
                  <td className="k">{v}</td>
                  <td>{p}</td>
                  <td className="mono">{d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}