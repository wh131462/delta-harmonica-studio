/**
 * 本地存储：设置 + 曲谱方案（用户数据目录下的 JSON 文件，便于备份/迁移）。
 * 目录结构：
 *   <userData>/settings.json
 *   <userData>/scores/<score-id>.dfh.json
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildScoreFromText } from '@core/score/dsl';
import { scoreEndBeat, type Score } from '@core/model/score';
import { DEFAULT_SETTINGS, mergeSettings } from '@shared/settings';
import { BUILTIN_SCORES } from '@shared/builtin-scores';
import type { AppSettings, LibraryEntry } from '@shared/types';

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tempPath, filePath);
}

function normalizeLoadedScore(value: unknown): Score | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<Score>;
  if (typeof candidate.id !== 'string' || !candidate.meta || !Array.isArray(candidate.notes)) return null;
  return candidate as Score;
}

export function toLibraryEntry(score: Score): LibraryEntry {
  const noteCount = score.notes.filter((note) => note.degree !== 0).length;
  return {
    id: score.id,
    title: score.meta.title || '未命名',
    artist: score.meta.artist,
    tempo: score.meta.tempo,
    meter: { num: score.meta.meter.num, den: score.meta.meter.den },
    keyRoot: score.meta.keyRoot,
    noteCount,
    durationBeats: scoreEndBeat(score),
    updatedAt: score.updatedAt,
    sourceKind: score.source?.kind ?? 'manual',
    favorite: false,
  };
}

export class AppStorage {
  private settings: AppSettings = structuredClone(DEFAULT_SETTINGS);
  private scores = new Map<string, Score>();
  private get settingsPath(): string {
    return path.join(this.userDataDir, 'settings.json');
  }
  private get scoresDir(): string {
    return path.join(this.userDataDir, 'scores');
  }

  constructor(private readonly userDataDir: string) {}

  async init(): Promise<{ seeded: number }> {
    await ensureDir(this.userDataDir);
    await ensureDir(this.scoresDir);
    await this.loadSettings();
    const seeded = await this.loadScores();
    return { seeded };
  }

  private async loadSettings(): Promise<void> {
    try {
      const raw = await fs.readFile(this.settingsPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      this.settings = mergeSettings(DEFAULT_SETTINGS, parsed);
    } catch {
      this.settings = structuredClone(DEFAULT_SETTINGS);
      await writeJsonAtomic(this.settingsPath, this.settings);
    }
  }

  private async loadScores(): Promise<number> {
    const files = (await fs.readdir(this.scoresDir).catch(() => [] as string[])).filter((name) => name.endsWith('.dfh.json'));
    for (const fileName of files) {
      try {
        const raw = await fs.readFile(path.join(this.scoresDir, fileName), 'utf8');
        const score = normalizeLoadedScore(JSON.parse(raw));
        if (score && SAFE_ID.test(score.id)) this.scores.set(score.id, score);
      } catch {
        // 单个损坏文件不影响整体启动
      }
    }
    if (this.scores.size === 0) {
      return this.seedBuiltinScores();
    }
    return 0;
  }

  private async seedBuiltinScores(): Promise<number> {
    let seeded = 0;
    for (const builtin of BUILTIN_SCORES) {
      try {
        const { score, diagnostics } = buildScoreFromText(builtin.text, { source: { kind: 'builtin', importedAt: new Date().toISOString() } });
        const fatal = diagnostics.filter((item) => item.severity === 'error');
        if (fatal.length > 0) continue;
        await this.save(score);
        seeded += 1;
      } catch {
        // 内置曲库有问题时静默跳过，保证应用能启动
      }
    }
    return seeded;
  }

  getSettings(): AppSettings {
    return this.settings;
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.settings = mergeSettings(this.settings, patch);
    this.settings.version = 1;
    await writeJsonAtomic(this.settingsPath, this.settings);
    return this.settings;
  }

  list(): LibraryEntry[] {
    const favorites = new Set(this.settings.favorites ?? []);
    return [...this.scores.values()]
      .map((score) => ({ ...toLibraryEntry(score), favorite: favorites.has(score.id) }))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.title.localeCompare(b.title, 'zh-CN')));
  }

  get(id: string): Score | null {
    if (!SAFE_ID.test(id)) return null;
    const score = this.scores.get(id);
    return score ? structuredClone(score) : null;
  }

  async save(input: Score): Promise<LibraryEntry> {
    const score: Score = structuredClone(input);
    if (!SAFE_ID.test(score.id)) {
      throw new Error(`曲谱 id 非法：${score.id}`);
    }
    score.updatedAt = new Date().toISOString();
    if (!score.createdAt) score.createdAt = score.updatedAt;
    if (!score.source) score.source = { kind: 'manual', importedAt: score.createdAt };
    await writeJsonAtomic(path.join(this.scoresDir, `${score.id}.dfh.json`), score);
    this.scores.set(score.id, score);
    const favorites = new Set(this.settings.favorites ?? []);
    return { ...toLibraryEntry(score), favorite: favorites.has(score.id) };
  }

  async remove(id: string): Promise<boolean> {
    if (!SAFE_ID.test(id)) return false;
    const removed = this.scores.delete(id);
    await fs.unlink(path.join(this.scoresDir, `${id}.dfh.json`)).catch(() => undefined);
    if ((this.settings.favorites ?? []).includes(id)) {
      await this.updateSettings({ favorites: (this.settings.favorites ?? []).filter((item) => item !== id) });
    }
    return removed;
  }

  async toggleFavorite(id: string): Promise<string[]> {
    const favorites = new Set(this.settings.favorites ?? []);
    if (favorites.has(id)) favorites.delete(id);
    else favorites.add(id);
    const next = [...favorites];
    await this.updateSettings({ favorites: next });
    return next;
  }
}
