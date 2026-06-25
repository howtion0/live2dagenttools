import { encodeTextCommand, serializeCommand, type Live2DCommand } from "../../protocol/src/index.js";
import type { AgentDevice, AgentTransport } from "./agent-transport.js";

export class Live2DAgentClient {
  constructor(private readonly transport: AgentTransport) {}

  scan(): Promise<AgentDevice[]> {
    return this.transport.scan();
  }

  connect(deviceId: string): Promise<void> {
    return this.transport.connect(deviceId);
  }

  disconnect(): Promise<void> {
    return this.transport.disconnect();
  }

  send(command: Live2DCommand): Promise<void> {
    return this.sendText(serializeCommand(command));
  }

  sendText(value: string): Promise<void> {
    return this.transport.write(encodeTextCommand(value));
  }

  ping(): Promise<void> {
    return this.send({ type: "ping" });
  }

  wave(): Promise<void> {
    return this.send({ type: "wave" });
  }

  speak(clipId: string): Promise<void> {
    return this.send({ type: "speak", clipId });
  }
}
