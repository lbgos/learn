/** Area averaging limits aliasing when reducing a device's sample rate. */
export function resampleMono(
  input: Float32Array,
  inputRate: number,
  outputRate = 16000,
): Float32Array {
  if (
    !Number.isFinite(inputRate) ||
    inputRate <= 0 ||
    !Number.isFinite(outputRate) ||
    outputRate <= 0
  )
    throw new Error("Invalid sample rate");
  const output = new Float32Array(Math.floor((input.length * outputRate) / inputRate));
  const ratio = inputRate / outputRate;
  for (let i = 0; i < output.length; i++) {
    const start = i * ratio;
    const end = Math.min((i + 1) * ratio, input.length);
    let sum = 0;
    for (let j = Math.floor(start); j < Math.ceil(end); j++) {
      sum += (input[j] ?? 0) * (Math.min(end, j + 1) - Math.max(start, j));
    }
    output[i] = sum / (end - start);
  }
  return output;
}

export function encodeS16le(input: Float32Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(input.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < input.length; i++) {
    const sample = Math.max(-1, Math.min(1, Number.isFinite(input[i]) ? input[i]! : 0));
    view.setInt16(i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}

export function framesToPcm(frames: readonly Float32Array[], inputRate: number) {
  const samples = new Float32Array(frames.reduce((sum, frame) => sum + frame.length, 0));
  let offset = 0;
  for (const frame of frames) {
    samples.set(frame, offset);
    offset += frame.length;
  }
  // Resample once so individual worklet frame boundaries cannot lose samples.
  return encodeS16le(resampleMono(samples, inputRate));
}
