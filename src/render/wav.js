// PCM WAV encoder. Pure bytes in, Blob out — no app state.

// 16-bit gets 1-LSB TPDF dither (plain truncation distorts fades);
// 24-bit (the master export) needs none in practice.
export function encodeWav(left, right, sampleRate, bits = 16) {
  const frameCount = Math.min(left.length, right.length);
  const bytesPerSample = bits / 8;
  const blockAlign = 2 * bytesPerSample;
  const dataSize = frameCount * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  function writeString(offset, value) {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  }

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bits, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < frameCount; i++) {
    const l = Math.max(-1, Math.min(1, left[i]));
    const r = Math.max(-1, Math.min(1, right[i]));
    if (bits === 24) {
      const vl = Math.max(-8388608, Math.min(8388607, Math.round(l * 8388607)));
      const vr = Math.max(-8388608, Math.min(8388607, Math.round(r * 8388607)));
      view.setUint8(offset, vl & 0xff);
      view.setUint8(offset + 1, (vl >> 8) & 0xff);
      view.setUint8(offset + 2, (vl >> 16) & 0xff);
      view.setUint8(offset + 3, vr & 0xff);
      view.setUint8(offset + 4, (vr >> 8) & 0xff);
      view.setUint8(offset + 5, (vr >> 16) & 0xff);
    } else {
      const dl = Math.random() - Math.random(); // TPDF, ±1 LSB
      const dr = Math.random() - Math.random();
      const vl = Math.max(-32768, Math.min(32767, Math.round(l * 32767 + dl)));
      const vr = Math.max(-32768, Math.min(32767, Math.round(r * 32767 + dr)));
      view.setInt16(offset, vl, true);
      view.setInt16(offset + 2, vr, true);
    }
    offset += blockAlign;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}
