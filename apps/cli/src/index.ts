#!/usr/bin/env node
import { Live2DAgentClient } from "../../../packages/interaction-core/src/index.js";
import { BluezTransport } from "../../../packages/transport-bluez/src/index.js";

interface CliOptions {
  device?: string;
  message?: string;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "send") {
    printHelp();
    process.exit(command ? 1 : 0);
  }

  const options = parseOptions(args);
  if (!options.device || !options.message) {
    printHelp();
    process.exit(1);
  }

  const client = new Live2DAgentClient(new BluezTransport());
  await client.connect(options.device);
  await client.sendText(options.message);
  console.log(`sent ${JSON.stringify(options.message)} to ${options.device}`);
}

function parseOptions(args: string[]): CliOptions {
  const options: CliOptions = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--device") {
      options.device = args[++i];
    } else if (arg === "--message") {
      options.message = args[++i];
    }
  }
  return options;
}

function printHelp(): void {
  console.log(`Usage:
  live2dagent send --device <BLE_MAC> --message <command>

Examples:
  live2dagent send --device 3C:DC:75:6F:C2:72 --message ping
  live2dagent send --device 3C:DC:75:6F:C2:72 --message wave`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
