# linux/amd64 build environment — the one that reproduces the shipped bytes.
#
# PyPI publishes pynini wheels only for manylinux x86_64 (there is no macOS
# arm64 and no Windows wheel), so this is the only environment in which the
# pinned toolchain can be installed at all. On Apple Silicon it runs under QEMU
# through Docker's linux/amd64 emulation; the whole three-language build costs
# ~19 s there (see docs/superpowers/REPORT.md), so emulation is not a problem for this workload.
#
# The grammar source is the git submodule at upstream/WeTextProcessing (pinned
# in lock.json, commit 039007e6…), not a clone made at image build time: the
# image and CI must build the exact tree the repository records, and a clone
# would silently follow whatever the network serves.
#
# Build and run from `tools/fst-build` (the repo root is not the build context):
#
#   docker build --platform linux/amd64 -t fstbuild .
#   docker run --rm --platform linux/amd64 --memory=2g \
#     -v "$PWD:/work" -w /work fstbuild \
#     python /work/build.py --langs en,zh,ja --out /work/out
#
# `verify.py` runs on the host, not in here — it needs only zstd.
#
FROM --platform=linux/amd64 python:3.11-slim

# Pinned in lock.json. `>=2.1.6` is what WeTextProcessing declares; 2.1.7 is
# what `pip install -U` resolved on release day, and it reproduces the wheel.
# Its manylinux wheel carries its own OpenFst (pynini.libs/libfst.so.26), so
# this image compiles nothing and needs no git.
RUN pip install --no-cache-dir "pynini==2.1.7"

COPY upstream/WeTextProcessing /src/WeTextProcessing

ENV PYTHONPATH=/src/WeTextProcessing

WORKDIR /work
