import { EventEmitter } from "node:events";

export type GatewayStatus = "starting" | "online" | "stopping" | "offline";
export type LlamaStatus = "not_started" | "starting" | "ready" | "restarting" | "stopped" | "error";
export type ModelStatus = "none" | "loading" | "loaded" | "error";

export interface RuntimeSnapshot {
  gateway: GatewayStatus;
  llama: LlamaStatus;
  model: ModelStatus;
  modelLoaded: boolean;
  tokensPerSecond: number;
}

export interface RuntimeEvent {
  type: string;
  timestamp: number;
  [key: string]: unknown;
}

export class RuntimeState extends EventEmitter {
  private s: RuntimeSnapshot = {
    gateway: "starting",
    llama: "not_started",
    model: "none",
    modelLoaded: false,
    tokensPerSecond: 0,
  };

  snapshot(): RuntimeSnapshot {
    return { ...this.s };
  }

  private emitEvent(type: string, extra: Record<string, unknown> = {}): void {
    this.emit("change", { type, timestamp: Date.now(), ...extra } satisfies RuntimeEvent);
  }

  setGateway(status: GatewayStatus): void {
    this.s.gateway = status;
    this.emitEvent("gateway.status", { status });
  }

  setLlama(status: LlamaStatus): void {
    this.s.llama = status;
    this.emitEvent("llama.status", { status });
  }

  setModel(status: ModelStatus): void {
    this.s.model = status;
    this.emitEvent("model.status", { status });
  }

  setModelLoaded(loaded: boolean): void {
    this.s.modelLoaded = loaded;
    if (loaded) this.s.model = "loaded";
  }

  setTokensPerSecond(tps: number): void {
    this.s.tokensPerSecond = tps;
  }
}