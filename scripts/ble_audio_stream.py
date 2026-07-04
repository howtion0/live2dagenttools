#!/usr/bin/env python3
"""Stream decoded PCM audio to the Live2D ESP32 BLE audio characteristic.

Modes:
  watermark: original ACK/credit hard-watermark sender.
  pi:        PC-side PI controller adjusts byte budget per tick from ESP32 fill.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import subprocess
import struct
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import dbus
import dbus.mainloop.glib
from gi.repository import GLib


AUDIO_UUID = "03104c21-e36a-2f97-454c-5a8a2f8f369e"
STATUS_UUID = "04104c21-e36a-2f97-454c-5a8a2f8f369e"
AUDIO_FORMAT_S16LE_MONO = 1
PCM_SAMPLE_RATE = 16000
PCM_BYTES_PER_SECOND = PCM_SAMPLE_RATE * 2


@dataclass
class StatusState:
    free: int = 65536
    fill: int = 0
    received: int = 0
    read: int = 0
    high: int = 0
    active: int = 0
    finished: int = 0
    updates: int = 0


class Metrics:
    def __init__(self, path: str | None, mode: str) -> None:
        self.path = path
        self.mode = mode
        self.start = time.monotonic()
        self.file = None
        self.writer = None
        if path:
            Path(path).parent.mkdir(parents=True, exist_ok=True)
            self.file = open(path, "w", newline="", encoding="utf-8")
            self.writer = csv.DictWriter(
                self.file,
                fieldnames=[
                    "time_s",
                    "event",
                    "mode",
                    "sent",
                    "packets",
                    "seq",
                    "free",
                    "fill",
                    "received",
                    "read",
                    "high",
                    "outstanding",
                    "effective_free",
                    "controller_budget",
                    "waits",
                ],
            )
            self.writer.writeheader()
            self.file.flush()

    def write(
        self,
        event: str,
        *,
        sent: int,
        packets: int,
        seq: int,
        state: StatusState,
        outstanding: int,
        effective_free: int,
        controller_budget: float,
        waits: int,
    ) -> None:
        if not self.writer:
            return
        self.writer.writerow(
            {
                "time_s": f"{time.monotonic() - self.start:.6f}",
                "event": event,
                "mode": self.mode,
                "sent": sent,
                "packets": packets,
                "seq": seq,
                "free": state.free,
                "fill": state.fill,
                "received": state.received,
                "read": state.read,
                "high": state.high,
                "outstanding": outstanding,
                "effective_free": effective_free,
                "controller_budget": f"{controller_budget:.3f}",
                "waits": waits,
            }
        )
        if self.file:
            self.file.flush()

    def close(self) -> None:
        if self.file:
            self.file.close()


class PiController:
    def __init__(
        self,
        *,
        target_fill: int,
        tick_s: float,
        kp: float,
        ki: float,
        min_budget: float,
        max_budget: float,
        integral_limit: float,
    ) -> None:
        self.target_fill = target_fill
        self.tick_s = tick_s
        self.kp = kp
        self.ki = ki
        self.min_budget = min_budget
        self.max_budget = max_budget
        self.integral_limit = integral_limit
        self.integral = 0.0
        self.credit = 0.0
        self.last_tick = time.monotonic()
        self.last_budget = PCM_BYTES_PER_SECOND * tick_s

    def update(self, fill: int) -> float:
        now = time.monotonic()
        elapsed = now - self.last_tick
        if elapsed < self.tick_s:
            return self.last_budget

        ticks = max(1, int(elapsed / self.tick_s))
        self.last_tick += ticks * self.tick_s
        error = float(self.target_fill - fill)
        self.integral += error * self.tick_s * ticks
        self.integral = max(-self.integral_limit, min(self.integral, self.integral_limit))

        base_budget = PCM_BYTES_PER_SECOND * self.tick_s
        budget = base_budget + (self.kp * error) + (self.ki * self.integral)
        budget = max(self.min_budget, min(budget, self.max_budget))
        self.credit = min(self.max_budget * 4, self.credit + budget * ticks)
        self.last_budget = budget
        return budget

    def consume(self, payload_len: int) -> bool:
        if self.credit >= payload_len:
            self.credit -= payload_len
            return True
        return False


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Stream MP3/PCM input to Live2D-ATRI over BLE.")
    parser.add_argument("--device", required=True, help="BLE MAC, for example 3C:DC:75:6F:C2:72")
    parser.add_argument("--input", required=True, help="Input audio file decoded by ffmpeg")
    parser.add_argument("--mode", choices=["watermark", "pi"], default="watermark")
    parser.add_argument("--metrics", help="Optional CSV metrics output path")
    parser.add_argument("--summary", help="Optional JSON summary output path")
    parser.add_argument("--progress-json", action="store_true", help="Print newline-delimited progress JSON to stdout")
    parser.add_argument("--adapter", default="hci0")
    parser.add_argument("--chunk-size", type=int, default=180)
    parser.add_argument("--safety-margin", type=int, default=4096)
    parser.add_argument("--target-fill", type=int, default=96 * 1024)
    parser.add_argument("--tick-ms", type=float, default=20.0)
    parser.add_argument("--kp", type=float, default=0.006)
    parser.add_argument("--ki", type=float, default=0.00004)
    parser.add_argument("--min-budget", type=float, default=0.0)
    parser.add_argument("--max-budget", type=float, default=2200.0)
    parser.add_argument("--integral-limit", type=float, default=4_000_000.0)
    parser.add_argument("--start-ack-timeout", type=float, default=10.0, help="Seconds to wait for ESP32 status ACK after START")
    parser.add_argument("--drain-timeout", type=float, default=20.0, help="Seconds to wait for final ESP32 drain ACK after END")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.chunk_size <= 0 or args.chunk_size % 2:
        raise RuntimeError("--chunk-size must be a positive even number")

    state = StatusState()
    lock = threading.Lock()
    metrics = Metrics(args.metrics, args.mode)
    started_at = time.monotonic()
    sent = 0
    packets = 0
    seq = 0
    wait_count = 0
    produced = 0

    pi = PiController(
        target_fill=args.target_fill,
        tick_s=args.tick_ms / 1000.0,
        kp=args.kp,
        ki=args.ki,
        min_budget=args.min_budget,
        max_budget=args.max_budget,
        integral_limit=args.integral_limit,
    )

    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SystemBus()
    manager = dbus.Interface(bus.get_object("org.bluez", "/"), "org.freedesktop.DBus.ObjectManager")
    device_path = "/org/bluez/" + args.adapter + "/dev_" + args.device.replace(":", "_")

    objects = manager.GetManagedObjects()
    if device_path not in objects:
        raise RuntimeError("BlueZ device not found; run scan first")

    device_obj = bus.get_object("org.bluez", device_path)
    device = dbus.Interface(device_obj, "org.bluez.Device1")
    props = dbus.Interface(device_obj, "org.freedesktop.DBus.Properties")
    try:
        if not bool(props.Get("org.bluez.Device1", "Connected")):
            device.Connect()
    except dbus.exceptions.DBusException as exc:
        if "AlreadyConnected" not in exc.get_dbus_name():
            raise

    audio_path, status_path = find_characteristics(manager, device_path)
    audio = dbus.Interface(bus.get_object("org.bluez", audio_path), "org.bluez.GattCharacteristic1")
    status = dbus.Interface(bus.get_object("org.bluez", status_path), "org.bluez.GattCharacteristic1")

    def snapshot() -> StatusState:
        with lock:
            return StatusState(**state.__dict__)

    def write_metric(event: str, controller_budget: float = 0.0) -> None:
        current = snapshot()
        outstanding = max(0, sent - current.received)
        effective_free = max(0, current.free - outstanding)
        metrics.write(
            event,
            sent=sent,
            packets=packets,
            seq=seq,
            state=current,
            outstanding=outstanding,
            effective_free=effective_free,
            controller_budget=controller_budget,
            waits=wait_count,
        )
        if args.progress_json:
            print(
                json.dumps(
                    {
                        "event": event,
                        "mode": args.mode,
                        "timeSeconds": time.monotonic() - started_at,
                        "produced": produced,
                        "sent": sent,
                        "packets": packets,
                        "seq": seq,
                        "free": current.free,
                        "fill": current.fill,
                        "received": current.received,
                        "read": current.read,
                        "high": current.high,
                        "outstanding": outstanding,
                        "effectiveFree": effective_free,
                        "controllerBudget": controller_budget,
                        "waits": wait_count,
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )

    def parse_status(value: object) -> None:
        data = bytes([int(v) for v in value])
        if len(data) < 23 or data[0] != 0x10:
            return
        free, fill, received, read, high = struct.unpack_from("<IIIII", data, 1)
        with lock:
            state.free = free
            state.fill = fill
            state.received = received
            state.read = read
            state.high = high
            state.active = data[21]
            state.finished = data[22]
            state.updates += 1
        write_metric("status")

    def on_properties_changed(interface: str, changed: dict, _invalidated: list, path: str | None = None) -> None:
        if path == status_path and interface == "org.bluez.GattCharacteristic1" and "Value" in changed:
            parse_status(changed["Value"])

    bus.add_signal_receiver(
        on_properties_changed,
        dbus_interface="org.freedesktop.DBus.Properties",
        signal_name="PropertiesChanged",
        path_keyword="path",
    )

    loop = GLib.MainLoop()
    thread = threading.Thread(target=loop.run, daemon=True)
    thread.start()
    status.StartNotify()
    time.sleep(0.2)

    def write_value(payload: bytes | bytearray) -> None:
        value = dbus.Array([dbus.Byte(b) for b in payload], signature="y")
        audio.WriteValue(value, dbus.Dictionary({"type": dbus.String("command")}, signature="sv"))

    def wait_for_status_update(previous_updates: int, timeout_s: float, label: str) -> None:
        deadline = time.monotonic() + max(0.0, timeout_s)
        while time.monotonic() < deadline:
            if snapshot().updates > previous_updates:
                return
            time.sleep(args.tick_ms / 1000.0)
        raise RuntimeError(f"timed out waiting for ESP32 {label} status ACK")

    def send_payload(payload: bytes) -> None:
        nonlocal sent, packets, seq, wait_count
        while True:
            current = snapshot()
            outstanding = max(0, sent - current.received)
            effective_free = max(0, current.free - outstanding)
            budget = pi.update(current.fill) if args.mode == "pi" else 0.0
            has_credit = effective_free >= len(payload) + args.safety_margin
            has_controller_budget = args.mode == "watermark" or pi.consume(len(payload))
            if has_credit and has_controller_budget:
                break
            wait_count += 1
            if args.mode == "pi" and has_credit and not has_controller_budget:
                pi.update(current.fill)
            if wait_count % 50 == 0:
                write_metric("wait", budget)
            time.sleep(args.tick_ms / 1000.0)

        packet = bytearray(3 + len(payload))
        packet[0] = 0x02
        struct.pack_into("<H", packet, 1, seq & 0xFFFF)
        packet[3:] = payload
        write_value(packet)
        sent += len(payload)
        packets += 1
        seq += 1
        if packets % 32 == 0:
            write_metric("send", pi.last_budget if args.mode == "pi" else 0.0)

    ffmpeg = None
    try:
        start = bytearray(9)
        start[0] = 0x01
        struct.pack_into("<I", start, 1, 0)
        struct.pack_into("<H", start, 5, PCM_SAMPLE_RATE)
        start[7] = 1
        start[8] = AUDIO_FORMAT_S16LE_MONO
        start_updates = snapshot().updates
        write_value(start)
        write_metric("start")
        wait_for_status_update(start_updates, args.start_ack_timeout, "START")

        ffmpeg = subprocess.Popen(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                args.input,
                "-vn",
                "-ac",
                "1",
                "-ar",
                str(PCM_SAMPLE_RATE),
                "-f",
                "s16le",
                "pipe:1",
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

        pending = b""
        assert ffmpeg.stdout is not None
        while True:
            decoded = ffmpeg.stdout.read(4096)
            if not decoded:
                break
            produced += len(decoded)
            write_metric("produce", pi.last_budget if args.mode == "pi" else 0.0)
            pending += decoded
            even_len = len(pending) & ~1
            offset = 0
            while offset + args.chunk_size <= even_len:
                send_payload(pending[offset : offset + args.chunk_size])
                offset += args.chunk_size
            pending = pending[offset:]

        exit_code = ffmpeg.wait()
        stderr = ffmpeg.stderr.read().decode("utf-8", errors="replace") if ffmpeg.stderr else ""
        if exit_code != 0:
            write_value(bytes([0x04]))
            raise RuntimeError(stderr.strip() or f"ffmpeg exited with code {exit_code}")

        tail_len = len(pending) & ~1
        if tail_len:
            send_payload(pending[:tail_len])
        write_value(bytes([0x03]))
        write_metric("end", pi.last_budget if args.mode == "pi" else 0.0)
        drain_complete = False
        drain_deadline = time.monotonic() + max(0.0, args.drain_timeout)
        drain_samples = 0
        while time.monotonic() < drain_deadline:
            current = snapshot()
            if current.received >= sent and current.read >= sent and current.fill == 0 and current.active == 0:
                drain_complete = True
                write_metric("drain", pi.last_budget if args.mode == "pi" else 0.0)
                break
            drain_samples += 1
            if drain_samples % 10 == 0:
                write_metric("drain_wait", pi.last_budget if args.mode == "pi" else 0.0)
            time.sleep(args.tick_ms / 1000.0)
        if not drain_complete:
            current = snapshot()
            raise RuntimeError(
                "ESP32 did not drain audio stream "
                f"sent={sent} received={current.received} read={current.read} fill={current.fill} active={current.active}"
            )
    except Exception:
        if ffmpeg:
            try:
                ffmpeg.kill()
            except Exception:
                pass
        try:
            write_value(bytes([0x04]))
        except Exception:
            pass
        raise
    finally:
        if ffmpeg:
            try:
                ffmpeg.wait(timeout=1)
            except Exception:
                pass
        try:
            status.StopNotify()
        except Exception:
            pass
        loop.quit()
        metrics.close()

    duration_s = time.monotonic() - started_at
    final = snapshot()
    summary = {
        "ok": True,
        "transport": "ble",
        "mode": args.mode,
        "bytes": sent,
        "packets": packets,
        "durationSeconds": duration_s,
        "averageBytesPerSecond": sent / duration_s if duration_s > 0 else 0,
        "statusUpdates": final.updates,
        "finalFree": final.free,
        "finalFill": final.fill,
        "finalReceived": final.received,
        "finalRead": final.read,
        "highWater": final.high,
        "drainComplete": True,
        "metrics": args.metrics,
    }
    if args.summary:
        Path(args.summary).parent.mkdir(parents=True, exist_ok=True)
        Path(args.summary).write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))


def find_characteristics(manager: dbus.Interface, device_path: str) -> tuple[str, str]:
    audio_path = None
    status_path = None
    deadline = time.time() + 12
    while time.time() < deadline:
        objects = manager.GetManagedObjects()
        for path, interfaces in objects.items():
            char = interfaces.get("org.bluez.GattCharacteristic1")
            if not char or not str(path).startswith(device_path + "/"):
                continue
            uuid = str(char.get("UUID", "")).lower()
            if uuid == AUDIO_UUID:
                audio_path = path
            elif uuid == STATUS_UUID:
                status_path = path
        if audio_path and status_path:
            return audio_path, status_path
        time.sleep(0.2)
    if audio_path is None:
        raise RuntimeError("audio characteristic not found")
    raise RuntimeError("status characteristic not found")


if __name__ == "__main__":
    main()
