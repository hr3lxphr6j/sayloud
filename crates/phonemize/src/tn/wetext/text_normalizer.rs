//! FST-based text normalizer
//!
//! This module provides FST (Finite State Transducer) based text normalization,
//! equivalent to kaldifst.TextNormalizer in Python.
//!
//! Upstream's `from_file` is gone (modification 1 in `NOTICE`): the FST is
//! parsed from a byte slice. `rustfst` needs no change for that —
//! `SerializableFst::load` takes the whole OpenFST binary as `&[u8]`, and
//! upstream's `from_file` only wraps it in `read`, which reads the file first.
//! So this is upstream's parse with the file read removed, and
//! `wasm32-unknown-unknown` has no file to read.

use rustfst::algorithms::compose::compose;
use rustfst::fst_impls::VectorFst;
use rustfst::fst_traits::SerializableFst;
use rustfst::prelude::*;
use rustfst::semirings::TropicalWeight;
use rustfst::utils::acceptor;
use rustfst::{Label, StateId, EPS_LABEL};

use crate::tn::wetext::error::{Result, WeTextError};

/// FST-based text normalizer
///
/// Equivalent to kaldifst.TextNormalizer in Python
pub struct FstTextNormalizer {
    fst: VectorFst<TropicalWeight>,
}

impl FstTextNormalizer {
    /// Parse an FST from an in-memory OpenFST binary.
    ///
    /// `SerializableFst::load` takes the whole binary as `&[u8]`, so this is
    /// upstream's `from_file` with the `read` that would have read a file
    /// removed — the parse itself is the same call on the same bytes.
    ///
    /// The bytes are borrowed only for the parse; the resulting `VectorFst` owns
    /// its states and arcs. That is what lets a caller hand over a slice out of
    /// a dictionary the wasm holds, rather than keeping the bytes alive for the
    /// lifetime of the normalizer.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        let fst = VectorFst::<TropicalWeight>::load(bytes)
            .map_err(|e| WeTextError::FstLoadError(e.to_string()))?;

        Ok(Self { fst })
    }

    /// Apply FST for text transformation
    ///
    /// Implementation flow:
    /// 1. Convert input string to linear FST (acceptor) using UTF-8 bytes
    /// 2. Compose with the loaded FST
    /// 3. Find the cheapest path with [`cheapest_path_labels`]
    /// 4. Extract output string from the path
    ///
    /// # Arguments
    /// * `input` - Input text to normalize
    ///
    /// # Returns
    /// Normalized text string
    pub fn normalize(&self, input: &str) -> Result<String> {
        if input.is_empty() {
            return Ok(String::new());
        }

        // Step 1: Convert input string to linear FST using UTF-8 bytes
        // WeText FSTs use UTF-8 byte encoding for labels
        let labels: Vec<Label> = input.as_bytes().iter().map(|&b| b as Label).collect();
        let input_fst: VectorFst<TropicalWeight> = acceptor(&labels, TropicalWeight::one());

        // Step 2: Compose with the normalizer FST
        // Note: compose() requires output type to implement AllocableFst
        // Explicitly specify all type parameters for compose
        let composed: VectorFst<TropicalWeight> = compose::<
            TropicalWeight,
            VectorFst<TropicalWeight>,
            VectorFst<TropicalWeight>,
            VectorFst<TropicalWeight>,
            _,
            _,
        >(&input_fst, &self.fst)
        .map_err(|e| WeTextError::FstOperationError(format!("compose failed: {}", e)))?;

        // Check if compose result is empty (no match)
        if composed.num_states() == 0 {
            // If no match, return original input (same as kaldifst behavior)
            return Ok(input.to_string());
        }

        // Step 3: Find the cheapest path, by Bellman-Ford rather than by
        // `rustfst::shortest_path`. Why is in `cheapest_path_labels`; the short
        // version is that these grammars have negative arc weights and
        // `shortest_path` does not handle them.
        let labels = match cheapest_path_labels(&composed) {
            Some(labels) => labels,
            // No successful path. Return the original input, which is what an
            // empty compose does above and what kaldifst does.
            None => return Ok(input.to_string()),
        };

        // Step 4: Assemble the output string from the path's labels.
        self.labels_to_string(&labels)
    }

    /// Assemble the output string from the output labels of one path.
    ///
    /// FST labels are either Unicode code points (CJK characters, code > 255) or
    /// UTF-8 bytes (ASCII, code < 256), so both have to be handled. This is the
    /// second half of upstream's `fst_to_string`; the first half — walking a
    /// path — is [`cheapest_path_labels`], which returns these labels.
    fn labels_to_string(&self, labels: &[Label]) -> Result<String> {
        // Check if labels look like UTF-8 bytes (all < 256) or Unicode code points
        let has_high_codepoint = labels
            .iter()
            .any(|&label| label != EPS_LABEL && label > 255);

        if has_high_codepoint {
            // Labels are Unicode code points - convert directly
            let output: String = labels
                .iter()
                .filter_map(|&label| {
                    if label == EPS_LABEL {
                        None
                    } else {
                        char::from_u32(label)
                    }
                })
                .collect();
            Ok(output)
        } else {
            // Labels are likely UTF-8 bytes - collect and decode
            let bytes: Vec<u8> = labels
                .iter()
                .filter_map(|&label| {
                    if label == EPS_LABEL {
                        None
                    } else {
                        Some(label as u8)
                    }
                })
                .collect();

            String::from_utf8(bytes).map_err(|e| {
                WeTextError::FstOperationError(format!("Invalid UTF-8 in FST output: {}", e))
            })
        }
    }
}

/// The output labels of the cheapest path through `fst`, or `None` if it has no
/// successful path.
///
/// This is Bellman-Ford relaxation, not `rustfst::shortest_path`, and the reason
/// is a measured defect in the latter rather than a preference:
///
/// **The grammars carry negative arc weights, and `shortest_path` does not
/// handle them.** Upstream ranks competing readings with
/// `pynutil.add_weight(..., -0.0001)` — in `cardinal.py`, the British `and` is
/// cheaper than its absence — and a composed FST reaches `-0.0001`.
///
/// `shortest_path` with its default `nshortest = 1` is `single_shortest_path`:
/// a relaxation loop (in `rustfst` 1.3.1, `algorithms/shortest_path.rs`) whose
/// queue discipline comes from `AutoQueue` — LIFO for an unweighted FST, the
/// SCC condensation's order for an acyclic one, per-SCC queues otherwise — and
/// the sign of the weights is not one of the properties it looks at. So an
/// improvement cannot be assumed to be re-scheduled, and the call returns a path
/// that is **not** the cheapest one. `shortest_distance` shares the queue and has
/// the same blind spot; `push_weights` was tried and normalises the total without
/// changing which reading is chosen.
///
/// Measured on the composed FST for `cardinal { integer: "123" }`: seven
/// readings exist, `one hundred and twenty three` costs `0.000000` and is the
/// cheapest, and `shortest_path` returned `one two three` at `0.000200`. Of 18
/// probe sentences through the real pipeline, 7 were affected, and every one was
/// the engine picking a *more* expensive path.
///
/// Algorithm:
/// 1. relax every arc, `|V|` times, recording the arc each state was reached by;
/// 2. take the final state with the smallest `dist + final_weight`;
/// 3. walk the recorded arcs back to the start, collecting output labels.
///
/// These grammars have no negative cycle, so step 1 terminates — and it says so
/// itself: a round that changes nothing ends the loop, which the probes measured
/// as 2–4 rounds. `|V|` rounds is the bound that makes termination
/// unconditional rather than dependent on the data.
fn cheapest_path_labels(fst: &VectorFst<TropicalWeight>) -> Option<Vec<Label>> {
    let num_states = fst.num_states();
    if num_states == 0 {
        return None;
    }
    let start = fst.start()?;

    // `dist[s]`: cost of the cheapest path from `start` to `s` found so far.
    // `incoming[s]`: the arc that last improved it — what step 3 walks.
    let mut dist = vec![f32::INFINITY; num_states];
    let mut incoming: Vec<Option<(StateId, Label)>> = vec![None; num_states];
    dist[start as usize] = 0.0;

    for _ in 0..num_states {
        let mut changed = false;
        for state in 0..num_states {
            let from_cost = dist[state];
            if !from_cost.is_finite() {
                continue;
            }
            let trs = fst.get_trs(state as StateId).ok()?;
            for tr in trs.trs() {
                let weight = *tr.weight.value();
                if !weight.is_finite() {
                    continue;
                }
                let candidate = from_cost + weight;
                let next = tr.nextstate as usize;
                // Strictly less, so a tie leaves the earlier arc in place and
                // the backtrack below cannot walk a zero-cost cycle forever.
                if candidate < dist[next] {
                    dist[next] = candidate;
                    incoming[next] = Some((state as StateId, tr.olabel));
                    changed = true;
                }
            }
        }
        if !changed {
            break;
        }
    }

    // Step 2: the cheapest successful path ends at whichever final state
    // minimizes the path cost plus that state's final weight.
    let mut best: Option<(f32, usize)> = None;
    for (state, cost) in dist.iter().enumerate() {
        let Some(final_weight) = fst.final_weight(state as StateId).ok().flatten() else {
            continue;
        };
        let total = cost + *final_weight.value();
        if !total.is_finite() {
            continue;
        }
        if best.is_none_or(|(best_total, _)| total < best_total) {
            best = Some((total, state));
        }
    }
    let (_, final_state) = best?;

    // Step 3: backtrack. `dist` strictly decreases along the recorded arcs, so
    // this reaches the start state in at most `num_states` steps.
    //
    // The bound is enforced rather than argued: the strict `<` above makes a
    // cycle here unreachable (a cycle of `incoming` pointers would need two
    // states to each have been strictly cheaper than the other), but a
    // malformed grammar would turn that reasoning into a hang, and a hang in
    // the wasm takes the whole worker with no error to report. Returning `None`
    // instead falls back to the input text, the same as an empty composition.
    let mut labels = Vec::new();
    let mut state = final_state;
    for _ in 0..num_states {
        if state == start as usize {
            labels.reverse();
            return Some(labels);
        }
        let (previous, olabel) = incoming[state]?;
        if olabel != EPS_LABEL {
            labels.push(olabel);
        }
        state = previous as usize;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_acceptor_creation() {
        let labels: Vec<Label> = "hello".chars().map(|c| c as Label).collect();
        let fst: VectorFst<TropicalWeight> = acceptor(&labels, TropicalWeight::one());
        assert_eq!(fst.num_states(), 6); // 5 chars + 1 (start state)
    }
}
