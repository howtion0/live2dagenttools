#!/usr/bin/env python3
"""Write Volcengine chunked TTS MP3 bytes to stdout or a FIFO/file."""

from __future__ import annotations

import argparse
import base64
import asyncio
import gzip
import json
import os
import sys
import uuid
from json import JSONDecodeError, JSONDecoder
from urllib import request as urllib_request

import websockets

VOLC_TTS_URL = "https://openspeech.bytedance.com/api/v3/tts/unidirectional"
VOLC_TTS_WS_URL = "wss://openspeech.bytedance.com/api/v1/tts/ws_binary"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Stream Volcengine TTS MP3 bytes.")
    parser.add_argument("--text", required=True)
    parser.add_argument("--output", default="-", help="Output path, FIFO, or - for stdout")
    parser.add_argument("--provider", choices=["api-key", "legacy-ws"], default=os.environ.get("VOLC_TTS_PROVIDER", "api-key"))
    parser.add_argument("--api-key", default=os.environ.get("VOLC_SPEECH_API_KEY", ""))
    parser.add_argument("--app-id", default=os.environ.get("VOLC_TTS_APP_ID", ""))
    parser.add_argument("--access-token", default=os.environ.get("VOLC_TTS_ACCESS_TOKEN", ""))
    parser.add_argument("--cluster", default=os.environ.get("VOLC_TTS_CLUSTER", "volcano_tts"))
    parser.add_argument("--voice-type", default=os.environ.get("VOLC_TTS_VOICE_TYPE", ""))
    parser.add_argument("--resource-id", default=os.environ.get("VOLC_TTS_RESOURCE_ID", "seed-tts-2.0"))
    parser.add_argument("--speaker", default=os.environ.get("VOLC_TTS_SPEAKER", "zh_female_shuangkuaisisi_moon_bigtts"))
    parser.add_argument("--language", default=os.environ.get("VOLC_TTS_LANGUAGE", "zh-cn"))
    parser.add_argument("--uid", default=os.environ.get("VOLC_TTS_UID", "talkmcp"))
    parser.add_argument("--volume-ratio", type=float, default=float(os.environ.get("VOLC_TTS_VOLUME_RATIO", "3.0")))
    parser.add_argument("--speed-ratio", type=float, default=float(os.environ.get("VOLC_TTS_SPEED_RATIO", "1.0")))
    parser.add_argument("--pitch-ratio", type=float, default=float(os.environ.get("VOLC_TTS_PITCH_RATIO", "1.0")))
    parser.add_argument("--loudness-rate", type=float, default=float(os.environ.get("VOLC_TTS_LOUDNESS_RATE", "0")))
    parser.add_argument("--volc-url", default=os.environ.get("VOLC_TTS_URL", VOLC_TTS_URL))
    parser.add_argument("--ws-url", default=os.environ.get("VOLC_TTS_WS_URL", VOLC_TTS_WS_URL))
    parser.add_argument("--http-timeout", type=float, default=120.0)
    parser.add_argument("--context-text", default=os.environ.get("VOLC_TTS_CONTEXT_TEXT", ""))
    parser.add_argument("--summary", help="Optional JSON summary path")
    return parser.parse_args()


def build_payload(args: argparse.Namespace, request_id: str) -> bytes:
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
                "format": "mp3",
                "sample_rate": 24000,
                "speech_rate": 0,
                "loudness_rate": args.loudness_rate,
            },
            "additions": json.dumps(additions, ensure_ascii=False),
        },
    }
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


def build_legacy_payload(args: argparse.Namespace, request_id: str) -> bytes:
    voice_type = args.voice_type or args.speaker
    payload = {
        "app": {
            "appid": args.app_id,
            "token": "access_token",
            "cluster": args.cluster,
        },
        "user": {
            "uid": args.uid,
        },
        "audio": {
            "voice_type": voice_type,
            "encoding": "mp3",
            "speed_ratio": args.speed_ratio,
            "volume_ratio": args.volume_ratio,
            "pitch_ratio": args.pitch_ratio,
        },
        "request": {
            "reqid": request_id,
            "text": args.text,
            "text_type": "plain",
            "operation": "submit",
        },
    }
    body = gzip.compress(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
    packet = bytearray(b"\x11\x10\x11\x00")
    packet.extend(len(body).to_bytes(4, "big"))
    packet.extend(body)
    return bytes(packet)


def parse_legacy_response(frame: bytes) -> tuple[bytes, bool, dict | None]:
    if len(frame) < 4:
        raise RuntimeError("legacy websocket response too short")
    header_size = frame[0] & 0x0F
    message_type = frame[1] >> 4
    flags = frame[1] & 0x0F
    compression = frame[2] & 0x0F
    payload = frame[header_size * 4 :]

    if message_type == 0xB:
        if flags == 0:
            return b"", False, None
        if len(payload) < 8:
            raise RuntimeError("legacy audio response missing sequence header")
        sequence = int.from_bytes(payload[:4], "big", signed=True)
        payload_size = int.from_bytes(payload[4:8], "big", signed=False)
        audio = payload[8 : 8 + payload_size]
        return audio, sequence < 0, None

    if message_type == 0xF:
        if len(payload) >= 8:
            error_code = int.from_bytes(payload[:4], "big", signed=False)
            payload_size = int.from_bytes(payload[4:8], "big", signed=False)
            error_payload = payload[8 : 8 + payload_size]
        else:
            error_code = -1
            error_payload = payload
        if compression == 1:
            error_payload = gzip.decompress(error_payload)
        try:
            details = json.loads(error_payload.decode("utf-8", errors="replace"))
        except Exception:
            details = {"raw": error_payload.decode("utf-8", errors="replace")}
        details["code"] = error_code
        return b"", True, details

    return b"", False, None


async def legacy_ws_to_output(args: argparse.Namespace, out) -> dict:
    if not args.app_id or not args.access_token:
        raise RuntimeError("VOLC_TTS_APP_ID and VOLC_TTS_ACCESS_TOKEN are required for legacy websocket TTS")

    request_id = str(uuid.uuid4())
    total = 0
    chunks = 0
    headers = {"Authorization": f"Bearer;{args.access_token}"}
    async with websockets.connect(args.ws_url, additional_headers=headers, ping_interval=None, max_size=16 * 1024 * 1024) as ws:
        await ws.send(build_legacy_payload(args, request_id))
        while True:
            frame = await asyncio.wait_for(ws.recv(), timeout=args.http_timeout)
            if isinstance(frame, str):
                frame = frame.encode("utf-8")
            audio, done, error = parse_legacy_response(frame)
            if error:
                raise RuntimeError(f"legacy websocket TTS failed: {error}")
            if audio:
                out.write(audio)
                out.flush()
                total += len(audio)
                chunks += 1
            if done:
                break

    return {
        "ok": True,
        "source": "volcengine_tts_legacy_ws_stream",
        "appId": args.app_id,
        "cluster": args.cluster,
        "voiceType": args.voice_type or args.speaker,
        "language": args.language,
        "ttsBytes": total,
        "ttsChunks": chunks,
        "requestId": request_id,
    }


def api_key_to_output(args: argparse.Namespace, out) -> dict:
    if not args.api_key:
        raise RuntimeError("VOLC_SPEECH_API_KEY is required for api-key TTS streaming")

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
        data=build_payload(args, request_id),
        headers=headers,
        method="POST",
    )
    decoder = JSONDecoder()
    pending = ""
    total = 0
    chunks = 0
    usage = None
    log_id = None
    with urllib_request.urlopen(req, timeout=args.http_timeout) as resp:
        log_id = resp.headers.get("X-Tt-Logid")
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
                    usage = obj.get("usage")
                if obj.get("data"):
                    audio = base64.b64decode(obj["data"])
                    out.write(audio)
                    out.flush()
                    total += len(audio)
                    chunks += 1
    return {
        "ok": True,
        "source": "volcengine_tts_mp3_stream",
        "resourceId": args.resource_id,
        "speaker": args.speaker,
        "language": args.language,
        "ttsBytes": total,
        "ttsChunks": chunks,
        "volcLogId": log_id,
        "usage": usage,
    }


def main() -> None:
    args = parse_args()
    if not args.text.strip():
        raise RuntimeError("--text is required")

    out = sys.stdout.buffer if args.output == "-" else open(args.output, "wb", buffering=0)
    try:
        if args.provider == "legacy-ws":
            summary = asyncio.run(legacy_ws_to_output(args, out))
        else:
            summary = api_key_to_output(args, out)
    finally:
        if out is not sys.stdout.buffer:
            out.close()
    if args.summary:
        with open(args.summary, "w", encoding="utf-8") as handle:
            json.dump(summary, handle, ensure_ascii=False, indent=2)
    print(json.dumps(summary, ensure_ascii=False), file=sys.stderr)


if __name__ == "__main__":
    main()
