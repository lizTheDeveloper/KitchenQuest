#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Kitchen Quest voice worker (M7 Step 3). The speech engines run in this process, behind the Node service's engine
# seam (apps/voice/src/engines/worker.ts). It is the GPL boundary (Ruling 14): espeak-ng and kokoro-onnx load here,
# Piper runs as a further separate `piper` process, and Node talks to this process over stdio only. It imports
# nothing from the Kitchen Quest repository.
#
# Copyright (C) 2026 Kitchen Quest contributors. This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3
# of the License, or (at your option) any later version. It is distributed WITHOUT ANY WARRANTY; see
# <https://www.gnu.org/licenses/>.
#
# Stdio framing, both directions: u32 BE header length, JSON header, u32 BE payload length, payload.
#   -> {op:'stt', id, sampleRate:16000, hint} + PCM16 LE    <- {op:'stt', id, text}
#   -> {op:'tts', id, voice, text}   <- {op:'pcm', id, sampleRate} + PCM16 LE (repeated)   <- {op:'done', id}
#   -> {op:'cancel', id}             a cancelled job ends with {op:'done', id}
#   -> {op:'ping'}                   <- {op:'pong', engines, sampleRate}   (sampleRate: the TTS rate, or null)
#   <- {op:'error', id, kind:'stt'|'tts'|'model'}   kind only; id is null for a model that failed to load
# Every job ends with exactly one terminal message: stt, done or error.
#
# C-18: audio is processed in memory and never stored.
# - This process writes no file. Models load once, offline (HF_HUB_OFFLINE=1), from --models-dir.
# - Each job's audio buffers are zeroed or dropped when the job ends.
# - File descriptors 1 and 2 point at /dev/null, so neither a library nor native code can print into the protocol
#   channel or the journal. The protocol uses a private duplicate of stdout. stderr carries only the fixed words in
#   FAULT_WORDS, through a private duplicate of fd 2, and the Node side only counts its bytes.
# - Python logging is at CRITICAL, warnings are ignored, and every exception hook prints a fixed word: no traceback,
#   message or value ever reaches any output. Core dumps are off (RLIMIT_CORE 0), as LimitCORE=0 is in the unit.
#
# Test triggers for the stdlib-only `echo` engine (B3): the hint word "__kq_crash__" makes the process exit mid-job,
# the hint word or text "__kq_hang__" never answers, "__kq_slow__" takes 0.4 s before its first answer, and the text
# "__kq_long__" streams 10 s of PCM.

import array
import json
import os
import struct
import sys
import threading
import time

FAULT_WORDS = ("args", "model", "crash", "protocol", "stt", "tts")
PCM_SCALE = 32768.0  # int16 -> float in [-1, 1): what faster-whisper is given
TTS_SCALE = 32767.0  # float in [-1, 1] -> int16: what kokoro's output is turned into
STT_RATE = 16000
ECHO_RATE = 22050
MAX_HEADER = 64 * 1024
MAX_PAYLOAD = 4 * 1024 * 1024
PROMPT = "Cooking assistant. Ingredients: "

_out_fd = -1
_err_fd = -1
_write_lock = threading.Lock()
_cancelled = set()
_cancel_lock = threading.Lock()


# --- output: the protocol channel and the fixed fault words -----------------------------------------------------------


def fault(word):
    """One fixed word on the real stderr. Never anything else."""
    if word not in FAULT_WORDS or _err_fd < 0:
        return
    try:
        os.write(_err_fd, ("kq-voice-worker: " + word + "\n").encode("ascii"))
    except OSError:
        pass


def _write_all(fd, data):
    view = memoryview(data)
    while len(view) > 0:
        n = os.write(fd, view)
        view = view[n:]


def send(header, payload=b""):
    head = json.dumps(header, separators=(",", ":")).encode("utf-8")
    frame = bytearray(struct.pack(">I", len(head)) + head + struct.pack(">I", len(payload)))
    frame += payload
    with _write_lock:
        try:
            _write_all(_out_fd, frame)
        except OSError:
            os._exit(0)  # the parent is gone
    frame[:] = bytes(len(frame))


def _seal_outputs():
    """fds 1 and 2 -> /dev/null; the protocol and the fault words get private duplicates first."""
    global _out_fd, _err_fd
    _out_fd = os.dup(1)
    _err_fd = os.dup(2)
    null = os.open(os.devnull, os.O_WRONLY)
    os.dup2(null, 1)
    os.dup2(null, 2)
    os.close(null)
    sys.stdout = open(os.devnull, "w")
    sys.stderr = open(os.devnull, "w")

    def hook(*_args, **_kwargs):
        fault("crash")

    sys.excepthook = hook
    threading.excepthook = hook
    sys.unraisablehook = hook
    import warnings

    warnings.simplefilter("ignore")
    import logging

    logging.getLogger().setLevel(logging.CRITICAL)
    logging.lastResort = None


def _no_core_dumps():
    try:
        import resource

        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    except Exception:
        pass


# --- input -------------------------------------------------------------------------------------------------------------


def _read_exact(stream, n):
    """A bytearray of exactly n bytes (so it can be zeroed), or None at end of input."""
    buf = bytearray(n)
    view = memoryview(buf)
    got = 0
    while got < n:
        k = stream.readinto(view[got:])
        if not k:
            return None
        got += k
    return buf


def read_frame(stream):
    raw = _read_exact(stream, 4)
    if raw is None:
        return None
    (hlen,) = struct.unpack(">I", raw)
    if hlen > MAX_HEADER:
        raise ValueError("header")
    head = _read_exact(stream, hlen)
    raw = _read_exact(stream, 4) if head is not None else None
    if raw is None:
        return None
    (plen,) = struct.unpack(">I", raw)
    if plen > MAX_PAYLOAD:
        raise ValueError("payload")
    payload = _read_exact(stream, plen)
    if payload is None:
        return None
    header = json.loads(bytes(head).decode("utf-8"))
    head[:] = bytes(len(head))
    if not isinstance(header, dict):
        raise ValueError("header")
    return header, payload


def is_cancelled(job_id):
    with _cancel_lock:
        return job_id in _cancelled


# --- conversions (the real adapter's; the Node leak detectors are built from PCM_SCALE) ------------------------------


def pcm16_samples(pcm):
    """PCM16 little-endian bytes -> an array('h') of samples."""
    samples = array.array("h")
    samples.frombytes(bytes(pcm))
    if sys.byteorder == "big":
        samples.byteswap()
    return samples


def pcm16_to_float(pcm):
    """PCM16 bytes -> float32 samples in [-1, 1), as faster-whisper takes them: x / PCM_SCALE."""
    samples = pcm16_samples(pcm)
    out = array.array("f", (s / PCM_SCALE for s in samples))
    for i in range(len(samples)):
        samples[i] = 0
    return out


def float_to_pcm16(samples):
    """Floats in [-1, 1] -> PCM16 little-endian bytes: clip, then x * TTS_SCALE."""
    out = array.array("h", (int(max(-1.0, min(1.0, s)) * TTS_SCALE) for s in samples))
    if sys.byteorder == "big":
        out.byteswap()
    return out.tobytes()


def zero(*buffers):
    for b in buffers:
        if isinstance(b, bytearray):
            b[:] = bytes(len(b))
        elif isinstance(b, array.array):
            for i in range(len(b)):
                b[i] = 0
        elif b is not None and hasattr(b, "fill"):
            b.fill(0)  # a numpy array


# --- engines -----------------------------------------------------------------------------------------------------------


class Echo:
    """Stdlib only (D4): runs as `python3 -I -S`. stt answers "echo <n samples>"; tts gives 50 ms of tone per word."""

    name = "echo"
    sample_rate = ECHO_RATE

    def __init__(self, leaks):
        self.leaks = leaks

    def stt(self, pcm, hint, job_id):
        if "__kq_crash__" in hint:
            fault("crash")
            os._exit(70)
        if "__kq_hang__" in hint:
            while True:
                time.sleep(3600)
        if "__kq_slow__" in hint:
            time.sleep(0.4)
        floats = pcm16_to_float(pcm)  # the conversion the whisper engine makes, so the leak controls are real
        n = len(floats)
        text = "echo " + str(n)
        if self.leaks:
            _leak(self.leaks, pcm, floats, hint, text)
        zero(floats)
        return text

    def tts(self, text, voice, job_id):
        if "__kq_hang__" in text:
            while True:
                time.sleep(3600)
        if "__kq_slow__" in text:
            time.sleep(0.4)  # a slow first piece, as Kokoro's single call is
        if "__kq_long__" in text:
            # 10 s of PCM in 100 ms pieces, paced at about 10x real time, so a cancel lands mid-stream.
            piece = self._tone(ECHO_RATE // 10, 0)
            for _ in range(100):
                if is_cancelled(job_id):
                    return
                yield piece
                time.sleep(0.01)
            return
        words = [w for w in text.split() if w]
        for k in range(len(words)):
            if is_cancelled(job_id):
                return
            yield self._tone(ECHO_RATE // 20, k)

    @staticmethod
    def _tone(n, k):
        import math

        out = array.array("h", (int(8000 * math.sin(2 * math.pi * 440 * (k * n + i) / ECHO_RATE)) for i in range(n)))
        if sys.byteorder == "big":
            out.byteswap()
        return out.tobytes()


def _leak(formats, pcm, floats, hint, text):
    """--leak-for-test (D1): the deliberate leaks the Node tests' positive controls must catch, one per format."""
    import base64
    import tempfile

    f32 = struct.pack("<%df" % min(16, len(floats)), *floats[:16])
    f64 = struct.pack("<%dd" % min(16, len(floats)), *floats[:16])
    out = {
        "text": "heard " + text + " hint " + " ".join(hint),
        "int16-hex": bytes(pcm[:32]).hex(),
        "float64-repr": repr([float(x) for x in floats[:4]]),
        "float32-str": " ".join("%.7g" % x for x in floats[:4]),
        "float32-hex": f32.hex(),
        "float32-b64": base64.b64encode(f32[1:]).decode("ascii"),
        "float64-hex": f64.hex(),
        "float64-b64": base64.b64encode(f64[3:]).decode("ascii"),
    }
    for fmt in formats:
        if fmt == "file":
            for d in (tempfile.gettempdir(), os.getcwd()):
                with open(os.path.join(d, "kq-leak.pcm"), "wb") as fh:
                    fh.write(bytes(pcm))
        elif fmt in out:
            os.write(_err_fd, (out[fmt] + "\n").encode("ascii", "replace"))


class Whisper:
    """faster-whisper, int8, beam 1, with the vocabulary hint as initial_prompt (Ruling 2). One thread per job."""

    name = "whisper"
    sample_rate = None

    def __init__(self, models_dir, model, threads):
        from faster_whisper import WhisperModel

        self.model = WhisperModel(
            os.path.join(models_dir, model),
            device="cpu",
            compute_type="int8",
            cpu_threads=threads,
            num_workers=1,
            local_files_only=True,
        )

    def stt(self, pcm, hint, job_id):
        import numpy as np

        audio = np.frombuffer(bytes(pcm), dtype="<i2").astype(np.float32) / np.float32(PCM_SCALE)
        try:
            segments, _info = self.model.transcribe(
                audio,
                beam_size=1,
                language="en",
                initial_prompt=PROMPT + ", ".join(hint),
                condition_on_previous_text=False,
                vad_filter=False,
            )
            parts = []
            for seg in segments:
                if is_cancelled(job_id):
                    return None
                parts.append(seg.text.strip())
            return " ".join(p for p in parts if p)
        finally:
            audio.fill(0)


class _MemFile:
    """
    An in-memory file (memfd) standing in for phonemizer's NamedTemporaryFile, into which espeak-ng writes each text's
    phonemes. On disk that file would hold the last phonemised line (the Pan's speech, which can read back the
    player's words) between calls; a memfd is never on disk. espeak opens it again by its /proc path.
    """

    def __init__(self):
        self.fd = os.memfd_create("kq-phonemes", 0)
        self.name = "/proc/self/fd/%d" % self.fd
        self.mode = "w+b"

    def truncate(self, n):
        os.ftruncate(self.fd, n)

    def seek(self, n):
        os.lseek(self.fd, n, os.SEEK_SET)

    def read(self):
        out = bytearray()
        while True:
            chunk = os.read(self.fd, 65536)
            if not chunk:
                return bytes(out)
            out += chunk

    def close(self):
        pass


PHONEMIZER_VERSION = "3.6.0"  # requirements.txt; the two patches below are written against it


def _phonemizer_in_memory():
    """
    phonemizer, as kokoro-onnx uses it, writes to disk twice: a copy of the espeak-ng library into a temporary
    directory (so that several copies can be loaded), and each phonemised text into a temporary file. This worker
    needs one copy only, so the library is loaded in place, and the text goes to a memfd. A phonemizer other than the
    pinned one is refused rather than patched blind.
    """
    import ctypes

    import phonemizer
    from phonemizer.backend.espeak import api, wrapper

    if getattr(phonemizer, "__version__", None) != PHONEMIZER_VERSION:
        raise ValueError("phonemizer")

    def init_in_place(self, library, data_path):
        self._library = None
        self._library = ctypes.cdll.LoadLibrary(str(library))
        version = self._version()
        if version < (1, 48):
            raise RuntimeError("espeak")
        if data_path is not None:
            data_path = self._data_path_argument(data_path, version, None)
        if self._library.espeak_Initialize(0x02, 0, data_path, 0) <= 0:
            raise RuntimeError("espeak")
        self._tempdir = None
        self._library_path = self._shared_library_path(self._library)

    def mem_tempfile(self):
        if getattr(self, "_kq_mem", None) is None:
            self._kq_mem = _MemFile()
        return self._kq_mem

    api.EspeakAPI.__init__ = init_in_place
    wrapper.EspeakWrapper._tempfile = property(mem_tempfile)


class Kokoro:
    """
    kokoro-onnx (Apache-2.0 weights; espeak-ng in this process). One chunk per call (the spike: no per-sentence
    stream). espeak-ng holds one language per process, so the worker serves the cast voice's language only.
    """

    name = "kokoro"
    sample_rate = 24000

    def __init__(self, models_dir, model, threads, voice):
        _phonemizer_in_memory()
        from kokoro_onnx import Kokoro as K

        base = os.path.join(models_dir, model)
        self.k = K(os.path.join(base, "kokoro-v1.0.onnx"), os.path.join(base, "voices-v1.0.bin"))
        if not voice:
            raise ValueError("voice")
        self.voice = voice
        self.lang = self._lang(voice)
        warm, _rate = self.k.create("Ready.", voice=voice, speed=1.0, lang=self.lang)
        zero(warm)

    @staticmethod
    def _lang(voice):
        return "en-gb" if voice.startswith("b") else "en-us"

    def tts(self, text, voice, job_id):
        if self._lang(voice) != self.lang:
            raise ValueError("voice")
        samples, rate = self.k.create(text, voice=voice, speed=1.0, lang=self.lang)
        try:
            if rate != self.sample_rate:
                raise ValueError("rate")
            if not is_cancelled(job_id):
                yield float_to_pcm16(samples)
        finally:
            zero(samples)


class Piper:
    """
    Piper as a further separate process (Ruling 14): `piper --output-raw`, one process per call, its end of output
    marking the end of the reply (the CLI has no delimiter between lines). Loading the voice costs about a second, so
    one spare process is started ahead, already loaded and waiting on its stdin, and the next spare is started as soon
    as a call takes it. A cancelled call's process is killed.
    """

    name = "piper"

    def __init__(self, models_dir, model, threads, piper_bin):
        base = os.path.join(models_dir, model)
        onnx = sorted(f for f in os.listdir(base) if f.endswith(".onnx"))
        if len(onnx) != 1:
            raise ValueError("model")
        self.model = os.path.join(base, onnx[0])
        with open(self.model + ".json", "rb") as fh:
            self.sample_rate = int(json.load(fh)["audio"]["sample_rate"])
        self.bin = piper_bin or os.path.join(os.path.dirname(sys.executable), "piper")
        if not os.path.exists(self.bin):
            raise ValueError("piper")
        self.cwd = base
        # Warm up before answering ping: one throwaway line through its own process (which also proves the binary
        # and the voice work), while the first spare loads alongside it.
        self.spare = self._start()
        warm = self._start()
        out, _ = warm.communicate(b"Ready.\n")
        if warm.returncode != 0 or len(out) == 0:
            raise ValueError("piper")
        out = None

    def _start(self):
        import subprocess

        # No HOME and no TMPDIR to write to, and onnxruntime's telemetry off (it writes a device id and a .ses file).
        env = {"PATH": os.environ.get("PATH", ""), "PYTHONDONTWRITEBYTECODE": "1", "HF_HUB_OFFLINE": "1", "OMP_NUM_THREADS": "1", "ORT_DISABLE_TELEMETRY": "1"}
        return subprocess.Popen(
            [self.bin, "--model", self.model, "--config", self.model + ".json", "--output-raw"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            cwd=self.cwd,
            env=env,
        )

    def _take(self):
        proc = self.spare
        if proc is None or proc.poll() is not None:
            proc = self._start()
        self.spare = self._start()
        return proc

    def tts(self, text, voice, job_id):
        proc = self._take()
        try:
            proc.stdin.write(text.replace("\n", " ").encode("utf-8") + b"\n")
            proc.stdin.close()
            carry = b""
            while True:
                if is_cancelled(job_id):
                    return
                chunk = proc.stdout.read1(8820)
                if not chunk:
                    break
                chunk = carry + chunk
                cut = len(chunk) - (len(chunk) % 2)
                carry = chunk[cut:]
                if cut > 0:
                    yield chunk[:cut]
            if proc.wait() != 0:
                raise ValueError("piper")
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()


# --- the job loop ------------------------------------------------------------------------------------------------------


def run_job(engine, header, payload):
    op = header.get("op")
    job_id = header.get("id")
    try:
        if is_cancelled(job_id):
            return send({"op": "done", "id": job_id})
        if op == "stt":
            hint = [w for w in header.get("hint", []) if isinstance(w, str)]
            if header.get("sampleRate") != STT_RATE or not hasattr(engine, "stt"):
                return send({"op": "error", "id": job_id, "kind": "stt"})
            text = engine.stt(payload, hint, job_id)
            hint[:] = []
            if text is None or is_cancelled(job_id):
                return send({"op": "done", "id": job_id})
            return send({"op": "stt", "id": job_id, "text": text})
        if op == "tts":
            text = header.get("text")
            voice = header.get("voice")
            if not isinstance(text, str) or not isinstance(voice, str) or not hasattr(engine, "tts"):
                return send({"op": "error", "id": job_id, "kind": "tts"})
            for pcm in engine.tts(text, voice, job_id):
                if is_cancelled(job_id):
                    break
                send({"op": "pcm", "id": job_id, "sampleRate": engine.sample_rate}, pcm)
            return send({"op": "done", "id": job_id})
        fault("protocol")
        return send({"op": "error", "id": job_id, "kind": "stt" if op == "stt" else "tts"})
    except Exception:
        # The exception is never looked at: its message may hold the transcript or the text.
        fault("stt" if op == "stt" else "tts")
        return send({"op": "error", "id": job_id, "kind": "stt" if op == "stt" else "tts"})
    finally:
        zero(payload)
        with _cancel_lock:
            _cancelled.discard(job_id)


def parse_args(argv):
    opts = {"engine": None, "model": "", "models_dir": "", "voice": "", "leaks": [], "piper": None, "threads": 1}
    i = 0
    while i < len(argv):
        flag = argv[i]
        val = argv[i + 1] if i + 1 < len(argv) else None
        if val is None:
            raise ValueError("args")
        if flag == "--engine":
            opts["engine"] = val
        elif flag == "--model":
            opts["model"] = val
        elif flag == "--models-dir":
            opts["models_dir"] = val
        elif flag == "--voice":
            opts["voice"] = val
        elif flag == "--leak-for-test":
            opts["leaks"].append(val)
        elif flag == "--piper":
            opts["piper"] = val
        elif flag == "--threads":
            opts["threads"] = int(val)
        else:
            raise ValueError("args")
        i += 2
    if opts["engine"] not in ("echo", "whisper", "kokoro", "piper"):
        raise ValueError("args")
    return opts


def load(opts):
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["ORT_DISABLE_TELEMETRY"] = "1"  # onnxruntime 1.31 otherwise writes a device id and a .ses file
    os.environ.setdefault("OMP_NUM_THREADS", str(opts["threads"]))
    engine = opts["engine"]
    if engine == "echo":
        return Echo(opts["leaks"])
    if engine == "whisper":
        return Whisper(opts["models_dir"], opts["model"], opts["threads"])
    if engine == "kokoro":
        return Kokoro(opts["models_dir"], opts["model"], opts["threads"], opts["voice"])
    return Piper(opts["models_dir"], opts["model"], opts["threads"], opts["piper"])


def main():
    _no_core_dumps()
    _seal_outputs()
    try:
        opts = parse_args(sys.argv[1:])
    except Exception:
        fault("args")
        os._exit(2)
    try:
        engine = load(opts)
    except Exception:
        fault("model")
        send({"op": "error", "id": None, "kind": "model"})
        os._exit(1)

    jobs = []
    ready = threading.Condition()
    stdin = sys.stdin.buffer

    def reader():
        while True:
            try:
                frame = read_frame(stdin)
            except Exception:
                fault("protocol")
                os._exit(3)
            if frame is None:
                os._exit(0)  # the parent closed stdin: stop at once, mid-job included
            header, payload = frame
            op = header.get("op")
            if op == "ping":
                send({"op": "pong", "engines": [engine.name], "sampleRate": getattr(engine, "sample_rate", None)})
            elif op == "cancel":
                with _cancel_lock:
                    _cancelled.add(header.get("id"))
            elif op in ("stt", "tts"):
                with ready:
                    jobs.append((header, payload))
                    ready.notify()
            else:
                fault("protocol")
                os._exit(3)

    threading.Thread(target=reader, daemon=True).start()
    while True:
        with ready:
            while not jobs:
                ready.wait()
            header, payload = jobs.pop(0)
        run_job(engine, header, payload)


if __name__ == "__main__":
    main()
