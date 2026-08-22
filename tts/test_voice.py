from __future__ import annotations

import argparse
from pathlib import Path

from service import NARRATOR

DEFAULT_TEXT = (
    "Kael se quedó inmóvil frente a la puerta. Durante un instante, nadie dijo nada. "
    "El aire parecía más frío allí, como si el corredor hubiese estado esperando ese momento durante años. "
    "Entonces apoyó la mano sobre el metal y escuchó, al otro lado, algo parecido a una respiración."
)


def main() -> None:
    parser = argparse.ArgumentParser(description="Prueba local del narrador IA de Luma.")
    parser.add_argument("--text", default=DEFAULT_TEXT, help="Texto que se sintetizará.")
    parser.add_argument("--output", default="data/narration-test.wav", help="Ruta WAV de salida.")
    parser.add_argument(
        "--voice",
        default=None,
        help="Archivo de referencia de voz (recomendado WAV limpio). Si se omite, usa la voz integrada.",
    )
    parser.add_argument("--exaggeration", type=float, default=0.45)
    parser.add_argument("--cfg-weight", type=float, default=0.45)
    parser.add_argument("--temperature", type=float, default=0.8)
    args = parser.parse_args()

    voice = Path(args.voice).expanduser().resolve() if args.voice else None

    audio_path, cache_hit, duration = NARRATOR.synthesize(
        args.text,
        exaggeration=args.exaggeration,
        cfg_weight=args.cfg_weight,
        temperature=args.temperature,
        audio_prompt_path=voice,
    )

    destination = Path(args.output).resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(audio_path.read_bytes())

    print()
    print("Prueba de narración terminada.")
    print(f"Voz: {voice if voice else 'integrada de Chatterbox'}")
    print(f"Archivo: {destination}")
    print(f"Duración: {duration:.2f}s")
    print(f"Caché: {'sí' if cache_hit else 'no (primera generación)'}")


if __name__ == "__main__":
    main()
