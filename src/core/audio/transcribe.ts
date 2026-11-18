/**
 * 音频 → 主旋律转谱主流程（纯 TypeScript，零第三方依赖）。
 *
 * 管线：峰值归一化 → 线性降采样到 22050Hz → 谱通量起音 + 自相关 BPM 估计
 *       → YIN 基频帧 → 中值滤波/离群回填 → 音符切分（迟滞阈值）→ 碎音合并/过滤。
 *
 * 输出的是“原始音符”（秒），不做节拍量化/调性判断（由上层 melody-to-score 负责）。
 */
import { clamp, peakNormalizeInPlace, resampleLinear, roundTo } from './dsp';
import { detectOnsets } from './onset';
import {
  DEFAULT_CLARITY_THRESHOLD,
  extractPitchFrames,
  midiToFreq,
  type PitchFrame,
} from './pitch';
import { estimateTempo } from './tempo';

export interface TranscribeOptions {
  /** 采样率（Hz）；函数入参 sampleRate 优先，此处保留以兼容 UI 传入的配置对象 */
  sampleRate: number;
  /** 音高分析帧长（分析采样率下的样本数），默认 1024 */
  frameSize?: number;
  /** 音高分析帧移（样本），默认 frameSize / 4 */
  hopSize?: number;
  /** 最短音符时长（毫秒），默认 70 */
  minNoteMs?: number;
  /** 帧级 clarity 阈值，默认 0.12（内部另有 0.3 抗噪下限） */
  clarityThreshold?: number;
  /** 最低 MIDI 音高，默认 36（C2） */
  minMidi?: number;
  /** 最高 MIDI 音高，默认 96（C7） */
  maxMidi?: number;
  /** 最大音符数，默认 2000，超出截断 */
  maxNotes?: number;
  /** 分析起点（秒），默认 0；输出时间相对该片段起点 */
  startSec?: number;
  /** 分析终点（秒），默认到音频末尾 */
  endSec?: number;
}

export interface TranscribedNote {
  /** MIDI 音高（整数） */
  midi: number;
  /** 起始时间（秒，相对分析片段起点） */
  startSec: number;
  /** 持续时长（秒） */
  durSec: number;
  /** 音符置信度 0..1 */
  confidence: number;
}

export interface TranscriptionResult {
  notes: TranscribedNote[];
  /** 估计 BPM；节拍置信度过低时回退为 100 */
  bpm: number;
  /** BPM 置信度 0..1 */
  bpmConfidence: number;
  warnings: string[];
  /** 有音高帧占比 0..1 */
  voicedRatio: number;
  /** 参与分析的音高帧数量 */
  frameCount: number;
}

/** 默认最短音符时长（毫秒） */
export const DEFAULT_MIN_NOTE_MS = 70;
/** BPM 置信度低于该值时回退为 100 */
const LOW_BPM_CONFIDENCE = 0.3;
/** 估计节拍所需的最少起音点数量：太少时自相关噪声会给出虚假高置信度 */
const MIN_ONSETS_FOR_TEMPO = 4;
/** 兜底 BPM（与上层量化解耦，仅作展示/拖拽参考） */
const FALLBACK_BPM = 100;
/** 高采样率输入的内部降采样上限（控制 3 分钟音频耗时） */
const MAX_ANALYSIS_RATE = 24000;
const TARGET_ANALYSIS_RATE = 22050;
/** 峰值低于该值视为静音 */
const SILENCE_PEAK = 1e-4;
/** 峰值低于该值给出“音量偏低”提示 */
const LOW_VOLUME_PEAK = 0.01;
/** 相邻帧 MIDI 差 ≤ 该值视为同音（半音） */
const PITCH_SAME_TOLERANCE = 0.7;
/** 超过该值的强跳变立即切分（半音） */
const PITCH_HOLD_TOLERANCE = 1.15;
/** 中值滤波半径（帧）：5 帧窗口抑制震音/八度抖动 */
const MEDIAN_RADIUS = 2;
/** 音符边界确认窗口（帧） */
const BOUNDARY_CONFIRM_FRAMES = 2;
/** 合并/消除碎音的最大间隔（秒） */
const NOTE_MERGE_GAP_SEC = 0.03;
/** 长静音切分阈值（秒）：超过该时长的无声段会断开音符 */
const LONG_SILENCE_SEC = 0.03;

/** 有理数中值（会原地排序传入数组） */
function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  values.sort((a, b) => a - b);
  const middle = values.length >> 1;
  return values.length % 2 === 1
    ? values[middle]
    : 0.5 * (values[middle - 1] + values[middle]);
}

interface RawNote {
  startSec: number;
  endSec: number;
  midi: number;
  confidence: number;
}

interface NoteBuildOptions {
  /** 帧移对应时长（秒） */
  hopSec: number;
  minNoteMs: number;
  clarityThreshold: number;
  minMidi: number;
  maxMidi: number;
  /** 分析片段总时长（秒） */
  totalSec: number;
}

/**
 * 音高轨迹后处理 + 音符切分：
 * 1. 短暂无声帧回填（两侧音高接近）；
 * 2. 5 帧中值滤波抑制震音/八度抖动，离群八度回填；
 * 3. 迟滞切分：偏离 >0.7 半音且持续 2 帧才切，>1.15 半音的强跳变立即切；
 * 4. 合并间隔 ≤30ms 的同音碎音，过滤 < minNoteMs 的碎音。
 */
function buildTranscribedNotes(frames: PitchFrame[], options: NoteBuildOptions): TranscribedNote[] {
  const count = frames.length;
  if (count === 0) return [];

  const voiced = new Uint8Array(count);
  const midiTrack = new Float64Array(count);
  const clarityTrack = new Float64Array(count);
  for (let i = 0; i < count; i += 1) {
    const frame = frames[i];
    clarityTrack[i] = frame.clarity;
    if (
      frame.freq > 0
      && frame.clarity >= options.clarityThreshold
      && frame.midi >= options.minMidi - 0.5
      && frame.midi <= options.maxMidi + 0.5
    ) {
      voiced[i] = 1;
      midiTrack[i] = frame.midi;
    }
  }

  // 1) 单帧离群回填：两侧都有声且音高接近时，把中间帧插值补回
  for (let i = 1; i < count - 1; i += 1) {
    if (voiced[i] || !voiced[i - 1] || !voiced[i + 1]) continue;
    if (Math.abs(midiTrack[i - 1] - midiTrack[i + 1]) > 1.5) continue;
    voiced[i] = 1;
    midiTrack[i] = 0.5 * (midiTrack[i - 1] + midiTrack[i + 1]);
    clarityTrack[i] = Math.min(clarityTrack[i - 1], clarityTrack[i + 1]);
  }

  // 2) 5 帧中值滤波（只统计有声帧，避免无声帧把音高拉向 0）
  const smoothed = new Float64Array(count);
  const windowBuffer: number[] = [];
  for (let i = 0; i < count; i += 1) {
    if (!voiced[i]) continue;
    windowBuffer.length = 0;
    const lo = Math.max(0, i - MEDIAN_RADIUS);
    const hi = Math.min(count - 1, i + MEDIAN_RADIUS);
    for (let j = lo; j <= hi; j += 1) {
      if (voiced[j]) windowBuffer.push(midiTrack[j]);
    }
    smoothed[i] = medianOf(windowBuffer);
  }

  // 2b) 八度离群回填：单帧比两侧高/低超过 7 个半音、而两侧彼此接近时替换为两侧均值
  for (let pass = 0; pass < 2; pass += 1) {
    let changed = false;
    for (let i = 1; i < count - 1; i += 1) {
      if (!voiced[i] || !voiced[i - 1] || !voiced[i + 1]) continue;
      const left = smoothed[i - 1];
      const right = smoothed[i + 1];
      if (Math.abs(smoothed[i] - left) > 7 && Math.abs(left - right) < 2) {
        smoothed[i] = 0.5 * (left + right);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // 3) 状态机切分音符（迟滞阈值 + 持续确认，避免震音/过渡帧把音符切碎）
  //    - 偏离当前参考音高 ≤0.7 半音：延续当前音符，参考音高取最近 5 帧中值缓慢跟随；
  //    - 偏离 >0.7：进入“切换候选”，连续 2 帧候选音高与当前参考差 >0.7 才切分；
  //    - 偏离 >1.15：强跳变（八度/大跳）立即切分；
  //    - 候选未持续（颤音/过渡）：候选帧并回原音符，不产生碎音。
  const maxGapFrames = Math.max(1, Math.round(LONG_SILENCE_SEC / options.hopSec));
  const rawNotes: RawNote[] = [];

  let noteStart = -1;
  let noteEnd = -1;
  let notePitches: number[] = [];
  let noteClarities: number[] = [];
  let refPitch = 0;
  let unvoicedRun = 0;
  let candidateStart = -1;
  let candidatePitches: number[] = [];
  let candidateClarities: number[] = [];

  const resetCandidate = (): void => {
    candidateStart = -1;
    candidatePitches = [];
    candidateClarities = [];
  };

  const startNote = (startIndex: number, pitches: number[], clarities: number[]): void => {
    noteStart = startIndex;
    noteEnd = startIndex + pitches.length - 1;
    notePitches = pitches.slice();
    noteClarities = clarities.slice();
    refPitch = medianOf(pitches.slice(-5));
    resetCandidate();
  };

  const appendToNote = (index: number): void => {
    notePitches.push(smoothed[index]);
    noteClarities.push(clarityTrack[index]);
    noteEnd = index;
    refPitch = medianOf(notePitches.slice(Math.max(0, notePitches.length - 5)));
  };

  const flushNote = (): void => {
    if (noteStart >= 0 && noteEnd >= noteStart && notePitches.length > 0) {
      const midi = Math.round(medianOf(notePitches.slice()));
      if (midi >= options.minMidi && midi <= options.maxMidi) {
        // 首帧中心 - 半帧移 = 音符起点；末帧中心 + 半帧移 = 音符终点
        const startSec = Math.max(0, frames[noteStart].timeSec - options.hopSec * 0.5);
        const endSec = Math.min(options.totalSec, frames[noteEnd].timeSec + options.hopSec * 0.5);
        if (endSec > startSec) {
          rawNotes.push({
            startSec,
            endSec,
            midi,
            confidence: medianOf(noteClarities.slice()),
          });
        }
      }
    }
    noteStart = -1;
    noteEnd = -1;
    notePitches = [];
    noteClarities = [];
  };

  for (let i = 0; i < count; i += 1) {
    if (!voiced[i]) {
      // 候选帧在无声段前也要并回当前音符，避免丢失音符尾部
      if (candidateStart >= 0) {
        for (const pitch of candidatePitches) notePitches.push(pitch);
        for (const clarity of candidateClarities) noteClarities.push(clarity);
        if (candidatePitches.length > 0 && i > 0) noteEnd = i - 1;
        resetCandidate();
      }
      unvoicedRun += 1;
      if (noteStart >= 0 && unvoicedRun > maxGapFrames) flushNote();
      continue;
    }
    unvoicedRun = 0;

    if (noteStart < 0) {
      startNote(i, [smoothed[i]], [clarityTrack[i]]);
      continue;
    }

    const deviation = Math.abs(smoothed[i] - refPitch);

    if (candidateStart >= 0) {
      const candidateRef = medianOf(candidatePitches.slice(-5));
      if (Math.abs(smoothed[i] - candidateRef) > PITCH_SAME_TOLERANCE) {
        // 候选未持续：并回原音符后重新评估当前帧
        for (const pitch of candidatePitches) notePitches.push(pitch);
        for (const clarity of candidateClarities) noteClarities.push(clarity);
        if (candidatePitches.length > 0 && i > 0) noteEnd = i - 1;
        refPitch = medianOf(notePitches.slice(Math.max(0, notePitches.length - 5)));
        resetCandidate();
        const retryDeviation = Math.abs(smoothed[i] - refPitch);
        if (retryDeviation <= PITCH_SAME_TOLERANCE) {
          appendToNote(i);
        } else {
          candidateStart = i;
          candidatePitches = [smoothed[i]];
          candidateClarities = [clarityTrack[i]];
          if (retryDeviation > PITCH_HOLD_TOLERANCE) {
            flushNote();
            startNote(i, candidatePitches, candidateClarities);
          }
        }
        continue;
      }
      candidatePitches.push(smoothed[i]);
      candidateClarities.push(clarityTrack[i]);
      const candidateMedian = medianOf(candidatePitches.slice(-5));
      const shift = Math.abs(candidateMedian - refPitch);
      if (candidatePitches.length >= BOUNDARY_CONFIRM_FRAMES && shift > PITCH_SAME_TOLERANCE) {
        // 确认切换：旧音符在候选起点前结束，新音符从候选起点开始
        flushNote();
        startNote(candidateStart, candidatePitches, candidateClarities);
      }
      continue;
    }

    if (deviation <= PITCH_SAME_TOLERANCE) {
      appendToNote(i);
    } else {
      candidateStart = i;
      candidatePitches = [smoothed[i]];
      candidateClarities = [clarityTrack[i]];
      if (deviation > PITCH_HOLD_TOLERANCE) {
        // 强跳变立即切分
        flushNote();
        startNote(i, candidatePitches, candidateClarities);
      }
    }
  }
  flushNote();

  // 5) 合并/清理
  let notes: TranscribedNote[] = rawNotes.map((note) => ({
    midi: note.midi,
    startSec: roundTo(note.startSec, 4),
    durSec: roundTo(note.endSec - note.startSec, 4),
    confidence: roundTo(note.confidence, 3),
  }));

  // 5a) 同音高且间隔 ≤30ms 的碎音合并
  const merged: TranscribedNote[] = [];
  for (const note of notes) {
    const last = merged.length > 0 ? merged[merged.length - 1] : null;
    if (last) {
      const gap = note.startSec - (last.startSec + last.durSec);
      if (last.midi === note.midi && gap <= NOTE_MERGE_GAP_SEC) {
        const end = Math.max(last.startSec + last.durSec, note.startSec + note.durSec);
        last.durSec = roundTo(end - last.startSec, 4);
        last.confidence = roundTo(0.5 * (last.confidence + note.confidence), 3);
        continue;
      }
    }
    merged.push({ ...note });
  }
  notes = merged;

  // 5b) 消除 ≤30ms 的小间隙，让单声部时间轴连贯
  for (let i = 1; i < notes.length; i += 1) {
    const previous = notes[i - 1];
    const previousEnd = previous.startSec + previous.durSec;
    const gap = notes[i].startSec - previousEnd;
    if (gap > 0 && gap <= NOTE_MERGE_GAP_SEC) {
      previous.durSec = roundTo(notes[i].startSec - previous.startSec, 4);
    } else if (gap < 0) {
      // 防御性修正：避免相邻音符重叠
      const end = notes[i].startSec + notes[i].durSec;
      notes[i].startSec = roundTo(previousEnd, 4);
      notes[i].durSec = roundTo(Math.max(0.001, end - notes[i].startSec), 4);
    }
  }

  // 5c) 过滤过短音符：优先并入相邻同音高音符，否则丢弃
  const minDurSec = options.minNoteMs / 1000;
  const cleaned: TranscribedNote[] = [];
  for (const note of notes) {
    if (note.durSec >= minDurSec) {
      cleaned.push(note);
      continue;
    }
    const previous = cleaned.length > 0 ? cleaned[cleaned.length - 1] : null;
    if (previous && previous.midi === note.midi) {
      const end = Math.max(previous.startSec + previous.durSec, note.startSec + note.durSec);
      previous.durSec = roundTo(end - previous.startSec, 4);
      continue;
    }
    // 与后续音符同音高的碎音在这里直接丢弃（多半是颤音/过渡帧）
  }

  // 5d) 丢弃碎音后可能留下小间隙，再补一次
  for (let i = 1; i < cleaned.length; i += 1) {
    const previous = cleaned[i - 1];
    const gap = cleaned[i].startSec - (previous.startSec + previous.durSec);
    if (gap > 0 && gap <= NOTE_MERGE_GAP_SEC) {
      previous.durSec = roundTo(cleaned[i].startSec - previous.startSec, 4);
    }
  }

  return cleaned;
}

/**
 * 把单声道 PCM 转谱为主旋律音符。
 *
 * @param pcm 单声道 Float32 样本（约 -1..1，可含任意峰值，内部会归一化）
 * @param sampleRate 采样率（Hz）
 * @param options 部分可选的转谱参数；sampleRate 入参优先于 options.sampleRate
 *
 * 说明：
 * - 输出音符时间为相对分析片段起点的秒数（若传了 startSec/endSec）；
 * - 不依赖节拍做量化/吸附，bpm 仅作上层参考，低置信度时回退为 100 并给出 warning；
 * - 静音/纯噪声输入返回空 notes 与相应 warnings，不抛异常。
 */
export function transcribeMelody(
  pcm: Float32Array,
  sampleRate: number,
  options: Partial<TranscribeOptions> = {},
): TranscriptionResult {
  const warnings: string[] = [];
  const makeResult = (
    notes: TranscribedNote[],
    bpm: number,
    bpmConfidence: number,
    voicedRatio: number,
    frameCount: number,
  ): TranscriptionResult => ({
    notes,
    bpm,
    bpmConfidence,
    warnings,
    voicedRatio,
    frameCount,
  });

  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    warnings.push('采样率无效，无法进行音频分析');
    return makeResult([], FALLBACK_BPM, 0, 0, 0);
  }
  if (pcm.length === 0) {
    warnings.push('输入音频为空');
    return makeResult([], FALLBACK_BPM, 0, 0, 0);
  }

  const minMidi = clamp(Math.round(options.minMidi ?? 36), 0, 126);
  const maxMidi = clamp(Math.round(options.maxMidi ?? 96), minMidi + 1, 127);
  const minNoteMs = clamp(options.minNoteMs ?? DEFAULT_MIN_NOTE_MS, 5, 5000);
  const clarityThreshold = clamp(options.clarityThreshold ?? DEFAULT_CLARITY_THRESHOLD, 0, 1);
  const maxNotes = clamp(Math.floor(options.maxNotes ?? 2000), 1, 100000);
  const frameSize = Math.max(64, Math.floor(options.frameSize ?? 1024));
  const hopSize = Math.max(1, Math.floor(options.hopSize ?? (frameSize >> 2)));

  // 1) 按 startSec/endSec 裁剪（输出时间相对裁剪片段）
  const startSample = clamp(Math.floor((options.startSec ?? 0) * sampleRate), 0, pcm.length);
  const requestedEnd = options.endSec === undefined ? pcm.length / sampleRate : options.endSec;
  const endSample = clamp(Math.ceil(requestedEnd * sampleRate), 0, pcm.length);
  if (endSample - startSample < sampleRate * 0.02) {
    warnings.push('分析片段过短（<20ms），无法提取有效旋律');
    return makeResult([], FALLBACK_BPM, 0, 0, 0);
  }
  const segment = pcm.subarray(startSample, endSample);
  const clipSec = (endSample - startSample) / sampleRate;

  // 2) 峰值归一化（先复制，避免修改调用方数组）
  const normalized = segment.slice();
  const peak = peakNormalizeInPlace(normalized);
  if (!(peak > SILENCE_PEAK)) {
    warnings.push('输入音频能量过低（疑似静音），未检测到可用的旋律');
    return makeResult([], FALLBACK_BPM, 0, 0, 0);
  }
  if (peak < LOW_VOLUME_PEAK) {
    warnings.push(`输入音量偏低（峰值 ${roundTo(peak, 4)}），已自动归一化`);
  }

  // 3) 降采样到 22050Hz（高采样率归一化后线性重采样，控制耗时）
  const analysisRate = sampleRate > MAX_ANALYSIS_RATE ? TARGET_ANALYSIS_RATE : sampleRate;
  const analysisPcm = analysisRate === sampleRate ? normalized : resampleLinear(normalized, sampleRate, analysisRate);

  // 4) 节拍估计（起音包络 → 自相关）
  const onset = detectOnsets(analysisPcm, analysisRate);
  const tempo = estimateTempo(onset.envelope, onset.frameRate);
  let bpm = tempo.bpm;
  let bpmConfidence = tempo.confidence;
  const onsetCount = onset.times.length;
  if (onsetCount < MIN_ONSETS_FOR_TEMPO) {
    // 起音太少时包络几乎是噪声，自相关会偶然给出高置信度，这里直接回退
    bpm = FALLBACK_BPM;
    bpmConfidence = Math.min(bpmConfidence, 0.2);
    warnings.push(
      `起音点过少（${onsetCount} 个），无法可靠估计节拍，BPM 已回退为 ${FALLBACK_BPM}；量化交由上层处理`,
    );
  } else if (tempo.confidence < LOW_BPM_CONFIDENCE) {
    bpm = FALLBACK_BPM;
    warnings.push(
      `节拍置信度较低（${roundTo(tempo.confidence, 2)}），BPM 已回退为 ${FALLBACK_BPM}；量化交由上层处理`,
    );
  }

  // 5) 音高帧提取（YIN）
  const frames = extractPitchFrames(analysisPcm, analysisRate, {
    frameSize,
    hopSize,
    minFreq: midiToFreq(minMidi),
    maxFreq: midiToFreq(maxMidi),
    threshold: clarityThreshold,
  });
  if (frames.length === 0) {
    warnings.push('音频过短，无法提取音高帧');
    return makeResult([], bpm, bpmConfidence, 0, 0);
  }

  // 6) 音高轨迹后处理 + 音符切分
  const hopSec = hopSize / analysisRate;
  const notes = buildTranscribedNotes(frames, {
    hopSec,
    minNoteMs,
    clarityThreshold,
    minMidi,
    maxMidi,
    totalSec: clipSec,
  });

  // 7) 截断
  let finalNotes = notes;
  if (finalNotes.length > maxNotes) {
    finalNotes = finalNotes.slice(0, maxNotes);
    warnings.push(`音符数量超过上限（${maxNotes}），已截断`);
  }

  // 8) 统计
  let voicedFrames = 0;
  for (const frame of frames) {
    if (frame.freq > 0 && frame.clarity >= clarityThreshold) voicedFrames += 1;
  }
  const voicedRatio = roundTo(voicedFrames / frames.length, 3);
  if (finalNotes.length === 0) {
    warnings.push('未检测到稳定的旋律音符（可能是噪声、静音或复音混合）');
  }

  return makeResult(
    finalNotes,
    roundTo(bpm, 1),
    roundTo(bpmConfidence, 3),
    voicedRatio,
    frames.length,
  );
}
