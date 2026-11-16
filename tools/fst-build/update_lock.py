#!/usr/bin/env python3
# Copyright 2026 SayLoud contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Re-baseline `lock.json` against a fresh build directory.
#
# This is the second half of a manual upstream bump (docs/superpowers/TN-PLAN.md
# §7): the report says which readings moved, and this says "these are now
# the bytes". The bump is not scheduled; run it when `master` has moved. It is the only sanctioned way to change `hashes.assets`, because
# the two files it writes are the two the gate reads — `verify.py --mode assets`
# compares exactly these keys.
#
# What it does NOT do: reorder, reformat, drop comments or touch any other field.
# `_outputs_note`, `wheel_parity_before_rules` and the pins' provenance notes stay
# as they are, so the diff on a bump is the two commits plus eight hashes and
# nothing else. It is idempotent: running it twice on the same build and commit
# writes the same bytes twice.
#
# Usage:
#   python3 tools/fst-build/update_lock.py \
#       --out tools/fst-build/out-new --commit <upstream sha>

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from pathlib import Path

# The file list and the two hash functions come from the verifier rather than
# from a second copy, because `lock.json` is only meaningful if the script that
# writes it and the script that checks it agree on the definition — a frame
# compressed differently or a path spelled differently would make `verify.py`
# fail on a lock this script had just produced.
import verify

HERE = Path(__file__).resolve().parent
DEFAULT_LOCK = HERE / "lock.json"

# `git rev-parse` output: the bump records a commit, not a tag or a branch.
COMMIT_RE = re.compile(r"[0-9a-f]{40}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Recompute lock.json's asset baselines from a build directory."
    )
    parser.add_argument("--out", required=True, help="build directory (verify.py --out)")
    parser.add_argument(
        "--lock",
        default=str(DEFAULT_LOCK),
        help=f"lock file to update in place (default: {DEFAULT_LOCK})",
    )
    parser.add_argument(
        "--commit",
        required=True,
        help="upstream WeTextProcessing commit the build came from (full 40-hex sha)",
    )
    args = parser.parse_args(argv)

    if not COMMIT_RE.fullmatch(args.commit):
        print(
            f"--commit must be a full 40-character lowercase hex sha, got {args.commit!r}",
            file=sys.stderr,
        )
        return 2

    out = Path(args.out)
    lock_path = Path(args.lock)

    # All eight or nothing: a partial build would silently leave seven stale
    # hashes next to one fresh one, and the gate would pass on a mixture.
    expected_paths = [name for name, _ in verify.FILES]
    missing = [name for name in expected_paths if not (out / name).is_file()]
    if missing:
        print(f"{out} is not a complete build; missing:", file=sys.stderr)
        for name in missing:
            print(f"  {name}", file=sys.stderr)
        return 2

    zstd = shutil.which("zstd")
    if zstd is None:
        print(
            "zstd not found in PATH; it is required for hashes.assets_zstd",
            file=sys.stderr,
        )
        return 2

    if not lock_path.is_file():
        print(f"{lock_path}: no such lock file", file=sys.stderr)
        return 2
    try:
        # `json.loads` keeps the file's key order (dicts preserve insertion order),
        # and `json.dumps` writes in that order — which is how every field this
        # script does not touch comes out byte-identical.
        lock = json.loads(lock_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        print(f"{lock_path}: not valid JSON: {error}", file=sys.stderr)
        return 2

    hashes = lock.setdefault("hashes", {})

    # The lock's own list of files and the verifier's must agree before either is
    # trusted: this is the assertion that catches a build that grew a ninth file
    # or renamed one.
    locked_paths = hashes.get("output_files")
    if locked_paths != expected_paths:
        print(
            "lock.json's hashes.output_files does not match verify.py's FILES:\n"
            f"  lock:    {locked_paths}\n"
            f"  verify:  {expected_paths}",
            file=sys.stderr,
        )
        return 2

    raw = {}
    frames = {}
    for name in expected_paths:
        path = out / name
        raw[name] = verify.sha256_file(path)
        frames[name] = verify.zstd_frame_sha256(path, zstd)

    old_raw = hashes.get("assets") or {}
    old_frames = hashes.get("assets_zstd") or {}

    # Assigning into the existing dicts keeps each key where the file already has
    # it, so the diff is eight hash lines and not a reordered file.
    hashes["assets"] = raw
    hashes["assets_zstd"] = frames
    lock.setdefault("upstream", {})["commit"] = args.commit
    lock.setdefault("wetextprocessing", {})["commit"] = args.commit

    width = max(len(name) for name in expected_paths)
    print(f"out: {out}")
    print(f"lock: {lock_path}")
    print(f"commit: {args.commit}")
    print(f"zstd: {verify.zstd_version(zstd)}")
    print()
    for name in expected_paths:
        moved = "changed" if old_raw.get(name) != raw[name] else "same"
        frame_moved = "changed" if old_frames.get(name) != frames[name] else "same"
        print(f"{name:<{width}}  raw {moved:<7}  frame {frame_moved}")

    # Same formatting as the file this replaces: two-space indent, literal
    # non-ASCII (the provenance notes are prose, not data), trailing newline.
    text = json.dumps(lock, indent=2, ensure_ascii=False) + "\n"
    lock_path.write_text(text, encoding="utf-8")
    print(f"\nwrote {lock_path} ({len(text)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
