#!/usr/bin/env python3
"""Stream decoded PCM audio to Live2D ESP32 over MQTT.

This keeps the same START/DATA/END/CANCEL packet format and status ACK packet
used by the BLE sender. The MQTT transport is intentionally minimal: MQTT 3.1.1,
TCP, QoS 0 publish for audio and QoS 0 subscribe for status.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import socket
import struct
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse


AUDIO_FORMAT_S16LE_MONO = 1
PCM_SAMPLE_RATE = 16000
PCM_BYTES_PER_SECOND = PCM_SAMPLE_RATE * 2
DEFAULT_RING_CAPACITY = 131072
STATUS_PACKET_CREDIT = 0x10


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
    updated_at: float = 0.0


class Metrics:
    def __init__(self, path: str | None, mode: str, transport: str) -> None:
        self.path = path
        self.mode = mode
        self.transport = transport
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
                    "transport",
                    "mode",
                    "produced",
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
        produced: int,
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
                "transport": self.transport,
                "mode": self.mode,
                "produced": produced,
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


class MqttClient:
    def __init__(self, broker_uri: str, client_id: str, status_topic: str, on_status) -> None:
        parsed = urlparse(broker_uri)
        if parsed.scheme not in ("mqtt", ""):
            raise RuntimeError("Only mqtt:// TCP brokers are supported by this minimal sender")
        self.host = parsed.hostname or parsed.path
        self.port = parsed.port or 1883
        if not self.host:
            raise RuntimeError("MQTT broker host is required")
        self.client_id = client_id
        self.status_topic = status_topic
        self.on_status = on_status
        self.sock: socket.socket | None = None
        self.lock = threading.Lock()
        self.reader: threading.Thread | None = None
        self.stop_event = threading.Event()
        self.packet_id = 1
        self.error_lock = threading.Lock()
        self.error: str | None = None

    def connect(self) -> None:
        self.sock = socket.create_connection((self.host, self.port), timeout=10)
        self.sock.settimeout(1.0)
        flags = 0x02
        keepalive = 30
        payload = _mqtt_string("MQTT") + bytes([0x04, flags]) + struct.pack("!H", keepalive) + _mqtt_string(self.client_id)
        self._send_packet(0x10, payload)
        packet_type, body = self._read_packet()
        if packet_type != 0x20 or len(body) < 2 or body[1] != 0:
            raise RuntimeError(f"MQTT CONNACK failed packet=0x{packet_type:02x} body={body.hex()}")
        self.subscribe(self.status_topic)
        self.reader = threading.Thread(target=self._reader_loop, daemon=True)
        self.reader.start()

    def subscribe(self, topic: str) -> None:
        packet_id = self._next_packet_id()
        body = struct.pack("!H", packet_id) + _mqtt_string(topic) + bytes([0])
        self._send_packet(0x82, body)
        packet_type, data = self._read_packet()
        if packet_type != 0x90 or len(data) < 3 or data[2] == 0x80:
            raise RuntimeError(f"MQTT SUBACK failed packet=0x{packet_type:02x} body={data.hex()}")

    def publish(self, topic: str, payload: bytes) -> None:
        self.raise_if_failed()
        body = _mqtt_string(topic) + payload
        self._send_packet(0x30, body)

    def raise_if_failed(self) -> None:
        with self.error_lock:
            if self.error:
                raise RuntimeError(self.error)

    def close(self) -> None:
        self.stop_event.set()
        try:
            self._send_packet(0xE0, b"")
        except Exception:
            pass
        if self.sock:
            try:
                self.sock.close()
            except Exception:
                pass

    def _next_packet_id(self) -> int:
        packet_id = self.packet_id
        self.packet_id += 1
        if self.packet_id > 0xFFFF:
            self.packet_id = 1
        return packet_id

    def _send_packet(self, header: int, body: bytes) -> None:
        if not self.sock:
            raise RuntimeError("MQTT socket is not connected")
        packet = bytes([header]) + _mqtt_remaining_length(len(body)) + body
        with self.lock:
            self.sock.sendall(packet)

    def _read_packet(self) -> tuple[int, bytes]:
        if not self.sock:
            raise RuntimeError("MQTT socket is not connected")
        first = _recv_exact(self.sock, 1)[0]
        multiplier = 1
        remaining = 0
        while True:
            encoded = _recv_exact(self.sock, 1)[0]
            remaining += (encoded & 127) * multiplier
            if (encoded & 128) == 0:
                break
            multiplier *= 128
            if multiplier > 128 * 128 * 128:
                raise RuntimeError("invalid MQTT remaining length")
        return first & 0xF0, _recv_exact(self.sock, remaining)

    def _reader_loop(self) -> None:
        while not self.stop_event.is_set():
            try:
                packet_type, body = self._read_packet()
            except socket.timeout:
                continue
            except Exception:
                if not self.stop_event.is_set():
                    with self.error_lock:
                        self.error = "MQTT reader stopped"
                    print(json.dumps({"event": "mqtt_error", "message": self.error}, ensure_ascii=False), flush=True)
                return
            if packet_type == 0x30 and len(body) >= 2:
                topic_len = struct.unpack_from("!H", body, 0)[0]
                payload_offset = 2 + topic_len
                if len(body) >= payload_offset:
                    self.on_status(body[payload_offset:])
            elif packet_type == 0xD0:
                continue


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Stream MP3/PCM input to Live2D-ATRI over MQTT.")
    parser.add_argument("--broker", required=True, help="MQTT broker URI, for example mqtt://192.168.1.10:1883")
    parser.add_argument("--device-id", default="live2d-atri")
    parser.add_argument("--input", required=True, help="Input audio file decoded by ffmpeg")
    parser.add_argument("--mode", choices=["watermark", "pi"], default="watermark")
    parser.add_argument("--metrics", help="Optional CSV metrics output path")
    parser.add_argument("--summary", help="Optional JSON summary output path")
    parser.add_argument("--progress-json", action="store_true", help="Print newline-delimited progress JSON to stdout")
    parser.add_argument("--chunk-size", type=int, default=180)
    parser.add_argument("--safety-margin", type=int, default=24 * 1024)
    parser.add_argument("--target-fill", type=int, default=64 * 1024)
    parser.add_argument(
        "--max-send-bps",
        type=float,
        default=float(PCM_BYTES_PER_SECOND),
        help="Maximum decoded PCM payload bytes per second after startup fill; 0 disables pacing",
    )
    parser.add_argument(
        "--startup-burst-bytes",
        type=int,
        default=48 * 1024,
        help="Payload bytes allowed before wall-clock pacing starts",
    )
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
    if args.max_send_bps < 0:
        raise RuntimeError("--max-send-bps must be >= 0")
    if args.startup_burst_bytes < 0:
        raise RuntimeError("--startup-burst-bytes must be >= 0")

    state = StatusState()
    state_lock = threading.Lock()
    metrics = Metrics(args.metrics, args.mode, "mqtt")
    started_at = time.monotonic()
    produced = 0
    sent = 0
    packets = 0
    seq = 0
    wait_count = 0
    drain_complete = False
    pace_started_at = 0.0
    pace_sent_base = 0

    pi = PiController(
        target_fill=args.target_fill,
        tick_s=args.tick_ms / 1000.0,
        kp=args.kp,
        ki=args.ki,
        min_budget=args.min_budget,
        max_budget=args.max_budget,
        integral_limit=args.integral_limit,
    )

    base_topic = f"live2d/{args.device_id}"
    audio_topic = f"{base_topic}/audio/in"
    status_topic = f"{base_topic}/audio/status"

    def snapshot() -> StatusState:
        with state_lock:
            return StatusState(**state.__dict__)

    def estimate_effective_free(current: StatusState) -> tuple[int, int]:
        outstanding = max(0, sent - current.received)
        free = current.free
        if current.updates > 0 and current.updated_at > 0.0 and not current.finished:
            capacity = max(DEFAULT_RING_CAPACITY, current.free + current.fill)
            elapsed = max(0.0, time.monotonic() - current.updated_at)
            inferred_read = min(current.received, current.read + int(elapsed * PCM_BYTES_PER_SECOND))
            inferred_fill = max(0, current.received - inferred_read)
            free = min(capacity, capacity - inferred_fill)
        return outstanding, max(0, free - outstanding)

    def write_metric(event: str, controller_budget: float = 0.0) -> None:
        current = snapshot()
        outstanding, effective_free = estimate_effective_free(current)
        metrics.write(
            event,
            produced=produced,
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
                        "transport": "mqtt",
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

    def parse_status(payload: bytes) -> None:
        if len(payload) < 23 or payload[0] != STATUS_PACKET_CREDIT:
            return
        free, fill, received, read, high = struct.unpack_from("<IIIII", payload, 1)
        with state_lock:
            state.free = free
            state.fill = fill
            state.received = received
            state.read = read
            state.high = high
            state.active = payload[21]
            state.finished = payload[22]
            state.updates += 1
            state.updated_at = time.monotonic()
        write_metric("status")

    mqtt = MqttClient(
        args.broker,
        f"live2d-tools-{os.getpid()}-{time.time_ns()}",
        status_topic,
        parse_status,
    )
    mqtt.connect()

    def publish_packet(payload: bytes) -> None:
        mqtt.publish(audio_topic, payload)

    def wait_for_status_update(previous_updates: int, timeout_s: float, label: str) -> None:
        deadline = time.monotonic() + max(0.0, timeout_s)
        while time.monotonic() < deadline:
            mqtt.raise_if_failed()
            if snapshot().updates > previous_updates:
                return
            time.sleep(args.tick_ms / 1000.0)
        raise RuntimeError(f"timed out waiting for ESP32 {label} status ACK")

    def send_payload(payload: bytes) -> None:
        nonlocal sent, packets, seq, wait_count, pace_started_at, pace_sent_base
        while True:
            mqtt.raise_if_failed()
            current = snapshot()
            _, effective_free = estimate_effective_free(current)
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

        if args.max_send_bps > 0 and sent >= args.startup_burst_bytes:
            if pace_started_at <= 0.0:
                pace_started_at = time.monotonic()
                pace_sent_base = sent
            target_elapsed = (sent - pace_sent_base + len(payload)) / args.max_send_bps
            sleep_until = pace_started_at + target_elapsed
            while True:
                remaining = sleep_until - time.monotonic()
                if remaining <= 0:
                    break
                wait_count += 1
                if wait_count % 50 == 0:
                    write_metric("pace_wait", pi.last_budget if args.mode == "pi" else 0.0)
                time.sleep(min(args.tick_ms / 1000.0, remaining))

        packet = bytearray(3 + len(payload))
        packet[0] = 0x02
        struct.pack_into("<H", packet, 1, seq & 0xFFFF)
        packet[3:] = payload
        publish_packet(packet)
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
        publish_packet(start)
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
            publish_packet(bytes([0x04]))
            raise RuntimeError(stderr.strip() or f"ffmpeg exited with code {exit_code}")

        tail_len = len(pending) & ~1
        if tail_len:
            send_payload(pending[:tail_len])
        publish_packet(bytes([0x03]))
        write_metric("end", pi.last_budget if args.mode == "pi" else 0.0)
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
            publish_packet(bytes([0x04]))
        except Exception:
            pass
        raise
    finally:
        if ffmpeg:
            try:
                ffmpeg.wait(timeout=1)
            except Exception:
                pass
        mqtt.close()
        metrics.close()

    duration_s = time.monotonic() - started_at
    final = snapshot()
    summary = {
        "ok": True,
        "transport": "mqtt",
        "mode": args.mode,
        "broker": args.broker,
        "deviceId": args.device_id,
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
        "drainComplete": drain_complete,
        "metrics": args.metrics,
    }
    if args.summary:
        Path(args.summary).parent.mkdir(parents=True, exist_ok=True)
        Path(args.summary).write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))


def _mqtt_string(value: str) -> bytes:
    encoded = value.encode("utf-8")
    if len(encoded) > 0xFFFF:
        raise RuntimeError("MQTT string too long")
    return struct.pack("!H", len(encoded)) + encoded


def _mqtt_remaining_length(value: int) -> bytes:
    encoded = bytearray()
    while True:
        digit = value % 128
        value //= 128
        if value > 0:
            digit |= 128
        encoded.append(digit)
        if value == 0:
            return bytes(encoded)


def _recv_exact(sock: socket.socket, length: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < length:
        chunk = sock.recv(length - len(chunks))
        if not chunk:
            raise RuntimeError("MQTT socket closed")
        chunks.extend(chunk)
    return bytes(chunks)


if __name__ == "__main__":
    main()
