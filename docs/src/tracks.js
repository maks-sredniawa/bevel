const AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wav', 'webm']);
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function isAudioFile(name) {
  return AUDIO_EXTENSIONS.has(name.split('.').pop().toLowerCase());
}

export function parseTrackName(fileName) {
  const stem = fileName.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
  const withoutNumber = stem.replace(/^\d{1,3}(?:\s*[-.)]\s*|\s+)(?=\S)/, '');
  const separator = withoutNumber.indexOf(' - ');
  if (separator === -1) return { artist: '', title: withoutNumber };
  return { artist: withoutNumber.slice(0, separator).trim(), title: withoutNumber.slice(separator + 3).trim() };
}

export function sortByName(files) {
  return [...files].sort((a, b) => collator.compare(a.name, b.name));
}

export function groupIntoPlaylists(items) {
  const topsWithSubfolders = new Set(
    items.filter((item) => item.name.split('/').length >= 3).map((item) => item.name.split('/')[0]),
  );
  const groups = new Map();
  for (const item of items) {
    const parts = item.name.split('/');
    let name = null;
    if (parts.length > 1) name = topsWithSubfolders.has(parts[0]) && parts.length >= 3 ? parts[1] : parts[0];
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(item);
  }
  return [...groups].map(([name, grouped]) => ({ name, items: grouped }));
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}
