/* 三角洲口琴工坊 · 首页脚本（无依赖）
 * Hero 视差、三步滚动叙事、页面巡览标签、可交互的跟谱判定演示。
 */
(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* ==================== Hero ==================== */

  function initHero() {
    const hero = $('[data-hero]');
    if (!hero) return;
    const visual = $('[data-hero-visual]', hero);
    const floats = $$('[data-parallax]', hero);
    let raf = 0;

    const update = () => {
      raf = 0;
      const rect = hero.getBoundingClientRect();
      const total = rect.height || 1;
      const progress = Math.min(1, Math.max(0, -rect.top / total));
      if (visual) visual.style.setProperty('--hero-p', progress.toFixed(3));
      floats.forEach((el) => {
        const speed = Number(el.getAttribute('data-parallax')) || 0;
        el.style.setProperty('--float-y', `${(-progress * 160 * speed).toFixed(1)}px`);
      });
    };

    if (!REDUCED.matches) {
      const onScroll = () => {
        if (!raf) raf = window.requestAnimationFrame(update);
      };
      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onScroll, { passive: true });
      update();

      hero.addEventListener('pointermove', (event) => {
        if (event.pointerType && event.pointerType !== 'mouse') return;
        const rect = hero.getBoundingClientRect();
        const x = (event.clientX - rect.left) / rect.width - 0.5;
        const y = (event.clientY - rect.top) / rect.height - 0.5;
        hero.style.setProperty('--pointer-x', x.toFixed(3));
        hero.style.setProperty('--pointer-y', y.toFixed(3));
      });
      hero.addEventListener('pointerleave', () => {
        hero.style.setProperty('--pointer-x', '0');
        hero.style.setProperty('--pointer-y', '0');
      });
    }
  }

  /* ==================== 三步滚动叙事 ==================== */

  function initFlow() {
    const stage = $('[data-flow]');
    if (!stage) return;
    const steps = $$('[data-flow-step]', stage);
    const screens = $$('[data-flow-screen]', stage);
    const progress = $('[data-flow-progress]', stage);
    if (!steps.length) return;

    const desktop = window.matchMedia('(min-width: 901px)');
    let active = 0;
    let raf = 0;

    const apply = (index) => {
      if (index === active) return;
      active = index;
      steps.forEach((el, i) => el.classList.toggle('is-active', i === index));
      screens.forEach((el, i) => el.classList.toggle('is-active', i === index));
      if (progress) {
        const ratio = (index + 1) / steps.length;
        progress.style.transform = `scaleX(${ratio.toFixed(4)})`;
      }
    };

    const update = () => {
      raf = 0;
      if (!desktop.matches) return;
      const anchor = window.innerHeight * 0.48;
      let index = 0;
      steps.forEach((step, i) => {
        if (step.getBoundingClientRect().top <= anchor) index = i;
      });
      apply(index);
    };

    const onScroll = () => {
      if (!raf) raf = window.requestAnimationFrame(update);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    update();
  }

  /* ==================== 页面巡览标签 ==================== */

  function initGallery() {
    const tabs = $$('[data-gallery-tab]');
    const panels = $$('[data-gallery-panel]');
    if (!tabs.length || !panels.length) return;

    const activate = (index, moveFocus) => {
      tabs.forEach((tab, i) => {
        const on = i === index;
        tab.classList.toggle('is-active', on);
        tab.setAttribute('aria-selected', String(on));
        tab.tabIndex = on ? 0 : -1;
        if (on && moveFocus) tab.focus();
      });
      panels.forEach((panel, i) => {
        const on = i === index;
        panel.classList.toggle('is-active', on);
        panel.hidden = !on;
      });
    };

    tabs.forEach((tab, i) => {
      tab.addEventListener('click', () => activate(i, false));
      tab.addEventListener('keydown', (event) => {
        let next = null;
        if (event.key === 'ArrowRight') next = (i + 1) % tabs.length;
        else if (event.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = tabs.length - 1;
        if (next === null) return;
        event.preventDefault();
        activate(next, true);
      });
    });
  }

  /* ==================== 跟谱判定演示 ==================== */

  const KEY_ROWS = [
    { key: 'z', label: 'Z', jianpu: '1', midi: 60 },
    { key: 'x', label: 'X', jianpu: '2', midi: 62 },
    { key: 'c', label: 'C', jianpu: '3', midi: 64 },
    { key: 'v', label: 'V', jianpu: '4', midi: 65 },
    { key: 'b', label: 'B', jianpu: '5', midi: 67 },
    { key: 'n', label: 'N', jianpu: '6', midi: 69 },
    { key: 'm', label: 'M', jianpu: '7', midi: 71 },
    { key: ',', label: ',', jianpu: '高音 1', midi: 72 },
  ];
  const KEY_TO_INDEX = new Map(KEY_ROWS.map((row, index) => [row.key, index]));
  const MELODY = [0, 0, 4, 4, 5, 5, 4, 3, 3, 2, 2, 1, 1, 0];
  const FALL_MS = 2400;
  const NOTE_SPACING = 720;
  const LEAD_IN = FALL_MS + 200;
  const JUDGE_WINDOW = 150;
  const KEY_WINDOW = 220;

  const Audio = {
    ctx: null,
    master: null,
    buffers: new Map(),
    loading: new Map(),
    timbre: 'harmonica',

    async ensure() {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return false;
      if (!this.ctx) {
        this.ctx = new Ctor();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.55;
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') {
        try {
          await this.ctx.resume();
        } catch {
          return false;
        }
      }
      return this.ctx.state === 'running';
    },

    async load(timbre) {
      if (!this.ctx) return;
      const notes = timbre === 'piano' ? [60, 72] : [60, 64, 67, 72];
      await Promise.all(
        notes.map((midi) => {
          const cacheKey = `${timbre}:${midi}`;
          if (this.buffers.has(cacheKey)) return Promise.resolve();
          if (this.loading.has(cacheKey)) return this.loading.get(cacheKey);
          const url =
            timbre === 'piano'
              ? `./assets/audio/piano-${midi}.mp3`
              : `./assets/audio/harmonica-${midi}.wav`;
          const task = (async () => {
            try {
              const response = await fetch(url);
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              const data = await response.arrayBuffer();
              const buffer = await new Promise((resolve, reject) => {
                this.ctx.decodeAudioData(data, resolve, reject);
              });
              this.buffers.set(cacheKey, buffer);
            } catch {
              /* 没有声音不影响判定，静默降级 */
            } finally {
              this.loading.delete(cacheKey);
            }
          })();
          this.loading.set(cacheKey, task);
          return task;
        }),
      );
    },

    nearest(timbre, midi) {
      const list = timbre === 'piano' ? [60, 72] : [60, 64, 67, 72];
      return list.reduce((best, candidate) => {
        return Math.abs(candidate - midi) < Math.abs(best - midi) ? candidate : best;
      }, list[0]);
    },

    play(midi) {
      if (!this.ctx || this.ctx.state !== 'running') return;
      const timbre = this.timbre;
      const base = this.nearest(timbre, midi);
      const buffer = this.buffers.get(`${timbre}:${base}`);
      if (!buffer) return;
      try {
        const source = this.ctx.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = Math.pow(2, (midi - base) / 12);
        const gain = this.ctx.createGain();
        gain.gain.value = 0.9;
        source.connect(gain);
        gain.connect(this.master);
        source.start();
        source.stop(this.ctx.currentTime + 1.35);
      } catch {
        /* 忽略音频异常 */
      }
    },

    setTimbre(timbre) {
      this.timbre = timbre;
      this.load(timbre);
    },
  };

  function initPractice() {
    const root = $('[data-practice]');
    if (!root) return;

    const stage = $('[data-practice-stage]', root);
    const notesLayer = $('[data-practice-notes]', root);
    const feedback = $('[data-practice-feedback]', root);
    const idle = $('[data-practice-idle]', root);
    const result = $('[data-practice-result]', root);
    const startButton = $('[data-practice-start]', root);
    const restartButton = $('[data-practice-restart]', root);
    const againButton = $('[data-practice-again]', root);
    const accuracyEl = $('[data-practice-accuracy]', root);
    const comboEl = $('[data-practice-combo]', root);
    const maxComboEl = $('[data-practice-maxcombo]', root);
    const resultAccuracy = $('[data-practice-result-accuracy]', root);
    const resultDetail = $('[data-practice-result-detail]', root);
    const pads = $$('.practice__pad', root);
    const timbreButtons = $$('[data-timbre]', root);
    if (!stage || !notesLayer || !idle) return;

    const demo = {
      visible: false,
      running: false,
      raf: 0,
      runId: 0,
      notes: [],
      lastTime: 0,
      timbre: 'harmonica',
      stats: null,
    };

    const emptyStats = () => ({
      perfect: 0,
      excellent: 0,
      good: 0,
      miss: 0,
      wrong: 0,
      combo: 0,
      maxCombo: 0,
      judged: 0,
      points: 0,
    });

    const accuracy = () => {
      const stats = demo.stats;
      if (!stats || !stats.judged) return 100;
      return Math.max(0, Math.min(100, Math.round((stats.points / stats.judged) * 100)));
    };

    const updateStats = () => {
      if (!demo.stats) return;
      if (accuracyEl) accuracyEl.textContent = String(accuracy());
      if (comboEl) comboEl.textContent = String(demo.stats.combo);
      if (maxComboEl) maxComboEl.textContent = String(demo.stats.maxCombo);
    };

    const labels = {
      perfect: '完美',
      excellent: '优秀',
      good: '良好',
      miss: '失误',
      wrong: '错音',
    };

    const showFeedback = (kind, delta) => {
      if (!feedback) return;
      const hit = kind === 'perfect' || kind === 'excellent' || kind === 'good';
      const ms = hit ? ` ${delta > 0 ? '+' : ''}${Math.round(delta)}ms` : '';
      feedback.textContent = `${labels[kind] || ''}${ms}`;
      feedback.classList.remove('is-show', 'is-excellent', 'is-good', 'is-miss');
      void feedback.offsetWidth;
      feedback.classList.add('is-show');
      if (kind === 'excellent') feedback.classList.add('is-excellent');
      else if (kind === 'good') feedback.classList.add('is-good');
      else if (kind === 'miss' || kind === 'wrong') feedback.classList.add('is-miss');
    };

    const registerJudge = (kind, delta) => {
      const stats = demo.stats;
      if (!stats) return;
      stats.judged += 1;
      if (kind === 'perfect') {
        stats.perfect += 1;
        stats.points += 1;
        stats.combo += 1;
      } else if (kind === 'excellent') {
        stats.excellent += 1;
        stats.points += 0.8;
        stats.combo += 1;
      } else if (kind === 'good') {
        stats.good += 1;
        stats.points += 0.6;
        stats.combo += 1;
      } else {
        stats.miss += 1;
        if (kind === 'wrong') stats.wrong += 1;
        stats.combo = 0;
      }
      stats.maxCombo = Math.max(stats.maxCombo, stats.combo);
      showFeedback(kind, delta);
      updateStats();
    };

    const dismissNote = (note, className, delay = 260) => {
      note.el.classList.add(className);
      window.setTimeout(() => {
        if (note.el && note.el.parentNode) note.el.parentNode.removeChild(note.el);
      }, delay);
    };

    const stopLoop = () => {
      demo.running = false;
      if (demo.raf) {
        window.cancelAnimationFrame(demo.raf);
        demo.raf = 0;
      }
    };

    const finish = () => {
      stopLoop();
      const stats = demo.stats || emptyStats();
      if (resultAccuracy) resultAccuracy.textContent = String(accuracy());
      if (resultDetail) {
        resultDetail.textContent = `完美 ${stats.perfect} · 优秀 ${stats.excellent} · 良好 ${stats.good} · 失误 ${stats.miss}`;
      }
      if (result) result.hidden = false;
      demo.notes.forEach((note) => {
        if (note.el && note.el.parentNode) note.el.parentNode.removeChild(note.el);
      });
      demo.notes = [];
    };

    const playNote = (index) => {
      const row = KEY_ROWS[index];
      if (!row) return;
      Audio.play(row.midi);
      const pad = pads[index];
      if (pad) {
        pad.classList.add('is-active');
        window.setTimeout(() => pad.classList.remove('is-active'), 130);
      }
    };

    const loop = () => {
      if (!demo.running) return;
      const now = performance.now();
      const stageHeight = stage.clientHeight || 300;
      const judgeY = stageHeight - 44;
      const maxTop = Math.max(40, judgeY - 44);
      demo.notes.forEach((note) => {
        if (note.judged) return;
        const remain = note.time - now;
        const top = maxTop * (1 - remain / FALL_MS);
        note.el.style.transform = `translate(-50%, ${top.toFixed(1)}px)`;
        if (now > note.time + JUDGE_WINDOW + 70) {
          note.judged = true;
          dismissNote(note, 'is-missed', 260);
          registerJudge('miss', 0);
        }
      });
      const allJudged = demo.notes.every((note) => note.judged);
      if (allJudged && now > demo.lastTime + 700) {
        finish();
        return;
      }
      demo.raf = window.requestAnimationFrame(loop);
    };

    const start = async () => {
      demo.runId += 1;
      const runId = demo.runId;
      stopLoop();
      if (idle) idle.hidden = true;
      if (result) result.hidden = true;
      notesLayer.textContent = '';
      demo.notes = [];
      demo.stats = emptyStats();
      updateStats();

      const ready = await Audio.ensure();
      if (ready) await Audio.load(demo.timbre);
      if (runId !== demo.runId) return;

      const now = performance.now();
      demo.running = true;
      MELODY.forEach((noteIndex, order) => {
        const time = now + LEAD_IN + order * NOTE_SPACING;
        const el = document.createElement('div');
        el.className = 'practice__note';
        el.textContent = KEY_ROWS[noteIndex].jianpu;
        el.style.left = `${(((noteIndex + 0.5) / 8) * 100).toFixed(3)}%`;
        el.style.transform = 'translate(-50%, 0)';
        const note = {
          index: noteIndex,
          midi: KEY_ROWS[noteIndex].midi,
          time,
          el,
          judged: false,
        };
        notesLayer.appendChild(el);
        demo.notes.push(note);
      });
      demo.lastTime = now + LEAD_IN + (MELODY.length - 1) * NOTE_SPACING;
      demo.raf = window.requestAnimationFrame(loop);
    };

    const judgeInput = (index) => {
      if (!demo.running) {
        start().then(() => playNote(index));
        return;
      }
      const now = performance.now();
      let nearest = null;
      demo.notes.forEach((note) => {
        if (note.judged) return;
        const distance = Math.abs(note.time - now);
        if (!nearest || distance < nearest.distance) nearest = { note, distance };
      });

      if (nearest && nearest.distance <= KEY_WINDOW) {
        const note = nearest.note;
        note.judged = true;
        if (note.index === index) {
          const delta = Math.round(now - note.time);
          const absolute = Math.abs(delta);
          let kind = 'miss';
          if (absolute <= 55) kind = 'perfect';
          else if (absolute <= 100) kind = 'excellent';
          else if (absolute <= JUDGE_WINDOW) kind = 'good';
          if (kind === 'miss') dismissNote(note, 'is-missed');
          else dismissNote(note, 'is-hit');
          registerJudge(kind, delta);
        } else {
          dismissNote(note, 'is-wrong');
          registerJudge('wrong', 0);
        }
      }
      playNote(index);
    };

    pads.forEach((pad, index) => {
      pad.addEventListener('click', () => judgeInput(index));
    });

    if (startButton) startButton.addEventListener('click', () => start());
    if (restartButton) restartButton.addEventListener('click', () => start());
    if (againButton) againButton.addEventListener('click', () => start());

    timbreButtons.forEach((button) => {
      button.addEventListener('click', async () => {
        const timbre = button.getAttribute('data-timbre') === 'piano' ? 'piano' : 'harmonica';
        demo.timbre = timbre;
        timbreButtons.forEach((item) => {
          const on = item === button;
          item.classList.toggle('is-active', on);
          item.setAttribute('aria-pressed', String(on));
        });
        const ready = await Audio.ensure();
        if (ready) Audio.setTimbre(timbre);
      });
    });

    document.addEventListener('keydown', (event) => {
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
      ) {
        return;
      }
      if (document.querySelector('dialog[open]')) return;
      const index = KEY_TO_INDEX.get(event.key.toLowerCase());
      if (index === undefined || !demo.visible) return;
      event.preventDefault();
      judgeInput(index);
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden && demo.running) finish();
    });

    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver(
        (entries) => {
          demo.visible = entries.some((entry) => entry.isIntersecting);
        },
        { threshold: 0.2 },
      );
      observer.observe(root);
    } else {
      demo.visible = true;
    }
  }

  function boot() {
    initHero();
    initFlow();
    initGallery();
    initPractice();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
