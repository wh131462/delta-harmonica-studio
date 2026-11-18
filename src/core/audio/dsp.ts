/**
 * 音频 DSP 内部工具（非对外 API，仅供 pitch/onset 模块复用）：
 * - 数值夹取、取整；
 * - 2 的幂与 radix-2 复数 FFT / IFFT（YIN 自相关与谱通量共用）；
 * - 线性重采样（高采样率音频降到 22050Hz 用）；
 * - 峰值归一化。
 *
 * 纯 TypeScript 实现，零第三方依赖，可在 Node 环境直接运行。
 */

/** 预计算旋转因子缓存：同一 FFT 长度只算一次，避免逐帧三角函数开销 */
const twiddleCache = new Map<number, { readonly cos: Float64Array; readonly sin: Float64Array }>();

function getTwiddles(size: number): { cos: Float64Array; sin: Float64Array } {
  const cached = twiddleCache.get(size);
  if (cached) return cached;
  const half = size >>> 1;
  const cos = new Float64Array(half);
  const sin = new Float64Array(half);
  for (let i = 0; i < half; i += 1) {
    const angle = (-2 * Math.PI * i) / size;
    cos[i] = Math.cos(angle);
    sin[i] = Math.sin(angle);
  }
  const entry = { cos, sin };
  twiddleCache.set(size, entry);
  return entry;
}

/** 把 value 夹到 [min, max]；输入 NaN 时返回 min */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return value < min ? min : value > max ? max : value;
}

/** 四舍五入到指定小数位（避免浮点噪声进入对外结果） */
export function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** 小于等于 value 的最大 2 的幂（至少为 1） */
export function prevPowerOfTwo(value: number): number {
  if (!Number.isFinite(value) || value < 1) return 1;
  let size = 1;
  while (size * 2 <= value) size *= 2;
  return size;
}

/**
 * 原地 radix-2 复数 FFT（Cooley-Tukey，输入长度必须是 2 的幂）。
 * re/im 分别保存实部、虚部；变换后为频域。
 */
export function fftInPlace(re: Float64Array, im: Float64Array): void {
  const size = re.length;
  if (size <= 1) return;
  if (im.length !== size) throw new Error('FFT 实部/虚部长度必须一致');
  if ((size & (size - 1)) !== 0) throw new Error('FFT 长度必须为 2 的幂');

  // 位反转置换
  for (let i = 1, j = 0; i < size; i += 1) {
    let bit = size >>> 1;
    while ((j & bit) !== 0) {
      j ^= bit;
      bit >>>= 1;
    }
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  const { cos, sin } = getTwiddles(size);
  for (let len = 2; len <= size; len *= 2) {
    const half = len >>> 1;
    const step = size / len;
    for (let start = 0; start < size; start += len) {
      for (let k = 0; k < half; k += 1) {
        const tw = k * step;
        const wr = cos[tw];
        const wi = sin[tw];
        const a = start + k;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

/** 原地离散傅里叶逆变换：conj → FFT → conj / N */
export function ifftInPlace(re: Float64Array, im: Float64Array): void {
  const size = re.length;
  if (size <= 1) return;
  for (let i = 0; i < size; i += 1) im[i] = -im[i];
  fftInPlace(re, im);
  const scale = 1 / size;
  for (let i = 0; i < size; i += 1) {
    re[i] *= scale;
    im[i] *= -scale;
  }
}

/**
 * 线性插值重采样。
 * - 采样率相同时直接返回原数组（不复制，调用方不得再原地修改）；
 * - 降采样未做抗混叠滤波（线性插值本身相当于一阶低通），对起音/基频检测足够。
 */
export function resampleLinear(pcm: Float32Array, srcRate: number, dstRate: number): Float32Array {
  if (pcm.length === 0) return new Float32Array(0);
  if (!(srcRate > 0) || !(dstRate > 0) || srcRate === dstRate) return pcm;
  const outLength = Math.max(1, Math.round((pcm.length * dstRate) / srcRate));
  const out = new Float32Array(outLength);
  const step = srcRate / dstRate;
  const last = pcm.length - 1;
  for (let i = 0; i < outLength; i += 1) {
    const position = i * step;
    const index = Math.floor(position);
    if (index >= last) {
      out[i] = pcm[last];
      continue;
    }
    const frac = position - index;
    const a = pcm[index];
    out[i] = a + (pcm[index + 1] - a) * frac;
  }
  return out;
}

/**
 * 原地峰值归一化到 ±1，返回归一化前的峰值（用于判断静音/低音量）。
 */
export function peakNormalizeInPlace(pcm: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < pcm.length; i += 1) {
    const value = Math.abs(pcm[i]);
    if (value > peak) peak = value;
  }
  if (peak > 0 && Number.isFinite(peak)) {
    const gain = 1 / peak;
    for (let i = 0; i < pcm.length; i += 1) pcm[i] *= gain;
  }
  return peak;
}
