# Architecture

`live2dagenttools` uses ports and adapters:

```text
Interaction core owns behavior.
Protocol owns command encoding.
Transport owns platform I/O.
Apps own UI and packaging.
```

## Transport Contract

Every platform implements the same small contract:

```ts
interface AgentTransport {
  scan(): Promise<AgentDevice[]>;
  connect(deviceId: string): Promise<void>;
  disconnect(): Promise<void>;
  write(data: Uint8Array): Promise<void>;
}
```

The interaction core never imports Capacitor, Electron, BlueZ, Android SDK, or browser BLE APIs.

## Platform Strategy

- Android: Capacitor app shell plus a BLE transport package.
- Desktop: Electron app shell plus a desktop BLE transport package.
- Linux dev: BlueZ D-Bus transport for fast ESP32 protocol testing.
- Web: Web Bluetooth transport when browser support is enough.
- Tests: mock transport.
