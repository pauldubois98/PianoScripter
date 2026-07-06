// Quantized notes -> standard MIDI file. Mirrors score_to_midi: the MIDI
// follows the quantized score (not the raw performance), at the chosen BPM.

import { Midi } from "@tonejs/midi";

export function buildMidi(qnotes, bpm) {
  const midi = new Midi();
  midi.header.setTempo(Math.round(bpm));
  const secPerQl = 60 / bpm;
  for (const hand of ["R", "L"]) {
    const track = midi.addTrack();
    track.instrument.number = 0; // acoustic grand piano
    for (const q of qnotes) {
      if (q.hand !== hand) continue;
      track.addNote({
        midi: q.pitch,
        time: q.onsetQl * secPerQl,
        duration: q.durQl * secPerQl,
        velocity: Math.min(127, Math.max(1, q.velocity)) / 127,
      });
    }
  }
  return new Uint8Array(midi.toArray());
}
