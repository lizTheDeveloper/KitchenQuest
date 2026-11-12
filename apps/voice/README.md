# apps/voice — the Kitchen Quest voice service

A private WebSocket service that turns the player's speech into text and the Pan's lines into speech (spec §7.7, M7).
Only the API connects to it, with a shared bearer token. It knows no user (C-15), keeps no audio and logs only numbers
and enums (C-18). The protocol is core's `voice/upstream.ts`.

```
API ──ws──▶ apps/voice (Node: server.ts, session.ts)
                │ stdio, framed (src/engines/worker.ts)
                ├──▶ STT workers: kq_voice_worker.py --engine whisper   (faster-whisper, int8, beam 1)
                └──▶ TTS workers: kq_voice_worker.py --engine piper     ──▶ `piper --output-raw` processes
                                                      or --engine kokoro (kokoro-onnx + espeak-ng, in the worker)
```

The worker (`worker/kq_voice_worker.py`) is GPL-3.0-or-later and is the GPL boundary (Ruling 14): Node talks to it over
stdio only, and nothing GPL is linked into Node, the API or the game. Every model it may load is in
`data/voice-models.json` with its licence and its sha256 pins; `ryan-high` is excluded and refused.

## Running

| What | How |
|---|---|
| Fake engines (no Python, no models) | `VOICE_ENGINE=fake VOICE_SERVICE_TOKEN=dev npm run dev -w @kitchenquest/voice` |
| The echo worker (Python stdlib only, no models) | `VOICE_ENGINE=worker VOICE_WORKER_ENGINE=echo VOICE_SERVICE_TOKEN=dev npm run dev -w @kitchenquest/voice` |
| Real engines | install the worker venv and fetch the models (below), then `VOICE_ENGINE=worker VOICE_PYTHON=<venv>/bin/python VOICE_SERVICE_TOKEN=dev npm run dev -w @kitchenquest/voice` |
| Tests | `npm test -w @kitchenquest/voice` (fake engines and the echo worker as `python3 -I -S`; needs `python3`, never a model) |

Every variable is in the `# Voice service (apps/voice)` block of `.env.example`. With real engines, a development boot
also verifies the models' sha256 pins; only production runs the latency gate.

### The worker

- **Framing**, both directions: u32 BE header length, JSON header, u32 BE payload length, payload. The messages are in
  the worker's header comment.
- **Processes**: `VOICE_WORKERS` processes per engine (STT and TTS each; default one per CPU), each one job at a time.
  The spike measured about one core-second of STT per utterance, so one job per core is the right shape.
- **Deadlines** (F5), all counted from submission, queue time included: an STT request has 20 s to answer; a TTS
  stream 30 s to its first message (Kokoro sends a whole chunk at once), then 10 s between messages. A job still queued
  at its deadline fails and never reaches a worker; a worker still holding one is killed and replaced, as is one that
  crashes, so a hung engine answers `failed` and never hangs an utterance. Step 5's own per-id reply timeout should
  allow at least these.
- **Restarts and readiness**: each worker slot is kept filled forever. A worker that dies, cannot be spawned (a venv
  rebuilt mid-deploy, fork pressure) or fails to load is retried with backoff (0.1 s doubling to 2 s), each failure a
  content-free `worker_down` log line; a replacement re-verifies the model's pins first. When a pool has no ready
  worker it logs `pool_empty` and fails utterances at once (not at their deadline) until a worker is back
  (`pool_ready`). `GET /ready` answers 200 while every pool has a ready worker and 503 otherwise (no body, no auth):
  point the API's health check or a systemd timer at it. At boot each worker gets 5 attempts; if none of a pool's
  workers starts, boot fails and the process exits 1, so systemd restarts it.
- **Output**: fds 1 and 2 of the worker point at `/dev/null`. The protocol uses a private copy of stdout, and stderr
  carries only fixed words (`kq-voice-worker: crash`, …) through a private copy of fd 2. Node counts stderr bytes and
  never reads them. Python logging is at CRITICAL, warnings are ignored, and tracebacks never print.
- **No files**: the worker's `HOME` is a path that does not exist, so a library writing under it fails rather than
  writes; models load offline (`HF_HUB_OFFLINE=1`), `-B` stops `.pyc` writes, `ORT_DISABLE_TELEMETRY=1` stops
  onnxruntime 1.31 writing a device id under `HOME` and a `.ses` file in `TMPDIR`, and each job's buffers are zeroed or
  dropped when it ends. Kokoro: phonemizer would copy the espeak-ng library into a temporary directory and write each
  phonemised line to a temporary file (the Pan's text, which can read back the player's words). The worker loads the
  library in place and gives espeak an in-memory file (`memfd`) instead. The patch is written against phonemizer
  3.6.0, and the worker refuses any other version.
- **Piper**: one `piper --output-raw` process per call, because its output has no delimiter between lines, so the end
  of output is the end of the reply. Loading the voice takes about a second, so one spare process is started ahead,
  loaded and waiting, and the worker warms up before it answers `ping`. Measured end to end: first audio about 0.1 s
  when the spare is ready (against 1.4 to 2.4 s without the spare).
- **Kokoro** synthesises one chunk per call (the spike: `create_stream` does not yield per sentence). espeak-ng holds
  one language per process, so a Kokoro worker serves its cast voice's language (`bm_*` en-gb, others en-us).

## Deploying

1. **A system user** `kq-voice`, and the repo at `/opt/kitchenquest` (owned by root, read-only to the service).
2. **The worker venv** (Python 3.13):
   ```sh
   python3.13 -m venv /opt/kitchenquest/voice-venv
   /opt/kitchenquest/voice-venv/bin/pip install --require-virtualenv -r apps/voice/worker/requirements.txt
   ```
3. **The models**, from the pinned revisions in `data/voice-models.json`, into `VOICE_MODELS_DIR` (never committed:
   `apps/voice/models/` is in `.gitignore`). This prints one `curl` per pinned file, from the repo root:
   ```sh
   export VOICE_MODELS_DIR=/opt/kitchenquest/apps/voice/models
   node -e '
   const m = require("./data/voice-models.json");
   for (const x of m.models) if (x.fetch) for (const f of x.files) {
     const src = [x.fetch.from, f.path.slice(x.id.length + 1)].filter(Boolean).join("/");
     console.log(`curl -fL --create-dirs -o "$VOICE_MODELS_DIR/${f.path}" https://huggingface.co/${x.fetch.repo}/resolve/${x.fetch.revision}/${src}`);
   }' | sh
   ```
   Fetch only the cast you run if you like (base.en and Piper on CPU; Kokoro on GPU). The service verifies every pinned
   file of the configured STT and TTS models at boot (and again before replacing a worker), and refuses to start on a
   missing or changed one, or on any file in a model's directory that is not pinned: put nothing else there.
4. **The secrets and box settings** in `/etc/kitchenquest/voice.env` (root-owned, mode 0600):
   ```sh
   VOICE_SERVICE_TOKEN=<openssl rand -base64 32; the same value the API has>
   VOICE_PYTHON=/opt/kitchenquest/voice-venv/bin/python
   VOICE_MODELS_DIR=/opt/kitchenquest/apps/voice/models
   # VOICE_HOST=10.0.0.2   only when the API runs on another box: this box's private interface address
   # VOICE_WORKERS=4
   ```
5. **The unit**: copy `apps/voice/deploy/kq-voice.service` to `/etc/systemd/system/`, then
   `systemctl daemon-reload && systemctl enable --now kq-voice`. It runs `node --disable-warning=ExperimentalWarning
   --import tsx src/main.ts` with `TSX_DISABLE_CACHE=1` (tsx would otherwise write its compile cache to `/tmp`), the
   same command as `npm start`. `NODE_ENV=production`, the real worker engine, offline models, onnxruntime telemetry
   off and the cache setting are on the `ExecStart` line itself, so nothing in `voice.env` can switch them off.
   The unit allows IP to loopback only. When the API runs on another box, add a drop-in allowing its private address
   (`systemctl edit kq-voice`):
   ```ini
   [Service]
   IPAddressAllow=10.0.0.3
   ```
6. **The benchmark** (next section) must have passed on this box, and its `bench/latest.json` been committed, or the
   service refuses to start.

### Host hardening (C-18, C-38, Review Focus 2)

- **Swap off** on the voice host and on the API host (`swapoff -a`, and remove swap from `/etc/fstab`). The unit also
  sets `MemorySwapMax=0`.
- **No core dumps.** `LimitCORE=0` is in `kq-voice.service` (and the worker sets `RLIMIT_CORE` to 0 itself). **Manual
  duty:** put `LimitCORE=0` in the API's unit too (B3). There is no API unit in the repo yet, so this is on the operator.
- **`kernel.core_pattern=|/bin/false`** in `/etc/sysctl.d/50-kitchenquest.conf` on both hosts, so no core reaches a
  disk even from a process outside these units.
- **Private interface only** (C-38): the service binds `VOICE_HOST`, loopback by default. Config refuses `0.0.0.0`,
  `::`, a public address and a hostname. When the API runs on another box, set `VOICE_HOST` to the private interface
  address, and firewall `VOICE_PORT` to the API host alone.
- **Firewall `VOICE_PORT` to the API host alone; this is required, not optional.** Any host that can reach the port can
  hold its 64 pre-upgrade slots open in 2 s rounds and starve the API's upgrades.
- The unit also gives the service a read-only filesystem except a private `/tmp` (`ProtectSystem=strict`,
  `ProtectHome=yes`, `PrivateTmp=yes`; nothing else made writable), no devices (so no microphone), no new privileges,
  IP to loopback only (plus the API's drop-in), a `@system-service` syscall filter, no namespaces and no realtime.

### Limits the service enforces

- HTTP: headers within 2 s, the whole request within 3 s, at most 64 sockets waiting before their upgrade (one more is
  destroyed unread), 8 KB of headers. Origin header: 403. Bad token: 401. Over `VOICE_MAX_CONNECTIONS`: 503.
  `GET /ready`: 200 or 503 (above). Anything else: 426.
- WebSocket: a socket that sends nothing within 5 s, or nothing either way for 11 minutes, is closed with **4408**
  (longer than core's `HANDS_FREE_IDLE_MS`, so a quiet hands-free cook is not cut off; the API reconnects). Other close
  codes: 4400 (a message the protocol refuses), 1011 (a handler error, or a client too slow to read), 1001 (shutdown).

## Benchmarking

The operator benchmark (spec §12) measures the configured stack on the target box. It never runs in CI.

```sh
BENCH_API_COOKIE='<the synthetic player session cookie>' BENCH_ORIGIN='https://<app origin>' \
  npm run bench -w @kitchenquest/voice -- --api https://<api host> --box ccx33-fsn1 \
  --cpu 'AMD EPYC 9454P, 8 dedicated vCPU' --llm qwen/qwen3.8-27b --providers tenstorrent
```

It needs the API running with AI on, a throwaway database and a synthetic player, and this service running with real
engines (it reads the same `VOICE_*` variables). It cannot run before the API's voice route and transcript turn exist
(M7 Steps 5 and 6). Step 7 adds `--selftest` against fake engines.

1. **Utterances**: the spike's ten cooking phrases and ten short openers, spoken by the configured voice, resampled to
   16 kHz, each mixed clean, at 15 dB and at 5 dB of kitchen-like noise (the spike's recipe, seeded). Or `--recordings`.
2. **WER**: each utterance is transcribed by this service directly, with the vocabulary hint and without.
3. **The round**, through the API as a device: the audio streamed at real time, `end`, the transcript turn (its heard
   card confirmed, so the turn proceeds), then the reply spoken. If the reply is not back 600 ms (`FILLER_AFTER_MS`)
   after the end of speech, the filler line is spoken first, as the device does.
4. **Output**: `bench/results/<date>-<box>.json`, copied to `bench/latest.json`. Commit both.

The first run measures the CPU default cast (base.en with Piper `northern_english_male`, C1), which the spike never
measured; run it again with `VOICE_STT_MODEL=faster-whisper-tiny.en` to compare tiny and base. Report the numbers to the
founder.

### The results file

`bench/latest.json` is what production boots against (Ruling 3). `bench/schema.ts` parses every committed result
strictly (a test checks them all), and recomputes `meetsTarget`, so a hand-edited pass is refused.

| Field | Meaning |
|---|---|
| `date` | The run's date, `YYYY-MM-DD`. With `box` and a hash of the run it makes the run id `VOICE_ACCEPT_LATENCY_MISS` names. |
| `box` | The box's name (lowercase, digits, hyphens); it names the results file. |
| `cpu`, `gpu` | The hardware, as text; `gpu` is `null` on a CPU box. |
| `stack.stt`, `stack.tts`, `stack.voice` | The model ids and voice measured. The gate refuses a run of another stack than the service is configured with. |
| `stack.llm`, `stack.providers` | The model and OpenRouter providers the API used (recorded, not gated). |
| `utterances.source` | `synthetic` or `recorded`. |
| `utterances.n` | How many utterances were measured. |
| `utterances.noise` | The noise levels used: `clean`, `15dB`, `5dB`. |
| `utterances.consentRecord` | For a recorded run, the written consent record it relied on (required); otherwise `null`. |
| `ms.firstAudio` | End of speech → the first audio of any kind (the filler line or the reply): p50, p90, p95. |
| `ms.replyAudio` | End of speech → the first audio of the reply. **The gated number.** |
| `ms.stt` | End of speech → the transcript. |
| `ms.turn` | Transcript → the turn's answer (the heard card's confirmation included). |
| `ms.ttsFirst` | The reply's `speak` → its first audio frame. |
| `wer.hinted`, `wer.unhinted` | Corpus word error rate, with and without the vocabulary hint, with the spike's normalisation. |
| `termRecall.hinted`, `termRecall.unhinted` | The share of the hard terms (gochujang, epazote, tamari, kiwi, halloumi, shallots) heard exactly. |
| `meetsTarget` | `replyAudio.p50 ≤ 1500 && replyAudio.p90 ≤ 2500`. Recomputed on parse; a mismatch is refused. |
| `manual` | Optional: the browser echo/barge-in checklist below, one entry per browser (`--manual chromium:pass,safari:pass,firefox:fail`). |

Percentiles are nearest-rank (`bench/stats.ts`).

### Recordings (`--recordings <dir> --consent <record>`, C8)

Only volunteers' speech, never a player's, and only with a written consent record, named by `--consent` and recorded
in `consentRecord`. Each `<name>.wav` (16 kHz, mono, 16-bit PCM) needs a `<name>.txt` holding what was said. The files
are read in place, never copied into `results/` or anywhere else (`apps/voice/bench/audio/` is in `.gitignore` in case
they are kept there), and deleted after the run.

### Reading a miss

Production refuses to start on a miss (Ruling 3). The founder reads it, then either sets `VOICE_ACCEPT_LATENCY_MISS` to
the run id the refusal prints (`<date>-<box>-<8 hex>`: a hash of that exact run, so an acceptance never carries over to
a rerun committed with the same date and box), or a change is made and the benchmark run again.

What the gate does not check: that `box` is this host, how old the run is, and the LLM or providers (`replyAudio`
includes the LLM turn, so a model or provider change means running the benchmark again). Re-run it after any change to
the box, the stack or the API's model routing.

The spike's fallbacks, in order of cost:

1. **Mask the latency**: the filler line within about 0.3 s of the end of speech (`firstAudio` shows whether it lands).
2. **Prefer scripted lines**: pre-rendered audio for common replies has no STT, LLM or TTS delay.
3. **Relax the target**: the target is already "p50 under 1.5 s, p90 under 2.5 s"; the tail is the LLM's.
4. **A cheaper STT**: `tiny.en` (about 0.2 s faster than base.en, about 3 WER points worse unhinted).
5. **A GPU box** for STT and TTS (Kokoro plus `small.en`); the LLM stays on OpenRouter.
6. **A faster LLM** for voice turns only, if OpenRouter has one with a better time to first token.
7. **Qwen realtime on Alibaba Cloud**: breaks the OpenRouter-only rule, so it is the founder's decision.
8. **Browser speech**: a development stand-in only (Ruling 1).

## The browser echo/barge-in checklist (Ruling 7)

Hands-free mode ships only when `bench/latest.json` records this checklist passing in all three browsers (the
`kqHandsFree` build plugin refuses `VITE_HANDS_FREE=on` otherwise). Run it on a laptop's **speakers, no headphones**,
in a kitchen-like room, in **Chromium, Safari and Firefox**:

1. Start cook mode with hands-free on. Ask a question that gets a long spoken reply.
2. While the Pan speaks, stay silent for its whole reply: it must finish uninterrupted (its own voice through the
   speakers never triggers barge-in).
3. Play a cook timer's alarm while the Pan speaks: no barge-in.
4. Ask again, and say "stop" over the reply: playback stops within about a quarter of a second, and the reply stays on
   screen.
5. Talk over the reply with a short word (under `BARGE_IN_MIN_MS`, e.g. "uh"): no barge-in.

Record each browser as `{ "browser": "chromium" | "safari" | "firefox", "echoBargeInPass": true | false }` in the run's
`manual` list (`--manual`, or edit the result and re-check it with `npm test -w @kitchenquest/voice`).
