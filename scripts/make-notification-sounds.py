#!/usr/bin/env python3
"""Synthesizes the three notification sounds into native/Resources/Sounds.

reminder: two soft rising notes; approval: a repeated mid knock that asks for
attention; done: a quick bright arpeggio. Short, quiet and distinct by contour.
Run once and commit the .caf files; needs macOS afconvert.
"""
import math, os, struct, subprocess, sys, tempfile, wave

RATE = 22050
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'native', 'Resources', 'Sounds')
SOUNDS = {
    # name: [(frequency Hz, start s, length s)]
    'aibro-reminder': [(659.25, 0.0, 0.32), (880.0, 0.16, 0.42)],
    'aibro-approval': [(587.33, 0.0, 0.14), (587.33, 0.17, 0.14), (783.99, 0.34, 0.30)],
    'aibro-done': [(1046.5, 0.0, 0.22), (1318.5, 0.08, 0.22), (1568.0, 0.16, 0.36)],
}

def render(notes):
    total = max(start + length for _, start, length in notes) + 0.05
    samples = [0.0] * int(total * RATE)
    for frequency, start, length in notes:
        offset = int(start * RATE)
        for i in range(int(length * RATE)):
            t = i / RATE
            # Fast attack, exponential decay; a faint octave keeps it bell-like.
            envelope = min(1.0, t / 0.008) * math.exp(-t * 7.0)
            value = math.sin(2 * math.pi * frequency * t) + 0.25 * math.sin(4 * math.pi * frequency * t)
            samples[offset + i] += 0.28 * envelope * value
    return samples

def main():
    os.makedirs(OUT, exist_ok=True)
    for name, notes in SOUNDS.items():
        with tempfile.TemporaryDirectory() as folder:
            source = os.path.join(folder, name + '.wav')
            with wave.open(source, 'wb') as out:
                out.setnchannels(1); out.setsampwidth(2); out.setframerate(RATE)
                out.writeframes(b''.join(struct.pack('<h', int(max(-1, min(1, s)) * 32767)) for s in render(notes)))
            subprocess.run(['afconvert', '-f', 'caff', '-d', 'LEI16', source, os.path.join(OUT, name + '.caf')], check=True)
    return 0

if __name__ == '__main__':
    sys.exit(main())
