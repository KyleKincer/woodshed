from __future__ import annotations
import pathlib
def detect(wav_path: pathlib.Path) -> list[list[float]]:
    """Return [[time, beatInBar], ...] — beatInBar == 1 marks a downbeat.

    This pair shape is what the player's `Metronome.setDetected` already
    parses, so the detector stays a drop-in replacement for the local one.
    """
    import sys
    import types

    # BeatNet imports pyaudio unconditionally for its microphone/streaming
    # modes, which the offline path never touches. Stubbing it avoids pulling
    # portaudio into the image.
    sys.modules.setdefault("pyaudio", types.ModuleType("pyaudio"))

    from BeatNet.BeatNet import BeatNet

    estimator = BeatNet(1, mode="offline", inference_model="DBN", plot=[], thread=False)
    output = estimator.process(str(wav_path))
    return [[round(float(t), 4), int(k)] for t, k in output]
