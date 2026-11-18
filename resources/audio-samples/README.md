# 真实音源采样 / Audio Samples

本目录只包含应用试听用的真实乐器采样，不包含游戏本体音频，也不包含任何从游戏中提取的资源。

## 口琴 / Harmonica

- **来源**：[VCSL — Versilian Community Sample Library](https://github.com/sgossner/VCSL) 的
  `Aerophones/Free Aerophones/Harmonica-Hohner-Special20-C`（Hohner Special 20 C 口琴，软力度层）。
- **整理包**：[Winds Studio harmonica sample pack](https://huggingface.co/AEmotionStudio/windstudio-harmonica-samples)
  （从 VCSL 提取的 48kHz / 24bit 单声道 WAV，每个音区 2.5s，峰值归一化到 −3dBFS）。
- **许可**：[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)（公共领域，可商用，无需署名）。
- **文件名**：`48.wav`–`84.wav` 沿用 VCSL 的原始文件名；实测基频比文件名高一个八度
  （例如 `48.wav` 实际是 C4 / MIDI 60），应用内 `sample-manifest.ts` 已按实测音高标注 root。
- **修改**：仅重命名文件；运行时会为长音在 1.15s–2.10s 之间做 120ms 尾首交叉淡化，
  以便无缝循环，原始 WAV 文件未改动。

## 钢琴 / Piano

- **来源**：[Salamander Grand Piano](https://freepats.zenvoid.org/Piano/acoustic-grand-piano.html)，
  由 Alexander Holm 录制；本项目使用 Tone.js 分发的 MP3 版本
  （<https://tonejs.github.io/audio/salamander/>）。
- **许可**：[Creative Commons Attribution 3.0](https://creativecommons.org/licenses/by/3.0/)。
  完整许可文本见 `LICENSE-CC-BY-3.0.txt`。
- **署名**：Piano samples by Alexander Holm — Salamander Grand Piano, CC BY 3.0.
- **修改**：文件按音高重命名为 `C3.mp3`、`Ds3.mp3`……`C6.mp3`；运行时只做播放速率、
  包络和声像处理，原始 MP3 文件未改动。

## 分发说明

`electron-builder.yml` 会把整个目录复制到安装包的 `resources/audio-samples/`；
主进程 `samples:read` IPC 只允许读取 `harmonica/*.wav` 与 `piano/*.mp3` 白名单文件，
渲染进程不接触任意文件系统路径。
