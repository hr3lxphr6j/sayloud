#!/usr/bin/env python3
# Copyright 2026 SayLoud contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Verify a build directory against `lock.json`.
#
# Deliberately stdlib-only and *not* importing pynini: it runs on the host,
# after the container, so the check does not inherit the build environment it
# is supposed to be checking. The only external binary is `zstd`, invoked as
# `zstd -19 -q -c <file>` — the same command that produced the shipped assets.
#
# Two baselines live in lock.json:
#
#   wheel_parity / wheel_parity_zstd   the wetext==0.1.8 wheel, before any local rule
#   assets / assets_zstd               our own grammars, from the first local
#                                      rule onwards
#
# The raw sha256 is the artifact contract. The `.bin.zst` frame is the output of
# a *compressor*, so it is version-sensitive (Ubuntu 24.04's zstd 1.5.5 emits a
# different frame for all 8 files than the 1.5.7 these baselines were made with).
# Frames are therefore opt-in via `--frames`, and always checked against a
# `--reference` directory when one is given (both sides are then compressed by
# the same host).
#
# Usage:
#   python3 verify.py --out out --mode parity
#   python3 verify.py --out out --mode parity --frames
#   python3 verify.py --out out --mode parity --reference public/dictionaries
#   python3 verify.py --out out --mode assets

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
LOCK_PATH = HERE / "lock.json"

# (path inside --out, asset filename in public/dictionaries). The eight files
# the extension ships; nothing else is built.
FILES = (
    ("en/tn/tagger.fst", "wetext-en-tn-tagger.bin.zst"),
    ("en/tn/verbalizer.fst", "wetext-en-tn-verbalizer.bin.zst"),
    ("zh/tn/tagger.fst", "wetext-zh-tn-tagger.bin.zst"),
    ("zh/tn/verbalizer.fst", "wetext-zh-tn-verbalizer.bin.zst"),
    ("ja/tn/tagger.fst", "wetext-ja-tn-tagger.bin.zst"),
    ("ja/tn/verbalizer.fst", "wetext-ja-tn-verbalizer.bin.zst"),
    ("full_to_half.fst", "wetext-tn-full-to-half.bin.zst"),
    ("traditional_to_simple.fst", "wetext-zh-tn-traditional-to-simple.bin.zst"),
)

# The baselines to use per mode: (raw baseline key, frame baseline key).
BASELINES = {
    "parity": ("wheel_parity_before_rules", "wheel_parity_zstd_before_rules"),
    "assets": ("assets", "assets_zstd"),
}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def zstd_frame_sha256(path: Path, zstd: str) -> str:
    """sha256 of `zstd -19 -q -c path`, i.e. the bytes of a .bin.zst asset."""
    completed = subprocess.run(
        [zstd, "-19", "-q", "-c", str(path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(
            f"zstd failed on {path} (exit {completed.returncode}): "
            f"{completed.stderr.decode(errors='replace').strip()}"
        )
    return sha256_bytes(completed.stdout)


def zstd_version(zstd: str) -> str:
    try:
        completed = subprocess.run(
            [zstd, "--version"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False
        )
    except OSError:
        return "unknown"
    return completed.stdout.decode(errors="replace").strip().splitlines()[0] or "unknown"


def load_lock() -> dict:
    with LOCK_PATH.open(encoding="utf-8") as handle:
        return json.load(handle)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Check rebuilt grammars against the baselines in lock.json."
    )
    parser.add_argument("--out", default="out", help="build directory to check (default: out)")
    parser.add_argument(
        "--mode",
        choices=sorted(BASELINES),
        default="parity",
        help="which baseline to compare against (default: parity)",
    )
    parser.add_argument(
        "--reference",
        default=None,
        help="optional directory of shipped .bin.zst assets (e.g. public/dictionaries); "
        "when given, the recomputed zstd frames are also compared byte for byte",
    )
    parser.add_argument(
        "--frames",
        action="store_true",
        help="also compare the zstd -19 frames against lock.json; version-sensitive, "
        "so it is off by default",
    )
    args = parser.parse_args(argv)

    lock = load_lock()
    raw_key, frame_key = BASELINES[args.mode]
    if args.mode == "parity":
        print(
            "note: --mode parity compares against the historical pre-rule "
            "baseline (no local rules); it is not expected to match now."
        )
    raw_baseline = lock.get("hashes", {}).get(raw_key) or {}
    frame_baseline = lock.get("hashes", {}).get(frame_key) or {}

    if args.mode == "assets" and not raw_baseline:
        print(
            "no assets baseline yet: lock.json hashes.assets is empty. It is filled from "
            "the first local rule onwards; use --mode parity until then.",
            file=sys.stderr,
        )
        return 2
    if not raw_baseline:
        print(f"lock.json has no hashes.{raw_key} baseline", file=sys.stderr)
        return 2

    zstd = shutil.which("zstd")
    out = Path(args.out)
    reference = Path(args.reference) if args.reference else None
    check_frames = args.frames or reference is not None
    if check_frames and zstd is None:
        print(
            "zstd not found in PATH; it is required for --frames / --reference",
            file=sys.stderr,
        )
        return 2

    print(f"out: {out}")
    print(f"mode: {args.mode} (hashes.{raw_key})")
    if args.frames:
        print(f"frames: hashes.{frame_key} (zstd-version-sensitive)")
    if check_frames:
        print(f"zstd: {zstd_version(zstd)}")
    if reference is not None:
        print(f"reference: {reference}")
    print()

    name_width = max(len(name) for name, _ in FILES)
    header = f"{'file':<{name_width}}  {'raw':<5}"
    if check_frames:
        header += f"  {'frame':<5}"
    if reference is not None:
        header += "  ref"
    print(header)
    print("-" * len(header))

    details: list[str] = []
    raw_ok = frame_ok = 0

    for name, asset in FILES:
        path = out / name
        row = f"{name:<{name_width}}"

        if not path.is_file():
            row += f"  {'MISS':<5}"
            if check_frames:
                row += f"  {'MISS':<5}"
            details.append(f"{name}: missing from {out}")
            if reference is not None:
                row += "  -"
            print(row)
            continue

        actual_raw = sha256_file(path)
        expected_raw = raw_baseline.get(name)
        if expected_raw is None:
            raw_status = "NOBL"
            details.append(f"{name}: no raw baseline for this path in hashes.{raw_key}")
        elif expected_raw == actual_raw:
            raw_status = "ok"
            raw_ok += 1
        else:
            raw_status = "FAIL"
            details.append(f"{name}: raw\n  expected {expected_raw}\n  actual   {actual_raw}")

        frame_status = "-"
        actual_frame = None
        if check_frames:
            actual_frame = zstd_frame_sha256(path, zstd)
            if args.frames:
                expected_frame = frame_baseline.get(name)
                if expected_frame is None:
                    frame_status = "NOBL"
                    details.append(f"{name}: no frame baseline for this path in hashes.{frame_key}")
                elif expected_frame == actual_frame:
                    frame_status = "ok"
                    frame_ok += 1
                else:
                    frame_status = "FAIL"
                    details.append(
                        f"{name}: frame\n  expected {expected_frame}\n  actual   {actual_frame}"
                    )

        row += f"  {raw_status:<5}"
        if check_frames:
            row += f"  {frame_status:<5}"

        if reference is not None:
            shipped = reference / asset
            if not shipped.is_file():
                row += "  MISS"
                details.append(f"{name}: reference asset missing: {shipped}")
            else:
                shipped_hash = sha256_file(shipped)
                if actual_frame is None:
                    actual_frame = zstd_frame_sha256(path, zstd)
                if shipped_hash == actual_frame:
                    row += "  ok"
                else:
                    row += "  FAIL"
                    details.append(
                        f"{name}: reference frame\n  expected {shipped_hash} ({shipped.name})"
                        f"\n  actual   {actual_frame}"
                    )
        print(row)

    print()
    checked = len(FILES)
    if details:
        for detail in details:
            print(detail)
        print()
    frames_checked = len(FILES) if args.frames else 0
    if frames_checked:
        print(f"raw: {raw_ok}/{checked} match   frame: {frame_ok}/{frames_checked} match")
    else:
        print(f"raw: {raw_ok}/{checked} match")
    return 0 if not details else 1


if __name__ == "__main__":
    sys.exit(main())
