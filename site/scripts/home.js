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

  /* ==================== 右侧章节进度 ==================== */

  function initChapterRail() {
    const sections = $$('main > section[data-chapter]');
    if (!sections.length || $('.chapter-rail')) return;

    const rail = document.createElement('nav');
    rail.className = 'chapter-rail';
    rail.setAttribute('aria-label', '页面章节');
    const list = document.createElement('ol');
    list.className = 'chapter-rail__list';

    const links = sections.map((section) => {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.className = 'chapter-rail__link';
      link.href = `#${section.id}`;
      link.setAttribute('aria-label', section.dataset.chapter);
      const dot = document.createElement('span');
      dot.className = 'chapter-rail__dot';
      dot.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'chapter-rail__label';
      label.setAttribute('aria-hidden', 'true');
      label.textContent = section.dataset.chapter;
      link.append(dot, label);
      item.append(link);
      list.append(item);
      return link;
    });

    rail.append(list);
    document.body.append(rail);

    let ticking = false;
    const update = () => {
      ticking = false;
      const probe = window.innerHeight * 0.5;
      let activeIndex = -1;
      sections.forEach((section, index) => {
        const rect = section.getBoundingClientRect();
        if (rect.top <= probe && rect.bottom > probe) activeIndex = index;
      });
      links.forEach((link, index) => {
        const active = index === activeIndex;
        link.classList.toggle('is-active', active);
        if (active) link.setAttribute('aria-current', 'true');
        else link.removeAttribute('aria-current');
      });
      rail.classList.toggle('is-visible', activeIndex >= 0);
    };
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(update);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    update();
  }

  /* ==================== 滚动视差 ==================== */

  function initParallax() {
    if (REDUCED.matches) return;

    // 巡览截图左右交错、以不同速度轻微位移，滚动时像一整面会呼吸的截图墙
    $$('.gallery__shot-parallax').forEach((el, index) => {
      if (!el.hasAttribute('data-parallax-scroll')) {
        el.setAttribute('data-parallax-scroll', index % 2 === 0 ? '0.18' : '0.32');
      }
    });

    const items = $$('[data-parallax-scroll]');
    if (!items.length) return;

    let ticking = false;
    const update = () => {
      ticking = false;
      const viewport = window.innerHeight || 1;
      items.forEach((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.bottom < -180 || rect.top > viewport + 180) return;
        const center = rect.top + rect.height / 2;
        const progress = Math.max(-1.2, Math.min(1.2, (center - viewport / 2) / viewport));
        const speed = Number(el.getAttribute('data-parallax-scroll')) || 0.15;
        el.style.setProperty('--parallax-y', `${(progress * speed * -140).toFixed(1)}px`);
      });
    };
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(update);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    update();
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

  const AUDIO_FILES = {
    harmonica: [60, 64, 67, 72].map((midi) => ({
      midi,
      url: `./assets/audio/harmonica-${midi}.wav`,
    })),
    piano: [60, 72].map((midi) => ({ midi, url: `./assets/audio/piano-${midi}.mp3` })),
  };

  const Audio = {
    ctx: null,
    master: null,
    buffers: new Map(),
    raw: new Map(),
    loading: new Map(),
    decoding: new Map(),
    timbre: 'harmonica',
    prefetched: false,

    /** 页面空闲时就抓音频文件，第一次按键只需要 decode，不需要等网络。 */
    prefetch() {
      if (this.prefetched) return;
      this.prefetched = true;
      Object.entries(AUDIO_FILES).forEach(([timbre, files]) => {
        files.forEach(({ midi, url }) => {
          const cacheKey = fileKey(timbre, midi);
          if (this.raw.has(cacheKey) || this.buffers.has(cacheKey) || this.loading.has(cacheKey)) {
            return;
          }
          const task = fetch(url, { cache: 'force-cache' })
            .then((response) => {
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              return response.arrayBuffer();
            })
            .then((buffer) => {
              this.raw.set(cacheKey, buffer);
              if (this.ctx) this.decode(cacheKey);
            })
            .catch(() => {})
            .finally(() => this.loading.delete(cacheKey));
          this.loading.set(cacheKey, task);
        });
      });
    },

    /** 交互手势里调用：创建/恢复 AudioContext，并开始解码已预抓取的采样。 */
    ensure() {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return Promise.resolve(false);
      if (!this.ctx) {
        this.ctx = new Ctor({ latencyHint: 'interactive' });
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.55;
        this.master.connect(this.ctx.destination);
      }
      this.prefetch();
      this.raw.forEach((_buffer, key) => {
        this.decode(key);
      });
      const resume =
        this.ctx.state === 'suspended' ? this.ctx.resume() : Promise.resolve();
      return resume
        .then(() => this.ctx.state === 'running')
        .catch(() => false);
    },

    decode(key) {
      if (this.buffers.has(key)) return Promise.resolve(this.buffers.get(key));
      if (this.decoding.has(key)) return this.decoding.get(key);
      const buffer = this.raw.get(key);
      if (!buffer || !this.ctx) return Promise.resolve(null);
      const task = new Promise((resolve) => {
        this.ctx.decodeAudioData(
          buffer.slice(0),
          (decoded) => {
            this.buffers.set(key, decoded);
            resolve(decoded);
          },
          () => resolve(null),
        );
      }).finally(() => this.decoding.delete(key));
      this.decoding.set(key, task);
      return task;
    },

    load(timbre) {
      if (!this.ctx) {
        return this.ensure().then((ready) => (ready ? this.load(timbre) : false));
      }
      const files = AUDIO_FILES[timbre] || [];
      return Promise.all(
        files.map(({ midi, url }) => {
          const key = `${timbre}:${midi}`;
          if (this.buffers.has(key)) return Promise.resolve();
          if (this.decoding.has(key)) return this.decoding.get(key);
          if (this.raw.has(key)) return this.decode(key);
          if (!this.loading.has(key)) {
            const task = fetch(url, { cache: 'force-cache' })
              .then((response) => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return response.arrayBuffer();
              })
              .then((buffer) => {
                this.raw.set(key, buffer);
                return this.decode(key);
              })
              .catch(() => {})
              .finally(() => this.loading.delete(key));
            this.loading.set(key, task);
          }
          return this.loading.get(key);
        }),
      ).catch(() => {});
    },

    nearest(timbre, midi) {
      const list = timbre === 'piano' ? [60, 72] : [60, 64, 67, 72];
      return list.reduce((best, candidate) => {
        return Math.abs(candidate - midi) < Math.abs(best - midi) ? candidate : best;
      }, list[0]);
    },

    playNow(midi) {
      if (!this.ctx || this.ctx.state !== 'running') return false;
      const timbre = this.timbre;
      const base = this.nearest(timbre, midi);
      const buffer = this.buffers.get(`${timbre}:${base}`);
      if (!buffer) return false;
      try {
        const source = this.ctx.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = Math.pow(2, (midi - base) / 12);
        const gain = this.ctx.createGain();
        gain.gain.value = 0.9;
        source.connect(gain);
        gain.connect(this.master);
        source.start(0);
        source.stop(this.ctx.currentTime + 1.35);
        return true;
      } catch {
        return false;
      }
    },

    /** 按键路径：立即尝试发声；首个手势时自动建 ctx / 恢复，采样未解码完则等解码后补发。 */
    play(midi) {
      if (!this.ctx) {
        this.ensure().then(() => {
          this.load(this.timbre);
          this.playWhenReady(midi, 0);
        });
        return;
      }
      if (this.ctx.state === 'suspended') {
        this.ctx
          .resume()
          .then(() => {
            if (!this.playNow(midi)) this.playWhenReady(midi, 0);
          })
          .catch(() => {});
        return;
      }
      if (!this.playNow(midi)) this.playWhenReady(midi, 0);
    },

    playWhenReady(midi, attempt) {
      if (attempt > 8) return;
      const base = this.nearest(this.timbre, midi);
      if (this.buffers.has(`${this.timbre}:${base}`)) {
        this.playNow(midi);
        return;
      }
      this.load(this.timbre).then(() => {
        if (!this.playNow(midi)) {
          window.setTimeout(() => this.playWhenReady(midi, attempt + 1), 40);
        }
      });
    },

    setTimbre(timbre) {
      this.timbre = timbre;
      if (this.ctx) this.load(timbre);
    },
  };

  /** 将 ./assets/audio/<timbre>-<midi>.ext 归一成 buffers 的 key。 */
  function fileKey(timbre, midi) {
    return `${timbre}:${midi}`;
  }

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

    // 第一次进入练习区附近就开始预抓采样；第一次真实按键只需解码，不必等网络
    root.addEventListener(
      'pointerdown',
      () => {
        Audio.ensure()
          .then(() => Audio.load(demo.timbre))
          .catch(() => {});
      },
      { once: true, passive: true },
    );

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

    const start = () => {
      demo.runId += 1;
      stopLoop();
      if (idle) idle.hidden = true;
      if (result) result.hidden = true;
      notesLayer.textContent = '';
      demo.notes = [];
      demo.stats = emptyStats();
      updateStats();

      // 不阻塞谱面开始：解锁音频与解码在后台完成，LEAD_IN 足够覆盖首次解码
      Audio.ensure()
        .then(() => Audio.load(demo.timbre))
        .catch(() => {});

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
      // 先发声再判定：声音不等待 DOM 更新与评分计算
      playNote(index);
      Audio.ensure()
        .then(() => Audio.load(demo.timbre))
        .catch(() => {});
      if (!demo.running) {
        start();
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
    };

    pads.forEach((pad, index) => {
      pad.addEventListener('click', () => judgeInput(index));
    });

    if (startButton) startButton.addEventListener('click', () => start());
    if (restartButton) restartButton.addEventListener('click', () => start());
    if (againButton) againButton.addEventListener('click', () => start());

    timbreButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const timbre = button.getAttribute('data-timbre') === 'piano' ? 'piano' : 'harmonica';
        demo.timbre = timbre;
        Audio.setTimbre(timbre);
        timbreButtons.forEach((item) => {
          const on = item === button;
          item.classList.toggle('is-active', on);
          item.setAttribute('aria-pressed', String(on));
        });
        Audio.ensure()
          .then(() => Audio.load(timbre))
          .catch(() => {});
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

      const warmObserver = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            Audio.prefetch();
            warmObserver.disconnect();
          }
        },
        { rootMargin: '600px 0px' },
      );
      warmObserver.observe(root);
    } else {
      demo.visible = true;
      Audio.prefetch();
    }
  }

  function boot() {
    initHero();
    initFlow();
    initChapterRail();
    initParallax();
    initPractice();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
