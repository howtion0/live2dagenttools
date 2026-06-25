#!/usr/bin/env python3
"""Render watermark-vs-PI audio flow metrics as an SVG comparison chart."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Plot BLE audio stream metrics CSV files.")
    parser.add_argument("--watermark", required=True)
    parser.add_argument("--pi", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--summary", help="Optional JSON comparison output")
    return parser.parse_args()


def read_rows(path: str) -> list[dict[str, float | str]]:
    rows: list[dict[str, float | str]] = []
    with open(path, newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            rows.append(
                {
                    "time_s": float(row["time_s"]),
                    "event": row["event"],
                    "fill": float(row["fill"]),
                    "free": float(row["free"]),
                    "sent": float(row["sent"]),
                    "received": float(row["received"]),
                    "read": float(row["read"]),
                    "effective_free": float(row["effective_free"]),
                    "controller_budget": float(row["controller_budget"]),
                }
            )
    return rows


def stats(rows: list[dict[str, float | str]]) -> dict[str, float]:
    if not rows:
        return {}
    end = rows[-1]
    duration = float(end["time_s"])
    sent = max(float(row["sent"]) for row in rows)
    fills = [float(row["fill"]) for row in rows if float(row["fill"]) > 0]
    return {
        "durationSeconds": duration,
        "sentBytes": sent,
        "averageBytesPerSecond": sent / duration if duration > 0 else 0,
        "avgFill": sum(fills) / len(fills) if fills else 0,
        "minFill": min(fills) if fills else 0,
        "maxFill": max(fills) if fills else 0,
        "maxEffectiveFree": max(float(row["effective_free"]) for row in rows),
    }


def points(rows: list[dict[str, float | str]], key: str, box: tuple[int, int, int, int], max_x: float, max_y: float) -> str:
    x0, y0, width, height = box
    if max_x <= 0 or max_y <= 0:
        return ""
    out = []
    last_x = None
    for row in rows:
        x = x0 + (float(row["time_s"]) / max_x) * width
        y = y0 + height - (float(row[key]) / max_y) * height
        if last_x is not None and abs(x - last_x) < 0.4:
            continue
        out.append(f"{x:.1f},{y:.1f}")
        last_x = x
    return " ".join(out)


def panel(title: str, key: str, watermark: list[dict[str, float | str]], pi: list[dict[str, float | str]], y: int) -> str:
    box = (80, y + 28, 1040, 210)
    max_x = max(float(watermark[-1]["time_s"]) if watermark else 0, float(pi[-1]["time_s"]) if pi else 0)
    max_y = max(
        max((float(row[key]) for row in watermark), default=0),
        max((float(row[key]) for row in pi), default=0),
        1,
    )
    wx = points(watermark, key, box, max_x, max_y)
    px = points(pi, key, box, max_x, max_y)
    x0, y0, width, height = box
    return f"""
<text x="80" y="{y + 18}" class="title">{title}</text>
<rect x="{x0}" y="{y0}" width="{width}" height="{height}" class="plot"/>
<text x="20" y="{y0 + 12}" class="axis">{int(max_y)}</text>
<text x="20" y="{y0 + height}" class="axis">0</text>
<text x="{x0 + width - 54}" y="{y0 + height + 22}" class="axis">{max_x:.1f}s</text>
<polyline points="{wx}" class="watermark"/>
<polyline points="{px}" class="pi"/>
"""


def main() -> None:
    args = parse_args()
    watermark = read_rows(args.watermark)
    pi = read_rows(args.pi)
    comparison = {"watermark": stats(watermark), "pi": stats(pi)}
    if args.summary:
        Path(args.summary).parent.mkdir(parents=True, exist_ok=True)
        Path(args.summary).write_text(json.dumps(comparison, ensure_ascii=False, indent=2), encoding="utf-8")

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="860" viewBox="0 0 1200 860">
<style>
  .bg {{ fill: #f8fafc; }}
  .plot {{ fill: #ffffff; stroke: #cbd5e1; stroke-width: 1; }}
  .title {{ font: 600 18px sans-serif; fill: #0f172a; }}
  .axis {{ font: 12px sans-serif; fill: #64748b; }}
  .legend {{ font: 14px sans-serif; fill: #334155; }}
  .watermark {{ fill: none; stroke: #2563eb; stroke-width: 2; }}
  .pi {{ fill: none; stroke: #dc2626; stroke-width: 2; }}
</style>
<rect class="bg" x="0" y="0" width="1200" height="860"/>
<text x="80" y="42" class="title">BLE Audio Flow Control: Watermark ACK vs PC-side PI</text>
<line x1="80" y1="64" x2="120" y2="64" class="watermark"/><text x="128" y="69" class="legend">watermark ACK</text>
<line x1="270" y1="64" x2="310" y2="64" class="pi"/><text x="318" y="69" class="legend">PI controller</text>
{panel("Ring fill bytes", "fill", watermark, pi, 88)}
{panel("Cumulative sent bytes", "sent", watermark, pi, 358)}
{panel("Effective free bytes", "effective_free", watermark, pi, 628)}
</svg>
"""
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(svg, encoding="utf-8")


if __name__ == "__main__":
    main()
