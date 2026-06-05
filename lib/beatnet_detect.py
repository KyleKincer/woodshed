"""Offline beat + downbeat detection via BeatNet.

Usage: python beatnet_detect.py <audio_file>
Prints one line:  BEATS_JSON{"beats": [[time, beatInBar], ...]}
where beatInBar == 1 marks a downbeat.

pyaudio is stubbed because BeatNet imports it unconditionally for its
microphone/streaming modes, which the offline path never touches.
"""
import sys
import types
import json

sys.modules.setdefault("pyaudio", types.ModuleType("pyaudio"))

from BeatNet.BeatNet import BeatNet  # noqa: E402


def main():
    audio = sys.argv[1]
    estimator = BeatNet(1, mode="offline", inference_model="DBN", plot=[], thread=False)
    out = estimator.process(audio)
    beats = [[round(float(t), 4), int(k)] for t, k in out]
    sys.stdout.write("BEATS_JSON" + json.dumps({"beats": beats}) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
