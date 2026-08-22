from __future__ import annotations

import hashlib
import inspect
import json
import os
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any

import numpy as np
import perth
import torch
from chatterbox.mtl_tts import ChatterboxMultilingualTTS

HOST = os.getenv("LUMA_TTS_HOST", "127.0.0.1")
PORT = int(os.getenv("LUMA_TTS_PORT", "8790"))
CACHE_DIR = Path(os.getenv("LUMA_TTS_CACHE_DIR", str(Path.cwd() / "data" / "narration"))).resolve()
MAX_TEXT_CHARS = int(os.getenv("LUMA_TTS_MAX_TEXT_CHARS", "700"))
MODEL_VARIANT = os.getenv("LUMA_TTS_MODEL", "v3")
LANGUAGE_ID = os.getenv("LUMA_TTS_LANGUAGE", "es")

DEFAULT_EXAGGERATION = 0.45
DEFAULT_CFG_WEIGHT = 0.45
DEFAULT_TEMPERATURE = 0.8

CACHE_DIR.mkdir(parents=True, exist_ok=True)


def _package_version(name: str) -> str:
    try:
        return version(name)
    except PackageNotFoundError:
        return "unknown"


CHATTERBOX_VERSION = _package_version("chatterbox-tts")
SETUPTOOLS_VERSION = _package_version("setuptools")
PERTH_VERSION = _package_version("resemble-perth")


def _supports_model_variant() -> bool:
    """Return whether this installed Chatterbox build accepts t3_model."""
    try:
        return "t3_model" in inspect.signature(ChatterboxMultilingualTTS.from_pretrained).parameters
    except (TypeError, ValueError):
        return False


SUPPORTS_MODEL_VARIANT = _supports_model_variant()


def _perth_watermarker_available() -> bool:
    return callable(getattr(perth, "PerthImplicitWatermarker", None))


def _require_perth_watermarker() -> None:
    if _perth_watermarker_available():
        return
    raise RuntimeError(
        "Perth no pudo cargar PerthImplicitWatermarker. En Chatterbox 0.1.x esto suele ocurrir "
        "cuando setuptools 81+ elimina pkg_resources. Con el entorno .venv-tts activo ejecuta: "
        "python -m pip install --force-reinstall setuptools==80.9.0 y vuelve a iniciar la prueba. "
        f"Versiones detectadas: setuptools={SETUPTOOLS_VERSION}, resemble-perth={PERTH_VERSION}."
    )


def _json_bytes(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


def _clamp(value: Any, minimum: float, maximum: float, fallback: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return max(minimum, min(maximum, number))


def _write_wav(path: Path, waveform: torch.Tensor, sample_rate: int) -> float:
    audio = waveform.detach().float().cpu().squeeze().numpy()
    if audio.ndim != 1:
        audio = audio.reshape(-1)
    audio = np.nan_to_num(audio, nan=0.0, posinf=0.0, neginf=0.0)
    audio = np.clip(audio, -1.0, 1.0)
    pcm = (audio * 32767.0).astype(np.int16)

    temporary = path.with_suffix(".tmp.wav")
    with wave.open(str(temporary), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm.tobytes())
    os.replace(temporary, path)
    return len(pcm) / float(sample_rate)


class Narrator:
    def __init__(self) -> None:
        self._model: ChatterboxMultilingualTTS | None = None
        self._model_lock = threading.Lock()
        self._generation_lock = threading.Lock()
        self._loaded_at: float | None = None
        self._resolved_model = MODEL_VARIANT if SUPPORTS_MODEL_VARIANT else "installed-default"

    @property
    def loaded(self) -> bool:
        return self._model is not None

    def status(self) -> dict[str, Any]:
        return {
            "ok": True,
            "modelLoaded": self.loaded,
            "model": f"chatterbox-multilingual-{self._resolved_model}",
            "requestedModel": MODEL_VARIANT,
            "supportsModelVariant": SUPPORTS_MODEL_VARIANT,
            "chatterboxVersion": CHATTERBOX_VERSION,
            "setuptoolsVersion": SETUPTOOLS_VERSION,
            "perthVersion": PERTH_VERSION,
            "perthWatermarkerAvailable": _perth_watermarker_available(),
            "language": LANGUAGE_ID,
            "cudaAvailable": torch.cuda.is_available(),
            "torch": torch.__version__,
            "cudaRuntime": torch.version.cuda,
            "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
            "cacheDir": str(CACHE_DIR),
            "loadedAt": self._loaded_at,
        }

    def _get_model(self) -> ChatterboxMultilingualTTS:
        if self._model is not None:
            return self._model

        with self._model_lock:
            if self._model is not None:
                return self._model
            if not torch.cuda.is_available():
                raise RuntimeError("CUDA no está disponible para el narrador local de Luma.")

            _require_perth_watermarker()

            print(
                f"[luma-tts] Chatterbox {CHATTERBOX_VERSION} · CUDA · RTX · "
                f"modelo solicitado: {MODEL_VARIANT}",
                flush=True,
            )
            started = time.perf_counter()

            if SUPPORTS_MODEL_VARIANT:
                print(f"[luma-tts] Cargando Chatterbox Multilingual {MODEL_VARIANT}...", flush=True)
                self._model = ChatterboxMultilingualTTS.from_pretrained(
                    device="cuda",
                    t3_model=MODEL_VARIANT,
                )
                self._resolved_model = MODEL_VARIANT
            else:
                # Older PyPI builds expose only from_pretrained(device). They
                # still provide the multilingual model, but do not allow V2/V3
                # checkpoint selection. Use that build's default checkpoint
                # instead of failing with an unexpected keyword argument.
                print(
                    "[luma-tts] Esta versión no permite seleccionar t3_model; "
                    "cargando su checkpoint multilingüe predeterminado.",
                    flush=True,
                )
                self._model = ChatterboxMultilingualTTS.from_pretrained(device="cuda")
                self._resolved_model = "installed-default"

            self._loaded_at = time.time()
            elapsed = time.perf_counter() - started
            print(
                f"[luma-tts] Modelo listo en {elapsed:.1f}s · "
                f"resuelto: {self._resolved_model}.",
                flush=True,
            )
            return self._model

    def synthesize(
        self,
        text: str,
        exaggeration: float = DEFAULT_EXAGGERATION,
        cfg_weight: float = DEFAULT_CFG_WEIGHT,
        temperature: float = DEFAULT_TEMPERATURE,
    ) -> tuple[Path, bool, float]:
        normalized = " ".join(text.split()).strip()
        if not normalized:
            raise ValueError("El texto de narración está vacío.")
        if len(normalized) > MAX_TEXT_CHARS:
            raise ValueError(f"El fragmento supera el máximo de {MAX_TEXT_CHARS} caracteres.")

        exaggeration = _clamp(exaggeration, 0.25, 1.2, DEFAULT_EXAGGERATION)
        cfg_weight = _clamp(cfg_weight, 0.2, 1.0, DEFAULT_CFG_WEIGHT)
        temperature = _clamp(temperature, 0.1, 1.5, DEFAULT_TEMPERATURE)

        # Include both package/API capability and requested model in the cache
        # identity. If Chatterbox is upgraded later and V3 becomes selectable,
        # Luma will generate fresh audio rather than reuse legacy checkpoint WAVs.
        identity = {
            "engine": "chatterbox",
            "chatterboxVersion": CHATTERBOX_VERSION,
            "supportsModelVariant": SUPPORTS_MODEL_VARIANT,
            "requestedModel": MODEL_VARIANT,
            "resolvedModel": MODEL_VARIANT if SUPPORTS_MODEL_VARIANT else "installed-default",
            "language": LANGUAGE_ID,
            "text": normalized,
            "exaggeration": round(exaggeration, 3),
            "cfgWeight": round(cfg_weight, 3),
            "temperature": round(temperature, 3),
        }
        key = hashlib.sha256(json.dumps(identity, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
        output = CACHE_DIR / f"{key}.wav"
        if output.exists() and output.stat().st_size > 44:
            return output, True, _wav_duration(output)

        with self._generation_lock:
            if output.exists() and output.stat().st_size > 44:
                return output, True, _wav_duration(output)

            model = self._get_model()
            print(f"[luma-tts] Generando {len(normalized)} caracteres...", flush=True)
            started = time.perf_counter()
            waveform = model.generate(
                normalized,
                language_id=LANGUAGE_ID,
                exaggeration=exaggeration,
                cfg_weight=cfg_weight,
                temperature=temperature,
            )
            duration = _write_wav(output, waveform, model.sr)
            elapsed = time.perf_counter() - started
            print(f"[luma-tts] Audio {duration:.2f}s generado en {elapsed:.2f}s.", flush=True)
            return output, False, duration


def _wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as wav_file:
        rate = wav_file.getframerate()
        frames = wav_file.getnframes()
    return frames / float(rate) if rate else 0.0


NARRATOR = Narrator()


class Handler(BaseHTTPRequestHandler):
    server_version = "LumaTTS/0.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[luma-tts] {self.address_string()} - {fmt % args}", flush=True)

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = _json_bytes(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._send_json(200, NARRATOR.status())
            return
        self._send_json(404, {"error": "Ruta no encontrada."})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/synthesize":
            self._send_json(404, {"error": "Ruta no encontrada."})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 128 * 1024:
                raise ValueError("Payload inválido o demasiado grande.")
            raw = self.rfile.read(length)
            payload = json.loads(raw.decode("utf-8"))
            text = str(payload.get("text", ""))
            audio_path, cache_hit, duration = NARRATOR.synthesize(
                text=text,
                exaggeration=payload.get("exaggeration", DEFAULT_EXAGGERATION),
                cfg_weight=payload.get("cfgWeight", DEFAULT_CFG_WEIGHT),
                temperature=payload.get("temperature", DEFAULT_TEMPERATURE),
            )
            audio = audio_path.read_bytes()

            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(audio)))
            self.send_header("Cache-Control", "private, max-age=31536000, immutable")
            self.send_header("X-Luma-TTS-Cache", "hit" if cache_hit else "miss")
            self.send_header("X-Luma-TTS-Duration", f"{duration:.3f}")
            self.end_headers()
            self.wfile.write(audio)
        except ValueError as exc:
            self._send_json(400, {"error": str(exc)})
        except Exception as exc:  # keep service alive and expose a useful local error
            print(f"[luma-tts] ERROR: {exc}", flush=True)
            self._send_json(500, {"error": str(exc)})


def main() -> None:
    print(f"[luma-tts] http://{HOST}:{PORT}", flush=True)
    print(f"[luma-tts] Cache: {CACHE_DIR}", flush=True)
    print(
        f"[luma-tts] Chatterbox: {CHATTERBOX_VERSION} · "
        f"selección de modelo: {'sí' if SUPPORTS_MODEL_VARIANT else 'no'}",
        flush=True,
    )
    print(
        f"[luma-tts] Perth: {PERTH_VERSION} · watermark: "
        f"{'sí' if _perth_watermarker_available() else 'no'} · setuptools: {SETUPTOOLS_VERSION}",
        flush=True,
    )
    print(f"[luma-tts] CUDA: {torch.cuda.is_available()} · {torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'No disponible'}", flush=True)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
