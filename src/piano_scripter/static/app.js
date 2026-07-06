// Vue application. Messages come from i18n.js, roll rendering from roll.js.
const { createApp } = Vue;

const EFFORT_ICONS = { ultra: "🚀", fast: "⚡", balanced: "⚖️", best: "✨" };

createApp({
  data() {
    return {
      state: "idle",       // idle | recording | live | processing | done
      theme: localStorage.getItem("theme")
        || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
      lang: localStorage.getItem("lang")
        || (navigator.language && navigator.language.toLowerCase().startsWith("fr") ? "fr" : "en"),
      effort: "balanced",
      dragging: false,
      error: null,
      result: null,
      title: "Transcription",
      author: "",
      bpm: 120,
      bpmTouched: false,
      updating: false,
      updatingLabel: "",
      recorder: null,
      chunks: [],
      seconds: 0,
      timerId: null,
      liveId: null,
      liveTimerId: null,
      liveBusy: false,
      liveSvgs: [],
      liveNotes: 0,
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
    timerLabel() {
      const m = String(Math.floor(this.seconds / 60)).padStart(2, "0");
      const s = String(this.seconds % 60).padStart(2, "0");
      return `${m}:${s}`;
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
      this.result = null;
      this.title = "Transcription";
      this.author = "";
      this.bpm = 120;
      this.bpmTouched = false;
    },
    syncFromResult() {
      this.title = this.result.title;
      this.author = this.result.author;
      this.bpm = Math.round(this.result.tempo_bpm);
    },
    effortSwapHint(id) {
      if (id === this.result.effort) return this.msg.swapCurrent;
      return this.result.cached_efforts.includes(id)
        ? this.msg.swapInstant
        : this.msg.swapRerun;
    },
    changeEffort(id) {
      if (this.updating || id === this.result.effort) return;
      this.effort = id; // also becomes the default for the next transcription
      this.updateJob(id);
    },
    onBpmChange() {
      this.bpm = Math.min(300, Math.max(20, Math.round(this.bpm) || 120));
      this.bpmTouched = true;
      this.updateJob();
    },
    async updateJob(newEffort) {
      if (!this.result || this.updating) return;
      const opt = newEffort && this.efforts.find((e) => e.id === newEffort);
      const rerun = opt && !this.result.cached_efforts.includes(newEffort);
      this.updating = true;
      this.updatingLabel = rerun
        ? this.msg.retranscribing(opt.name.toLowerCase())
        : this.msg.updating;
      try {
        const form = new FormData();
        form.append("title", this.title || "Transcription");
        form.append("author", this.author);
        if (this.bpmTouched) form.append("bpm", this.bpm);
        if (newEffort) form.append("effort", newEffort);
        const resp = await fetch(`/api/jobs/${this.result.id}/update`, { method: "POST", body: form });
        if (resp.ok) {
          this.result = await resp.json();
          this.syncFromResult();
        }
      } finally {
        this.updating = false;
      }
    },
    dl(kind) {
      return `/api/download/${this.result.id}/${kind}`;
    },

    // ---- plain recording ----
    async getMic() {
      return navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    },
    startTimer() {
      this.seconds = 0;
      this.timerId = setInterval(() => this.seconds++, 1000);
    },
    async startRecording() {
      this.error = null;
      let stream;
      try { stream = await this.getMic(); }
      catch { this.error = this.msg.micDenied; return; }
      this.chunks = [];
      this.recorder = new MediaRecorder(stream);
      this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
      this.recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        this.transcribe(this.blobFile());
      };
      this.recorder.start();
      this.startTimer();
      this.state = "recording";
    },
    stopRecording() {
      clearInterval(this.timerId);
      this.recorder.stop();
      this.state = "processing";
    },
    blobFile() {
      const blob = new Blob(this.chunks, { type: this.recorder.mimeType });
      const ext = this.recorder.mimeType.includes("ogg") ? "ogg" : "webm";
      return new File([blob], `recording.${ext}`);
    },

    // ---- live session ----
    async startLive() {
      this.error = null;
      let stream;
      try { stream = await this.getMic(); }
      catch { this.error = this.msg.micDenied; return; }
      const resp = await fetch("/api/live/start", { method: "POST" });
      this.liveId = (await resp.json()).id;
      this.liveSvgs = [];
      this.liveNotes = 0;
      this.liveEvents = [];
      this.chunks = [];
      this.recorder = new MediaRecorder(stream);
      this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
      this.recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        fetch(`/api/live/${this.liveId}`, { method: "DELETE" });
        this.transcribe(this.blobFile());
      };
      this.recorder.start(1000); // gather data every second
      this.startTimer();
      this.liveStart = performance.now();
      this.liveTimerId = setInterval(() => this.sendLiveChunk(), 1000);
      this.state = "live";
      this.$nextTick(() => this.drawRoll());
    },
    async sendLiveChunk() {
      if (this.liveBusy || !this.chunks.length || this.state !== "live") return;
      this.liveBusy = true;
      try {
        const form = new FormData();
        form.append("file", this.blobFile());
        const resp = await fetch(`/api/live/${this.liveId}/chunk`, { method: "POST", body: form });
        if (resp.ok && this.state === "live") {
          const data = await resp.json();
          if (data.svg_pages.length) this.liveSvgs = data.svg_pages;
          this.liveNotes = data.n_notes;
          this.liveEvents = data.notes;
        }
      } finally {
        this.liveBusy = false;
      }
    },
    stopLive() {
      clearInterval(this.timerId);
      clearInterval(this.liveTimerId);
      cancelAnimationFrame(this.rollRaf);
      this.recorder.stop(); // onstop triggers the final full-quality pass
      this.state = "processing";
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
      if (f) this.transcribe(f);
      e.target.value = "";
    },
    onDrop(e) {
      this.dragging = false;
      const f = e.dataTransfer.files[0];
      if (f) this.transcribe(f);
    },
    async transcribe(file) {
      this.state = "processing";
      const form = new FormData();
      form.append("file", file);
      form.append("effort", this.effort);
      form.append("title", this.title || "Transcription");
      form.append("author", this.author);
      try {
        const resp = await fetch("/api/transcribe", { method: "POST", body: form });
        if (!resp.ok) throw new Error(await resp.text());
        this.result = await resp.json();
        this.syncFromResult();
        this.state = "done";
      } catch {
        this.error = this.msg.failed;
        this.state = "idle";
      }
    },
  },
}).mount("#app");
