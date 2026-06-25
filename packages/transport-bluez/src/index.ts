import { spawn } from "node:child_process";
import type { AgentDevice, AgentTransport } from "../../interaction-core/src/index.js";

const DEFAULT_CHARACTERISTIC_UUID = "02104c21-e36a-2f97-454c-5a8a2f8f369e";

export interface BluezTransportOptions {
  adapter?: string;
  characteristicUuid?: string;
}

export class BluezTransport implements AgentTransport {
  private readonly adapter: string;
  private readonly characteristicUuid: string;
  private deviceId?: string;

  constructor(options: BluezTransportOptions = {}) {
    this.adapter = options.adapter ?? "hci0";
    this.characteristicUuid = options.characteristicUuid ?? DEFAULT_CHARACTERISTIC_UUID;
  }

  async scan(): Promise<AgentDevice[]> {
    throw new Error("BluezTransport.scan is not implemented yet. Use bluetoothctl scan on for now.");
  }

  async connect(deviceId: string): Promise<void> {
    this.deviceId = deviceId;
  }

  async disconnect(): Promise<void> {
    this.deviceId = undefined;
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.deviceId) {
      throw new Error("BluezTransport is not connected. Call connect(deviceId) first.");
    }
    await writeValueViaDbus({
      adapter: this.adapter,
      deviceId: this.deviceId,
      characteristicUuid: this.characteristicUuid,
      data,
    });
  }
}

interface WriteValueOptions {
  adapter: string;
  deviceId: string;
  characteristicUuid: string;
  data: Uint8Array;
}

async function writeValueViaDbus(options: WriteValueOptions): Promise<void> {
  const payload = Buffer.from(options.data).toString("hex");
  const script = String.raw`
import dbus

adapter = "${escapePythonString(options.adapter)}"
device_id = "${escapePythonString(options.deviceId)}"
char_uuid = "${escapePythonString(options.characteristicUuid)}"
payload = bytes.fromhex("${payload}")
device_path = "/org/bluez/" + adapter + "/dev_" + device_id.replace(":", "_")

bus = dbus.SystemBus()
manager = dbus.Interface(bus.get_object("org.bluez", "/"), "org.freedesktop.DBus.ObjectManager")
objects = manager.GetManagedObjects()

char_path = None
for path, interfaces in objects.items():
    char = interfaces.get("org.bluez.GattCharacteristic1")
    if not char:
        continue
    if not str(path).startswith(device_path + "/"):
        continue
    if str(char.get("UUID", "")).lower() == char_uuid.lower():
        char_path = path
        break

if char_path is None:
    raise RuntimeError("GATT characteristic not found; connect and resolve services first")

obj = bus.get_object("org.bluez", char_path)
char = dbus.Interface(obj, "org.bluez.GattCharacteristic1")
value = dbus.Array([dbus.Byte(b) for b in payload], signature="y")
options = dbus.Dictionary({"type": dbus.String("command")}, signature="sv")
char.WriteValue(value, options)
`;

  await runProcess("python3", ["-c", script]);
}

function escapePythonString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function runProcess(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
      }
    });
  });
}
