/**
 * 真实采样音源的音区表。
 *
 * 口琴：VCSL「Hohner Special 20 C」口琴软力度层（CC0），48kHz / 24bit，
 *       每个采样 2.5s。VCSL 文件名的八度比实测基频低一个八度，这里按实测音高
 *       重新标注 root（例如文件 48.wav 的基频是 C4，root=60），游戏 C4–C6
 *       因此可以用原始速度播放，只有 C3–B3 才向下变速。
 * 钢琴：Salamander Grand Piano（Alexander Holm，CC BY 3.0），每 3 个半音一个采样，
 *       音域内最远只做 ±1 个半音的变速，保留真实琴弦与共鸣。
 *
 * 文件放在 resources/audio-samples/，由主进程通过 IPC 读取，避免 file:// 下的
 * fetch/CORS 限制，也让安装包可以直接替换/升级采样。
 */

export interface SampleZone {
  /** 相对 resources/audio-samples 的路径 */
  file: string;
  /** 采样原始音高（MIDI，按实测基频标注） */
  root: number;
  /** 该采样负责的最低 MIDI 音高 */
  low: number;
  /** 该采样负责的最高 MIDI 音高 */
  high: number;
}

export const HARMONICA_ZONES: readonly SampleZone[] = [
  { file: 'harmonica/48.wav', root: 60, low: 48, high: 62 },
  { file: 'harmonica/52.wav', root: 64, low: 63, high: 65 },
  { file: 'harmonica/55.wav', root: 67, low: 66, high: 69 },
  { file: 'harmonica/60.wav', root: 72, low: 70, high: 74 },
  { file: 'harmonica/64.wav', root: 76, low: 75, high: 77 },
  { file: 'harmonica/67.wav', root: 79, low: 78, high: 81 },
  { file: 'harmonica/72.wav', root: 84, low: 82, high: 86 },
  { file: 'harmonica/76.wav', root: 88, low: 87, high: 89 },
  { file: 'harmonica/79.wav', root: 91, low: 90, high: 93 },
  { file: 'harmonica/84.wav', root: 96, low: 94, high: 108 },
];

export const PIANO_ZONES: readonly SampleZone[] = [
  { file: 'piano/C3.mp3', root: 48, low: 48, high: 49 },
  { file: 'piano/Ds3.mp3', root: 51, low: 50, high: 52 },
  { file: 'piano/Fs3.mp3', root: 54, low: 53, high: 55 },
  { file: 'piano/A3.mp3', root: 57, low: 56, high: 58 },
  { file: 'piano/C4.mp3', root: 60, low: 59, high: 61 },
  { file: 'piano/Ds4.mp3', root: 63, low: 62, high: 64 },
  { file: 'piano/Fs4.mp3', root: 66, low: 65, high: 67 },
  { file: 'piano/A4.mp3', root: 69, low: 68, high: 70 },
  { file: 'piano/C5.mp3', root: 72, low: 71, high: 73 },
  { file: 'piano/Ds5.mp3', root: 75, low: 74, high: 76 },
  { file: 'piano/Fs5.mp3', root: 78, low: 77, high: 79 },
  { file: 'piano/A5.mp3', root: 81, low: 80, high: 82 },
  { file: 'piano/C6.mp3', root: 84, low: 83, high: 84 },
];

export const SAMPLE_ZONES = {
  harmonica: HARMONICA_ZONES,
  piano: PIANO_ZONES,
} as const;

/** 选中最接近目标音高的采样；音域内优先使用覆盖该音的采样。 */
export function selectZone(zones: readonly SampleZone[], midi: number): SampleZone {
  const rounded = Number.isFinite(midi) ? Math.round(midi) : 60;
  const covering = zones.find((zone) => rounded >= zone.low && rounded <= zone.high);
  if (covering) return covering;
  return zones.reduce((best, zone) =>
    Math.abs(zone.root - rounded) < Math.abs(best.root - rounded) ? zone : best,
  );
}
