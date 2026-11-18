/**
 * 真实采样音源回归：音区表覆盖 C3–C6、每个音符只命中一个采样、文件真实存在。
 * 采样来源与许可见 resources/audio-samples/README.md。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  HARMONICA_ZONES,
  PIANO_ZONES,
  SAMPLE_ZONES,
  selectZone,
} from '@renderer/audio/sample-manifest';

const SAMPLE_ROOT = fileURLToPath(new URL('../resources/audio-samples', import.meta.url));
const GAME_LOW = 48; // C3
const GAME_HIGH = 84; // C6
// 采样是二进制大文件，可能通过 LFS 或发布前脚本准备；缺失时跳过，发布工作流会单独校验。
const HAS_SAMPLES = existsSync(SAMPLE_ROOT);

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else out.push(full);
  }
  return out;
}

describe.skipIf(!HAS_SAMPLES)('真实采样音区表', () => {
  it('口琴与钢琴都完整覆盖 C3–C6', () => {
    for (const zones of [HARMONICA_ZONES, PIANO_ZONES]) {
      for (let midi = GAME_LOW; midi <= GAME_HIGH; midi += 1) {
        const zone = selectZone(zones, midi);
        expect(zone, `MIDI ${midi} 没有采样`).toBeTruthy();
        expect(midi).toBeGreaterThanOrEqual(zone.low);
        expect(midi).toBeLessThanOrEqual(zone.high);
      }
    }
  });

  it('音区之间不重叠，避免同一个音随机换采样', () => {
    for (const zones of [HARMONICA_ZONES, PIANO_ZONES]) {
      const sorted = [...zones].sort((a, b) => a.low - b.low);
      for (let index = 1; index < sorted.length; index += 1) {
        expect(sorted[index].low).toBeGreaterThan(sorted[index - 1].high);
      }
    }
  });

  it('超音域时选最接近的采样，而不是静音', () => {
    expect(selectZone(HARMONICA_ZONES, 24).root).toBe(60);
    expect(selectZone(HARMONICA_ZONES, 108).root).toBe(96);
    expect(selectZone(PIANO_ZONES, 24).root).toBe(48);
    expect(selectZone(PIANO_ZONES, 108).root).toBe(84);
    expect(selectZone(HARMONICA_ZONES, 51).root).toBe(60);
    expect(selectZone(PIANO_ZONES, 61).root).toBe(60);
  });

  it('音区表没有重复文件，且所有采样文件真实存在', () => {
    const all = [...HARMONICA_ZONES, ...PIANO_ZONES];
    const files = all.map((zone) => zone.file);
    expect(new Set(files).size).toBe(files.length);
    for (const file of files) {
      const stat = statSync(join(SAMPLE_ROOT, file));
      expect(stat.isFile()).toBe(true);
      expect(stat.size).toBeGreaterThan(1024);
    }
  });

  it('目录里没有音区表之外的多余音频，避免安装包夹带未授权素材', () => {
    const onDisk = filesUnder(SAMPLE_ROOT)
      .filter((file) => ['.wav', '.mp3'].includes(extname(file).toLowerCase()))
      .map((file) => file.slice(SAMPLE_ROOT.length + 1).replaceAll('\\', '/'))
      .sort();
    const declared = [...SAMPLE_ZONES.harmonica, ...SAMPLE_ZONES.piano]
      .map((zone) => zone.file)
      .sort();
    expect(onDisk).toEqual(declared);
  });

  it('口琴采样是 48kHz / 24bit 的 2.5s WAV', () => {
    for (const zone of HARMONICA_ZONES) {
      const data = readFileSync(join(SAMPLE_ROOT, zone.file));
      expect(data.toString('ascii', 0, 4)).toBe('RIFF');
      expect(data.toString('ascii', 8, 12)).toBe('WAVE');
      const channels = data.readUInt16LE(22);
      const sampleRate = data.readUInt32LE(24);
      const bits = data.readUInt16LE(34);
      const bytesPerSecond = data.readUInt32LE(28);
      const dataSize = data.readUInt32LE(40);
      expect(channels).toBe(1);
      expect(sampleRate).toBe(48000);
      expect(bits).toBe(24);
      expect(dataSize / bytesPerSecond).toBeCloseTo(2.5, 2);
    }
  });

  it('钢琴采样是有效的 MP3 文件', () => {
    for (const zone of PIANO_ZONES) {
      const data = readFileSync(join(SAMPLE_ROOT, zone.file));
      const isId3 = data.toString('ascii', 0, 3) === 'ID3';
      const isFrame = data[0] === 0xff && (data[1] & 0xe0) === 0xe0;
      expect(isId3 || isFrame, zone.file).toBe(true);
    }
  });

  it('口琴采样根音与实测基频一致（VCSL 文件名低了一个八度）', () => {
    for (const zone of HARMONICA_ZONES) {
      const { samples, sampleRate } = readMono24(join(SAMPLE_ROOT, zone.file));
      const start = Math.floor(sampleRate * 0.8);
      const end = Math.floor(sampleRate * 1.8);
      const segment = samples.subarray(start, end);
      const rootHz = midiToHz(zone.root);
      const octaveUpHz = midiToHz(zone.root + 12);
      const rootPower = goertzel(segment, sampleRate, rootHz);
      const octavePower = goertzel(segment, sampleRate, octaveUpHz);
      // 根音应有可测能量；若 root 标低一个八度，能量会落到 2×root 上，比值趋近 0。
      expect(rootPower / octavePower, zone.file).toBeGreaterThan(0.01);
    }
  });
});

function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

function readMono24(path: string): { samples: Float32Array; sampleRate: number } {
  const data = readFileSync(path);
  const sampleRate = data.readUInt32LE(24);
  const dataSize = data.readUInt32LE(40);
  const frames = Math.floor(dataSize / 3);
  const samples = new Float32Array(frames);
  for (let index = 0; index < frames; index += 1) {
    const offset = 44 + index * 3;
    const raw = data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16);
    const signed = (raw << 8) >> 8;
    samples[index] = signed / 8388608;
  }
  return { samples, sampleRate };
}

/** Goertzel 单频能量；加 Hann 窗压住相邻谐波泄漏。 */
function goertzel(samples: Float32Array, sampleRate: number, frequency: number): number {
  const omega = (2 * Math.PI * frequency) / sampleRate;
  const coefficient = 2 * Math.cos(omega);
  let previous = 0;
  let beforePrevious = 0;
  const length = samples.length;
  for (let index = 0; index < length; index += 1) {
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (length - 1));
    const value = samples[index] * window + coefficient * previous - beforePrevious;
    beforePrevious = previous;
    previous = value;
  }
  return (
    previous * previous +
    beforePrevious * beforePrevious -
    coefficient * previous * beforePrevious
  );
}
