export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '00:00';
  const rounded = Math.floor(totalSeconds);
  const hours = Math.floor(rounded / 3600);
  const mins = Math.floor((rounded % 3600) / 60);
  const secs = rounded % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (hours > 0) {
    return `${hours}:${pad(mins)}:${pad(secs)}`;
  }
  return `${pad(mins)}:${pad(secs)}`;
}

export function formatBytes(bytes?: number | string | null): string {
  const num = Number(bytes);
  if (!Number.isFinite(num) || num <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let idx = 0;
  let val = num;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return `${val >= 100 || idx === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[idx]}`;
}

export function formatRelativeDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function sanitizeExtensionLabel(mimeType: string, filename: string): string {
  const extMatch = filename.match(/\.([a-zA-Z0-9]+)$/);
  if (extMatch) return extMatch[1].toUpperCase();
  if (mimeType.includes('mpeg')) return 'MP3';
  if (mimeType.includes('wav')) return 'WAV';
  if (mimeType.includes('mp4')) return 'MP4';
  if (mimeType.includes('quicktime')) return 'MOV';
  if (mimeType.includes('webm')) return 'WEBM';
  return 'MEDIA';
}
