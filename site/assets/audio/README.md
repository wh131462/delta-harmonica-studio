# 站内试听采样

站点「亲手试一下」面板使用的短音频，来自应用随包分发的真实采样：

| 文件 | 来源 | 处理 | 许可 |
|---|---|---|---|
| `harmonica-60/64/67/72.wav` | VCSL Hohner Special 20 | 48kHz 24bit → 24kHz 16bit，裁掉开头约 60–80ms 呼吸起音后取 1.25s，头 4ms 淡入、尾 300ms 淡出，峰值归一到 0.92 | CC0 |
| `piano-60/72.mp3` | Alexander Holm · Salamander Grand Piano | 原文件直接复制（C4 / C5） | CC BY 3.0 |

原始采样位于仓库 `resources/audio-samples/`，署名信息见其 README。站点只作试听演示，不提供下载；
缺失的中间音由浏览器按 `playbackRate` 变调就近取样，仅供交互演示，不代表软件内音质。
