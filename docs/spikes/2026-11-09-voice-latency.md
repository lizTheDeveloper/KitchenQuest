# Spike: can a self-hosted open-source voice pipeline hit the 1.5 s target?

Date: 2026-11-09. Spec reference: design spec §7.7 (Live voice). Throwaway spike; code, venv and models live in `/tmp/claude-0/-home-user/757c4bd1-1cee-5420-8c4c-4e93e09ff079/scratchpad/voice-spike/` and are not part of the repo.

**Target:** under 1.5 s from the end of the player's speech to the first spoken audio, using VAD, then STT, then Qwen via OpenRouter (streamed), then TTS.

## Verdict

- **Median: yes, narrowly, on CPU, with the smallest models.** `faster-whisper tiny.en` or `base.en` plus Piper gives about 1.4 to 1.65 s. With two cheap tricks (below) it is about 1.3 to 1.5 s.
- **p90: no, on any stack.** The LLM time to first sentence is p50 0.64 s but p90 1.13 s (max about 2.8 s for the first token). That tail is outside our control, so p90 lands near 2.0 s on CPU and about 1.8 s on GPU.
- **Kokoro on CPU misses the target** (about 2.0 s at p50). Kokoro is the more characterful voice, so a GPU box is what buys it.
- **Recommendation:** treat 1.5 s as a median target. Hide the tail with a pre-rendered Pan filler sound and scripted lines. Start on CPU with Piper; move STT and TTS to a GPU box only if Kokoro, or `small` accuracy, is wanted for the Pan.

## Environment

| Item | Value |
|---|---|
| Machine | CPU only, no GPU |
| CPU | Intel Xeon @ 2.30 GHz (Sapphire Rapids class: AVX-512, AMX, VNNI) |
| Cores | 4 vCPU, 1 thread per core, 15 GB RAM |
| OS / Python | Linux 6.18, Python 3.13 |
| STT | faster-whisper 1.2.1 (CTranslate2 4.8.5), int8, `cpu_threads=4`, models `tiny.en`, `base.en`, `small.en` |
| TTS | piper-tts 1.8.0 (ONNX Runtime 1.31.1), kokoro-onnx 0.6.1 with `kokoro-v1.0.int8.onnx` |
| LLM | `qwen/qwen3.8-27b` via OpenRouter, streaming, called through the agent proxy with `Authorization: Bearer proxy-injected` |
| Network | No download host was blocked. Hugging Face (Whisper models, Piper voices), GitHub releases (Kokoro ONNX files), PyPI and openrouter.ai were all reachable. |

All measurements were taken on this one noisy-neighbour-free sandbox VM. Numbers are medians unless stated. A Hetzner dedicated-vCPU box of the same class should be similar, but this was not verified.

## Method and honest limits

- **Test audio is synthetic.** The 10 cooking phrases were generated with the TTS candidates themselves (Piper lessac, Piper alan, Kokoro af_heart, Kokoro bm_george), giving 40 clips per condition. Synthetic speech is cleaner and more regular than a real cook, so **WER here is optimistic**. Real microphone audio must be tested before any final decision.
- **Noise:** pink-ish hiss plus random clatter bursts, mixed at 15 dB and 5 dB SNR to roughly imitate a kitchen. It is not a recorded kitchen.
- **WER normalisation:** lowercased, punctuation and hyphens removed ("K-I-W-I" becomes "k i w i"), "12" becomes "twelve", "2" becomes "two".
- **"+hint"** means Whisper `initial_prompt` was set to "Cooking assistant. Ingredients: gochujang, epazote, tamari, kiwi, halloumi, shallots, dal." The hint contained the test terms, so the +hint numbers represent a best case where the app knows the player's pantry and allergens. They do not represent unseen ingredients.
- **STT latency** is the time to transcribe a whole 5.2 s utterance (two phrases joined, 19 clips) after speech ends, with beam 1 unless stated. This is the non-streaming worst case. It does not include VAD hangover.
- I did not listen to the audio, so voice "character" ratings below are judgements from the model design and the voice list, not an ear test. Samples are in `.../voice-spike/audio/` for a human to rate.
- Barge-in and VAD were not measured in a browser. They are reasoned from known behaviour.

## Results

### 1. STT: latency on a 5.2 s utterance (CPU, int8, 4 threads)

| Model | Beam 1 median (p90) | Beam 5 median (p90) |
|---|---|---|
| tiny.en | 0.34 s (0.36) | 0.46 s (0.51) |
| base.en | 0.55 s (0.57) | 0.75 s (0.84) |
| small.en | 1.32 s (1.44) | 1.74 s (1.87) |

### 2. STT: word error rate on 10 cooking phrases (beam 5, 40 clips per cell)

"Terms" counts the hard words (gochujang, epazote, tamari, kiwi, halloumi, shallots) recognised exactly, out of 24.

| Model | Clean | 15 dB | 5 dB | Clean +hint | 15 dB +hint | 5 dB +hint | Terms, no hint | Terms, +hint |
|---|---|---|---|---|---|---|---|---|
| tiny.en | 15.1% | 17.9% | 21.8% | 8.7% | 7.9% | 11.9% | 12/24 | 22/24 |
| base.en | 11.5% | 14.7% | 21.0% | 10.3% | 10.3% | 12.7% | 11/24 | 17/24 |
| small.en | 8.3% | 13.1% | 15.5% | 5.2% | 7.5% | 8.7% | 14/24 | 19/24 |

Typical errors without a hint: "epazote" became "episodes" or "episode"; "gochujang" became "gotchujang"; "pad thai" became "pad time" or "pad tie"; "halloumi" became "halomie"; "kiwi, K-I-W-I" became "kiwi kai i w r" at 5 dB. Spelled-out letters are the weakest spot, which matters for §7.6 allergen read-backs.

Takeaways: a pantry-aware prompt is worth more than a bigger model (tiny+hint beats base without hint). `small` is the only model that stays under 10% WER in noise with a hint, but it costs about 1.3 s on CPU. Non-hinted ingredient recognition is poor (about half) at every size, so allergen handling must not rely on STT alone.

### 3. TTS: time to first audio for a 2-sentence Pan line

Pan line: "Ah, leftover pad thai. Bold of you to admit that in front of me. I will log it, but we are never speaking of the second helping." First sentence alone: "Ah, leftover pad thai." Median of 5 runs after warm-up, 4 threads.

| Voice | First audio, sentence-chunked (first sentence) | First chunk, whole 2-sentence line | Real-time factor |
|---|---|---|---|
| Piper en_US-lessac-medium | 0.05 s | 0.07 s | 0.03 |
| Piper en_US-amy-medium | 0.05 s | 0.07 s | 0.02 |
| Piper en_GB-alan-medium | 0.06 s | 0.05 s | 0.03 |
| Piper en_GB-northern_english_male-medium | 0.04 s | 0.04 s | 0.03 |
| Piper en_US-ryan-high | 0.27 s | 0.26 s | 0.14 |
| Kokoro af_heart | 0.42 s | 1.75 s | 0.23 to 0.34 |
| Kokoro bm_fable | 0.57 s | 1.83 s | 0.23 to 0.29 |
| Kokoro am_puck | 0.42 s | 1.97 s | 0.24 to 0.27 |
| Kokoro bm_george | 0.71 s | 1.98 s | 0.28 to 0.33 |
| Kokoro af_bella | 0.60 s | 2.12 s | 0.29 to 0.38 |

Kokoro's `create_stream` does not yield per sentence: for the 2-sentence line its first chunk arrived after about 1.75 to 2.1 s. **The service must split sentences itself and synthesise one sentence at a time**, which is the "first sentence" column. Piper streams per sentence natively.

### 4. LLM: time to first token via OpenRouter (qwen/qwen3.8-27b, streaming, n = 20)

| Metric | p50 | p90 | Max |
|---|---|---|---|
| First content token | 0.51 s | 0.90 s | 2.84 s |
| First complete sentence (what sentence-chunked TTS waits for) | 0.64 s | 1.13 s | not recorded |

**Gotcha:** with the default settings the model spends its whole budget on hidden reasoning. With `max_tokens: 80` it returned reasoning chunks and no content in all 5 test calls. The voice path must send `"reasoning": {"enabled": false}` (this worked), or Pan turns will stall. Measured from this sandbox through the agent proxy; from a Hetzner box to OpenRouter the figure may differ by tens of milliseconds.

### 5. Full pipeline estimate (CPU, 4 vCPU)

Composition: VAD end-of-speech hangover (assumed 0.30 s, browser-side Silero-style detector) + STT (measured, beam 1) + LLM first sentence (measured p50 0.64 s, p90 1.13 s) + TTS first sentence (measured) + audio network up and down (assumed 0.10 s). The VAD and network figures are assumptions, not measurements.

| Stack | VAD | STT | LLM | TTS | Net | **p50 total** | **p90 total** | Meets 1.5 s? |
|---|---|---|---|---|---|---|---|---|
| tiny.en + Piper lessac | 0.30 | 0.34 | 0.64 | 0.05 | 0.10 | **1.43 s** | about 1.96 s | p50 only, barely |
| base.en + Piper lessac | 0.30 | 0.55 | 0.64 | 0.05 | 0.10 | **1.64 s** | about 2.17 s | no (1.45 s with the tricks below) |
| base.en + Kokoro af_heart | 0.30 | 0.55 | 0.64 | 0.42 | 0.10 | **2.01 s** | about 2.7 s | no |
| small.en + Kokoro af_heart | 0.30 | 1.32 | 0.64 | 0.42 | 0.10 | **2.78 s** | about 3.6 s | no |
| GPU: small.en + Kokoro (estimate) | 0.30 | about 0.12 | 0.64 | about 0.10 | 0.10 | **about 1.26 s** | about 1.8 s | p50 yes, p90 no |

**Two cheap tricks that probably save about 0.2 s** (not built, so treated as estimates):
1. **Speculative STT:** start decoding at about 150 to 200 ms of silence rather than waiting for a 300 ms hangover, and discard the result if speech resumes. Saves up to about 0.1 to 0.15 s.
2. **Flush TTS on the first clause** (comma or about 6 words) instead of the first full sentence. The first content token is at p50 0.51 s versus 0.64 s for a full sentence. Saves about 0.1 s.

With both, tiny + Piper is about 1.25 to 1.3 s and base + Piper about 1.45 s at p50.

A true streaming recognizer (for example sherpa-onnx streaming zipformer, Apache-2.0) would remove most of the STT term, since most decoding happens while the player is still talking. It was not tested here and is the next thing to try if Whisper's batch latency is the problem.

### 6. Concurrency on CPU (base.en, beam 1, one 4.5 s utterance each, 1 thread per job)

| Simultaneous utterance-ends | Median latency per job | Worst |
|---|---|---|
| 1 | 0.95 s | 1.06 s |
| 2 | 0.91 s | 1.61 s |
| 4 | 1.17 s | 1.40 s |
| 6 (on 4 vCPU) | 1.32 to 1.74 s | 2.37 s |

- One utterance costs about **1 core-second** of STT (base.en). Four threads on one utterance only improves 0.95 s to about 0.6 s, so give each job one thread and run many jobs in parallel.
- Piper costs about 0.2 to 0.7 core-seconds per 8 s Pan line (RTF about 0.03 on 4 threads). Kokoro costs about 2 s wall on 4 threads (about 8 core-seconds, roughly 10x more).
- **Cost per concurrent conversation (base + Piper):** about 1.2 to 1.7 core-seconds per turn. If a player takes a turn every 20 to 30 s, that is about 0.05 to 0.08 of a core on average. Capacity is limited by simultaneous turn-ends, not by averages. With Kokoro on CPU it is about 5 to 10x worse.

## Hosting and capacity (estimates, not load-tested)

Capacity numbers extrapolate from the single-box measurements above plus simple queueing reasoning (keep average utilisation under about 40% so simultaneous turn-ends stay inside the latency budget). Only 1 to 6 parallel STT jobs were actually run. **Hetzner models and prices below are from memory and are estimates; confirm on hetzner.com before budgeting.**

| Box (type, approximate monthly price, estimate) | Stack | Concurrent voice conversations (estimate) |
|---|---|---|
| CCX23, 4 dedicated vCPU, about 25 to 35 EUR | base.en/tiny.en + Piper | about 15 to 25 |
| CCX33, 8 dedicated vCPU, about 55 to 70 EUR | base.en + Piper | about 35 to 50 |
| CCX43, 16 dedicated vCPU, about 110 to 140 EUR | base.en + Piper | about 80 to 100 |
| Any of the above | small.en and/or Kokoro | about 3 to 5x fewer, and misses the latency target on CPU |
| GEX44, GPU (RTX 4000 SFF Ada, 20 GB), about 180 to 200 EUR plus setup fee | small.en or large-v3-turbo + Kokoro, batched | about 50 to 100 (from published faster-whisper and Kokoro GPU speed claims; not measured) |

The GPU row rests on published benchmarks: faster-whisper small on a modern GPU runs tens of times faster than real time (roughly 0.1 to 0.15 s for 5 s of speech), and Kokoro-82M on a GPU is reported at tens of times real time (roughly 0.1 s for a short sentence). Treat these as labelled estimates.

## Licences (check before shipping)

| Component | Licence | Note |
|---|---|---|
| faster-whisper | MIT | |
| Whisper weights (tiny/base/small .en) | MIT (OpenAI Whisper; Systran CTranslate2 conversions list MIT) | |
| Kokoro-82M weights | Apache-2.0 (model card) | Wrapper `kokoro-onnx` has blank package metadata; the repo is MIT per its listing, which I did not re-verify |
| Piper engine (`piper-tts` 1.8.0 from PyPI) | **GPL-3.0-or-later** | The current maintained fork is GPL. The older rhasspy/piper was MIT but is archived. A self-hosted server that is not distributed is fine under GPL; distributing it is not. Needs legal sign-off. |
| espeak-ng (phoneme step in both Piper and Kokoro) | GPL-3.0 | Same caution as above |
| Piper voice en_US-lessac-medium | Blizzard 2013 Lessac licence (link on model card) | Not read in full; confirm commercial use is allowed |
| Piper voice en_US-ryan-high | **CC BY-NC-SA 4.0** | **Non-commercial. Do not use in the game.** |
| Piper voice en_GB-northern_english_male-medium | CC BY-SA 4.0 (OpenSLR 83) | Commercial use allowed with attribution; share-alike applies |
| Piper voices en_GB-alan, en_US-amy | "See URL" (Mimic3 voices repo) | Licence not confirmed; treat as unknown |

None of the models tested are from the banned Llama, Mistral or Gemma families.

## Voice character (judgement, not an ear test)

Rating 1 to 5 for how well a voice could carry Pan's deadpan, fond, concerned delivery (spec §8).

| Voice | Character | Why |
|---|---|---|
| Kokoro bm_fable (British male) | 4 | Storyteller prosody; best fit for dry deadpan. Slower on CPU (0.57 s first sentence). |
| Kokoro af_heart (US female) | 4 | Warm, natural; the best-reviewed Kokoro voice; fastest Kokoro voice here (0.42 s). |
| Kokoro bm_george (British male) | 3 | Neutral-dry; 0.71 s first sentence. |
| Kokoro am_puck (US male) | 3 | Livelier, may be too bouncy for deadpan. |
| Kokoro af_bella | 3 | Warm, less distinct. |
| Piper en_GB-northern_english_male-medium | 3 | A regional accent gives instant personality and the licence is workable (attribution plus share-alike). Flatter prosody. |
| Piper en_GB-alan-medium | 2 | Clear, but flat and licence unconfirmed. |
| Piper en_US-lessac-medium | 2 | Clean, neutral, audiobook-like; licence needs a read. |
| Piper en_US-amy-medium | 2 | Neutral; licence unconfirmed. |
| Piper en_US-ryan-high | 3 | Best Piper quality but non-commercial; excluded. |

Kokoro can also blend voice style vectors, so a custom Pan voice (for example a blend of bm_fable and bm_george) is possible without training. Piper has fewer, flatter English voices and is the "fast and plain" option. Each of the five or so characters needs its own voice, and Kokoro's roster is far larger. Kokoro has no emotion control beyond punctuation and speed.

## Barge-in feasibility

Feasible, and cheap on the server. It is mostly a browser job:
- The browser VAD stays running while Pan speaks. On confirmed speech (about 150 to 250 ms of voice), it stops audio playback, aborts the in-flight OpenRouter stream, and cancels pending TTS. Cancelling work costs nothing on the server beyond dropping the queue.
- **Main risk is echo**: Pan's own voice from the speakers re-triggering the VAD in a kitchen without headphones. Mitigate with `getUserMedia({echoCancellation: true, noiseSuppression: true})`, a higher VAD threshold while Pan is speaking, and requiring a minimum speech duration. Hold-to-talk (the spec's default) avoids this entirely, so hands-free barge-in can ship after hold-to-talk.
- Not measured here, since it needs a browser and a real microphone.

## Recommended stack and hosting

1. **STT:** faster-whisper `base.en`, int8, beam 1, one thread per job, with an `initial_prompt` listing the player's pantry, saved ingredients and allergens. Use `tiny.en` if the tail latency is more important than accuracy (about 0.2 s faster, about 3 WER points worse unhinted). Use `small.en` only on GPU.
2. **LLM:** `qwen/qwen3.8-27b` with reasoning disabled, a prompt that makes the first sentence short (8 words or fewer), and flush-on-first-clause.
3. **TTS:** start with Piper for speed and cheapness; use the `northern_english_male` voice if the licence check passes. Keep Kokoro (bm_fable or af_heart, sentence-chunked) as the "good voice" path for the Pan once on GPU.
4. **Hosting:** phase 1 on one CPU box (CCX33, about 55 to 70 EUR estimated per month, 8 dedicated vCPU) as a stateless `voice` service. Add a GPU box (GEX44-class, estimated about 180 to 200 EUR per month) only when Kokoro or `small.en` is needed, or concurrency passes about 40.
5. **Safety:** keep §7.6. Because unhinted ingredient recognition is about half correct and spelled letters are weak, every allergen must be spelled out and shown on screen for a tap, never accepted from STT alone. Fuzzy-match transcripts against the ingredient database before use.

## Is 1.5 s achievable, and under what conditions?

Achievable at the **median** when all of these hold:
- tiny.en or base.en at beam 1, and Piper (not Kokoro) on CPU, or a GPU for anything heavier.
- LLM reasoning disabled and a short first sentence or clause.
- Browser VAD hangover at or under 300 ms, and speculative STT start.
- One STT job per core, with no more than 4 simultaneous utterance-ends per 4 vCPU.
- Network round trip from the player to the voice box under about 100 ms.

Not achievable at p90 (about 2.0 s CPU, 1.8 s GPU estimated), because the LLM first-sentence p90 alone is 1.13 s.

## Fallback if it isn't

In order of cost:
1. **Mask the latency:** play a short pre-rendered Pan filler ("Hm.", a pan sizzle) within about 0.3 s of end of speech while the real reply is generated, plus a "Pan is thinking" animation. This changes perceived latency without changing real latency.
2. **Prefer scripted lines** (spec §8): pre-rendered audio for common replies has zero STT/LLM/TTS delay, so only free-form turns go through the full pipeline.
3. **Relax the target** to "median under 1.5 s, p90 under 2.5 s" and tell Liz the tail is the LLM's.
4. **Move STT and TTS to a GPU box** (Kokoro plus `small.en`); the LLM stays on OpenRouter.
5. **Smaller or faster LLM** for voice turns only, if one with a better time to first token is available on OpenRouter.
6. **Qwen realtime omni on Alibaba Cloud** (better latency, natural turn-taking). This breaks the OpenRouter-only rule, so it needs Liz's decision (spec open question 5).
7. **Browser speech** as a development stand-in only.

## Open items

- Re-run the STT test on real recorded speech (several accents, real kitchen noise) before final model choice.
- A human should listen to `.../voice-spike/audio/pan_*.wav` to rate the voices.
- Legal check: Piper engine GPL-3.0, espeak-ng GPL-3.0, Lessac, Alan and Amy voice licences.
- Build a browser VAD + barge-in prototype and measure real hangover and echo behaviour.
- Try a streaming STT (sherpa-onnx) and a load test beyond 6 parallel jobs.
