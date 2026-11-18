/**
 * 音频解码：把用户选择的 mp3/wav/m4a 等文件解码为单声道 22.05kHz PCM（在渲染进程用 Chromium 自带解码器）。
 */
export interface DecodedAudio {
  pcm: Float32Array;
  sampleRate: number;
  durationSec: number;
  channels: number;
}

export async function decodeAudioFile(data: Uint8Array): Promise<DecodedAudio> {
  const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const context = new OfflineAudioContext(1, 1, 22050);
  const audioBuffer = await context.decodeAudioData(buffer);
  const channels = audioBuffer.numberOfChannels;
  const pcm = new Float32Array(audioBuffer.length);
  for (let channelIndex = 0; channelIndex < channels; channelIndex += 1) {
    const channel = audioBuffer.getChannelData(channelIndex);
    for (let index = 0; index < channel.length; index += 1) {
      pcm[index] += channel[index] / channels;
    }
  }
  return {
    pcm,
    sampleRate: audioBuffer.sampleRate,
    durationSec: audioBuffer.duration,
    channels,
  };
}
