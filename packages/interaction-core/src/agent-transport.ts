export type AgentConnectionState = "idle" | "scanning" | "connecting" | "connected" | "disconnected" | "error";

export interface AgentDevice {
  id: string;
  name?: string;
  rssi?: number;
}

export interface AgentTransport {
  scan(): Promise<AgentDevice[]>;
  connect(deviceId: string): Promise<void>;
  disconnect(): Promise<void>;
  write(data: Uint8Array): Promise<void>;
  onStateChange?(handler: (state: AgentConnectionState) => void): void;
  onMessage?(handler: (data: Uint8Array) => void): void;
}
