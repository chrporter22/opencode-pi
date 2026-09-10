// Payload shapes mirror the gateway /api/* responses and /ws events.
// Cross-reference: docs/analytics-layer.md and gateway/src/routes/*.

export type RiskLabel = "normal" | "watch" | "high";

export interface SystemStatus {
  gateway: "online" | "offline" | string;
  llama: string;
  model: string;
  modelLoaded?: boolean;
}

export interface ModelMeta {
  name: string;
  quantization?: string;
  quantizationLabel?: string;
  contextSize?: number;
  installed?: boolean;
  sizeBytes?: number;
  installedAt?: string;
  sha256?: string;
  file?: string;
  loadingStatus?: string;
  llamaArgs?: string;
}

export interface DiskInfo {
  usedPercent?: number;
  availableBytes?: number;
  totalBytes?: number;
}

export interface SystemMetrics {
  cpu?: number;
  memory?: number;
  temperature?: number;
  disk?: DiskInfo;
  diskUsedPct?: number;
  tokensPerSecond?: number;
  requestsPerMinute?: number;
  sampleMs?: number;
  timestamp?: string | number;
}

export interface MountInfo {
  device: string;
  mount: string;
  fs?: string;
}

export interface HostInfo {
  hostname?: string;
  os?: string;
  hostOs?: string;
  kernel?: string;
  arch?: string;
  model?: string;
  cpuModel?: string;
  cpuCores?: number;
  memoryTotalBytes?: number;
  uptimeSeconds?: number;
  localIp?: string;
  mounts?: MountInfo[];
}

export interface PcaScore {
  i: number;
  z: number;
  value: number;
}

export interface AnalyticsRisk {
  type?: string;
  level?: RiskLabel;
  t2?: number;
  pValue?: number;
  computeMs?: number;
  windowsScored?: number;
  contextWindows?: number;
  contextCap?: number;
  modelActive?: boolean;
  nnRisk?: RiskLabel;
  nnProb?: [number, number, number] | number[];
  nnLatencyMs?: number;
  pcScores?: PcaScore[];
  variance?: number[];
  heartbeat?: number;
  lastRun?: number;
  confidence?: number;
}

export interface AnalyticsInfer {
  type?: string;
  nnRisk?: RiskLabel;
  nnProb?: number[];
  nnLatencyMs?: number;
  timestamp?: number;
  source?: "live" | string;
  onWindowStart?: number;
}

export interface TrainConfig {
  minRows?: number;
  epochs?: number;
  batch?: number;
  trials?: number;
  validation?: number;
  seed?: number;
}

export interface AnalyticsConfig {
  featureWindowSec?: number;
  ingestEnabled?: boolean;
  ewmaDecay?: number;
  pcaComponents?: number;
  watchZ?: number;
  highZ?: number;
  cron?: string;
  nextRun?: string;
  watermark?: string;
  train?: TrainConfig;
  featureFilter?: boolean[];
  mlDir?: string;
  redisAvailable?: boolean;
}

export interface BestModel {
  f1?: number;
  accuracy?: number;
  precision?: number;
  recall?: number;
}

export interface ModelMetadata {
  architecture?: { inputDim?: number; params?: number };
  hparams?: { kind?: string };
  metrics?: { f1?: number; accuracy?: number; precision?: number; recall?: number };
  datasetRows?: number;
  fineTuned?: boolean;
  trainSeconds?: number;
  trainedUpTo?: string;
}

export interface TrainingStatus {
  state?: string;
  rows?: number;
  minRows?: number;
  run?: number;
  trials?: number;
  epochs?: number;
  modelActive?: boolean;
  tfliteModel?: string;
  tfliteBytes?: number;
  savedModel?: string;
  modelBytes?: number;
  trainedUpTo?: string;
  watermark?: string;
  error?: string;
  best?: { metrics?: BestModel; modelFile?: string; kind?: string };
  modelMetadata?: ModelMetadata;
}

export interface InputFeature {
  name: string;
  value: number | string;
}

export interface FeatureFilterEntry {
  name: string;
  enabled: boolean;
}

export interface AnalyticsMeta {
  ingestEnabled?: boolean;
  model?: {
    active?: boolean;
    name?: string;
    tfliteBytes?: number;
    kerasBytes?: number;
  };
  inputFeatures?: InputFeature[];
  inputFilter?: FeatureFilterEntry[];
  latency?: {
    lastComputeMs?: number;
    lastNnMs?: number;
    nnRuns?: number;
  };
  context?: {
    count?: number;
    cap?: number;
  };
  system?: {
    cpuFrac?: number;
    memFrac?: number;
    tempC?: number;
    diskFrac?: number;
  };
  nextRun?: string;
}

export interface TrainingRun {
  id: number;
  startedAt: string;
  state?: string;
  rows?: number;
  epochs?: number;
  metrics?: { f1?: number; accuracy?: number; precision?: number; recall?: number };
  best?: boolean;
  seconds?: number;
  error?: string;
}

export interface RegisteredModel {
  id: number;
  name?: string;
  kind?: string;
  enabled?: boolean;
  createdAt?: string;
  metadata?: ModelMetadata;
}

export interface WarehouseTable {
  table: string;
  rows: number;
}

export interface WarehouseSql {
  tables?: WarehouseTable[];
  windows?: number;
  requests?: number;
  sizeBytes?: number;
  path?: string;
  latestWindowStart?: string;
  latestRisk?: string;
}

export interface RedisKey {
  key: string;
  type?: string;
  ttl?: number;
}

export interface WarehouseRedis {
  available?: boolean;
  keys?: RedisKey[];
  memoryBytes?: number;
  persistence?: boolean;
}

export interface QueryResult {
  columns?: string[];
  rows?: unknown[][];
  rowCount?: number;
  truncated?: boolean;
  ms?: number;
}

export interface CloudPoint {
  windowStart: string;
  risk?: RiskLabel;
  t2?: number;
  pValue?: number;
  computeMs?: number;
  nnMs?: number;
  pcs?: number[];
  z?: number[];
  features?: number[];
  featureNames?: string[];
}

export interface HistoricWindow {
  timestamp?: string;
  windowStart?: string;
  drift?: number;
  risk?: RiskLabel;
  t2?: number;
}

export interface LatencyPoint {
  computeMs?: number;
  nnMs?: number;
}

export interface LogEntry {
  msg: string;
  level: string;
}

export interface RequestRecord {
  id: string;
  method?: string;
  path?: string;
  model?: string;
  source?: string;
  ip?: string;
  status: string;
  startedAt: number;
  durationMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  tokensPerSecond?: number;
  error?: string;
}

export interface ConnCheckResult {
  ok: boolean;
  note?: string;
  ms?: number | null;
  when: number;
  skipped?: boolean;
  data?: { path?: string; tables?: WarehouseTable[]; windows?: number; requests?: number; latestWindowStart?: string; latestRisk?: string; model?: AnalyticsMeta["model"]; available?: boolean; keys?: RedisKey[]; memoryBytes?: number; persistence?: boolean } | null;
}

export interface BacktestRun {
  runId: number;
  startedAt: number;
  finishedAt?: number;
  state?: string;
  mode?: string;
  modelWatermark?: number | null;
  windowFrom?: number | null;
  windowTo?: number | null;
  rows?: number;
  correct?: number;
  accuracy?: number | null;
  precision?: number | null;
  recall?: number | null;
  f1?: number | null;
  error?: string;
}

export interface BacktestSample {
  windowStart: number;
  actual?: string | null;
  nnRisk?: string;
  nnProb?: number[];
  modelWatermark?: number | null;
  match?: boolean;
}

export type ViewName =
  | "overview"
  | "infrastructure"
  | "pipelines"
  | "warehouse"
  | "logs"
  | "metrics"
  | "ml"
  | "playground"
  | "documents";