export interface ModelContext {
  dir: string;
  file: string;
  url?: string;
  sha256?: string;
}

export interface ModelMetadata {
  name: string;
  file: string;
  quantization?: string;
  installed: boolean;
  sizeBytes: number | null;
  installedAt: string | null;
  sha256?: string;
  downloadUrl?: string;
}

export interface ModelProgress {
  phase: "downloading" | "verifying" | "swapping";
  percent?: number;
}

export interface ModelEvents {
  log: (level: "info" | "warn" | "error", msg: string) => void;
  progress?: (p: ModelProgress) => void;
}