#!/usr/bin/env python3
"""Probe and stream one or more audio files through the BLE or MQTT sender."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path


AUDIO_EXTENSIONS = {
    ".aac",
    ".flac",
    ".m4a",
    ".mka",
    ".mkv",
    ".mp3",
    ".mp4",
    ".ogg",
    ".opus",
    ".wav",
    ".webm",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Probe audio inputs and stream them with ACK backpressure.")
    parser.add_argument("inputs", nargs="+", help="Audio files or directories")
    parser.add_argument("--transport", choices=["ble", "mqtt"], required=True)
    parser.add_argument("--device", help="BLE MAC address")
    parser.add_argument("--adapter", default="hci0")
    parser.add_argument("--broker", default="mqtt://192.168.135.73:1883")
    parser.add_argument("--device-id", default="live2d-atri")
    parser.add_argument("--mode", choices=["watermark", "pi"], default="pi")
    parser.add_argument("--recursive", action="store_true", help="Recurse into input directories")
    parser.add_argument("--manifest", help="Optional JSON manifest path")
    parser.add_argument("--metrics-dir", help="Optional directory for per-file CSV metrics")
    parser.add_argument("--summary-dir", help="Optional directory for per-file JSON summaries")
    parser.add_argument("--progress-json", action="store_true", help="Print newline-delimited progress JSON")
    parser.add_argument("--start-ack-timeout", type=float, default=20.0)
    parser.add_argument("--drain-timeout", type=float, default=180.0)
    return parser.parse_args()


def discover(inputs: list[str], recursive: bool) -> list[Path]:
    files: list[Path] = []
    for raw in inputs:
        path = Path(raw).expanduser()
        if path.is_dir():
            iterator = path.rglob("*") if recursive else path.iterdir()
            files.extend(p for p in iterator if p.is_file() and p.suffix.lower() in AUDIO_EXTENSIONS)
        elif path.is_file():
            files.append(path)
        else:
            raise RuntimeError(f"input not found: {path}")
    return sorted(dict.fromkeys(p.resolve() for p in files))


def probe(path: Path) -> dict:
    output = subprocess.check_output(
        [
            "ffprobe",
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            str(path),
        ],
        text=True,
    )
    parsed = json.loads(output)
    audio = next((s for s in parsed.get("streams", []) if s.get("codec_type") == "audio"), None)
    if not audio:
        raise RuntimeError("no audio stream")
    fmt = parsed.get("format", {})
    return {
        "path": str(path),
        "name": path.name,
        "bytes": path.stat().st_size,
        "formatName": fmt.get("format_name"),
        "durationSeconds": _number_or_none(fmt.get("duration")),
        "bitRate": _number_or_none(fmt.get("bit_rate")),
        "audioCodec": audio.get("codec_name"),
        "sampleRate": _number_or_none(audio.get("sample_rate")),
        "channels": audio.get("channels"),
        "route": {
            "decoder": "ffmpeg",
            "output": "s16le",
            "sampleRate": 16000,
            "channels": 1,
            "transportBackpressure": "esp32-status-ack",
        },
    }


def build_sender_args(args: argparse.Namespace, file_path: Path, index: int) -> list[str]:
    script = Path(__file__).with_name("mqtt_audio_stream.py" if args.transport == "mqtt" else "ble_audio_stream.py")
    cmd = [sys.executable, str(script)]
    if args.transport == "mqtt":
        cmd.extend(["--broker", args.broker, "--device-id", args.device_id])
    else:
        if not args.device:
            raise RuntimeError("--device is required for BLE")
        cmd.extend(["--device", args.device, "--adapter", args.adapter])
    cmd.extend(
        [
            "--input",
            str(file_path),
            "--mode",
            args.mode,
            "--start-ack-timeout",
            str(args.start_ack_timeout),
            "--drain-timeout",
            str(args.drain_timeout),
        ]
    )
    if args.metrics_dir:
        metrics_path = Path(args.metrics_dir) / f"{index:03d}-{file_path.stem}-{args.transport}.csv"
        cmd.extend(["--metrics", str(metrics_path)])
    if args.summary_dir:
        summary_path = Path(args.summary_dir) / f"{index:03d}-{file_path.stem}-{args.transport}.json"
        cmd.extend(["--summary", str(summary_path)])
    return cmd


def emit(event: dict, progress_json: bool) -> None:
    if progress_json:
        print(json.dumps(event, ensure_ascii=False), flush=True)
    else:
        print(f"{event['event']}: {event.get('name', '')} {event.get('message', '')}".strip(), flush=True)


def _number_or_none(value: object) -> float | None:
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number else None


def main() -> None:
    args = parse_args()
    started_at = time.monotonic()
    files = discover(args.inputs, args.recursive)
    if not files:
        raise RuntimeError("no supported audio files found")

    manifest: dict = {
        "ok": False,
        "transport": args.transport,
        "mode": args.mode,
        "inputs": args.inputs,
        "files": [],
        "results": [],
    }

    for path in files:
        try:
            info = probe(path)
            manifest["files"].append(info)
            emit({"event": "probe", **info}, args.progress_json)
        except Exception as exc:
            manifest["results"].append({"ok": False, "path": str(path), "error": str(exc)})
            emit({"event": "skip", "name": path.name, "message": str(exc)}, args.progress_json)

    streamable = [Path(item["path"]) for item in manifest["files"]]
    if not streamable:
        raise RuntimeError("no streamable audio files found")

    for index, path in enumerate(streamable, start=1):
        emit({"event": "file_start", "index": index, "count": len(streamable), "path": str(path), "name": path.name}, args.progress_json)
        command = build_sender_args(args, path, index)
        proc = subprocess.run(command, text=True, capture_output=True)
        stdout = proc.stdout.strip()
        stderr = proc.stderr.strip()
        if proc.returncode != 0:
            result = {"ok": False, "path": str(path), "code": proc.returncode, "stderr": stderr, "stdout": stdout}
            manifest["results"].append(result)
            emit({"event": "file_error", "index": index, "path": str(path), "message": stderr or stdout}, args.progress_json)
            break
        try:
            summary = json.loads(stdout.splitlines()[-1])
        except Exception:
            summary = {"ok": True, "raw": stdout}
        summary["path"] = str(path)
        summary["name"] = path.name
        manifest["results"].append(summary)
        emit({"event": "file_done", "index": index, "count": len(streamable), **summary}, args.progress_json)

    manifest["ok"] = all(item.get("ok") for item in manifest["results"]) and len(manifest["results"]) == len(streamable)
    manifest["durationSeconds"] = time.monotonic() - started_at
    if args.manifest:
        Path(args.manifest).parent.mkdir(parents=True, exist_ok=True)
        Path(args.manifest).write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False))
    if not manifest["ok"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
