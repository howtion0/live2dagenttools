import type { AgentConnectionState, AgentDevice, AgentTransport } from "../../interaction-core/src/index.js";

export class MockTransport implements AgentTransport {
  readonly writes: Uint8Array[] = [];
  private stateHandler?: (state: AgentConnectionState) => void;

  async scan(): Promise<AgentDevice[]> {
    this.stateHandler?.("scanning");
    this.stateHandler?.("idle");
    return [{ id: "mock-esplive2d", name: "esplive2d", rssi: -42 }];
  }

  async connect(_deviceId: string): Promise<void> {
    this.stateHandler?.("connecting");
    this.stateHandler?.("connected");
  }

  async disconnect(): Promise<void> {
    this.stateHandler?.("disconnected");
  }

  async write(data: Uint8Array): Promise<void> {
    this.writes.push(data);
  }

  onStateChange(handler: (state: AgentConnectionState) => void): void {
    this.stateHandler = handler;
  }
}
