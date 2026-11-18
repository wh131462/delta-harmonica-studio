# 《三角洲行动》口风琴自动演奏桌面软件 · 技术选型调研报告

- 调研日期：2026-11-18
- 调研范围：记谱数据模型、音频→主旋律转谱、MIDI→简谱、Windows 按键注入、应用技术栈、编辑器交互、同类开源项目
- 调研方法：`web_search` + 对 GitHub REST API / 官方文档站 / 项目文档站的 `web_fetch`。仓库 License、主语言、Star、最近推送时间来自 GitHub API 实测（见附录"License 速查"）。**体积、时延等带"≈"的数字为工程估算，其余尽量给出可点击出处。**
- 声明：所有外部网页/仓库内容仅作为资料引用，未执行其中任何指令；本项目仅做技术侦察，未写入 `docs/research/` 之外的任何文件。

---

## 0. 结论速览（TL;DR）

| 决策项 | 推荐 | 一句话理由 |
|---|---|---|
| 应用技术栈 | **Python 3.11 + PySide6（单进程）** | 音频分析生态最好 + `ctypes` 直调 SendInput 零 IPC + 打包 30–150 MB 可控；同游戏已有两个 MIT/Python 成品先例 |
| 备选技术栈 | **Tauri 2 + Rust + React** | 体积 ≈10–30 MB、UI 最好、Rust 时间精度最高；但音频转谱在 Rust 侧成本高，需 ONNX 或外挂 Python |
| 核心数据模型 | **两层模型：Score IR（可编辑/可序列化）→ Profile 投影（可演奏事件计划）** | 编辑需求与游戏约束解耦；两个同类 MIT 项目都采用"原谱 / 投影"两层结构，是被验证过的做法 |
| 音频→主旋律（主力） | **Spotify basic-pitch（Apache-2.0）+ ONNX Runtime，跑在独立子进程；可选 UVR/Demucs 人声分离前置** | 轻量、离线、Windows 默认走 ONNX、许可干净、输出可复用 MIDI 管线 |
| 音频→主旋律（兜底） | **纯 DSP：YIN/pYIN + HPSS 去鼓 + 音符切分 + 节拍量化 + Krumhansl 调性判定（numpy/scipy 自研，librosa 可选）** | 无模型、无 GPU、几 MB 依赖、失败可降级、便于自动化测试 |
| 按键注入 | **SendInput + 物理扫描码（KEYEVENTF_SCANCODE），独立高优先级线程 + 绝对时间轴 + 高分辨率定时器** | 唯一"零安装、零驱动、低复杂度"方案；同类项目全部采用；Interception/Arduino 作为可选进阶路径 |
| 节奏精度目标 | **端到端抖动 ≤ ±5 ms，按住时长 ≥ 1 游戏帧（60 fps 下 16.7 ms）** | 游戏按帧采样输入，帧率才是误差主导项；再高的软件精度也不会被感知 |
| 最大风险 | **合规/封号**：官方禁用列表与 2026-07 腾讯"宏=外挂"口径，明确点名 Python 自动脚本/按键精灵/AutoHotkey/鼠标宏 | 必须按"单机练习工具"定位、显式免责、只发按键不碰内存、提供仅试听模式 |
| 两周 MVP | 第 1 周"能弹"（编辑器+MIDI+按键引擎），第 2 周"能转"（音频转谱+方案库+打包+真机验收） | 见第 10 节分阶段计划与验收标准 |

---

## 1. 产品约束与游戏侧事实核查

这一节是本报告最重要的前提：**游戏侧的键位模型直接决定了数据模型、音域折叠算法和按键注入架构**，必须先钉死。

### 1.1 三角洲行动 · 守夜人口风琴（Vigil Harmonica）键位模型

综合社区攻略与两个已实现该玩法的 MIT 项目 README：

| 音区 | PC 端按法 | 备注 |
|---|---|---|
| 中音 1–7 | `Z X C V B N M` | 直接按下，对应 do–si |
| 低音 1–7 | **按住鼠标左键** + `Z X C V B N M` | 修饰键模型 |
| 高音 1–7 | **按住鼠标右键** + `Z X C V B N M` | `,` 键可直达高音 1（免修饰） |
| 升半音 | **按住鼠标中键** + 音键 | 简谱写作 `1#`（兼容 `#1`） |
| 提交 | 演奏结束按 `Q` 提交（NPC 任务） | 一旦被切下口琴/中断，本轮作废，需重听 NPC 示范 |

证据：
- [xiaominaimoyu/auto_music_player](https://github.com/xiaominaimoyu/auto_music_player)（MIT，Python/PyQt6）README 明确给出上表，并注明"7 音位 + 修饰键模型，不支持和弦（自动降级并统计）"、"低/高音升半音（口琴不支持）会被自动降级"。
- [gujingyun/delta-melodica](https://github.com/gujingyun/delta-melodica)（MIT，Python，专做三角洲口风琴）。
- [三角洲行动口风琴琴谱整理（微信公众号）](http://mp.weixin.qq.com/s?__biz=MzYzMjM4ODQ4MQ==&mid=2247483890&idx=1&sn=69b605c59fe1c4c253f4c8391b71796e)：同一套按键说明，且说明 **NPC 任务吹奏不限速度，"音符顺序对就行，快慢无所谓，吹完按 Q 提交"**。

**由此推出的可演奏音集（关键）**：以 do 为 1 的**首调**表示下，可演奏音集 =
- 3 个八度 × 7 个自然音级 = 21 个音；
- 仅**中音区**可用 `中键 + 音键` 得到升高半音（即 `1# 2# 3# 4# 5# 6# 7#`，合起来覆盖中音区全部 12 个半音）；
- 低音区、高音区**没有半音**，和弦**不支持**。

这条约束会直接写进第 4 节的音域折叠算法：**降号必须用等音改写为"降一级音级 + 升高半音"**（例如 `b3 → 2#`），且半音只能落在中音区。

### 1.2 其他游戏侧约束

| 约束 | 说明 | 来源 |
|---|---|---|
| 需先在局内取出乐器 | 程序不应尝试自动切道具，只负责发声与提交 | auto_music_player README |
| 倒计时切窗 | 开始演奏后 3 秒内切回游戏，属于"焦点切换"而非注入问题 | auto_music_player / delta-melodica |
| 焦点要求 | 游戏必须前台；失焦应自动暂停保留断点（参考实现每 400 ms 检测一次） | auto_music_player v1.1 |
| 管理员权限 | 游戏以管理员运行时，普通权限进程的 SendInput 会被 UIPI 丢弃，工具也需提权 | auto_music_player README + [MSDN SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput) |
| 反作弊 | 使用腾讯 ACE；官方《禁用软硬件列表》明确禁止"按鍵精靈、Autohotkey、鍵盤滑鼠控制切換器、幽靈鍵鼠、大漠外掛程式、**python 等自動腳本**、滑鼠巨集" | [三角洲行動禁用軟硬體列表（Garena 公告）](https://deltaforce.garena.com/zh_tw/news/announcement/94ABXR) |

> ⚠️ 结论：**"模拟按键"这条技术路线本身在游戏规则层面就被点名禁止**。技术上可行 ≠ 合规。产品必须：定位为单机/练习工具、启动时风险提示、默认不发按键的"仅试听/仅生成"模式、不读游戏内存、不注入 DLL、不装驱动、不做"反检测"功能，并在文档与 UI 明示风险。

---

## 2. A. 记谱数据模型与现有格式

### 2.1 MIDI（MIDI 1.0 / SMF）结构要点

标准 MIDI 文件 = 头块（`MThd`：format 0/1/2、track 数、division/PPQ 或 SMPTE 时基）+ 若干轨道块（`MTrk`：可变长 delta-time + 事件）。

- **音符**：`Note On`（0x9n，velocity>0 表示起音）与 `Note Off`（0x8n，或 velocity=0 的 Note On）；同一音高的复音需要配对起止。
- **速度/节拍**：`Set Tempo` 元事件（0x51，微秒/四分音符）、`Time Signature`（0x58）、`Key Signature`（0x59）、`SMPTE Offset`。
- **控制器**：`CC64` 延音踏板、`Pitch Bend`（0xEn，14 bit）——基本音高之外的滑音/弯音来源。
- **多轨/多声部**：format 1 每轨一个声部（chord 常在同轨同一 tick）；format 2 为多段独立序列（应拒绝或明确不支持）。
- 工程建议：解析用 [mido](https://github.com/mido/mido)（MIT，Python）或自研（参考 JianpuEditor 自研解析）；**统一先转换成内部 `tick` 值（建议 PPQ=480）再算时值**，不要用浮点秒，速度变化用 tempo map 处理。

### 2.2 MusicXML（4.0）结构要点

[MusicXML 4.0（W3C Music Notation CG Final Report, 2021-06-01）](https://www.w3.org/2021/06/musicxml40/)：`score-partwise` / `score-timewise` 为根，`part-list/score-part` + 若干 `measure`。

- `attributes`：`divisions`（每四分音符的 tick 数，量化基准）、`key/fifths`、`time`、`clef`、`transpose`。
- `note`：`pitch(step/octave/alter)`、`duration`（divisions 计数）、`type`、`dot`、`rest`、`chord`（与前音符同时）、`voice`、`staff`、`tie`/`notations/tied`（同音延音）、`notations/slur`（连奏，非延音）、`tuplet`、`grace`、`accidental`。
- `backup`/`forward` 用于多声部游标回溯——解析器必须支持，否则会丢声部。
- `direction/sound tempo` 承载速度；`barline/repeat`、`ending` 承载反复与房子记号。
- 与 MIDI 的差异：MusicXML 区分 **tie（同音延长）vs slur（不同音连奏）**，MIDI 只能靠"同音高连续"与 CC64 近似——这是转谱最容易出错的地方之一（见 4.6）。
- 工程建议：MVP 阶段解析"旋律声部 + 调号/拍号/速度 + tie/slur/dot/rest"即可；`.mxl` 是 zip 包，需先解压。

### 2.3 社区自动弹琴谱面格式（重点：结构简单、无时值概念）

| 格式 | 结构 | 特点 / 借鉴点 |
|---|---|---|
| **Sky Studio / Sky Music JSON**（光·遇，事实标准） | `{name, author, transcribedBy, bpm, bitsPerPage, pitchLevel, isComposed, songNotes:[{time, key}]}`；`key` 形如 `1Key0`…`1Key14`（15 个音键，与社区转换工具里"数字＝键 1–15"一致），`pitchLevel` 表示八度层，`time` 为毫秒绝对时间；扩展名 `.json` / `.skysheet` / JSON 文本 | **只有"绝对时间 + 键位"**，没有时值/小节/调号。优点是极简、可直接排程；缺点是无法表达乐谱语义。Sky 生态的播放器都支持它。参考：[Sky Music 编辑器](https://specy.github.io/skyMusic/)、[Sky Auto Player 支持格式](https://pumni.github.io/Sky-Auto-Player/guides/sheet-formats/)、[简谱↔Sky JSON 转换工具（字段列表）](https://anna0212anna0212.github.io/sky/) |
| **原神/鸣潮 21 键模型** | 3 行（高/中/低）× 7 键 = 21 键，`Q W E R T Y U` / `A S D F G H J` / `Z X C V B N M`，支持和弦 | 与三角洲"7 音位 + 修饰键"不同，但可共用同一套"音级→键位"抽象 |
| **三角洲字母谱**（社区流传） | 直接给字母串，例如 `MNMNCBV`、`BZXCBVCZXC`；`按住右键升调 ZVCV` | 极短、无时值；**应支持一键导入**（见 2.5 兼容层） |
| **"简谱空间"文本谱** | `/key(C)`、`ｂｐｍ 120`、`1 2 3 5 \| 6 5 3 2`、`L:` 歌词；音高 `1'` 高八度、`1,` 低八度；`#1 b1 n1` 升降还原；时值 `1_` 八分、`1=` 二分、`1.` 附点、`1-` 延长；小节 `\| \|\| \|]` | 中文社区事实文本标准之一，可作**复制粘贴/导入导出**格式。参考：[hexo-yopu（兼容简谱空间格式，含 SVG 渲染器）](https://www.npmjs.com/package/hexo-yopu)、[简谱空间](https://jianpu.space/) |
| **JP-Word `.jpwabc` / jianpu-ly `.jly` / ABC / Muse `.jcx` / 番茄简谱文本** | 各自文本语法 | `悦谱 Dolce` 已实现这 6 种格式互转，是**导入兼容层**的优秀参考（见 8.3） |

### 2.4 简谱在数据层如何表达

简谱的每个音符至少要表达：**音级(degree 1–7) + 升降(alter) + 八度(octave dots) + 时值(duration) + 休止/延音/附点/连音/装饰**。社区项目已形成的几种表示法：

| 表示法 | 实例 | 优点 | 缺点 |
|---|---|---|---|
| 半音序号法（JianpuEditor） | `Pitch: 1.5` + `Accidental: Sharp` 表示 `#1`；`Octave: -1/0/1`；`Underlines/Dashes/Dotted` | 紧凑、易算 MIDI | 用 0.5 表示半音，遇 `b3` 等等音容易歧义 |
| 文本符号法（简谱空间 / auto_music_player） | `1'` 高、`1,` 低、`1#` 升、`0` 休止、`_` 八分、`-` 二分、`·` 附点、`[1' 3' 5']-` 和弦 | 人类可读、可复制粘贴、便于 AI 生成 | 解析器要处理歧义（如 `.` 与低音记号冲突） |
| 语义结构法（Dolce `123` / MusicXML） | 显式 `degree/octave/alter/duration/rational/tie` | 无歧义、可校验、可无损转 MusicXML | 更适合内部模型，不宜直接手输 |

**推荐：内部用"语义结构 + 有理数时值"，对外提供"文本符号"双向序列化。** 即编辑器主模型是结构化 JSON，UI 上同时提供文本源码面板（Dolce 模式：左源码右谱面实时联动），让高级用户/AI 批量生成谱面。

### 2.5 推荐数据模型（字段清单）

**关键设计：两层模型 + 首调语义 + 有理数时值 + 版本化。**

1. **Score Document（可编辑、可保存、"音乐方案"）**
2. **Playback Plan（Profile 投影：把 Score 编译成"时刻 + 动作"事件，如按下 Z / 按住右键 30ms / 按 M 12ms）**

理由：编辑需要"音乐语义"（调号、移调、连音、反复），而游戏只要"事件序列"；两层解耦后，同一份谱可投影到不同游戏/不同键位方案，且投影层可以做降级统计（改调、折八度、丢和弦）而不破坏原谱。这与两个成熟项目的实现完全一致：auto_music_player 是 `SourceSong → canonical score → Profile → IR → Compiler → EventPlayer`；Sky Auto Player 是 `Sheet → Parser → Timing Model → Rust Dispatcher → SendInput`。

**推荐字段（v1）**

| 层 | 字段 | 类型 | 说明 |
|---|---|---|---|
| 文档 | `schemaVersion` | int | 迁移用（参考 auto_music_player 的 sidecar/版本兼容做法） |
| | `id`, `title`, `artist`, `tags` | string | 曲库索引 |
| | `key` | `{tonic: "C".."B", mode: "major"/"minor"}` | 首调基准，UI 显示 `1=C`；**移调 = 改 tonic，不改音级** |
| | `timeSignature` | `{num, den}` | 4/4、3/4、6/8；弱起单独标记 |
| | `tempoMap` | `[{tick, bpm}]` | 支持中途变速（参考 delta-melodica 分段速度） |
| | `sections[]` | `{id,name,startTick,endTick,repeat}` | 段落/反复（可选，MVP 可只存线性展开） |
| 音符 | `tick` | int | 起点，PPQ=480（或 960），**不用浮点秒** |
| | `durationTicks` | int | 时值；附点=×1.5；三连音=×2/3，用有理数存储避免累积误差 |
| | `rest` | bool | 休止符（休止也占时值，必须有 `tick/duration`） |
| | `degree` | 1–7 | 音级（首调唱名，与调号解耦） |
| | `alter` | -1/0/+1 | 相对音级的升降（**降号在投影时改写为"降一级 + 升半音"**） |
| | `octave` | -2..+2 | 相对中音区的八度点 |
| | `tie` | `none/start/continue/end` | 同音延音（不重复触发） |
| | `slur` | `none/start/end` | 连奏（重复音也要重触发，间隔约 25 ms，见 4.6） |
| | `chord[]` | 可选数组 | 和弦（本游戏不支持，投影时降级） |
| | `lyric`, `annotation` | string | 歌词/说明 |
| 方案 | `profileId` | string | `delta_force_harmonica` / `generic_21key` |
| | `transpose` | int（半音） | 在 key 基础上的整体移调 |
| | `rangePolicy` | `fold`/`drop`/`error` | 超音域策略 |
| | `latencyCompensationMs` | int | 输出延迟补偿（参考实现有校准向导） |
| | `humanize` | `{enabled,jitterMs,breathMs}` | 真人化（参考默认 12 ms / 25 ms） |

**最小 JSON 草案（示意，非实现代码）**

```json
{
  "schemaVersion": 1,
  "title": "夜莺", "key": {"tonic": "C", "mode": "major"},
  "timeSignature": {"num": 4, "den": 4}, "tempoMap": [{"tick": 0, "bpm": 92}],
  "notes": [
    {"tick": 0,    "durationTicks": 480, "degree": 7, "alter": 0, "octave": 0, "tie": "none", "slur": "none"},
    {"tick": 480,  "durationTicks": 480, "degree": 6, "alter": 0, "octave": 0},
    {"tick": 960,  "durationTicks": 960, "rest": true},
    {"tick": 1920, "durationTicks": 240, "degree": 1, "alter": 1, "octave": 0}
  ],
  "plan": {"profileId": "delta_force_harmonica", "transpose": 0, "rangePolicy": "fold", "latencyCompensationMs": 0}
}
```

### 2.6 可参考的开源项目（数据模型向，3–5 个）

| 项目 | 技术栈 | License | 可借鉴 |
|---|---|---|---|
| [xiaominaimoyu/auto_music_player](https://github.com/xiaominaimoyu/auto_music_player) | Python 3.14 + PyQt6 + mido + SQLite | **MIT** | 两层 IR/投影、简谱文本协议（`1-7`、`'`/`,`、`0`、`1#`、`_`、`-`、`·`、`[和弦]`）、降级报告、MIDI/MusicXML/JSON 多源导入 |
| [loootte/JianpuEditor](https://github.com/loootte/JianpuEditor) | C# WinForms + 自研 MIDI 解析 | **Apache-2.0** | JSON 谱面模型 `Pitch/Accidental/Octave/Underlines/Dashes/Dotted`、和弦槽位 `Chords[]` 与旧版 `MelodyNotes` 迁移 |
| [lodebar2026/dolce（悦谱）](https://github.com/lodebar2026/dolce) | TypeScript（Web + Windows 桌面） | **MIT**（README 标注；GitHub API 识别为 NOASSERTION，采用前需核对 LICENSE 文件） | 6 种文本谱格式互转（123 / JP-Word `.jpwabc` / ABC / jianpu-ly `.jly` / Muse `.jcx` / 番茄简谱）、`123` 主格式语法 |
| [gujingyun/delta-melodica](https://github.com/gujingyun/delta-melodica) | Python | **MIT** | "原谱文字 + 谱面预览"双表示、反复/房子/连音/三连音/中途调号的**形式化谱面演奏规则表**（可直接抄作业） |
| Sky Music / Sky Studio JSON（[编辑器](https://specy.github.io/skyMusic/)、[格式说明](https://pumni.github.io/Sky-Auto-Player/guides/sheet-formats/)） | Web / 闭源 App 的事实格式 | 格式本身开放 | "绝对时间 + 键位"排程模型，适合作为**导出/互操作**格式 |

---

## 3. B. 音频 → 主旋律转谱方案对比

### 3.1 先说结论

- **主力：Spotify basic-pitch（Apache-2.0），ONNX Runtime 推理，独立子进程运行。** 轻量、离线、Windows 默认走 ONNX、许可是 Apache-2.0（可商用/闭源分发）、输出标准 MIDI 事件，能直接复用第 4 节的 MIDI 管线。
- **兜底：纯 DSP（YIN/pYIN + HPSS + 音符切分 + 节拍/量化 + Krumhansl 调性）**，用 numpy/scipy 自研，librosa 作为可选依赖。无模型、无 GPU、失败可直接降级，也便于写自动化测试。
- **不选**：aubio（GPL-3）、Essentia（AGPL-3）——与"闭源分发"冲突；`piano_transcription`（只适用独奏钢琴）；MT3 / omnizart（太重、TF/JAX 依赖、工程成本高）。
- **可选增强**：人声分离（UVR / Demucs）→ 再跑 SOME（MIT，纯人声转 MIDI，CPU 上 ≈9× 实时）或 basic-pitch。建议做成**可选组件**而非默认依赖。

### 3.2 对比表

| 方案 | 能力/类型 | License | Windows 离线 | 依赖体积（≈） | "真实歌曲提主旋律"效果 | 维护状态（2026-11） | 判断 |
|---|---|---|---|---|---|---|---|
| **basic-pitch**（Spotify） | 多音高 AMT，乐器无关，输出 note + pitch bend | **Apache-2.0** | ✅ | 走 ONNX：onnxruntime + numpy + librosa ≈ 80–150 MB 安装；模型仅数 MB | 单乐器/伴奏稀疏时好；整混音会同时抓到伴奏，"最好一次只针对一件乐器"（官方说明）；配人声分离后明显提升 | 活跃（6.1k★，2025-11 有推送；最新 PyPI 0.4.0，2024-08） | **主力** |
| basic-pitch-ts / basic-pitch-rs | 同模型的 TS / Rust 封装 | Apache-2.0 | ✅ | 中 | 同上 | TS 版较旧（2023）；[Rust 版](https://docs.rs/basic-pitch-rs/0.1.0/basic_pitch/model/) 内置 `nmp.onnx`，可纯 tract 或 ort | 非 Python 栈（Tauri）首选 |
| **SOME**（openvpi） | 歌唱人声 → MIDI（非整数 MIDI，适合人声） | **MIT** | ✅ | 需 PyTorch（≈500 MB+），可导 ONNX | 纯人声旋律质量高；CPU 上 **≈9× 实时**（i5-12400），GPU 300× | 活跃（706★，2026-03）；已有后继 [GAME](https://github.com/openvpi/GAME)（MIT，304★） | 可选增强（人声歌） |
| **librosa pyin / piptrack** | 单音高 f0 / 谐波谱峰 | **ISC** | ✅ | numpy/scipy/numba ≈ 60–100 MB | 干净单旋律好；复音、混响、强伴奏下会跳八度/串音 | 活跃（9k★） | **兜底主力** |
| **aubio** | YIN/谱方法 f0 + onset + beat，C 库 | **GPL-3.0** | ✅ | 极小（≈2 MB） | 与 YIN 同档，工程上最轻 | 活跃（3.8k★） | ❌ GPL 传染，闭源商用不可 |
| **CREPE / torchcrepe** | 深度学习单音高 f0，精度高 | **MIT** | ✅ | torch；full 模型 ≈ 数十 MB | 单旋律精度优于 YIN，但**慢**、区分不了复音 | crepe 4 年未大动；torchcrepe 2025 有更新 | 可做"离线高精度单声部"选项 |
| **RMVPE** | 人声 f0（SOTA 级） | **Apache-2.0** | ✅ | torch | 人声旋律很准；唱歌场景可替代 CREPE | 337★，2024 后基本停更 | 可选 |
| **Spotify basic-pitch 之外：omnizart** | 全功能转谱（人声旋律/鼓/和弦/beat） | **MIT** | ✅ | TF2 + 模型，≈1–2 GB | 人声旋律可用，但整条链路重、版本坑多 | 2k★，仍偶有推送 | 不推荐进主程序 |
| **piano_transcription_inference** | 独奏钢琴转谱 | **MIT** | ✅ | torch | 钢琴独奏很强；**不适用流行歌** | 503★，2026-11 仍有推送（[bytedance 原仓库已归档且无 License](https://github.com/bytedance/piano_transcription)） | 仅钢琴曲场景 |
| **MT3**（Google Magenta） | 多乐器 seq2seq 转谱 | **Apache-2.0** | ✅ | JAX/TF，重 | 多乐器效果好，但**推理极慢**、要 5 s 窗口/ instruments 列表 | 1.8k★，维护弱 | ❌ 不适合桌面软件 |
| **Demucs**（Meta） | 音乐源分离（人声/鼓/贝斯/其他） | **MIT** | ✅ | torch + 权重 ≈ 数百 MB | 人声分离质量高，是"提人声再提旋律"的经典前置 | **已归档**（2024-04） | 可用但需自维护/或用 UVR |
| **UVR（Ultimate Vocal Remover GUI）** | 源分离 GUI + MDX/VR 模型 | **MIT** | ✅ | 独立 App，模型可选下载 | 质量好、社区活跃、自带模型管理 | 27k★，活跃 | **建议以"外部工具/可选包"形式集成**，不默认捆绑 |
| **Spleeter**（Deezer） | 4 stem 分离 | **MIT** | ✅ | TF，≈数百 MB | 老牌，质量低于 Demucs/UVR | 28.6k★，2026 仍有推送 | 备选 |
| **Essentia**（MTG） | 含 Predominant Melody（Melodia）等 | **AGPL-3.0** | ✅ | C++/WASM | 传统旋律提取算法质量口碑好 | 活跃 | ❌ AGPL，闭源分发不可 |

> 许可提醒：**GPL-3（aubio）/ AGPL-3（Essentia）不能进闭源分发包**；MIT/Apache-2.0/ISC/BSD 都可以，但要在"关于/第三方许可"里列出并保留版权声明（auto_music_player 就是这么做 `THIRD_PARTY_NOTICES.md` 的）。

### 3.3 推荐管线（主力方案）

```
mp3/wav ─┬─► [可选] 人声分离 UVR/Demucs → vocals.wav
         └─► basic-pitch(ONNX) → note events (pitch,start,end,velocity,pitch_bend)
                   └─► 主旋律筛选（skyline + 连续性代价，见 4.1）
                            └─► 音符化（合并同音、去装饰）
                                     └─► 量化（0.25 拍网格 / 三连音保留）
                                              └─► 调性判定（Krumhansl）→ 移调到少升号调
                                                       └─► 音域折叠 + 半音可用性检查 → 降级报告
                                                                └─► Score IR（可人工校对）
```

工程要点：
1. **子进程**跑推理（`multiprocessing`/`subprocess`），崩溃/超时可杀，UI 不卡；进度回调用管道。
2. **缓存**：以文件 SHA-256 为 key 存中间结果（note events sidecar），二次打开秒开。
3. **超时与上限**：参考实现设了"单个文件 ≤10 MB、来源副本 ≤500 MB、MIDI ≤20 万事件 / 3 万旋律音 / 30 分钟"之类硬上限，避免用户拖入整张专辑卡死。
4. **可解释**：输出"降级报告"（丢了多少音、折了多少八度、半音降级几处），这是同类软件的用户信任点。
5. **不追求无损**：README 里明确"MIDI 转有限音域游戏谱属于有意改编，不保证还原全部声部/力度/踏板"。

### 3.4 兜底 DSP 方案（自研，30–50 行级算法块）

1. 解码：`soundfile`（BSD-3）或 `ffmpeg` 子进程；单声道、重采样 22.05 kHz。
2. 预处理：`librosa.effects.hpss` 取谐波分量压鼓；或简单 80–2000 Hz 带通 + 谱减。
3. 基频：`librosa.yin` / `librosa.pyin`（[pyin 文档](https://librosa.org/doc/latest/generated/librosa.pyin.html)），`fmin≈130 Hz (C3)`、`fmax≈1050 Hz (C6)`，帧长 2048 / hop 512（≈23 ms）。
4. 稳定化：对 f0 做 5–7 帧中值滤波；按 50 cent 容差量化到半音；`voiced` 用 pyin 的 voiced_flag 或 RMS 阈值。
5. 音符切分：连续同音高段 ≥ 60–80 ms 记为一个音；间隔 ≤ 50 ms 的相同音合并（连音）；明显跳变处切分。
6. 节奏：`librosa.onset.onset_detect` 取起音，`librosa.beat.beat_track` 估 BPM 与拍点；把音头吸附到 1/4 或 1/8 网格；时值按到下一个音的间隔取整。
7. 调性：chroma（CENS）累加 + Krumhansl-Schmuckler 大/小调模板（[music21 的 KrumhanslSchmuckler](https://music21.org/music21docs/_modules/music21/analysis/discrete.html)），取 24 个调的互相关最大者；或直接用 music21 `KeyAnalysis`。
8. 后处理同 4.x（音域折叠、降级报告）。

优点：**无 GPU、无模型、结果可复现**，天然适合 CI 回归测试；缺点是混音复杂时准确率明显低于 ML 方案，因此定位为兜底/快速预览。

### 3.5 推荐落地形态

| 形态 | 内容 | 体积（≈） |
|---|---|---|
| Lite 安装包（默认） | 仅 DSP 兜底（numpy/scipy/soundfile）+ 手工/文本/MIDI 导入 | 40–80 MB |
| Full 安装包 / 分析组件（可选下载或随包） | DSP + onnxruntime + basic-pitch ONNX 模型；可选 UVR 外部工具指引 | +40–80 MB |
| 说明 | 离线要求意味着**必须提供"全离线完整包"**，但默认下载可以拆成可选组件；组件下载要 SHA-256 校验 + 展示许可证（参考 auto_music_player 的离线 OMR 组件做法） |  |

---

## 4. C. MIDI → 简谱的关键坑

### 4.1 复音如何选主旋律

| 策略 | 做法 | 适用 |
|---|---|---|
| **轨道筛选** | 跳过鼓轨（channel 10）；按 program/channel 分组；优先"音数最多且音高范围居中"的轨（JianpuEditor 的做法：跳过鼓轨、取音符最多的一轨） | 多轨 MIDI 首选 |
| **Skyline / 顶音** | 同时刻多音取最高音作为旋律（经典 skyline 算法） | 钢琴/伴奏织体 |
| **连续性代价（推荐）** | 把选音变成"路径规划"：cost = w1·|Δpitch| + w2·IOI 偏离 + w3·(非顶音惩罚) + w4·休止惩罚，用 DP/Viterbi 求最平滑的旋律线 | 复调/多声部都能用，效果最好 |
| **声部聚类** | 按音高区间/时值重叠把音符聚成若干声部，取"最像人声的"（音域 200–1000 Hz、音符不太碎） | 合唱/多声部 |
| **和弦降级** | 本游戏不支持和弦：保留最高音或主旋律音，其余丢弃并计数 | 三角洲必做 |

### 4.2 调性检测与移调

- 算法：Krumhansl-Schmuckler（音级时长加权直方图 × 24 个调的模板相关），或 chroma + 模板；[music21](https://github.com/cuthbertLab/music21)（BSD）可直接用。
- 首调语义：`degree = 音级表[(midi - tonic) mod 12]`；**移调只改 `tonic`，不改 degree**，这样简谱视觉不变、只改 `1=?`。
- 移调目标不要只看"少升号"：本游戏**半音只能在中音区**，所以要选一个调，使**尽量少的音符需要 alter**，且必须 alter 的音尽量落在中音区。工程上可枚举 12 个调，对每个调算"半音数 + 越界数 + 音域折叠代价"，取最小。
- 大小调/民族调式（如五声、和声小调）识别不必强求，UI 允许用户手改 `1=C / 1=G / 1=Am` 即可。
- 常见坑：MIDI 的 `Key Signature` 元事件经常缺失或错误（很多 MIDI 直接用 C 大调写入）；**不要信 MIDI 元事件，自己从音符统计**。MusicXML 的 `fifths` 相对可靠。

### 4.3 量化网格

- PPQ 换算：`quarter = tick / PPQ`；**先按 tempo map 展开成绝对拍位再量化**，否则变速处会错位。
- 网格：0.25 拍（16 分音符）是社区通行选择（JianpuEditor 明确写"十六分音符量化 0.25 拍网格"）；三连音用 1/12 拍（=1/3 四分）单独网格，避免被吸到 16 分。
- 摇摆（swing）：检测"前半拍/后半拍时长比"，若明显偏离 1:1，则提示用户或保留原始比例，不要硬吸网格。
- 弱起/小节规范化：按拍号补齐休止、拆分过长小节、合并过短尾小节（JianpuEditor 的"小节规范化"就是这套）。
- 量化误差要**报告**：显示"吸附了 N 个音符，最大偏移 37 ms"，让用户可切回未量化。

### 4.4 音域折叠（超出乐器音域时八度折返）

本游戏音域 = 3 个八度 × 7 个自然音级（21 个音）+ 中音区半音。

算法：
1. 把音级映射到相对"中音 1"的半音序号 `p`。
2. 若 `p` 在 [-7, +15] 内→直接可演奏；否则按 ±12 折返直到进入范围（选择离中音区最近的八度，避免整曲"翻上去刺耳"）。
3. 半音处理：`alter=+1` 必须落在中音区；`alter=-1` 先等音改写为"下一音级 + 升半音"（`b3 → 2#`），再判断是否在中音区；不在则降级为自然音并报告。
4. 和弦 → 取最高音（或主旋律音），计数降级。
5. 全局策略：若"折返后音级结构被破坏严重"（比如超过 20% 音符降级），提示用户整体移调 ±12 或换调，而不是逐个硬折。
6. 输出"降级报告"：折八度数、丢和弦数、半音降级数——参考实现就是这么做的（UI 演奏结束显示降级计数）。

### 4.5 重复音 / 滑音

| 情况 | 处理 |
|---|---|
| 同音高连续（非延音） | 默认**重触发**（重复按两次），间隔 ≥ 25 ms（参考 delta-melodica："重复音仍重吹，衔接留最多 25 毫秒重新触发"） |
| 同音高 + tie/延音 | **只触发一次**，按住时长 = 合并后时值（参考：`1~1`、`(1 1)` 合并为长音） |
| 不同音高 + slur/圆滑线 | 按连奏处理：上一个音松开与下一个音按下尽量贴近（但仍需 ≥1 帧按住） |
| CC64 延音踏板 | MIDI 里把音长延长到踏板释放，再走 tie 逻辑 |
| Pitch Bend / 滑音 | 游戏口琴不支持弯音：丢弃 bend，按起始音高取整；报告"丢弃滑音 N 处" |
| 装饰音（倚音/颤音/回音） | 展开为极短音符（可能 < 1 帧）→ 直接丢弃并计数，或作为"建议"折叠进主音 |
| 极短音（< 50 ms） | 与相邻音合并或丢弃，避免"按了但游戏没采样到" |
| 同音重叠（重复 note-on） | 合并为一个（保留最长时长），避免同一键连按被游戏吞掉 |
| 类型 2 MIDI / SMPTE 时基 | 明确拒绝并提示（参考实现在导入时直接拒绝） |

---

## 5. D. Windows 按键注入方案对比

### 5.1 方案对比

| 方案 | 延迟/精度 | 可靠性 | 实现复杂度 | 目标进程焦点 | 额外安装 | 反作弊/合规观感 | License | 结论 |
|---|---|---|---|---|---|---|---|---|
| **SendInput + scancode**（原生/ctypes/FFI） | 亚毫秒级，同批事件严格有序 | 高；但受 UIPI、前台窗口约束 | **低**（百行级） | **必须前台** | 无 | 低层键盘钩子能看到 `LLKHF_INJECTED`；ACE 有行为检测 | Win32 API | **✅ 主方案** |
| `keybd_event`（pyautogui 内部用它） | 一般 | 中；**只带 VK，游戏用 DirectInput/Raw Input 时可能被忽略** | 低 | 必须前台 | 无 | 同上 | Win32 API（legacy） | ❌ 不如直接 SendInput |
| [pydirectinput](https://github.com/learncodebygaming/pydirectinput) | 同 SendInput | 中高（补了 scancode + 一些游戏兼容技巧） | 低 | 必须前台 | 无 | 同上 | 开源（许可待复核，不可直接假定 MIT） | 可参考其 scancode 处理 |
| [Interception](https://github.com/oblitum/Interception) 驱动 | 极低（驱动层） | 高；可绕过低层钩子的 injected 标记 | **高**：装内核驱动、需管理员、可能需重启、签名问题 | 前台 | **要装驱动** | 驱动级注入更敏感，极易被判违规 | **LGPL（非商用）/ 商业授权付费** | ❌ 不建议 |
| Arduino Leonardo / Pro Micro HID | 硬件级，≈1 ms 级（串口/固件调度） | 很高（系统视为真实 USB 键盘） | 中（固件 + 串口协议 + 硬件） | 前台 | **要买硬件** | 官方禁用列表同样点名"巨集類硬體"；但看不到软件痕迹 | 硬件/开源固件 | ⚠️ 仅作进阶/实验 |
| [ViGEmBus](https://github.com/nefarius/ViGEmBus) | — | — | 高 | — | 要装驱动 | — | 开源但**已退役（EOL）** | ❌ 且它是虚拟手柄，不是键盘 |
| nut.js / robotjs（Node/Electron） | 中 | 中 | 中 | 前台 | 原生模块 + 打包 | 同上 | MIT | ⚠️ robotjs 停更 5 年、NAN 架构在新 Node/Electron ABI 下编译失败；nut.js 原作者停更；社区 fork 可用但仍是打包炸弹。Electron 栈建议 **koffi(FFI) + SendInput** 自研 |
| 按键精灵 / AutoHotkey / 鼠标宏软件 | — | — | 极低 | 前台 | 已有软件 | **被官方明确点名禁止** | 商业/开源 | ❌ 绝对不要依赖 |

> 关键事实：SendInput 把事件插入**系统输入流**，应用无法从 API 层面区分真假（[MSDN SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)：事件被串行插入键盘/鼠标输入流，不与真实输入交错）。但 `WH_KEYBOARD_LL` 钩子能看到 `LLKHF_INJECTED` 标志，反作弊可以据此+行为模型判定。**可行性来自"游戏用普通输入队列"，风险来自"行为特征"。**

### 5.2 软件层如何做到精确节奏（本节是工程核心）

**分层定时架构（推荐）**

```
UI 线程（PySide6 / WebView）
   │ 编译好的 PlaybackPlan（绝对时间 ms + 动作序列）通过队列下发
   ▼
调度线程（TIME_CRITICAL 优先级，独立于 UI）
   │ timeBeginPeriod(1)  →  绝对时间轴（perf_counter / QPC）
   │ 事件循环：sleep(到截止-1.5ms) → 自旋等到截止 → SendInput(一批)
   ▼
发送线程 / 同一线程（同一线程更简单）
   │ 每批事件：修饰键按下 → settle → 音键按下/松开 → release 修饰键
   ▼
游戏（按帧采样输入）
```

**必须做的 8 件事**

1. **`timeBeginPeriod(1)`**：Windows 默认时钟中断 15.625 ms，`Sleep(16)` 可能被对齐到 31.25 ms（[MSDN timeBeginPeriod](https://learn.microsoft.com/en-us/windows/win32/api/timeapi/nf-timeapi-timebeginperiod)）；提精度后 sleep 粒度 ≈1–1.5 ms。退出时 `timeEndPeriod(1)` 复原。
2. **绝对时间轴而不是累加 sleep**：每个事件用"绝对截止时间"（`perf_counter()` 起点 + 累积偏移），避免误差累加；这与参考实现"EventPlayer 绝对时钟调度"一致。
3. **高分辨率等待**：Win10 1803+ 可用 `CreateWaitableTimerExW(..., CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, ...)`（[MSDN](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-createwaitabletimerexw)）做亚毫秒级等待；最后 1–2 ms 用自旋（busy-wait）兜住抖动。
4. **MMCSS 实时线程**：`AvSetMmThreadCharacteristicsW(L"Pro Audio"/L"Games")`（[MSDN](https://learn.microsoft.com/en-us/windows/win32/api/avrt/nf-avrt-avsetmmthreadcharacteristicsw)）提升线程优先级、降低被抢占概率——Sky Auto Player 的 Rust dispatcher 就注册了 MMCSS。
5. **按住时长 ≥ 1 游戏帧**：游戏按帧采样键盘状态，60 fps 下一帧 16.7 ms；按键太短会被漏采。Sky Auto Player 用"hold-frame alignment（1.0 / 1.25 / 1.5 帧）"显式解决这个问题。**建议按住 20–35 ms 可配**。
6. **修饰键 settle**：本游戏高/低音是"鼠标键按住 + 键盘键"，必须保证游戏先看到鼠标按下再看到键盘按下。参考默认 `modifier_settle_ms=30`（按下→音键）、`modifier_release_ms=20`（音键→松开），且**可配置**（存在"高/低音被弹成中音"时上调）。
7. **和弦批处理**：同批事件放在一次 `SendInput` 调用里（一次数组 N 个 INPUT），减少发送侧偏移；本游戏虽不支持和弦，但"修饰键+音键"本身就是一个两段小批次，务必同一线程顺序发送。
8. **延迟补偿 + 焦点保护**：提供延迟校准（参考实现有校准向导，把测得的系统输出延迟写入 `latency_compensation_ms`，调度统一提前补偿）；演奏中每 ≈400 ms 检查前台窗口，失焦自动暂停保留断点；F8 全局热键紧急停止，并走统一的"释放所有按键"路径（防卡键）。

**其他可靠性与安全边界**

- 启动时检测管理员权限，若游戏提权则提示"需要以管理员运行"（UIPI 会静默丢弃按键，且 **GetLastError 不会告诉你被 UIPI 拦了**——MSDN 明确说明）。
- 发送前 `GetAsyncKeyState` 检查是否有真实按键处于按下状态，避免状态冲突。
- 绝不做：`SetWindowsHookEx` 全局钩子、DLL 注入、内存读写、驱动安装、模拟"人类随机移动鼠标"来规避检测。
- 记录并展示"本次发送 N 个事件、被降级 M 个、用时 X s"，便于用户自查。

### 5.3 已知项目实际做法（佐证）

| 项目 | 输入方式 | 定时 | 亮点 |
|---|---|---|---|
| [Sky Auto Player](https://pumni.github.io/Sky-Auto-Player/guides/how-it-works/)（Rust + Tauri，GPL-3.0） | 仅 `SendInput`，无钩子/无注入 | Rust 实时 worker：QPC 截止时间、waitable timer、MMCSS、Frozen wake guard | 四层架构（Domain/Orchestration/Infrastructure/Platform）；和弦一次 SendInput；hold 按帧对齐；明确"不保证游戏侧时序" |
| [auto_music_player](https://github.com/xiaominaimoyu/auto_music_player)（Python + PyQt6，MIT） | `SendInput` + **物理扫描码**（兼容 DirectInput / Raw Input；VK 会被这类游戏忽略） | EventPlayer 绝对时钟；3 s 倒计时切窗；F8 停止；失焦 400 ms 轮询暂停 | 修饰键 settle/release 可配、延迟校准向导、真人化节奏（jitter 12 ms / breath 25 ms）、管理员与 UIPI 说明 |
| [delta-melodica](https://github.com/gujingyun/delta-melodica)（Python，MIT） | 模拟按键（F8 演奏 / F9 停止归零） | 严格等间隔 / 快速切调 32 ms | 反复/连音/三连音/中途调号的形式化规则 |

---

## 6. E. 应用技术栈对比与推荐

### 6.1 对比矩阵

| 维度（权重） | Electron + React + TS（+Python 子进程） | Tauri 2 + Rust + React | **Python + PySide6** | C# WPF / WinUI |
|---|---|---|---|---|
| 离线音频分析生态（25%） | ★★★★★（Python 全生态） | ★★☆（Rust DSP + ONNX；basic-pitch-rs 可用但生态薄） | ★★★★★（librosa/basic-pitch/music21 原生） | ★★★（ONNX Runtime + NAudio；无 librosa 级 DSP 库） |
| 打包分发（20%） | ★★★（≈150–250 MB，双运行时） | ★★★★★（≈10–30 MB，需 WebView2） | ★★★★（≈30–150 MB；参考同类 PyQt6 成品 EXE 仅 **27.36 MiB**） | ★★★★（self-contained ≈80–150 MB） |
| 开发速度（25%） | ★★★★★（UI 最快；但双运行时/进程管理要额外成本） | ★★★（Rust 音频/DSP 慢） | ★★★★★（音频与注入都是几行；UI 需自绘） | ★★★（C# 快，但音频/OMR 生态少） |
| UI 质量（15%） | ★★★★★ | ★★★★★ | ★★★（Qt Widgets 中规中矩，可自绘/换 Fusion+QSS） | ★★★★ |
| 原生按键调用便利度（15%） | ★★（需 FFI/原生插件/旁路进程） | ★★★★★（`windows` crate 直调） | ★★★★★（`ctypes` 直调，进程内零 IPC） | ★★★★★ |
| 综合 | 76/100 | 68/100 | **88/100** | 72/100 |

> 打包体积参考：[Electron ≈80–150 MB vs Tauri ≈2.5–10 MB 的对比](https://github.com/jwynia/agent-skills/blob/main/skills/tech/development/tooling/electron-best-practices/references/tooling/tauri-comparison.md)；Python 实测：[auto_music_player v1.4.2 Windows 单文件 EXE = 28,685,373 B ≈ 27.36 MiB](https://github.com/xiaominaimoyu/auto_music_player/releases)（PyInstaller 6.22.2 + PyQt6 6.11.0 + mido 1.3.3）；[midikey-player](https://github.com/ChickenD233/midikey-player) 单文件 exe ≈23 MB。

### 6.2 唯一推荐主方案：**Python 3.11 + PySide6（单进程）**

选它的 5 条硬理由：

1. **音频分析是最大不确定性，Python 生态把风险降到最低**：basic-pitch / librosa / music21 / mido / soundfile 全是一行 import；换方案、做实验、写回归测试成本最低。用 Rust/C# 复刻同一套试错，工期至少 ×2。
2. **按键注入是"零 IPC"级别**：`ctypes.windll.user32.SendInput` + `winmm.timeBeginPeriod` + `kernel32.CreateWaitableTimerExW` 全部进程内可达；调度线程与 UI 同进程，没有 Electron 的"JS↔原生↔旁路进程"三段式抖动与打包麻烦。
3. **打包完全可接受**：PySide6 + numpy/scipy 的 PyInstaller/Nuitka 产物 ≈ 60–120 MB；同类 PyQt6 成品已实测 27 MiB。若把 basic-pitch 做成可选组件，Lite 包可以压到 ≈60 MB。
4. **有直接可对标的成功先例**：同一个游戏、同一套键位模型，[auto_music_player](https://github.com/xiaominaimoyu/auto_music_player)（MIT/PyQt6）与 [delta-melodica](https://github.com/gujingyun/delta-melodica)（MIT/Python）都跑通了，且 README 明确记录了 UIPI、扫描码、修饰键 settle、焦点检测、降级报告等实战细节——相当于免费拿到一份"避坑清单"。
5. **单进程 = 更少故障面**：没有 IPC 超时、没有子进程被杀、没有版本错配；崩溃日志一处收口，符合"质量可靠"。

代价与对策：
- UI 不如 Web 精致 → 简谱是"数字+点+线"的简单图形，`QPainter` 自绘 1–2 天可达可用；配色/间距用 QSS 统一；关键交互（键盘录入、播放高亮）比视觉更重要。
- 同步/异步混用易卡 UI → 音频分析、文件 IO 一律 `QThread`/`QProcess`；UI 只做渲染。
- 打包体积 → 默认不装 torch；onnxruntime 可选；用 `--exclude-module` 去 numba/tkinter/test 等。

**备选方案：Tauri 2 + Rust + React**
- 适合：团队 TS/Rust 强、对安装体积（10–30 MB）和 UI 质感要求高、愿意接受音频分析更高成本。
- 可行路径：UI = React/TS（简谱渲染可用 SVG 自绘或 VexFlow/OSMD 思路）；Rust 侧 `windows` crate + waitable timer + MMCSS 做注入与调度（Sky Auto Player 已验证）；音频分析 = (a) 引入 [basic-pitch-rs](https://docs.rs/basic-pitch-rs/0.1.0/basic_pitch/model/)（内置官方 `nmp.onnx`，tract 纯 Rust / ort 加速）或 (b) 开发期用 Python CLI 生成 sidecar note events，发布期可选装 Python 组件。
- 风险：Rust DSP 调参慢、`basic-pitch-rs` 是 0.1.x 新库、后期维护成本高。

**不推荐 Electron 作为主方案**：体积最大、双运行时、原生按键要么 FFI 要么再挂一个 Python 进程；它的优势（Web UI）在本产品中权重不足以抵消运维复杂度。若团队已有 Electron 资产，可用"Electron UI + Python 引擎进程"作为过渡，但需接受 ≈200 MB+ 安装包和进程监管逻辑。

### 6.3 如何避免"音频分析依赖太重"

| 策略 | 做法 |
|---|---|
| **默认轻量、能力可选** | 默认 Lite（DSP 兜底 + MIDI/文本导入）；basic-pitch/人声分离作为"分析组件" |
| **组件化管理** | 组件目录独立、清单 JSON 描述版本/大小/SHA-256/许可证；首次使用时引导下载；**同时提供 Full 离线安装包**（离线要求不能只靠下载） |
| **不要 torch** | 只用 onnxruntime（CPU wheel 十几 MB 级）跑 basic-pitch 的 ONNX 模型；坚决不 import torch/TF |
| **懒加载 + 超时 + 子进程** | 分析跑在子进程；超时/内存上限/取消按钮；失败回退 DSP 并明确提示 |
| **缓存 sidecar** | 结果按文件哈希缓存；用户二次打开不重算 |
| **两段式体验** | 先 1–2 s 出 DSP 草稿（可立即听/编辑），后台再跑 ML 精修，用户可随时取消 |
| **依赖审计** | 每个新增 pip 包记录 License 与体积；禁止 GPL/AGPL 进包（aubio/Essentia 直接排除） |
| **合成器** | 不引入 FluidSynth/SF2（额外 DLL + License 复杂度）：MVP 用"预渲染 WAV + QtMultimedia/sounddevice 播放"，或 numpy 加性合成正弦+包络；后续再考虑 SF2 |

---

## 7. F. 简谱编辑器 UI 参考与设计建议

### 7.1 现有软件的交互模式

| 软件 / 项目 | 交互模式 | 可借鉴 |
|---|---|---|
| **JP-Word**（商业，Windows 简谱排版标杆） | "像在 Word 里打字"的所见即所得；独创"切换音符时值组合"一键改时值组合；自动减时线/小节线/折行；丰富快捷键 | **时值组合一键切换**是简谱录入效率的关键；排版自动化（自动连减时线）必须做 |
| **悦谱 Dolce**（MIT，TS/Web+桌面） | **左源码右谱面实时联动**；↑↓ 调内音级、Alt+↑↓ 半音、Ctrl/⌘+↑↓ 八度；点选音符双向定位源码；拍数不符标红；六种文本格式互转 | **双栏（源码↔谱面）** 是性价比最高的编辑架构；键位设计可直接对齐 |
| **JianpuEditor**（Apache-2.0，C#） | 工具栏步进式：增时+/减时- **六档循环**（1/16→1/8→1/4→+1→+2→+3）；高/低音点、附点按钮；Ctrl 多选、Shift 范围选；拆分/合并；连音线点两音连接；装饰音按钮；Ctrl+Z/Y；点击谱头内联编辑 | **六档时值循环**、**连音线两点式**、**多选批量修饰**、**内联编辑谱头**都很实用 |
| **delta-melodica** | "原谱文字 + 谱面预览"；精确分数/小数拍数；选段编辑；试听跟随 | 原谱保真 + 预览分离，用户改坏了能回退 |
| **auto_music_player** | 上传/录制 → **校对表格**（改音符/时值/和弦）→ 入库 → 演奏；按钮步进录制 + 物理键实时录制 | **识别结果先进校对表**再入库，是"不伪造识别结果"的正确姿势 |
| 光·遇 Sky Music / 各 Sky 播放器 | 网格/卷帘式谱面，节奏按拍格点选 | "网格点选"比"打字"更适合移动端/新手 |

### 7.2 推荐交互设计（键盘录入优先）

**光标模型**：音符槽位（`(bar, beat, noteIndex)`）为唯一光标；左右键在音符间移动、上下键在八度/相邻音级间移动（遵循 Dolce 键位）、Tab 在乐句间跳；点击谱面即定位到最近槽位并同步源码行。

**录入状态机（建议键位）**

| 按键 | 行为 | 说明 |
|---|---|---|
| `1`–`7` | 在当前槽位写入该音级（中音区），光标后移 | 最常用路径：一手按数字、一手按空格 |
| `0` | 休止符 | |
| `↑ / ↓` | 光标上下移动；`Alt+↑/↓` 半音；`Ctrl+↑/↓` 八度 | 对齐 Dolce |
| `空格` | 确认音高并前进到下一槽位 | "先音高后时值"或"先时值后音高"两种模式都要有 |
| `-` / `=` / `_` | 减时线 / 增时线 / 附点（或按六档循环：`[` `]`） | 参考 JianpuEditor 六档循环 |
| `T` | 连音线：选中起点→再点终点（两点式） | 参考 JianpuEditor |
| `|` | 插入小节线；`Enter` 换行/新小节 | |
| `.` | 附点（与低音记号区分：用 `,` 表低八度） | 文本协议里要明确定义，避免歧义 |
| `Del` | 删除当前音符；`Ctrl+Z/Y` 撤销重做 | 撤销栈要覆盖所有批量操作 |

**时值输入两种流派**：① 先音高后时值（打完音再按 `_`/`-` 调）——适合新手；② 时值锁定（先选时值，再连续打音）——适合熟练者。**建议默认 ①，提供 ② 的开关**（JP-Word 的"时值组合"本质是②的自动化）。

**播放高亮**：
- 预览用"预渲染整曲 WAV + 播放位置驱动高亮"最稳（不依赖实时调度），播放头 = 音频时钟；若实时合成则用音频回调帧位置。
- 高亮当前音符（反色/描边）+ 当前小节淡色背景 + 自动滚动（当前行保持在可视区中间）；点击谱面任意音即 seek 到该音。
- 演奏（游戏）模式下高亮单独一条"事件进度条"，与试听进度解耦（两者时间基准不同：一个音频时钟，一个注入调度时钟）。

**校验与反馈（质量相关，别省）**
- 每小节拍数校验：不符标红并提示差几拍（Dolce/JianpuEditor 都做了）。
- 音域校验：超出/需降级/半音不可用的音实时标黄，旁边给"降级建议"。
- 导入校对表：识别/转换结果先进入可编辑表格（音符、时值、调号、BPM），确认后才入库。
- 降级报告：演奏前弹一个"预检"对话框，列出将丢弃/折叠/改调的音符数量，让用户决定是否继续。

---

## 8. G. 现有同类开源项目清单（12 个）

| # | 项目 | 栈 | License | 可借鉴点 | 风险/备注 |
|---|---|---|---|---|---|
| 1 | [xiaominaimoyu/auto_music_player](https://github.com/xiaominaimoyu/auto_music_player)（17★，2026-11 活跃） | Python 3.14 + PyQt6 + mido + SQLite，PyInstaller 单文件 | **MIT** | **本产品最强对标**：三角洲口琴 profile、IR/投影、降级统计、修饰键 settle、焦点暂停、延迟校准、真人化节奏、简谱文本协议、MIDI/MusicXML/JSON 导入、离线 OMR 组件化 | 同为竞品；MIT 复用需保留版权声明；无代码签名 |
| 2 | [gujingyun/delta-melodica](https://github.com/gujingyun/delta-melodica)（19★，2026-09） | Python | **MIT** | 三角洲口风琴专项；**形式化谱面演奏规则表**（反复/房子/连音/三连音/中途调号）；原谱+预览双表示；F8/F9 | 竞品；功能面较窄（无音频转谱） |
| 3 | [lodebar2026/dolce 悦谱](https://github.com/lodebar2026/dolce)（96★，2026-11 活跃） | TypeScript（Web + Windows 桌面） | **MIT**（README 徽章；LICENSE 需复核） | 简谱/五线谱编辑器、6 种文本格式互转、OMR、双栏实时联动、键位设计、导出 MIDI/PDF/PNG | 体量大，适合"读设计"而非"抄代码" |
| 4 | [loootte/JianpuEditor](https://github.com/loootte/JianpuEditor)（C#，2026-09） | C# WinForms，自研 MIDI 解析 | **Apache-2.0** | 结构化谱面 JSON、六档时值循环、多选/拆分合并、装饰音、连音线、MIDI 导入量化/调性/小节规范化 | License 友好但 WinForms 技术栈不同 |
| 5 | [pumni/Sky-Auto-Player](https://github.com/pumni/Sky-Auto-Player)（20★，2026-11 活跃） | **Rust + Tauri + React** | **GPL-3.0** | **按键调度最佳工程范例**：QPC/MMCSS/waitable timer、SendInput 批处理、hold 按帧对齐、四层架构、诊断/校准 UI | GPL：不能闭源分发；只可学习架构 |
| 6 | [ChickenD233/midikey-player](https://github.com/ChickenD233/midikey-player)（50★，2026-10） | 单文件 exe（无 .NET 依赖），卷帘编辑器 | 未声明（README 称免费开源） | MIDI→按键播放器，内置卷帘编辑器、自定义键位方案、MIDI 设备实时演奏；明确支持三角洲 | License 不明，不可直接复用代码 |
| 7 | [JeanWenzelCN/DF-NoctReed](https://github.com/JeanWenzelCN/DF-NoctReed) | Android/Kotlin + Compose + 无障碍手势 | 未声明 | 三角洲口琴安卓端：简谱解析（高低音点/升降号/延音/乐句）、12 键位校准、BPM 实时调速、悬浮窗 | 移动端方案，桌面不适用；有格式规范可参考 |
| 8 | [xiexianyan/Playing-the-harp-automatically-in-Genshin](https://github.com/xiexianyan/Playing-the-harp-automatically-in-Genshin) | Python + pyautogui | **无 License** | 原神自动弹琴最简实现（文本谱→按键、停顿标记） | 不可复用代码；pyautogui 走 keybd_event，效果差 |
| 9 | [GJYUSUN/GenshinAutoPlayBalladsofBreeze](https://github.com/GJYUSUN/GenshinAutoPlayBalladsofBreeze) | Python + PyQt5 + OpenCV + pyautogui | **无 License** | **屏幕图像识别**判断谱面位置再按键；说明"图像识别方案正确率受 CPU 影响" | 反面教材：识别累、慢、易错；不可复用 |
| 10 | [ssb22/jianpu-ly](https://github.com/ssb22/jianpu-ly)（132★，2026-11） | Python → LilyPond | **Apache-2.0** | 文本简谱→排版；简谱语法与移调处理 | 依赖 LilyPond（GPL），不适合直接嵌入 |
| 11 | [spotify/basic-pitch](https://github.com/spotify/basic-pitch)（6.1k★） / [NeuralNote](https://github.com/DamRsn/NeuralNote)（3.5k★，VST） | Python / C++ | **Apache-2.0** | 音频→MIDI 主力；NeuralNote 是"GUI 化音频转 MIDI"的成熟交互参考 | NeuralNote 是 VST 插件，集成方式仅参考 |
| 12 | [Music-and-Culture-Technology-Lab/omnizart](https://github.com/Music-and-Culture-Technology-Lab/omnizart)（2k★） | Python + TF | **MIT** | 全功能转谱 CLI（人声旋律/鼓/和弦/beat），命令行组织方式可参考 | 依赖重，不进主程序 |

**License 风险提示**：GPL-3（Sky Auto Player、LilyPond、aubio）与 AGPL-3（Essentia）**不能进入闭源分发包**；无 License 的仓库（RuMaxwell/jianpu、ChickenD233、DF-NoctReed、两个原神项目、bytedance/piano_transcription）默认"保留所有权利"，**只能读思路，不能复制代码**。MIT/Apache-2.0 项目可以复用，但必须保留版权与许可声明（建议项目内放 `THIRD_PARTY_NOTICES.md`）。

---

## 9. 风险清单

| 等级 | 风险 | 影响 | 缓解 |
|---|---|---|---|
| **高** | **合规/封号**：官方禁用列表点名"Python 自动脚本/AutoHotkey/按键精灵/鼠标宏"；腾讯 2026-07 公告把"鼠标宏"统一视为外挂（[报道](https://m.163.com/dy/article/L224UBHL0526K1KN.html)） | 账号受限、产品无法公开推广 | 定位单机练习工具；启动风险提示+阅读锁定；默认"仅试听"；不碰内存/不注入/不装驱动；不提供"绕过检测"；文档与商店描述避免"自动上分/竞技"表述 |
| **高** | 反作弊行为检测（精确等间隔连发是明显特征） | 同上 | 提供 humanize（jitter/呼吸）、NPC 任务模式放宽为"顺序正确优先"；提供"手动节奏模式"（用户按，程序只提示） |
| 中 | 音频转谱效果不达预期（混音、失真、说唱） | 核心卖点变弱 | 主力+兜底双方案；"分析组件"可选；强引导用户先用 MIDI/人声版；校对表 + 可手动改 |
| 中 | 依赖膨胀/打包失败（numpy/onnxruntime/PySide6 的 DLL 冲突） | 发布延期 | 固定 Python 3.11、构建机干净 venv、Nuitka/PyInstaller onedir 而非 onefile、CI 每次跑冒烟启动 |
| 中 | 许可污染（无意引入 GPL/AGPL/无 License 代码） | 法律风险 | 依赖白名单 + 每次 PR 审 License；THIRD_PARTY_NOTICES |
| 中 | 游戏版本更新改键位/音域 | 功能失效 | Profile 配置化（键位/修饰键/settle/音域全部数据驱动），玩家可自改；版本检测提示 |
| 低 | UIPI/管理员权限 | 按键无效且无报错 | 启动检测、以管理员重启按钮、文档说明 |
| 低 | 修饰键组合被游戏"吃掉"（高低音变中音） | 少量错音 | settle 时间可调 + 默认 30 ms + 演奏前校准向导 |
| 低 | 焦点丢失/误触发到其他窗口 | 乱按键 | 前台焦点校验 + F8 紧急停止 + 发送前目标窗口确认 |

---

## 10. 两周 MVP 计划（2–3 人小团队，AI 辅助开发）

目标：**第 14 天能交付一个"导入 MIDI/音频 → 生成简谱 → 校对 → 在游戏里正确演奏 NPC 任务 4 首曲 + 自由演奏"的可安装版本。**

### 第 1 周：能弹（编辑器 + MIDI + 按键引擎）

| 天 | 任务 | 交付/验收 |
|---|---|---|
| D1 | 数据模型 + 序列化 + 版本迁移；Score→Plan 编译骨架 | JSON 存取往返无损；单元测试覆盖时值/附点/连音 |
| D2 | 简谱渲染（QPainter：数字、八度点、减时线、增时线、附点、小节线、连音线）+ 缩放/滚动 | 4/4、3/4 谱面渲染正确，截图评审 |
| D3 | 键盘录入状态机 + 光标 + 时值循环 + 撤销/重做 + 拍数校验 | 纯键盘录入《夜莺》8 音不碰鼠标 < 60 s；撤销 20 步正确 |
| D4 | 内置合成器试听（预渲染 WAV + 播放头高亮/自动滚动/点击 seek） | 播放与高亮同步误差 < 1 帧；暂停/续播正常 |
| D5 | MIDI 导入管线：解析→选轨→音符化→量化（0.25 拍/三连音）→调性→移调→音域折叠→降级报告 | 导入 3 首真实 MIDI，产出可演奏谱；降级报告准确 |
| D6 | **按键引擎**：SendInput+scancode、绝对时钟线程、timeBeginPeriod、hold≥25 ms、修饰键 settle/release、F8 停止、焦点校验、倒计时切窗 | 记事本回显 100 个事件抖动 ≤ ±5 ms；游戏内高低音正确率 100%（先手动校准） |
| D7 | 口琴 Profile（21 键 + 鼠标修饰）+ 演奏预检/降级提示 + 曲库（本地存储） | 4 首 NPC 任务曲全部一次吹对（顺序正确）；自由演奏 60 s 无漏音 |

### 第 2 周：能转（音频 + 方案 + 打包 + 验收）

| 天 | 任务 | 交付/验收 |
|---|---|---|
| D8 | DSP 兜底管线（YIN/HPSS/onset/beat/调性）+ 子进程 + 进度/取消/超时 | 干净的哼唱/单声部音频 → 可读简谱；< 10 s 出结果 |
| D9 | basic-pitch ONNX 分析组件（下载/校验/许可证展示/失败回退 DSP）+ 主旋律筛选（skyline+连续性） | 真实歌曲（人声清晰）主旋律可用率主观 ≥70%；崩溃不影响主程序 |
| D10 | 校对 UI（表格：音符/时值/调号/BPM/降级标记）+ 导入报告 | 用户 3 分钟内能修好一首识别错误的曲子 |
| D11 | "音乐方案"（Profile+移调+速度+音域策略+humanize+延迟补偿）保存/加载；曲库管理 | 方案切换后同一谱正确投影；设置持久化 |
| D12 | 打包：Lite/Full 两包（PyInstaller onedir + Nuitka 备选）、图标、版本、许可清单、风险提示页 | 干净 Win10/11 机器安装即用；Lite ≤ 80 MB、Full ≤ 180 MB |
| D13 | 真机验收矩阵：管理员/非管理员、1080p 窗口/无边框、切窗、失焦暂停、F8、长曲 3 分钟、连续 10 次演奏不卡键 | 全部通过；无卡键；无进程残留 |
| D14 | 打磨 + 回归测试 + 使用文档 + 免责声明 + 发布包 | 冒烟测试脚本全绿；发布 checklist 完成 |

### MVP 明确不做（避免范围爆炸）
- 不做 OMR（图片/PDF 识谱）、不做 MusicXML 全量编辑、不做多声部/和弦（游戏不支持）、不做云同步/账号、不做 MIDI 输出以外的对外集成、不做驱动/硬件方案、不做"防检测"。
- 音频：MVP 只做"单主旋律"，不做鼓/和弦/多轨分离 UI；人声分离仅给文档指引（用户自行用 UVR）。

### 关键验收指标（Go/No-Go）
1. 游戏内 NPC 任务 4 首曲子 **一次通过率 100%**（顺序正确、无漏音、自动提交 Q）。
2. 自由演奏 3 分钟，**漏音 ≤ 1%**，无卡键、无修饰键残留。
3. 事件发送抖动 **P99 ≤ ±5 ms**（相对绝对时间轴）。
4. MIDI 导入 10 首样本，**可演奏率 ≥ 90%**（不需手工改音高，只改节奏/降级）。
5. 真实歌曲音频（3 首）转谱后，**主旋律主观可用率 ≥ 70%**（人工评分 1–5，≥3.5 分）。
6. 安装包在无 Python/无 CUDA 的干净 Windows 10/11 上**双击可用**。

---

## 附录 A：关键参考链接

**游戏/键位与合规**
- [三角洲行动口风琴琴谱整理（微信公众号，含 PC/手机按键说明）](http://mp.weixin.qq.com/s?__biz=MzYzMjM4ODQ4MQ==&mid=2247483890&idx=1&sn=69b605c59fe1c4c253f4c8391b71796e)
- [三角洲行動 禁用軟硬體列表（Garena 官方公告）](https://deltaforce.garena.com/zh_tw/news/announcement/94ABXR)
- [腾讯：鼠标宏被视为外挂，最高封十年（2026-07 报道）](https://m.163.com/dy/article/L224UBHL0526K1KN.html)
- [Midishow 社区问答：三角洲口琴自动演奏/MIDI 导入经验](https://www.midishow.com/question/8696.html)

**Windows 平台 API**
- [SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput) · [KEYBDINPUT](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-keybdinput) · [timeBeginPeriod](https://learn.microsoft.com/en-us/windows/win32/api/timeapi/nf-timeapi-timebeginperiod) · [CreateWaitableTimerExW](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-createwaitabletimerexw) · [AvSetMmThreadCharacteristicsW](https://learn.microsoft.com/en-us/windows/win32/api/avrt/nf-avrt-avsetmmthreadcharacteristicsw)

**格式标准**
- [MusicXML 4.0（W3C CG Final Report）](https://www.w3.org/2021/06/musicxml40/) · [MIDI 规范（MIDI Association）](https://midi.org/) · [简谱空间](https://jianpu.space/) · [hexo-yopu（简谱空间语法/SVG 渲染参考）](https://www.npmjs.com/package/hexo-yopu) · [Sky Music 编辑器](https://specy.github.io/skyMusic/)

**关键项目**
- [auto_music_player](https://github.com/xiaominaimoyu/auto_music_player) · [delta-melodica](https://github.com/gujingyun/delta-melodica) · [Dolce](https://github.com/lodebar2026/dolce) · [JianpuEditor](https://github.com/loootte/JianpuEditor) · [Sky Auto Player](https://github.com/pumni/Sky-Auto-Player) · [midikey-player](https://github.com/ChickenD233/midikey-player) · [jianpu-ly](https://github.com/ssb22/jianpu-ly)

**音频/ML**
- [basic-pitch](https://github.com/spotify/basic-pitch)（[PyPI](https://pypi.org/project/basic-pitch/)）· [ICASSP 2022 论文](https://arxiv.org/abs/2203.09893) · [basic-pitch-rs](https://docs.rs/basic-pitch-rs/0.1.0/basic_pitch/model/) · [SOME](https://github.com/openvpi/some) · [GAME](https://github.com/openvpi/GAME) · [librosa](https://github.com/librosa/librosa)（[pyin](https://librosa.org/doc/latest/generated/librosa.pyin.html)）· [torchcrepe](https://github.com/maxrmorrison/torchcrepe) · [CREPE](https://github.com/marl/crepe) · [RMVPE](https://github.com/Dream-High/RMVPE) · [piano_transcription_inference](https://github.com/qiuqiangkong/piano_transcription_inference) · [omnizart](https://github.com/Music-and-Culture-Technology-Lab/omnizart) · [MT3](https://github.com/magenta/mt3) · [Demucs](https://github.com/facebookresearch/demucs) · [UVR](https://github.com/Anjok07/ultimatevocalremovergui) · [Spleeter](https://github.com/deezer/spleeter) · [music21](https://github.com/cuthbertLab/music21) · [mido](https://github.com/mido/mido)

**注入/输入**
- [Interception](https://github.com/oblitum/Interception)（LGPL 非商用/商业授权）· [ViGEmBus（已退役）](https://github.com/nefarius/ViGEmBus) · [nut.js](https://github.com/nut-tree/nut.js) · [robotjs](https://github.com/octalmage/robotjs) · [pydirectinput](https://github.com/learncodebygaming/pydirectinput) · [pyautogui](https://github.com/asweigart/pyautogui)

**技术栈**
- [PySide6 / Qt for Python](https://doc.qt.io/qtforpython-6/) · [PyInstaller](https://pyinstaller.org/) · [Nuitka](https://nuitka.net/) · [Tauri 2](https://v2.tauri.app/) · [Electron](https://www.electronjs.org/) · [Electron vs Tauri 体积对比](https://github.com/jwynia/agent-skills/blob/main/skills/tech/development/tooling/electron-best-practices/references/tooling/tauri-comparison.md) · [OpenSheetMusicDisplay](https://github.com/OpenSheetMusicDisplay/opensheetmusicdisplay) · [VexFlow](https://github.com/0xfe/vexflow) · [Tone.js](https://github.com/tonejs/Tone.js)

---

## 附录 B：License 速查（GitHub API 实测，2026-11-18）

| 项目 | License | 主语言 | Star | 最近推送 |
|---|---|---|---|---|
| xiaominaimoyu/auto_music_player | MIT | Python | 17 | 2026-11-15 |
| gujingyun/delta-melodica | MIT | Python | 19 | 2026-09-20 |
| lodebar2026/dolce | NOASSERTION（README 标 MIT） | TypeScript | 96 | 2026-11-15 |
| loootte/JianpuEditor | Apache-2.0 | C# | 1 | 2026-09-19 |
| RuMaxwell/jianpu | 无 | TypeScript | 1 | 2025-05-19 |
| pumni/Sky-Auto-Player | GPL-3.0 | Rust | 20 | 2026-11-18 |
| spotify/basic-pitch | Apache-2.0 | Python | 6091 | 2025-11-13 |
| spotify/basic-pitch-ts | Apache-2.0 | TypeScript | 366 | 2023-05-23 |
| openvpi/some | MIT | Python | 706 | 2026-03-07 |
| openvpi/GAME | MIT | Python | 304 | 2026-10-24 |
| Music-and-Culture-Technology-Lab/omnizart | MIT | Python | 2002 | 2026-05-31 |
| bytedance/piano_transcription | **无（已归档）** | Python | 2015 | 2023-08-18 |
| qiuqiangkong/piano_transcription_inference | MIT | Python | 503 | 2026-11-12 |
| magenta/mt3 | Apache-2.0 | Python | 1776 | 2026-10-27 |
| maxrmorrison/torchcrepe | MIT | Python | 525 | 2025-05-16 |
| marl/crepe | MIT | Python | 1428 | 2024-08-19 |
| Dream-High/RMVPE | Apache-2.0 | Python | 337 | 2024-01-25 |
| facebookresearch/demucs | MIT（已归档） | Python | 10415 | 2024-04-24 |
| Anjok07/ultimatevocalremovergui | MIT | Python | 27226 | 2026-10-06 |
| deezer/spleeter | MIT | Python | 28537 | 2026-10-28 |
| librosa/librosa | ISC | Python | 9002 | 2026-11-17 |
| aubio/aubio | **GPL-3.0** | C | 3790 | 2026-04-10 |
| MTG/essentia | **AGPL-3.0** | C++ | 3809 | 2026-11-05 |
| mido/mido | MIT | Python | 1663 | 2026-11-09 |
| ssb22/jianpu-ly | Apache-2.0 | Python | 132 | 2026-11-17 |
| oblitum/Interception | 双许可（LGPL 非商用/商业付费） | C | 2049 | 2021-08-09 |
| OpenSheetMusicDisplay | BSD-3-Clause | TypeScript | 2021 | 2026-11-15 |
| 0xfe/vexflow | NOASSERTION（官网标 MIT） | TypeScript | 4405 | 2025-03-05 |
| tonejs/Tone.js | MIT | TypeScript | 14927 | 2026-11-15 |
