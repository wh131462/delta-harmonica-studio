/**
 * 《三角洲行动》守夜人口琴 物理键位模型（S11 群星赛季实测/社区资料）：
 * - 8 个音键：Z X C V B N M ,  → 1 2 3 4 5 6 7 高音1
 * - 鼠标右键 = 升八度，左键 = 降八度，中键 = 升半音（可组合）
 * 绝对音高为约定值（游戏内固定调，默认以 1=C4=60 表示，便于与 MIDI / 简谱互通）。
 */

export type KeyId = 'k1' | 'k2' | 'k3' | 'k4' | 'k5' | 'k6' | 'k7' | 'k8';

export type MouseButton = 'left' | 'middle' | 'right';

export interface NoteKeyBinding {
  id: KeyId;
  /** 界面显示名（物理键） */
  label: string;
  /** Windows 虚拟键码 */
  vk: number;
  /** PC 扫描码 Set 1 */
  scan: number;
  /** 该键在本位（无鼠标修饰）时的 MIDI 音高 */
  baseMidi: number;
  /** 简谱级数（1-7；高音 1 键记为 8） */
  degree: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
}

export interface HarmonicaInstrument {
  id: string;
  name: string;
  noteKeys: NoteKeyBinding[];
  /** 八度修饰：按住左键降八度、右键升八度 */
  octaveButtons: { down: MouseButton; up: MouseButton };
  /** 半音修饰：按住中键升半音 */
  semitoneButton: MouseButton;
  /** 是否允许同时按住八度键与半音键（允许时可吹出全部半音） */
  allowModifierCombos: boolean;
  note: string;
}

/** 每个音键最多 ±1 个八度修饰 */
export const MAX_OCTAVE_SHIFT = 1;

export const DEFAULT_HARMONICA: HarmonicaInstrument = {
  id: 'df-vigil-harmonica-pc',
  name: '守夜人口琴（PC）',
  noteKeys: [
    { id: 'k1', label: 'Z', vk: 0x5a, scan: 0x2c, baseMidi: 60, degree: 1 },
    { id: 'k2', label: 'X', vk: 0x58, scan: 0x2d, baseMidi: 62, degree: 2 },
    { id: 'k3', label: 'C', vk: 0x43, scan: 0x2e, baseMidi: 64, degree: 3 },
    { id: 'k4', label: 'V', vk: 0x56, scan: 0x2f, baseMidi: 65, degree: 4 },
    { id: 'k5', label: 'B', vk: 0x42, scan: 0x30, baseMidi: 67, degree: 5 },
    { id: 'k6', label: 'N', vk: 0x4e, scan: 0x31, baseMidi: 69, degree: 6 },
    { id: 'k7', label: 'M', vk: 0x4d, scan: 0x32, baseMidi: 71, degree: 7 },
    { id: 'k8', label: ',', vk: 0xbc, scan: 0x33, baseMidi: 72, degree: 8 },
  ],
  octaveButtons: { down: 'left', up: 'right' },
  semitoneButton: 'middle',
  allowModifierCombos: true,
  note: 'PC 端口琴：8 个音键 + 鼠标左/右八度、中键半音',
};

export interface PhysicalCombo {
  keyId: KeyId;
  keyLabel: string;
  vk: number;
  scan: number;
  degree: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  /** -1 = 按住左键，0 = 无，+1 = 按住右键 */
  octaveShift: -1 | 0 | 1;
  /** 0 = 本位，1 = 按住中键升半音 */
  semitone: 0 | 1;
  midi: number;
  /** 需要按住的鼠标键数量 */
  modCount: number;
  mods: MouseButton[];
  /** 稳定 id，用于优化器的 DP 状态 */
  comboKey: string;
}

export function comboKeyOf(combo: Pick<PhysicalCombo, 'keyId' | 'octaveShift' | 'semitone'>): string {
  return `${combo.keyId}:${combo.octaveShift}:${combo.semitone}`;
}

export function modsOf(instrument: HarmonicaInstrument, octaveShift: number, semitone: number): MouseButton[] {
  const mods: MouseButton[] = [];
  if (octaveShift < 0) mods.push(instrument.octaveButtons.down);
  if (octaveShift > 0) mods.push(instrument.octaveButtons.up);
  if (semitone > 0) mods.push(instrument.semitoneButton);
  return mods;
}

let comboCache: { instrument: HarmonicaInstrument; combos: PhysicalCombo[]; byMidi: Map<number, PhysicalCombo[]> } | null = null;

/** 枚举全部合法物理组合（每个音键 × 八度修饰 × 半音修饰） */
export function allCombos(instrument: HarmonicaInstrument = DEFAULT_HARMONICA): PhysicalCombo[] {
  if (comboCache && comboCache.instrument === instrument) return comboCache.combos;
  const combos: PhysicalCombo[] = [];
  for (const key of instrument.noteKeys) {
    const octaveShifts: Array<-1 | 0 | 1> = instrument.allowModifierCombos
      ? [-1, 0, 1]
      : [-1, 0, 1];
    for (const octaveShift of octaveShifts) {
      const semitones: Array<0 | 1> = instrument.allowModifierCombos ? [0, 1] : [0, 1];
      for (const semitone of semitones) {
        // 兼容模式：一次只能按住一个鼠标修饰键
        if (!instrument.allowModifierCombos && octaveShift !== 0 && semitone === 1) continue;
        const midi = key.baseMidi + 12 * octaveShift + semitone;
        const mods = modsOf(instrument, octaveShift, semitone);
        combos.push({
          keyId: key.id,
          keyLabel: key.label,
          vk: key.vk,
          scan: key.scan,
          degree: key.degree,
          octaveShift,
          semitone,
          midi,
          modCount: mods.length,
          mods,
          comboKey: comboKeyOf({ keyId: key.id, octaveShift, semitone }),
        });
      }
    }
  }
  const byMidi = new Map<number, PhysicalCombo[]>();
  for (const combo of combos) {
    const list = byMidi.get(combo.midi) ?? [];
    list.push(combo);
    byMidi.set(combo.midi, list);
  }
  for (const list of byMidi.values()) {
    list.sort(
      (a, b) =>
        a.modCount - b.modCount ||
        Math.abs(a.octaveShift) - Math.abs(b.octaveShift) ||
        a.semitone - b.semitone ||
        a.degree - b.degree,
    );
  }
  comboCache = { instrument, combos, byMidi };
  return combos;
}

export function combosForMidi(midi: number, instrument: HarmonicaInstrument = DEFAULT_HARMONICA): PhysicalCombo[] {
  allCombos(instrument);
  return comboCache?.byMidi.get(Math.round(midi)) ?? [];
}

export function instrumentRange(instrument: HarmonicaInstrument = DEFAULT_HARMONICA): { min: number; max: number } {
  const combos = allCombos(instrument);
  let min = Infinity;
  let max = -Infinity;
  for (const combo of combos) {
    min = Math.min(min, combo.midi);
    max = Math.max(max, combo.midi);
  }
  return { min, max };
}

/** 是否为连续半音可演奏（理论上全部 12 个半音） */
export function isChromatic(instrument: HarmonicaInstrument = DEFAULT_HARMONICA): boolean {
  const { min, max } = instrumentRange(instrument);
  for (let midi = min; midi <= max; midi += 1) {
    if (combosForMidi(midi, instrument).length === 0) return false;
  }
  return true;
}

/** 单个音的最佳（修饰键最少）组合；超出音域返回 undefined */
export function bestCombo(midi: number, instrument: HarmonicaInstrument = DEFAULT_HARMONICA): PhysicalCombo | undefined {
  return combosForMidi(midi, instrument)[0];
}

/** 把音高折返进音域（默认在 ±2 个八度内寻找最近的同音级音） */
export function foldIntoRange(
  midi: number,
  instrument: HarmonicaInstrument = DEFAULT_HARMONICA,
  maxOctaveDistance = 3,
): { midi: number; octaves: number } | null {
  const { min, max } = instrumentRange(instrument);
  if (midi >= min && midi <= max) return { midi, octaves: 0 };
  for (let distance = 1; distance <= maxOctaveDistance; distance += 1) {
    for (const direction of [-1, 1]) {
      const candidate = midi + direction * 12 * distance;
      if (candidate >= min && candidate <= max && combosForMidi(candidate, instrument).length > 0) {
        return { midi: candidate, octaves: direction * distance };
      }
    }
  }
  return null;
}

/** 生成人类可读的按键记号，例如 "↑Z"（右键升八度）、"↓#Z"（左键降八度 + 中键升半音） */
export function formatCombo(combo: PhysicalCombo | undefined): string {
  if (!combo) return '—';
  let prefix = '';
  if (combo.octaveShift > 0) prefix += '↑';
  if (combo.octaveShift < 0) prefix += '↓';
  if (combo.semitone > 0) prefix += '#';
  return `${prefix}${combo.keyLabel}`;
}

export function comboModsLabel(combo: PhysicalCombo): string {
  if (combo.mods.length === 0) return '';
  const names = combo.mods.map((mod) => (mod === 'left' ? '左键' : mod === 'right' ? '右键' : '中键'));
  return `按住${names.join('+')}`;
}
