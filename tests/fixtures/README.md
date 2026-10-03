# Test fixtures

## `test-dict.json` / `test-dict.json.zst`

A stand-in for a real dictionary (the Japanese one is 8.5 MB compressed, 45.4 MB
decompressed). It is deliberately tiny and deliberately not a real dictionary: it
exists to test the *transport* — bytes arrive compressed, come out whole — without
carrying 45 MB of IPADic into every test that touches the registry.

The `.json` file is the plaintext the compressed one must decode to; the Rust test
compares the two, which is what makes "decompression actually happened" an assertion
rather than a hope.

**Where this fixture is no longer enough.** Phase 2 could only check that the bytes
arrived, so any payload would do. Phase 3 made `finish_loading` build the Japanese
segmenter from those bytes, and no small payload can satisfy lindera's nine
components — a tar without them fails as `dictionary-incomplete`, and one with them
fails as `dictionary-component`. So the tests that reach that step use the real
asset, built by `scripts/setup-lindera-dict.sh`:

- Rust: `crates/phonemize/tests/ja_pipeline.rs` (via `tests/common/mod.rs`);
- TypeScript: the `prepare` and `phonemize` blocks of
  `tests/unit/models/phonemize-rust.test.ts`.

Both skip, loudly, when the asset is missing rather than passing quietly. This
fixture still covers everything up to `finish_loading`: the magic-number check, the
decompression itself, the name bookkeeping, and the cache.

Regenerate with (the `zstd` CLI, not `ruzstd` — the point is that the decoder reads
what the reference encoder writes):

```sh
zstd -19 -f -q tests/fixtures/test-dict.json -o tests/fixtures/test-dict.json.zst
```
