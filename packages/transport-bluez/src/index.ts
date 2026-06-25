import { spawn } from "node:child_process";
import type { AgentDevice, AgentTransport } from "../../interaction-core/src/index.js";

const DEFAULT_CHARACTERISTIC_UUID = "02104c21-e36a-2f97-454c-5a8a2f8f369e";

export interface BluezTransportOptions {
  adapter?: string;
  characteristicUuid?: string;
  scanSeconds?: number;
}

export class BluezTransport implements AgentTransport {
  private readonly adapter: string;
  private readonly characteristicUuid: string;
  private readonly scanSeconds: number;
  private deviceId?: string;

  constructor(options: BluezTransportOptions = {}) {
    this.adapter = options.adapter ?? "hci0";
    this.characteristicUuid = options.characteristicUuid ?? DEFAULT_CHARACTERISTIC_UUID;
    this.scanSeconds = options.scanSeconds ?? 5;
  }

  async scan(): Promise<AgentDevice[]> {
    return scanViaDbus({ adapter: this.adapter, seconds: this.scanSeconds });
  }

  async connect(deviceId: string): Promise<void> {
    await connectViaDbus({
      adapter: this.adapter,
      deviceId,
      characteristicUuid: this.characteristicUuid,
    });
    this.deviceId = deviceId;
  }

  async disconnect(): Promise<void> {
    if (this.deviceId) {
      await disconnectViaDbus({ adapter: this.adapter, deviceId: this.deviceId });
    }
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

interface ConnectOptions {
  adapter: string;
  deviceId: string;
  characteristicUuid: string;
}

interface ScanOptions {
  adapter: string;
  seconds: number;
}

interface DeviceOptions {
  adapter: string;
  deviceId: string;
}

async function scanViaDbus(options: ScanOptions): Promise<AgentDevice[]> {
  const script = String.raw`
import dbus
import json
import time

adapter = "${escapePythonString(options.adapter)}"
seconds = ${Math.max(1, Math.min(30, Math.round(options.seconds)))}
adapter_path = "/org/bluez/" + adapter

bus = dbus.SystemBus()
manager = dbus.Interface(bus.get_object("org.bluez", "/"), "org.freedesktop.DBus.ObjectManager")
adapter_obj = bus.get_object("org.bluez", adapter_path)
adapter_iface = dbus.Interface(adapter_obj, "org.bluez.Adapter1")

try:
    adapter_iface.StartDiscovery()
except dbus.exceptions.DBusException as exc:
    if "InProgress" not in exc.get_dbus_name():
        raise

time.sleep(seconds)

try:
    adapter_iface.StopDiscovery()
except dbus.exceptions.DBusException:
    pass

devices = []
objects = manager.GetManagedObjects()
prefix = adapter_path + "/dev_"
for path, interfaces in objects.items():
    if not str(path).startswith(prefix):
        continue
    props = interfaces.get("org.bluez.Device1")
    if not props:
        continue
    address = str(props.get("Address", ""))
    if not address:
        continue
    devices.append({
        "id": address,
        "name": str(props.get("Name", props.get("Alias", ""))) or None,
        "rssi": int(props["RSSI"]) if "RSSI" in props else None,
    })

print(json.dumps(devices))
`;

  const output = await runProcessWithOutput("python3", ["-c", script]);
  return JSON.parse(output) as AgentDevice[];
}

async function connectViaDbus(options: ConnectOptions): Promise<void> {
  const script = String.raw`
import dbus
import time

adapter = "${escapePythonString(options.adapter)}"
device_id = "${escapePythonString(options.deviceId)}"
char_uuid = "${escapePythonString(options.characteristicUuid)}"
device_path = "/org/bluez/" + adapter + "/dev_" + device_id.replace(":", "_")

bus = dbus.SystemBus()
manager = dbus.Interface(bus.get_object("org.bluez", "/"), "org.freedesktop.DBus.ObjectManager")

objects = manager.GetManagedObjects()
if device_path not in objects:
    raise RuntimeError("BlueZ device not found; run bluetoothctl scan on first")

device_obj = bus.get_object("org.bluez", device_path)
device = dbus.Interface(device_obj, "org.bluez.Device1")
props = dbus.Interface(device_obj, "org.freedesktop.DBus.Properties")

try:
    if not bool(props.Get("org.bluez.Device1", "Connected")):
        device.Connect()
except dbus.exceptions.DBusException as exc:
    if "AlreadyConnected" not in exc.get_dbus_name():
        raise

deadline = time.time() + 12
while time.time() < deadline:
    objects = manager.GetManagedObjects()
    for path, interfaces in objects.items():
        char = interfaces.get("org.bluez.GattCharacteristic1")
        if not char:
            continue
        if not str(path).startswith(device_path + "/"):
            continue
        if str(char.get("UUID", "")).lower() == char_uuid.lower():
            raise SystemExit(0)
    time.sleep(0.2)

raise RuntimeError("GATT characteristic not found after connect")
`;

  await runProcess("python3", ["-c", script]);
}

async function disconnectViaDbus(options: DeviceOptions): Promise<void> {
  const script = String.raw`
import dbus

adapter = "${escapePythonString(options.adapter)}"
device_id = "${escapePythonString(options.deviceId)}"
device_path = "/org/bluez/" + adapter + "/dev_" + device_id.replace(":", "_")

bus = dbus.SystemBus()
device_obj = bus.get_object("org.bluez", device_path)
device = dbus.Interface(device_obj, "org.bluez.Device1")

try:
    device.Disconnect()
except dbus.exceptions.DBusException as exc:
    if "NotConnected" not in exc.get_dbus_name():
        raise
`;

  await runProcess("python3", ["-c", script]);
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

function runProcessWithOutput(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
      }
    });
  });
}
