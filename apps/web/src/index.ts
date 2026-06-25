import { Live2DAgentClient } from "../../../packages/interaction-core/src/index.js";
import { MockTransport } from "../../../packages/transport-mock/src/index.js";

const client = new Live2DAgentClient(new MockTransport());

export { client };
