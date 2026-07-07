#!/usr/bin/env python3
"""Stream Volcengine TTS audio to Live2D ESP32 over MQTT.

The producer reads Volcengine HTTP chunked TTS JSON objects, decodes base64 MP3
fragments, and writes them into ffmpeg stdin. The consumer reads ffmpeg's 16 kHz
mono s16le stdout and sends it to the ESP32 using the existing MQTT packet
format and ACK/backpressure controller.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import struct
import subprocess
import sys
import threading
import time
import uuid
from json import JSONDecodeError, JSONDecoder
from pathlib import Path
from urllib import request as urllib_request

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from mqtt_audio_stream import (  # noqa: E402
    AUDIO_FORMAT_S16LE_MONO,
    DEFAULT_RING_CAPACITY,
    PCM_BYTES_PER_SECOND,
    PCM_SAMPLE_RATE,
    Metrics,
    MqttClient,
    PiController,
    StatusState,
)

VOLC_TTS_URL = "https://openspeech.bytedance.com/api/v3/tts/unidirectional"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Stream Volcengine TTS to Live2D ESP32 over MQTT.")
    parser.add_argument("--text", required=True, help="Literal text to synthesize. Never parsed as a command.")
    parser.add_argument("--broker", required=True, help="MQTT broker URI, for example mqtt://192.168.11.73:1883")
    parser.add_argument("--device-id", default="live2d-atri")
    parser.add_argument("--api-key", default=os.environ.get("VOLC_SPEECH_API_KEY", ""))
    parser.add_argument("--resource-id", default=os.environ.get("VOLC_TTS_RESOURCE_ID", "seed-tts-2.0"))
    parser.add_argument("--speaker", default=os.environ.get("VOLC_TTS_SPEAKER", "zh_female_shuangkuaisisi_moon_bigtts"))
    parser.add_argument("--language", default=os.environ.get("VOLC_TTS_LANGUAGE", "zh-cn"))
    parser.add_argument("--uid", default=os.environ.get("VOLC_TTS_UID", "talkmcp"))
    parser.add_argument("--loudness-rate", type=float, default=float(os.environ.get("VOLC_TTS_LOUDNESS_RATE", "0")))
    parser.add_argument("--pcm-gain", type=float, default=float(os.environ.get("TALKMCP_PCM_GAIN", "1.0")), help="PCM gain applied by ffmpeg before streaming")
    parser.add_argument("--format", default="mp3", choices=["mp3"], help="Volcengine output format to feed ffmpeg.")
    parser.add_argument("--volc-url", default=os.environ.get("VOLC_TTS_URL", VOLC_TTS_URL))
    parser.add_argument("--mode", choices=["watermark", "pi"], default="pi")
    parser.add_argument("--metrics", help="Optional CSV metrics output path")
    parser.add_argument("--summary", help="Optional JSON summary output path")
    parser.add_argument("--progress-json", action="store_true")
    parser.add_argument("--chunk-size", type=int, default=180)
    parser.add_argument("--safety-margin", type=int, default=24 * 1024)
    parser.add_argument("--target-fill", type=int, default=64 * 1024)
    parser.add_argument("--max-send-bps", type=float, default=float(PCM_BYTES_PER_SECOND))
    parser.add_argument("--startup-burst-bytes", type=int, default=48 * 1024)
    parser.add_argument("--tick-ms", type=float, default=20.0)
    parser.add_argument("--kp", type=float, default=0.006)
    parser.add_argument("--ki", type=float, default=0.00004)
    parser.add_argument("--min-budget", type=float, default=0.0)
    parser.add_argument("--max-budget", type=float, default=2200.0)
    parser.add_argument("--integral-limit", type=float, default=4_000_000.0)
    parser.add_argument("--start-ack-timeout", type=float, default=20.0)
    parser.add_argument("--drain-timeout", type=float, default=180.0)
    parser.add_argument("--http-timeout", type=float, default=120.0)
    parser.add_argument("--context-text", default=os.environ.get("VOLC_TTS_CONTEXT_TEXT", ""))
    return parser.parse_args()


def build_volc_payload(args: argparse.Namespace, request_id: str) -> bytes:
    additions = {
        "explicit_language": args.language,
        "aigc_metadata": {
            "enable": True,
            "content_producer": "TALKMCP",
            "produce_id": request_id,
        },
    }
    if args.context_text:
        additions["context_texts"] = [args.context_text]
    payload = {
        "user": {"uid": args.uid},
        "req_params": {
            "text": args.text,
            "speaker": args.speaker,
            "audio_params": {
                "format": args.format,
                "sample_rate": 24000,
                "speech_rate": 0,
                "loudness_rate": args.loudness_rate,
            },
            "additions": json.dumps(additions, ensure_ascii=False),
        },
    }
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


def volc_tts_producer(args: argparse.Namespace, ffmpeg_stdin, stats: dict, error_box: dict) -> None:
    request_id = str(uuid.uuid4())
    headers = {
        "Content-Type": "application/json",
        "X-Api-Key": args.api_key,
        "X-Api-Resource-Id": args.resource_id,
        "X-Api-Request-Id": request_id,
        "X-Control-Require-Usage-Tokens-Return": "text_words",
    }
    req = urllib_request.Request(
        args.volc_url,
        data=build_volc_payload(args, request_id),
        headers=headers,
        method="POST",
    )
    decoder = JSONDecoder()
    pending = ""
    try:
        with urllib_request.urlopen(req, timeout=args.http_timeout) as resp:
            stats["httpStatus"] = int(getattr(resp, "status", 0) or 0)
            stats["logId"] = resp.headers.get("X-Tt-Logid")
            while True:
                chunk = resp.read(8192)
                if not chunk:
                    break
                pending += chunk.decode("utf-8", errors="ignore")
                while pending.strip():
                    pending = pending.lstrip()
                    try:
                        obj, idx = decoder.raw_decode(pending)
                    except JSONDecodeError:
                        break
                    pending = pending[idx:].lstrip()
                    code = obj.get("code")
                    if code not in (0, 20000000, None):
                        raise RuntimeError(f"Volcengine TTS failed: {obj}")
                    if obj.get("usage"):
                        stats["usage"] = obj.get("usage")
                    data = obj.get("data")
                    if data:
                        audio = base64.b64decode(data)
                        ffmpeg_stdin.write(audio)
                        ffmpeg_stdin.flush()
                        stats["ttsBytes"] = int(stats.get("ttsBytes", 0)) + len(audio)
                        stats["ttsChunks"] = int(stats.get("ttsChunks", 0)) + 1
    except Exception as exc:
        error_box["error"] = str(exc)
    finally:
        try:
            ffmpeg_stdin.close()
        except Exception:
            pass


def main() -> None:
    args = parse_args()
    if not args.api_key:
        raise RuntimeError("VOLC_SPEECH_API_KEY is required for real TTS streaming")
    if args.chunk_size <= 0 or args.chunk_size % 2:
        raise RuntimeError("--chunk-size must be a positive even number")
    if args.pcm_gain <= 0:
        raise RuntimeError("--pcm-gain must be > 0")
    if not args.text.strip():
        raise RuntimeError("--text is required")

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
    tts_stats: dict = {"ttsBytes": 0, "ttsChunks": 0}
    producer_error: dict = {}

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
                        "ttsBytes": tts_stats.get("ttsBytes", 0),
                        "produced": produced,
                        "sent": sent,
                        "packets": packets,
                        "free": current.free,
                        "fill": current.fill,
                        "received": current.received,
                        "read": current.read,
                        "effectiveFree": effective_free,
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )

    def parse_status(payload: bytes) -> None:
        if len(payload) < 23 or payload[0] != 0x10:
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
        f"talkmcp-{os.getpid()}-{time.time_ns()}",
        status_topic,
        parse_status,
    )
    ffmpeg = None

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
            if producer_error.get("error"):
                raise RuntimeError(producer_error["error"])
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

    try:
        mqtt.connect()
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

        ffmpeg_cmd = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            args.format,
            "-i",
            "pipe:0",
            "-vn",
            "-ac",
            "1",
            "-ar",
            str(PCM_SAMPLE_RATE),
        ]
        if args.pcm_gain != 1.0:
            ffmpeg_cmd.extend(["-af", f"volume={args.pcm_gain}"])
        ffmpeg_cmd.extend(["-f", "s16le", "pipe:1"])

        ffmpeg = subprocess.Popen(
            ffmpeg_cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        assert ffmpeg.stdin is not None
        producer = threading.Thread(
            target=volc_tts_producer,
            args=(args, ffmpeg.stdin, tts_stats, producer_error),
            daemon=True,
        )
        producer.start()

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

        producer.join(timeout=5)
        exit_code = ffmpeg.wait()
        stderr = ffmpeg.stderr.read().decode("utf-8", errors="replace") if ffmpeg.stderr else ""
        if producer_error.get("error"):
            publish_packet(bytes([0x04]))
            raise RuntimeError(producer_error["error"])
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
        try:
            mqtt.close()
        except Exception:
            pass
        metrics.close()

    duration_s = time.monotonic() - started_at
    final = snapshot()
    summary = {
        "ok": True,
        "source": "volcengine_tts_stream",
        "transport": "mqtt",
        "mode": args.mode,
        "broker": args.broker,
        "deviceId": args.device_id,
        "resourceId": args.resource_id,
        "speaker": args.speaker,
        "language": args.language,
        "ttsBytes": tts_stats.get("ttsBytes", 0),
        "ttsChunks": tts_stats.get("ttsChunks", 0),
        "volcHttpStatus": tts_stats.get("httpStatus"),
        "volcLogId": tts_stats.get("logId"),
        "usage": tts_stats.get("usage"),
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


if __name__ == "__main__":
    main()
