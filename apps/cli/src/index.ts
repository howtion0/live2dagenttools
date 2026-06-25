#!/usr/bin/env node
import { Live2DAgentClient } from "../../../packages/interaction-core/src/index.js";
import { BluezTransport } from "../../../packages/transport-bluez/src/index.js";

interface CliOptions {
  device?: string;
  message?: string;
  clip?: string;
  motion?: string;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || !["scan", "send", "ping", "wave", "speak", "motion"].includes(command)) {
    printHelp();
    process.exit(command ? 1 : 0);
  }

  if (command === "scan") {
    const transport = new BluezTransport();
    const devices = await transport.scan();
    for (const device of devices) {
      const name = device.name ? ` ${device.name}` : "";
      const rssi = typeof device.rssi === "number" ? ` rssi=${device.rssi}` : "";
      console.log(`${device.id}${name}${rssi}`);
    }
    return;
  }

  const options = parseOptions(args);
  if (!options.device) {
    printHelp();
    process.exit(1);
  }

  const client = new Live2DAgentClient(new BluezTransport());
  await client.connect(options.device);

  switch (command) {
    case "send":
      if (!options.message) {
        printHelp();
        process.exit(1);
      }
      await client.sendText(options.message);
      console.log(`sent ${JSON.stringify(options.message)} to ${options.device}`);
      break;
    case "ping":
      await client.ping();
      console.log(`sent ping to ${options.device}`);
      break;
    case "wave":
      await client.wave();
      console.log(`sent wave to ${options.device}`);
      break;
    case "speak":
      if (!options.clip) {
        printHelp();
        process.exit(1);
      }
      await client.speak(options.clip);
      console.log(`sent speak:${options.clip} to ${options.device}`);
      break;
    case "motion":
      if (!options.motion) {
        printHelp();
        process.exit(1);
      }
      await client.motion(options.motion);
      console.log(`sent motion:${options.motion} to ${options.device}`);
      break;
  }
}

function parseOptions(args: string[]): CliOptions {
  const options: CliOptions = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--device") {
      options.device = args[++i];
    } else if (arg === "--message") {
      options.message = args[++i];
    } else if (arg === "--clip") {
      options.clip = args[++i];
    } else if (arg === "--motion") {
      options.motion = args[++i];
    }
  }
  return options;
}

function printHelp(): void {
  console.log(`Usage:
  live2dagent scan
  live2dagent send --device <BLE_MAC> --message <command>
  live2dagent ping --device <BLE_MAC>
  live2dagent wave --device <BLE_MAC>
  live2dagent speak --device <BLE_MAC> --clip <clip_id>
  live2dagent motion --device <BLE_MAC> --motion <motion_id>

Examples:
  live2dagent scan
  live2dagent send --device 3C:DC:75:6F:C2:72 --message ping
  live2dagent wave --device 3C:DC:75:6F:C2:72
  live2dagent motion --device 3C:DC:75:6F:C2:72 --motion think
  live2dagent speak --device 3C:DC:75:6F:C2:72 --clip ATR_b102_015`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
