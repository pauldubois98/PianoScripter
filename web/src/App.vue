<script>
import { MESSAGES } from "./i18n.js";
import { drawPianoRoll } from "./roll.js";
import { decodeToMono16k, SAMPLE_RATE } from "./audio/decode.js";
import { trimSilence } from "./audio/trim.js";
import { estimateTempo } from "./audio/tempo.js";
import { MicCapture } from "./audio/mic.js";
import { transcribeAudio, renderScore } from "./engine/engine.js";
import { LiveSession } from "./engine/live.js";
import { quantize } from "./engine/quantize.js";
import { buildMusicXml } from "./engine/musicxml.js";
import { buildMidi } from "./engine/midi.js";

const EFFORT_ICONS = { ultra: "🚀", fast: "⚡", balanced: "⚖️", best: "✨" };

export default {
  data() {
    return {
      state: "idle", // idle | recording | live | processing | done
      theme: localStorage.getItem("theme")
        || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
      lang: localStorage.getItem("lang")
        || (navigator.language && navigator.language.toLowerCase().startsWith("fr") ? "fr" : "en"),
      effort: "balanced",
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
      // recording / live
      mic: null,
      seconds: 0,
      timerId: null,
      live: null,
      liveTimerId: null,
      liveEvents: [],
      liveStart: 0,
      rollRaf: null,
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
    currentEffort() {
      return this.efforts.find((e) => e.id === this.effort);
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
    },
    effortSwapHint(id) {
      if (id === this.resultEffort) return this.msg.swapCurrent;
      return this.cachedEfforts.includes(id) ? this.msg.swapInstant : this.msg.swapRerun;
    },

    // ---- pipeline (replaces the /api/transcribe + /update endpoints) ----
    async processAudio(audio16k) {
      this.state = "processing";
      this.error = null;
      this.progress = null;
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
      this.qnotes = quantize(res.notes, bpm);
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
    changeEffort(id) {
      if (this.updating || id === this.resultEffort) return;
      this.effort = id; // also becomes the default for the next transcription
      this.updateJob(id);
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

    // ---- plain recording ----
    startTimer() {
      this.seconds = 0;
      this.timerId = setInterval(() => this.seconds++, 1000);
    },
    async startRecording() {
      this.error = null;
      const mic = new MicCapture();
      try {
        await mic.start();
      } catch {
        this.error = this.msg.micDenied;
        return;
      }
      this.mic = mic;
      this.startTimer();
      this.state = "recording";
    },
    async stopRecording() {
      clearInterval(this.timerId);
      const audio = await this.mic.stop();
      this.mic = null;
      await this.processAudio(audio);
    },

    // ---- live session ----
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
      this.live = new LiveSession(mic);
      this.liveEvents = [];
      this.startTimer();
      this.liveStart = performance.now();
      this.liveTimerId = setInterval(async () => {
        const session = this.live;
        if (this.state !== "live" || !session) return;
        await session.tick();
        if (this.live === session) this.liveEvents = session.sortedEvents();
      }, 1000);
      this.state = "live";
      this.$nextTick(() => this.drawRoll());
    },
    async stopLive() {
      clearInterval(this.timerId);
      clearInterval(this.liveTimerId);
      cancelAnimationFrame(this.rollRaf);
      const audio = await this.mic.stop();
      this.mic = null;
      this.live = null;
      await this.processAudio(audio); // final full-quality pass
    },
    drawRoll() {
      if (this.state !== "live") return;
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
  },
};
</script>

<template>
  <button class="theme-toggle" :aria-label="theme === 'dark' ? msg.themeLight : msg.themeDark"
          :title="theme === 'dark' ? msg.themeLight : msg.themeDark" @click="toggleTheme">
    {{ theme === "dark" ? "☀️" : "🌙" }}
  </button>
  <button class="lang-toggle" :aria-label="msg.langTitle" :title="msg.langTitle" @click="toggleLang">
    {{ lang === "fr" ? "EN" : "FR" }}
  </button>
  <header>
    <h1>🎹 NotesScripter</h1>
    <p>{{ msg.subtitle }}</p>
    <span class="badge">{{ msg.badge }}</span>
  </header>

  <main>
    <!-- idle -->
    <div class="card" v-if="state === 'idle'">
      <div class="effort">
        <div class="effort-row">
          <span class="effort-label">{{ msg.effortLabel }}</span>
          <div class="segmented" role="radiogroup" :aria-label="msg.effortAria">
            <button v-for="opt in efforts" :key="opt.id"
                    :class="{ active: effort === opt.id }"
                    :title="opt.hint" @click="effort = opt.id">
              {{ opt.icon }} {{ opt.name }}
            </button>
          </div>
        </div>
        <span class="hint">{{ currentEffort.hint }}</span>
      </div>
      <div class="actions">
        <button class="action" @click="startRecording">
          <span class="icon">🎙️</span>
          <span><strong>{{ msg.record }}</strong></span>
          <small>{{ msg.recordSub }}</small>
        </button>
        <button class="action" @click="startLive">
          <span class="icon">🔴</span>
          <span><strong>{{ msg.live }}</strong></span>
          <small>{{ msg.liveSub }}</small>
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

    <!-- recording -->
    <div class="card center" v-else-if="state === 'recording'">
      <div style="display:flex; align-items:center; gap:.7rem">
        <span class="rec-dot"></span><strong>{{ msg.recording }}</strong>
      </div>
      <div class="timer">{{ timerLabel }}</div>
      <p class="hint">{{ msg.recordingHint }}</p>
      <button class="btn danger" @click="stopRecording">{{ msg.stopTranscribe }}</button>
    </div>

    <!-- live -->
    <div v-else-if="state === 'live'">
      <div class="card center">
        <div style="display:flex; align-items:center; gap:.7rem">
          <span class="rec-dot"></span><strong>{{ msg.live }}</strong>
        </div>
        <div class="timer">{{ timerLabel }}</div>
        <p class="hint">{{ msg.liveHint(liveEvents.length, currentEffort.name.toLowerCase()) }}</p>
        <button class="btn danger" @click="stopLive">{{ msg.stopFinalize }}</button>
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
      <div class="card center">
        <div class="meta-edit">
          <input v-model.trim="title" :placeholder="msg.titlePlaceholder" :aria-label="msg.titlePlaceholder"
                 :disabled="updating" @keyup.enter="$event.target.blur()" @change="updateJob()" />
          <input v-model.trim="author" :placeholder="msg.authorPlaceholder" :aria-label="msg.authorPlaceholder"
                 :disabled="updating" @keyup.enter="$event.target.blur()" @change="updateJob()" />
          <label class="bpm-field">
            <input type="number" min="20" max="300" step="1" v-model.number="bpm" aria-label="BPM"
                   :disabled="updating" @keyup.enter="$event.target.blur()" @change="onBpmChange" />
            BPM
          </label>
        </div>
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
          <span class="hint">{{ efforts.find((e) => e.id === resultEffort).hint }}</span>
        </div>
        <span class="meta-busy" v-if="updating">{{ updatingLabel }}</span>
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
          <button class="btn secondary" @click="reset">{{ msg.newTranscription }}</button>
        </div>
      </div>

      <div class="pages">
        <div class="page" v-for="(svg, i) in svgPages" :key="i" v-html="svg"></div>
      </div>
    </div>
  </main>

  <footer>{{ msg.footer }}</footer>
</template>
