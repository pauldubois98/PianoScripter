<script>
import { MESSAGES } from "./i18n.js";
import { drawPianoRoll } from "./roll.js";
import { decodeToMono16k, SAMPLE_RATE } from "./audio/decode.js";
import { trimSilence, trimSilenceOffset } from "./audio/trim.js";
import { estimateTempo } from "./audio/tempo.js";
import { MicCapture } from "./audio/mic.js";
import { transcribeAudio, renderScore, elementsAtTime } from "./engine/engine.js";
import { LiveSession } from "./engine/live.js";
import {
  quantize,
  quantizeAdaptive,
  DEFAULT_AGGRESSIVENESS,
  MIN_QL,
  MAX_QL,
  silenceGapBefore,
  shiftFrom,
} from "./engine/quantize.js";
import { buildMusicXml, midiName, durationLabel, ALLOWED_DURATIONS } from "./engine/musicxml.js";
import { buildMidi } from "./engine/midi.js";
import { encodeWav16 } from "./audio/wav.js";
import { MODEL_DOWNLOAD_INFO, isModelCached } from "./engine/model-availability.js";

const EFFORT_ICONS = { ultra: "🚀", oaf: "🎶", fast: "⚡", balanced: "⚖️", best: "✨" };
// engines light enough to keep up with the mic; switchable live during a
// recording (see liveEngine / setLiveEngine)
const LIVE_EFFORTS = ["ultra", "oaf"];
// recommended reprocess target once a live recording stops
const RECOMMENDED_REPROCESS_EFFORT = "balanced";
// silence insert/delete nudge in the note editor: one beat per click, like
// moveEvent's fixed nudge
const SILENCE_STEP_QL = 1;

export default {
  data() {
    return {
      state: "idle", // idle | live | processing | done
      theme: localStorage.getItem("theme")
        || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
      lang: localStorage.getItem("lang")
        || (navigator.language && navigator.language.toLowerCase().startsWith("fr") ? "fr" : "en"),
      effort: "ultra", // no selector on the first page anymore; uploads default to this too
      showAbout: false,
      dragging: false,
      error: null,
      // current transcription (replaces the server-side Job)
      audio: null, // trimmed 16 kHz Float32Array
      duration: 0,
      tempoBpm: 120,
      resultCache: {}, // effort -> { notes, pedals, tempoBpm }
      resultEffort: null, // effort of the displayed result
      qnotes: [],
      musicxml: "",
      svgPages: [],
      keyName: null,
      title: "Transcription",
      author: "",
      bpm: 120,
      bpmTouched: false,
      updating: false,
      updatingLabel: "",
      progress: null, // { stage: "download"|"infer", value: 0..1 }
      pendingDownload: null, // { id, mb } while confirming a first-time model download
      editing: false,
      hasEditedNotes: false, // guards "New transcription" from silently discarding manual edits
      rhythmMode: localStorage.getItem("rhythmMode") || "adaptive", // "adaptive" | "raw"
      aggressiveness: localStorage.getItem("aggressiveness") != null
        ? Number(localStorage.getItem("aggressiveness"))
        : DEFAULT_AGGRESSIVENESS,
      aggressivenessDebounce: null,
      // recording / live
      mic: null,
      seconds: 0,
      timerId: null,
      live: null,
      liveTimerId: null,
      liveEvents: [],
      liveStart: 0,
      livePaused: false,
      livePausedAt: 0,
      liveEngine: "ultra", // switchable mid-recording between the two live-capable engines
      showReprocessPrompt: false,
      rollRaf: null,
      // playback of the recorded audio, with a cursor synced to the score
      playing: false,
      playOffset: 0, // seconds already played, used to resume after pause
      playStartedAt: 0, // audioCtx.currentTime when the current segment started
      audioCtx: null,
      audioBuffer: null,
      playAudio: null, // this.audio further trimmed to the first detected note, matching the score's time origin
      playDuration: 0,
      playSource: null,
      playRaf: null,
      playheadBusy: false,
      playbackTime: 0,
      playheadPage: null,
      playheadLeft: 0,
    };
  },
  computed: {
    msg() {
      return MESSAGES[this.lang];
    },
    efforts() {
      return Object.keys(EFFORT_ICONS).map((id) => ({
        id,
        icon: EFFORT_ICONS[id],
        ...this.msg.efforts[id],
      }));
    },
    liveEngineOptions() {
      return this.efforts.filter((e) => LIVE_EFFORTS.includes(e.id));
    },
    cachedEfforts() {
      return Object.keys(this.resultCache);
    },
    timerLabel() {
      const m = String(Math.floor(this.seconds / 60)).padStart(2, "0");
      const s = String(this.seconds % 60).padStart(2, "0");
      return `${m}:${s}`;
    },
    progressLabel() {
      if (!this.progress) return "";
      const pct = Math.round(this.progress.value * 100);
      return this.progress.stage === "download"
        ? this.msg.downloadingModel(pct)
        : this.msg.inferring(pct);
    },
    rightEvents() {
      return this.groupEvents("R");
    },
    leftEvents() {
      return this.groupEvents("L");
    },
    pitchOptions() {
      // A0..C8, the full piano range
      return Array.from({ length: 88 }, (_, i) => i + 21);
    },
    aggressivenessLabel() {
      const levels = this.msg.aggressivenessLevels;
      const i = Math.min(levels.length - 1, Math.floor(this.aggressiveness * levels.length));
      return levels[i];
    },
  },
  mounted() {
    document.documentElement.dataset.theme = this.theme;
    document.documentElement.lang = this.lang;
  },
  methods: {
    toggleTheme() {
      this.theme = this.theme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = this.theme;
      localStorage.setItem("theme", this.theme);
    },
    toggleLang() {
      this.lang = this.lang === "fr" ? "en" : "fr";
      document.documentElement.lang = this.lang;
      localStorage.setItem("lang", this.lang);
    },
    reset() {
      this.stopPlayback();
      this.audioBuffer = null;
      this.playAudio = null;
      this.playDuration = 0;
      this.state = "idle";
      this.error = null;
      this.audio = null;
      this.resultCache = {};
      this.resultEffort = null;
      this.qnotes = [];
      this.musicxml = "";
      this.svgPages = [];
      this.keyName = null;
      this.title = "Transcription";
      this.author = "";
      this.bpm = 120;
      this.bpmTouched = false;
      this.progress = null;
      this.pendingDownload = null;
      this.editing = false;
      this.hasEditedNotes = false;
      this.liveEngine = "ultra";
      this.showReprocessPrompt = false;
    },
    resetWithConfirm() {
      if (this.hasEditedNotes && !window.confirm(this.msg.confirmDiscardEdits)) return;
      this.reset();
    },
    effortSwapHint(id) {
      if (id === this.resultEffort) return this.msg.swapCurrent;
      return this.cachedEfforts.includes(id) ? this.msg.swapInstant : this.msg.swapRerun;
    },

    // ---- pipeline (replaces the /api/transcribe + /update endpoints) ----
    async processAudio(audio16k) {
      this.stopPlayback();
      this.audioBuffer = null;
      this.playAudio = null;
      this.playDuration = 0;
      this.state = "processing";
      this.error = null;
      this.progress = null;
      this.editing = false;
      try {
        const trimmed = trimSilence(audio16k);
        if (!trimmed.length) throw new Error("empty audio");
        this.audio = trimmed;
        this.duration = Math.round((trimmed.length / SAMPLE_RATE) * 10) / 10;
        this.tempoBpm = estimateTempo(trimmed);
        this.resultCache = {};
        await this.runEffort(this.effort);
        this.syncFromResult();
        this.state = "done";
      } catch (err) {
        console.error(err);
        this.error = this.msg.failed;
        this.state = "idle";
      } finally {
        this.progress = null;
      }
    },
    async runEffort(effort) {
      if (!this.resultCache[effort]) {
        const { notes, pedals } = await transcribeAudio(this.audio, effort, {
          onProgress: (stage, value) => (this.progress = { stage, value }),
        });
        this.resultCache[effort] = { notes, pedals };
      }
      this.resultEffort = effort;
      await this.rebuild();
    },
    async rebuild() {
      const res = this.resultCache[this.resultEffort];
      const bpm = this.bpmTouched ? this.bpm : this.tempoBpm;
      this.qnotes =
        this.rhythmMode === "adaptive"
          ? quantizeAdaptive(res.notes, bpm, this.aggressiveness)
          : quantize(res.notes, bpm);
      this.editing = false; // a new note set invalidates manual edits
      this.syncPlayAudio(res.notes);
      await this.rebuildRender();
    },
    // The score always starts its first note on beat 1 (finalizeQuantized
    // drops leading silence), but this.audio still has whatever lead-in
    // trimSilence left in front of that first note. Without this, playback
    // starts "too early" relative to the score and the cursor runs ahead
    // of the audio for the whole piece. Re-trim a playback-only copy so
    // both share the same time origin.
    syncPlayAudio(rawNotes) {
      const lead = rawNotes.length ? Math.max(0, Math.min(...rawNotes.map((n) => n.onset))) : 0;
      const leadSamples = Math.min(this.audio.length, Math.round(lead * SAMPLE_RATE));
      this.playAudio = this.audio.slice(leadSamples);
      this.playDuration = this.playAudio.length / SAMPLE_RATE;
      this.audioBuffer = null;
    },
    toggleRhythmMode() {
      if (this.updating) return;
      this.rhythmMode = this.rhythmMode === "adaptive" ? "raw" : "adaptive";
      localStorage.setItem("rhythmMode", this.rhythmMode);
      this.updateJob();
    },
    onAggressivenessChange() {
      localStorage.setItem("aggressiveness", this.aggressiveness);
      clearTimeout(this.aggressivenessDebounce);
      this.aggressivenessDebounce = setTimeout(() => this.updateJob(), 150);
    },
    // Re-engraves the score from the current qnotes as-is (does not
    // re-quantize), so manual edits and title/author-only changes survive.
    async rebuildRender() {
      this.stopPlayback(); // ids in the old SVG are about to become stale
      const bpm = this.bpmTouched ? this.bpm : this.tempoBpm;
      const { musicxml, key } = buildMusicXml(this.qnotes, bpm, {
        title: this.title || "Transcription",
        composer: this.author,
      });
      this.musicxml = musicxml;
      this.keyName = key;
      this.svgPages = await renderScore(musicxml, {
        title: this.title || "Transcription",
        composer: this.author,
      });
    },
    syncFromResult() {
      if (!this.bpmTouched) this.bpm = Math.round(this.tempoBpm);
    },
    async changeEffort(id) {
      if (this.updating || id === this.resultEffort) return;
      // Cached results never re-download, regardless of effort; otherwise
      // ask before a first-time fetch of a heavier model (see MODEL_DOWNLOAD_INFO).
      if (!this.cachedEfforts.includes(id)) {
        const info = MODEL_DOWNLOAD_INFO[id];
        if (info && !(await isModelCached(info.file))) {
          this.pendingDownload = { id, mb: info.mb };
          return;
        }
      }
      this.effort = id; // also becomes the default for the next transcription
      this.showReprocessPrompt = false;
      this.updateJob(id);
    },
    confirmDownload() {
      const { id } = this.pendingDownload;
      this.pendingDownload = null;
      this.effort = id;
      this.showReprocessPrompt = false;
      this.updateJob(id);
    },
    cancelDownload() {
      this.pendingDownload = null;
    },
    onBpmChange() {
      this.bpm = Math.min(300, Math.max(20, Math.round(this.bpm) || 120));
      this.bpmTouched = true;
      this.updateJob();
    },
    async updateJob(newEffort) {
      if (!this.audio || this.updating) return;
      const opt = newEffort && this.efforts.find((e) => e.id === newEffort);
      const rerun = opt && !this.cachedEfforts.includes(newEffort);
      this.updating = true;
      this.updatingLabel = rerun
        ? this.msg.retranscribing(opt.name.toLowerCase())
        : this.msg.updating;
      try {
        if (newEffort) await this.runEffort(newEffort);
        else await this.rebuild();
      } catch (err) {
        console.error(err);
        this.error = this.msg.failed;
      } finally {
        this.updating = false;
        this.progress = null;
      }
    },
    // Title/author changes and manual note edits: re-engrave without
    // touching the bpm/effort-derived note set.
    async renderOnly() {
      if (!this.audio || this.updating) return;
      this.updating = true;
      this.updatingLabel = this.msg.updating;
      try {
        await this.rebuildRender();
      } catch (err) {
        console.error(err);
        this.error = this.msg.failed;
      } finally {
        this.updating = false;
      }
    },

    // ---- note editing ----
    groupEvents(hand) {
      const map = new Map();
      for (const q of this.qnotes) {
        if (q.hand !== hand) continue;
        if (!map.has(q.onsetQl)) map.set(q.onsetQl, { onsetQl: q.onsetQl, durQl: q.durQl, pitches: [] });
        map.get(q.onsetQl).pitches.push(q.pitch);
      }
      return [...map.values()]
        .sort((a, b) => a.onsetQl - b.onsetQl)
        .map((ev) => ({ ...ev, pitches: [...ev.pitches].sort((a, b) => a - b) }));
    },
    durOptionsFor(durQl) {
      const set = new Set(ALLOWED_DURATIONS);
      set.add(durQl);
      return [...set].sort((a, b) => b - a);
    },
    midiName,
    durationLabel,
    silenceGapBefore,
    beatLabel(onsetQl) {
      const measure = Math.floor(onsetQl / 4) + 1;
      const beat = (onsetQl % 4) + 1;
      return `${measure}.${beat}`;
    },
    // Every mutation goes through here: it normalizes the result (clips
    // durations against the next onset per hand, re-sorts, re-ids) then
    // re-engraves. Keeps individual edit methods free of that bookkeeping.
    async editNotes(mutate) {
      if (this.updating) return;
      mutate();
      this.hasEditedNotes = true;
      this.normalizeQnotes();
      this.updating = true;
      this.updatingLabel = this.msg.updating;
      try {
        await this.rebuildRender();
      } catch (err) {
        console.error(err);
        this.error = this.msg.failed;
      } finally {
        this.updating = false;
      }
    },
    normalizeQnotes() {
      for (const hand of ["R", "L"]) {
        const onsets = [...new Set(this.qnotes.filter((q) => q.hand === hand).map((q) => q.onsetQl))]
          .sort((a, b) => a - b);
        onsets.forEach((onset, i) => {
          const next = onsets[i + 1];
          const cap = next != null ? next - onset : MAX_QL;
          for (const q of this.qnotes) {
            if (q.hand === hand && q.onsetQl === onset) {
              q.durQl = Math.max(MIN_QL, Math.min(q.durQl, cap));
            }
          }
        });
      }
      this.qnotes.sort((a, b) => a.onsetQl - b.onsetQl || a.hand.localeCompare(b.hand) || a.pitch - b.pitch);
      this.qnotes.forEach((q, i) => (q.id = i));
    },
    setEventDuration(hand, onsetQl, durQl) {
      this.editNotes(() => {
        for (const q of this.qnotes) {
          if (q.hand === hand && q.onsetQl === onsetQl) q.durQl = durQl;
        }
      });
    },
    moveEvent(hand, onsetQl, deltaQl) {
      this.editNotes(() => {
        const newOnset = Math.max(0, Math.round((onsetQl + deltaQl) * 4) / 4);
        for (const q of this.qnotes) {
          if (q.hand === hand && q.onsetQl === onsetQl) q.onsetQl = newOnset;
        }
      });
    },
    removePitch(hand, onsetQl, pitch) {
      this.editNotes(() => {
        this.qnotes = this.qnotes.filter((q) => !(q.hand === hand && q.onsetQl === onsetQl && q.pitch === pitch));
      });
    },
    onAddPitch(hand, onsetQl, e) {
      const pitch = Number(e.target.value);
      e.target.value = "";
      if (!pitch) return;
      this.editNotes(() => {
        if (this.qnotes.some((q) => q.hand === hand && q.onsetQl === onsetQl && q.pitch === pitch)) return;
        const group = this.qnotes.filter((q) => q.hand === hand && q.onsetQl === onsetQl);
        const durQl = group.length ? group[0].durQl : 1;
        this.qnotes.push({ id: 0, hand, onsetQl, durQl, pitch, velocity: 80 });
      });
    },
    deleteEvent(hand, onsetQl) {
      this.editNotes(() => {
        this.qnotes = this.qnotes.filter((q) => !(q.hand === hand && q.onsetQl === onsetQl));
      });
    },
    addEvent(hand) {
      this.editNotes(() => {
        const handNotes = this.qnotes.filter((q) => q.hand === hand);
        const onsetQl = handNotes.length ? Math.max(...handNotes.map((q) => q.onsetQl + q.durQl)) : 0;
        this.qnotes.push({ id: 0, hand, onsetQl, durQl: 1, pitch: hand === "R" ? 60 : 48, velocity: 80 });
      });
    },
    // Both hands share one timeline, so inserting/removing silence at a
    // point shifts every note (either hand) at/after it, keeping the hands
    // in sync with each other -- a note already sounding through the pivot
    // is left untouched.
    insertSilence(onsetQl) {
      this.editNotes(() => shiftFrom(this.qnotes, onsetQl, SILENCE_STEP_QL));
    },
    deleteSilence(onsetQl) {
      const gap = silenceGapBefore(this.qnotes, onsetQl);
      if (gap <= 1e-9) return;
      this.editNotes(() => shiftFrom(this.qnotes, onsetQl, -Math.min(SILENCE_STEP_QL, gap)));
    },

    // ---- downloads (generated locally, on demand) ----
    saveBlob(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    },
    dlMidi() {
      const bpm = this.bpmTouched ? this.bpm : this.tempoBpm;
      const bytes = buildMidi(this.qnotes, bpm);
      this.saveBlob(new Blob([bytes], { type: "audio/midi" }), "transcription.mid");
    },
    dlMusicXml() {
      this.saveBlob(
        new Blob([this.musicxml], { type: "application/vnd.recordare.musicxml+xml" }),
        "transcription.musicxml"
      );
    },
    async dlPdf() {
      const { svgsToPdf } = await import("./pdf.js");
      this.saveBlob(await svgsToPdf(this.svgPages), "transcription.pdf");
    },
    dlWav() {
      this.saveBlob(new Blob([encodeWav16(this.audio, SAMPLE_RATE)], { type: "audio/wav" }), "recording.wav");
    },

    // ---- recording (always live-monitored) ----
    startTimer() {
      this.seconds = 0;
      this.timerId = setInterval(() => this.seconds++, 1000);
    },
    async startLive() {
      this.error = null;
      const mic = new MicCapture();
      try {
        await mic.start();
      } catch {
        this.error = this.msg.micDenied;
        return;
      }
      this.mic = mic;
      this.liveEngine = "ultra"; // always starts on the built-in, no-download engine
      this.live = new LiveSession(mic, {
        engine: this.liveEngine,
        // only the one-time model download is worth surfacing mid-session
        onProgress: (stage, value) => {
          this.progress = stage === "download" && value < 1 ? { stage, value } : null;
        },
      });
      this.liveEvents = [];
      this.startTimer();
      this.liveStart = performance.now();
      this.liveTimerId = setInterval(async () => {
        const session = this.live;
        if (this.state !== "live" || this.livePaused || !session) return;
        await session.tick();
        if (this.live === session) this.liveEvents = session.sortedEvents();
      }, 1000);
      this.state = "live";
      this.livePaused = false;
      this.$nextTick(() => this.drawRoll());
    },
    async pauseLive() {
      if (this.livePaused) return;
      this.livePaused = true;
      this.livePausedAt = performance.now();
      clearInterval(this.timerId);
      cancelAnimationFrame(this.rollRaf);
      await this.mic.pause(); // worklet stops emitting frames: no gap in the buffer
    },
    async resumeLive() {
      if (!this.livePaused) return;
      await this.mic.resume();
      // shift both clocks forward by the pause duration so the timer and the
      // roll's playhead keep matching the (unpaused) audio timeline
      const pausedMs = performance.now() - this.livePausedAt;
      this.liveStart += pausedMs;
      this.livePaused = false;
      this.timerId = setInterval(() => this.seconds++, 1000);
      this.$nextTick(() => this.drawRoll());
    },
    // Switches the engine driving the running session's incremental
    // transcription. LiveSession reads `this.engine` fresh on every tick, so
    // this takes effect on the next pass without restarting the recording.
    setLiveEngine(id) {
      this.liveEngine = id;
      if (this.live) this.live.engine = id;
    },
    async stopLive() {
      clearInterval(this.timerId);
      clearInterval(this.liveTimerId);
      cancelAnimationFrame(this.rollRaf);
      if (this.livePaused) await this.mic.resume();
      this.livePaused = false;
      const audio = await this.mic.stop();
      const session = this.live;
      this.mic = null;
      this.live = null;
      await this.finishLiveRecording(session, audio);
    },
    // Builds the initial result straight from the notes the live session
    // already detected -- no need to re-run inference on the same audio at
    // the same engine. A banner then offers to reprocess with a heavier
    // model for a cleaner score (see showReprocessPrompt in the template).
    async finishLiveRecording(session, audio16k) {
      this.stopPlayback();
      this.audioBuffer = null;
      this.playAudio = null;
      this.playDuration = 0;
      this.state = "processing";
      this.error = null;
      this.progress = null;
      this.editing = false;
      try {
        const trimmed = trimSilence(audio16k);
        if (!trimmed.length) throw new Error("empty audio");
        const offsetSamples = trimSilenceOffset(audio16k);
        this.audio = trimmed;
        this.duration = Math.round((trimmed.length / SAMPLE_RATE) * 10) / 10;
        this.tempoBpm = session.bpm || estimateTempo(trimmed);
        // the session's notes are timed against the untrimmed buffer;
        // re-anchor them to trimmed audio's origin so playback sync
        // (syncPlayAudio) and the shown duration agree with this.audio
        const offsetSec = offsetSamples / SAMPLE_RATE;
        const notes = session
          .sortedEvents()
          .map((n) => ({ ...n, onset: n.onset - offsetSec, offset: n.offset - offsetSec }));
        this.resultCache = { [this.liveEngine]: { notes, pedals: [] } };
        this.resultEffort = this.liveEngine;
        await this.rebuild();
        this.syncFromResult();
        this.state = "done";
        this.showReprocessPrompt = true;
      } catch (err) {
        console.error(err);
        this.error = this.msg.failed;
        this.state = "idle";
      } finally {
        this.progress = null;
      }
    },
    reprocessRecommended() {
      this.showReprocessPrompt = false;
      this.changeEffort(RECOMMENDED_REPROCESS_EFFORT);
    },
    drawRoll() {
      if (this.state !== "live" || this.livePaused) return;
      const canvas = this.$refs.roll;
      if (canvas) {
        drawPianoRoll(canvas, this.liveEvents, (performance.now() - this.liveStart) / 1000);
      }
      this.rollRaf = requestAnimationFrame(() => this.drawRoll());
    },

    // ---- upload ----
    onPick(e) {
      const f = e.target.files[0];
      if (f) this.transcribeFile(f);
      e.target.value = "";
    },
    onDrop(e) {
      this.dragging = false;
      const f = e.dataTransfer.files[0];
      if (f) this.transcribeFile(f);
    },
    async transcribeFile(file) {
      this.state = "processing";
      this.error = null;
      let audio;
      try {
        audio = await decodeToMono16k(await file.arrayBuffer());
      } catch {
        this.error = this.msg.decodeFailed;
        this.state = "idle";
        return;
      }
      await this.processAudio(audio);
    },

    // ---- replay the recorded audio, with a cursor on the sheet music ----
    formatTime(t) {
      const s = Math.max(0, Math.floor(t || 0));
      const m = String(Math.floor(s / 60)).padStart(2, "0");
      return `${m}:${String(s % 60).padStart(2, "0")}`;
    },
    ensureAudioBuffer() {
      if (!this.audioBuffer && this.playAudio) {
        if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const buffer = this.audioCtx.createBuffer(1, this.playAudio.length, SAMPLE_RATE);
        buffer.copyToChannel(this.playAudio, 0);
        this.audioBuffer = buffer;
      }
      return this.audioBuffer;
    },
    togglePlay() {
      if (this.playing) this.pausePlayback();
      else this.resumePlayback();
    },
    resumePlayback() {
      if (!this.playAudio) return;
      const buffer = this.ensureAudioBuffer();
      if (this.playOffset >= this.playDuration) this.playOffset = 0;
      const source = this.audioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.audioCtx.destination);
      source.onended = () => {
        if (this.playSource !== source) return; // superseded by pause/stop
        this.playing = false;
        this.playOffset = 0;
        this.playbackTime = 0;
        this.playSource = null;
        this.playheadPage = null;
      };
      source.start(0, this.playOffset);
      this.playStartedAt = this.audioCtx.currentTime - this.playOffset;
      this.playSource = source;
      this.playing = true;
      this.tickPlayhead();
    },
    pausePlayback() {
      if (!this.playSource) return;
      this.playOffset = this.audioCtx.currentTime - this.playStartedAt;
      const source = this.playSource;
      this.playSource = null; // so onended becomes a no-op
      source.onended = null;
      source.stop();
      this.playing = false;
      cancelAnimationFrame(this.playRaf);
    },
    stopPlayback() {
      if (this.playSource) {
        const source = this.playSource;
        this.playSource = null;
        source.onended = null;
        try {
          source.stop();
        } catch {
          // already stopped
        }
      }
      cancelAnimationFrame(this.playRaf);
      this.playing = false;
      this.playOffset = 0;
      this.playbackTime = 0;
      this.playheadPage = null;
    },
    tickPlayhead() {
      if (!this.playing) return;
      this.playbackTime = this.audioCtx.currentTime - this.playStartedAt;
      this.updatePlayhead(this.playbackTime);
      this.playRaf = requestAnimationFrame(() => this.tickPlayhead());
    },
    async updatePlayhead(sec) {
      if (this.playheadBusy) return;
      this.playheadBusy = true;
      try {
        const info = await elementsAtTime(sec * 1000);
        const ids = [...(info?.notes || []), ...(info?.chords || []), ...(info?.rests || [])];
        let el = null;
        for (const id of ids) {
          el = document.getElementById(id);
          if (el) break;
        }
        const pageEl = el?.closest(".page");
        const pageIndex = pageEl ? [...this.$refs.pageEls].indexOf(pageEl) : -1;
        if (pageIndex === -1) {
          this.playheadPage = null;
          return;
        }
        const noteRect = el.getBoundingClientRect();
        const pageRect = pageEl.getBoundingClientRect();
        this.playheadLeft = noteRect.left - pageRect.left + pageEl.scrollLeft;
        this.playheadPage = pageIndex;
      } catch {
        // transient: score may be mid-rebuild, just skip this frame
      } finally {
        this.playheadBusy = false;
      }
    },
  },
};
</script>

<template>
  <div class="top-toolbar">
    <button class="toolbar-btn" :aria-label="msg.aboutTitle" :title="msg.aboutTitle" @click="showAbout = !showAbout">
      {{ showAbout ? "✕" : "ℹ️" }}
    </button>
    <button class="toolbar-btn lang-toggle" :aria-label="msg.langTitle" :title="msg.langTitle" @click="toggleLang">
      {{ lang === "fr" ? "EN" : "FR" }}
    </button>
    <button class="toolbar-btn" :aria-label="theme === 'dark' ? msg.themeLight : msg.themeDark"
            :title="theme === 'dark' ? msg.themeLight : msg.themeDark" @click="toggleTheme">
      {{ theme === "dark" ? "☀️" : "🌙" }}
    </button>
  </div>
  <header>
    <h1>🎹 PianoScripter</h1>
    <p>{{ msg.subtitle }}</p>
    <span class="badge">{{ msg.badge }}</span>
  </header>

  <main>
    <!-- about -->
    <div class="card about" v-if="showAbout">
      <h2>{{ msg.about.title }}</h2>
      <p>{{ msg.about.intro }}</p>

      <div class="flow">
        <span class="flow-step" v-for="(step, i) in msg.about.pipeline" :key="i">
          <span class="flow-box">{{ step }}</span>
          <span class="flow-arrow" v-if="i < msg.about.pipeline.length - 1">→</span>
        </span>
      </div>

      <h3>{{ msg.about.modelsTitle }}</h3>
      <div class="model-card" v-for="m in msg.about.models" :key="m.name">
        <div class="model-card-head">
          <span class="model-icon">{{ m.icon }}</span>
          <strong>{{ m.name }}</strong>
          <span class="chip">{{ m.tag }}</span>
        </div>
        <p>{{ m.text }}</p>
      </div>

      <h3>{{ msg.about.rhythmTitle }}</h3>
      <div class="model-card" v-for="m in msg.about.rhythmModes" :key="m.name">
        <div class="model-card-head">
          <span class="model-icon">{{ m.icon }}</span>
          <strong>{{ m.name }}</strong>
        </div>
        <p>{{ m.text }}</p>
      </div>

      <p class="hint" style="margin-top:1rem">{{ msg.about.privacy }}</p>
    </div>

    <template v-else>
    <!-- idle -->
    <div class="card" v-if="state === 'idle'">
      <div class="actions">
        <button class="action" @click="startLive">
          <span class="icon">🎙️</span>
          <span><strong>{{ msg.record }}</strong></span>
          <small>{{ msg.recordSub }}</small>
        </button>
        <label class="action" :class="{ dragover: dragging }"
               @dragover.prevent="dragging = true" @dragleave="dragging = false"
               @drop.prevent="onDrop">
          <span class="icon">📁</span>
          <span><strong>{{ msg.upload }}</strong></span>
          <small>{{ msg.uploadSub }}</small>
          <input type="file" accept="audio/*" @change="onPick" />
        </label>
      </div>
      <p class="hint" style="text-align:center; margin-top:1.4rem" v-if="error === null">
        {{ msg.firstRun }}
      </p>
      <p class="error" style="text-align:center; margin-top:1.4rem" v-else>{{ error }}</p>
    </div>

    <!-- live (recording, live-monitored) -->
    <div v-else-if="state === 'live'">
      <div class="card center">
        <div style="display:flex; align-items:center; gap:.7rem">
          <span class="rec-dot" :class="{ paused: livePaused }"></span>
          <strong>{{ livePaused ? msg.livePausedLabel : msg.live }}</strong>
        </div>
        <div class="timer">{{ timerLabel }}</div>
        <p class="hint">
          {{ livePaused ? msg.livePausedHint : msg.liveHint(liveEvents.length) }}
        </p>
        <div class="effort" style="margin-bottom:0">
          <div class="effort-row">
            <span class="effort-label">{{ msg.liveEngineLabel }}</span>
            <div class="segmented" role="radiogroup" :aria-label="msg.liveEngineLabel">
              <button v-for="opt in liveEngineOptions" :key="opt.id"
                      :class="{ active: liveEngine === opt.id }"
                      :title="opt.hint" @click="setLiveEngine(opt.id)">
                {{ opt.icon }} {{ opt.name }}
              </button>
            </div>
          </div>
        </div>
        <div class="progress" v-if="progress">
          <div :style="{ width: Math.round(progress.value * 100) + '%' }"></div>
        </div>
        <p class="model-note" v-if="progress">{{ progressLabel }}</p>
        <div style="display:flex; gap:.7rem; flex-wrap:wrap; justify-content:center">
          <button class="btn secondary" @click="livePaused ? resumeLive() : pauseLive()">
            {{ livePaused ? msg.resumeLive : msg.pauseLive }}
          </button>
          <button class="btn danger" @click="stopLive">{{ msg.stopFinalize }}</button>
        </div>
      </div>
      <div class="roll-wrap"><canvas ref="roll"></canvas></div>
      <div class="pages" v-if="live && live.svgPages.length">
        <div class="page" v-for="(svg, i) in live.svgPages" :key="i" v-html="svg"></div>
      </div>
      <p class="hint" style="text-align:center; margin-top:1.4rem" v-else>
        {{ msg.liveWaiting }}
      </p>
    </div>

    <!-- processing -->
    <div class="card center" v-else-if="state === 'processing'">
      <div class="spinner"></div>
      <strong>{{ msg.transcribing }}</strong>
      <div class="progress" v-if="progress">
        <div :style="{ width: Math.round(progress.value * 100) + '%' }"></div>
      </div>
      <p class="model-note" v-if="progress">{{ progressLabel }}</p>
      <p class="hint">{{ msg.processingHint }}</p>
    </div>

    <!-- result -->
    <div v-else-if="state === 'done'">
      <div class="card center reprocess-banner" v-if="showReprocessPrompt">
        <p>{{ msg.reprocessBody(efforts.find((e) => e.id === resultEffort).name) }}</p>
        <div style="display:flex; gap:.7rem; flex-wrap:wrap; justify-content:center">
          <button class="btn" @click="reprocessRecommended">{{ msg.reprocessAccept }}</button>
          <button class="btn secondary" @click="showReprocessPrompt = false">{{ msg.reprocessDismiss }}</button>
        </div>
      </div>
      <div class="card center">
        <div class="meta-edit">
          <input v-model.trim="title" :placeholder="msg.titlePlaceholder" :aria-label="msg.titlePlaceholder"
                 :disabled="updating" @keyup.enter="$event.target.blur()" @change="renderOnly()" />
          <input v-model.trim="author" :placeholder="msg.authorPlaceholder" :aria-label="msg.authorPlaceholder"
                 :disabled="updating" @keyup.enter="$event.target.blur()" @change="renderOnly()" />
          <label class="bpm-field">
            <input type="number" min="20" max="300" step="1" v-model.number="bpm" aria-label="BPM"
                   :disabled="updating" @keyup.enter="$event.target.blur()" @change="onBpmChange" />
            BPM
          </label>
        </div>
        <div class="settings-group">
          <div class="settings-group-title">{{ msg.qualityGroupTitle }}</div>
          <div class="effort" style="margin-bottom:0">
            <div class="effort-row">
              <span class="effort-label">{{ msg.effortLabel }}</span>
              <div class="segmented" role="radiogroup" :aria-label="msg.effortAria">
                <button v-for="opt in efforts" :key="opt.id"
                        :class="{ active: resultEffort === opt.id }" :disabled="updating"
                        :title="effortSwapHint(opt.id)" @click="changeEffort(opt.id)">
                  {{ opt.icon }} {{ opt.name }}
                </button>
              </div>
            </div>
            <span class="hint updating-hint" v-if="updating">
              <span class="spinner small"></span>{{ updatingLabel }}
            </span>
            <div class="hint download-confirm" v-else-if="pendingDownload">
              <span>{{ msg.confirmDownloadBody(pendingDownload.mb) }}</span>
              <button class="btn small" @click="confirmDownload">{{ msg.confirmDownloadAccept }}</button>
              <button class="btn secondary small" @click="cancelDownload">{{ msg.confirmDownloadCancel }}</button>
            </div>
            <span class="hint" v-else>{{ efforts.find((e) => e.id === resultEffort).hint }}</span>
          </div>
        </div>
        <div class="settings-group">
          <div class="settings-group-title">{{ msg.rhythmGroupTitle }}</div>
          <div class="effort" style="margin-bottom:0">
            <div class="effort-row">
              <span class="effort-label">{{ msg.rhythmModeLabel }}</span>
              <div class="segmented" role="radiogroup" :aria-label="msg.rhythmModeLabel">
                <button :class="{ active: rhythmMode === 'adaptive' }" :disabled="updating"
                        :title="msg.rhythmAdaptiveHint" @click="rhythmMode !== 'adaptive' && toggleRhythmMode()">
                  {{ msg.rhythmAdaptive }}
                </button>
                <button :class="{ active: rhythmMode === 'raw' }" :disabled="updating"
                        :title="msg.rhythmRawHint" @click="rhythmMode !== 'raw' && toggleRhythmMode()">
                  {{ msg.rhythmRaw }}
                </button>
              </div>
            </div>
            <span class="hint">{{ rhythmMode === "adaptive" ? msg.rhythmAdaptiveHint : msg.rhythmRawHint }}</span>
          </div>
          <div class="effort" style="margin-bottom:0" v-if="rhythmMode === 'adaptive'">
            <div class="effort-row">
              <span class="effort-label">{{ msg.aggressivenessLabel }}</span>
              <input class="aggressiveness-slider" type="range" min="0" max="1" step="0.05"
                     v-model.number="aggressiveness" :disabled="updating"
                     :aria-label="msg.aggressivenessLabel" @input="onAggressivenessChange" />
              <span class="aggressiveness-value">{{ aggressivenessLabel }}</span>
            </div>
            <span class="hint">{{ msg.aggressivenessHint }}</span>
          </div>
        </div>
        <div class="progress" v-if="updating && progress">
          <div :style="{ width: Math.round(progress.value * 100) + '%' }"></div>
        </div>
        <div class="chips">
          <span class="chip">⏱️ {{ duration }} s</span>
          <span class="chip">🎵 {{ qnotes.length }} {{ msg.notes }}</span>
          <span class="chip" v-if="keyName">🔑 {{ keyName }}</span>
        </div>
        <div class="downloads">
          <button class="btn" @click="dlPdf">⬇ PDF</button>
          <button class="btn" @click="dlMidi">⬇ MIDI</button>
          <button class="btn" @click="dlMusicXml">⬇ MusicXML</button>
          <button class="btn" @click="dlWav">⬇ {{ msg.dlRecording }}</button>
        </div>
        <div class="result-actions">
          <button class="btn secondary" :disabled="updating" @click="editing = !editing">
            {{ editing ? msg.doneEditing : msg.editScore }}
          </button>
          <button class="btn secondary" @click="resetWithConfirm">{{ msg.newTranscription }}</button>
          <button class="btn secondary" @click="togglePlay">
            {{ playing ? "⏸ " + msg.pauseRecording : "▶ " + msg.playRecording }}
          </button>
          <span class="playback-time">{{ formatTime(playbackTime) }} / {{ formatTime(playDuration) }}</span>
        </div>
      </div>

      <div class="card editor" v-if="editing">
        <div class="editor-hands">
          <div class="editor-hand" v-for="hand in ['R', 'L']" :key="hand">
            <div class="editor-hand-title">{{ hand === "R" ? msg.rightHand : msg.leftHand }}</div>
            <div class="editor-event" v-for="ev in (hand === 'R' ? rightEvents : leftEvents)" :key="hand + ev.onsetQl">
              <div class="editor-event-row">
                <button class="mini" :disabled="updating || ev.onsetQl <= 0" :title="msg.moveEarlier"
                        @click="moveEvent(hand, ev.onsetQl, -0.25)">◀</button>
                <span class="editor-beat">{{ beatLabel(ev.onsetQl) }}</span>
                <button class="mini" :disabled="updating" :title="msg.moveLater"
                        @click="moveEvent(hand, ev.onsetQl, 0.25)">▶</button>
                <select :value="ev.durQl" :disabled="updating"
                        @change="setEventDuration(hand, ev.onsetQl, Number($event.target.value))">
                  <option v-for="d in durOptionsFor(ev.durQl)" :key="d" :value="d">{{ durationLabel(d) }}</option>
                </select>
                <span class="editor-pitches">
                  <span class="pitch-chip" v-for="p in ev.pitches" :key="p">
                    {{ midiName(p) }}
                    <button class="chip-x" :disabled="updating" @click="removePitch(hand, ev.onsetQl, p)">×</button>
                  </span>
                </span>
                <select class="editor-add-pitch" :disabled="updating" @change="onAddPitch(hand, ev.onsetQl, $event)">
                  <option value="">{{ msg.addPitch }}</option>
                  <option v-for="p in pitchOptions" :key="p" :value="p">{{ midiName(p) }}</option>
                </select>
                <button class="mini danger" :disabled="updating" :title="msg.deleteChord"
                        @click="deleteEvent(hand, ev.onsetQl)">🗑</button>
                <button class="mini" :disabled="updating" :title="msg.insertSilence"
                        @click="insertSilence(ev.onsetQl)">⏸+</button>
                <button class="mini" :disabled="updating || silenceGapBefore(qnotes, ev.onsetQl) <= 1e-9"
                        :title="msg.deleteSilence" @click="deleteSilence(ev.onsetQl)">⏸−</button>
              </div>
            </div>
            <button class="btn secondary small" :disabled="updating" @click="addEvent(hand)">{{ msg.addChord }}</button>
          </div>
        </div>
      </div>

      <div class="pages">
        <div class="page" ref="pageEls" v-for="(svg, i) in svgPages" :key="i">
          <div class="page-content" v-html="svg"></div>
          <div class="playhead" v-if="playheadPage === i" :style="{ left: playheadLeft + 'px' }"></div>
        </div>
      </div>
    </div>
    </template>
  </main>

  <footer>{{ msg.footer }}</footer>
</template>
