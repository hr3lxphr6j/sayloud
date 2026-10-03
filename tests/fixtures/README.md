# Test fixtures

## `test-dict.json` / `test-dict.json.zst`

A stand-in for a real dictionary (the Japanese one is ~10 MB compressed, 45.3 MB
decompressed). It is deliberately tiny and deliberately not valid JSON-as-a-dictionary:
phase 2 only defines the *transport* — bytes arrive compressed, come out whole — and
the per-dictionary format is a later task. Keeping the payload small is what lets the
same fixture be read by both sides, so the Rust decoder and the TypeScript loader are
tested against the same bytes.

The `.json` file is the plaintext the compressed one must decode to; the Rust test
compares the two, which is what makes "decompression actually happened" an assertion
rather than a hope.

Regenerate with (the `zstd` CLI, not `ruzstd` — the point is that the decoder reads
what the reference encoder writes):

```sh
zstd -19 -f -q tests/fixtures/test-dict.json -o tests/fixtures/test-dict.json.zst
```
