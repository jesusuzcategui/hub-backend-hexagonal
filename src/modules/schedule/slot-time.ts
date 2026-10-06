export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// Split a time range into 1-hour chunks. Returns array of { chunkStart, chunkEnd } in HH:MM.
export function hourChunks(startTime: string, endTime: string): Array<{ chunkStart: string; chunkEnd: string }> {
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  const chunks: Array<{ chunkStart: string; chunkEnd: string }> = [];
  for (let m = startMin; m + 60 <= endMin; m += 60) {
    chunks.push({
      chunkStart: `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`,
      chunkEnd: `${pad2(Math.floor((m + 60) / 60))}:${pad2((m + 60) % 60)}`,
    });
  }
  // If range < 1h or not divisible, treat the whole range as one slot
  if (chunks.length === 0 && endMin > startMin) {
    chunks.push({ chunkStart: startTime, chunkEnd: endTime });
  }
  return chunks;
}
