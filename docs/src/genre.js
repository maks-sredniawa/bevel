import { parseId3 } from './audio-info.js';

const HEAD_BYTES = 65536;
const MAX_ID3_BYTES = 4 * 1024 * 1024;
const MAX_MOOV_BYTES = 8 * 1024 * 1024;

const ID3V1_GENRES = [
  'Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop', 'Jazz', 'Metal',
  'New Age', 'Oldies', 'Other', 'Pop', 'R&B', 'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial',
  'Alternative', 'Ska', 'Death Metal', 'Pranks', 'Soundtrack', 'Euro-Techno', 'Ambient', 'Trip-Hop', 'Vocal', 'Jazz+Funk',
  'Fusion', 'Trance', 'Classical', 'Instrumental', 'Acid', 'House', 'Game', 'Sound Clip', 'Gospel', 'Noise',
  'Alternative Rock', 'Bass', 'Soul', 'Punk', 'Space', 'Meditative', 'Instrumental Pop', 'Instrumental Rock', 'Ethnic', 'Gothic',
  'Darkwave', 'Techno-Industrial', 'Electronic', 'Pop-Folk', 'Eurodance', 'Dream', 'Southern Rock', 'Comedy', 'Cult', 'Gangsta',
  'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle', 'Native American', 'Cabaret', 'New Wave', 'Psychedelic', 'Rave', 'Showtunes',
  'Trailer', 'Lo-Fi', 'Tribal', 'Acid Punk', 'Acid Jazz', 'Polka', 'Retro', 'Musical', 'Rock & Roll', 'Hard Rock',
  'Folk', 'Folk-Rock', 'National Folk', 'Swing', 'Fast Fusion', 'Bebop', 'Latin', 'Revival', 'Celtic', 'Bluegrass',
  'Avantgarde', 'Gothic Rock', 'Progressive Rock', 'Psychedelic Rock', 'Symphonic Rock', 'Slow Rock', 'Big Band', 'Chorus', 'Easy Listening', 'Acoustic',
  'Humour', 'Speech', 'Chanson', 'Opera', 'Chamber Music', 'Sonata', 'Symphony', 'Booty Bass', 'Primus', 'Porn Groove',
  'Satire', 'Slow Jam', 'Club', 'Tango', 'Samba', 'Folklore', 'Ballad', 'Power Ballad', 'Rhythmic Soul', 'Freestyle',
  'Duet', 'Punk Rock', 'Drum Solo', 'A Cappella', 'Euro-House', 'Dance Hall',
];

const GENRE_PRESETS = [
  ['Hip-Hop', /hip.?hop|\b(rap|trap|drill|rnb|crunk)\b|gangsta|grime|r&b|booty/],
  ['Rock', /rock|metal|punk|grunge|hardcore|\bemo\b|industrial|gothic|alternative/],
  ['Dance', /dance|house|techno|trance|\bedm\b|electro|club|rave|disco|dubstep|drum.?(n|and|&).?bass|jungle|garage|hardstyle|breakbeat|eurobeat|synthwave/],
  ['Classical', /classical|baroque|orchestra|symphon|sonata|opera|chamber|choral|chorus|concerto|piano|soundtrack|score|new age|ambient|meditat/],
  ['Jazz', /jazz|swing|bebop|big band|blues|soul|funk|fusion|lounge|bossa/],
  ['Acoustic', /acoustic|folk|country|bluegrass|celtic|singer.?songwriter|unplugged|americana|world|latin|reggae|\bska\b|ethnic/],
  ['Vocal', /vocal|speech|spoken|podcast|audiobook|comedy|humou?r|a.?cap+el+a|chanson|ballad|gospel/],
  ['Pop', /pop|top 40|schlager/],
];

function ascii(bytes, start, length) {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function littleEndian(bytes, start) {
  return (bytes[start] | (bytes[start + 1] << 8) | (bytes[start + 2] << 16) | (bytes[start + 3] << 24)) >>> 0;
}

function bigEndian(bytes, start) {
  return ((bytes[start] << 24) | (bytes[start + 1] << 16) | (bytes[start + 2] << 8) | bytes[start + 3]) >>> 0;
}

export function id3v1Genre(index) {
  return ID3V1_GENRES[index] ?? null;
}

// TCON may hold ID3v1 references such as "(17)", "(17)Rock" or a bare "17", plus "RX"/"CR".
export function cleanGenre(text) {
  if (!text) return null;
  const parts = text.split(/\0|\s*[;/|]\s*(?=\S)/).map((part) => part.trim()).filter(Boolean);
  for (const part of parts) {
    const reference = part.match(/^\((\d{1,3})\)(.*)$/);
    const named = reference?.[2].trim() || (reference ? id3v1Genre(Number(reference[1])) : null);
    const plain = /^\d{1,3}$/.test(part) ? id3v1Genre(Number(part)) : part;
    const genre = reference ? named : plain;
    if (genre && !['RX', 'CR', 'Other'].includes(genre)) return genre;
  }
  return null;
}

export function parseId3v1Genre(tail) {
  if (tail.length < 128) return null;
  const tag = tail.subarray(tail.length - 128);
  if (ascii(tag, 0, 3) !== 'TAG') return null;
  return cleanGenre(id3v1Genre(tag[127]));
}

function vorbisCommentGenre(bytes, start) {
  let offset = start;
  const vendor = littleEndian(bytes, offset);
  offset += 4 + vendor;
  if (offset + 4 > bytes.length) return null;
  const count = littleEndian(bytes, offset);
  offset += 4;
  const decoder = new TextDecoder();
  for (let i = 0; i < count && offset + 4 <= bytes.length; i++) {
    const length = littleEndian(bytes, offset);
    offset += 4;
    if (offset + length > bytes.length) break;
    const comment = decoder.decode(bytes.subarray(offset, offset + length));
    offset += length;
    const separator = comment.indexOf('=');
    if (separator > 0 && comment.slice(0, separator).toUpperCase() === 'GENRE') return cleanGenre(comment.slice(separator + 1));
  }
  return null;
}

function flacGenre(bytes) {
  let offset = 4;
  while (offset + 4 <= bytes.length) {
    const header = bytes[offset];
    const length = (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
    if ((header & 0x7f) === 4) return vorbisCommentGenre(bytes, offset + 4);
    if (header & 0x80) break;
    offset += 4 + length;
  }
  return null;
}

function indexOfText(bytes, text) {
  const codes = [...text].map((character) => character.charCodeAt(0));
  outer: for (let i = 0; i + codes.length <= bytes.length; i++) {
    for (let j = 0; j < codes.length; j++) if (bytes[i + j] !== codes[j]) continue outer;
    return i;
  }
  return -1;
}

// Ogg pages are concatenated naively, which is enough because the comment header comes right after the first page.
function oggGenre(bytes) {
  const payload = [];
  let offset = 0;
  while (offset + 27 <= bytes.length && ascii(bytes, offset, 4) === 'OggS') {
    const segments = bytes[offset + 26];
    const lacing = bytes.subarray(offset + 27, offset + 27 + segments);
    const size = lacing.reduce((sum, value) => sum + value, 0);
    const start = offset + 27 + segments;
    payload.push(bytes.subarray(start, Math.min(bytes.length, start + size)));
    offset = start + size;
  }
  const joined = new Uint8Array(payload.reduce((sum, part) => sum + part.length, 0));
  payload.reduce((at, part) => (joined.set(part, at), at + part.length), 0);
  const vorbis = indexOfText(joined, '\x03vorbis');
  if (vorbis !== -1) return vorbisCommentGenre(joined, vorbis + 7);
  const opus = indexOfText(joined, 'OpusTags');
  return opus === -1 ? null : vorbisCommentGenre(joined, opus + 8);
}

export function parseHeadGenre(bytes) {
  if (bytes.length < 4) return null;
  try {
    if (ascii(bytes, 0, 4) === 'fLaC') return flacGenre(bytes);
    if (ascii(bytes, 0, 4) === 'OggS') return oggGenre(bytes);
  } catch {
    return null;
  }
  return null;
}

const MP4_CONTAINERS = new Set(['moov', 'udta', 'meta', 'ilst']);

export function mp4BoxGenre(bytes) {
  const walk = (from, to) => {
    let offset = from;
    while (offset + 8 <= to) {
      const size = bigEndian(bytes, offset);
      const type = ascii(bytes, offset + 4, 4);
      if (size < 8 || offset + size > to) return null;
      const body = offset + 8 + (type === 'meta' ? 4 : 0);
      if (type === '\xa9gen' || type === 'gnre') {
        const data = body;
        if (ascii(bytes, data + 4, 4) !== 'data') return null;
        const value = bytes.subarray(data + 16, offset + size);
        if (type === 'gnre') return value.length >= 2 ? cleanGenre(id3v1Genre(((value[0] << 8) | value[1]) - 1)) : null;
        return cleanGenre(new TextDecoder().decode(value));
      }
      if (MP4_CONTAINERS.has(type)) {
        const found = walk(body, offset + size);
        if (found) return found;
      }
      offset += size;
    }
    return null;
  };
  try {
    return walk(0, bytes.length);
  } catch {
    return null;
  }
}

async function findMp4Moov(readBytes, fileSize) {
  let offset = 0;
  while (offset + 8 <= fileSize) {
    const header = await readBytes(offset, offset + 16);
    if (header.length < 8) return null;
    let size = bigEndian(header, 0);
    const type = ascii(header, 4, 4);
    if (size === 1 && header.length >= 16) size = bigEndian(header, 8) * 2 ** 32 + bigEndian(header, 12);
    if (size === 0) size = fileSize - offset;
    if (size < 8) return null;
    if (type === 'moov') return size <= MAX_MOOV_BYTES ? readBytes(offset, offset + size) : null;
    offset += size;
  }
  return null;
}

async function wavGenre(readBytes, fileSize) {
  let offset = 12;
  while (offset + 8 <= fileSize) {
    const header = await readBytes(offset, offset + 12);
    if (header.length < 8) return null;
    const type = ascii(header, 0, 4);
    const size = littleEndian(header, 4);
    const isInfo = type === 'LIST' && ascii(header, 8, 4) === 'INFO';
    if ((isInfo || type.toLowerCase() === 'id3 ') && size <= MAX_ID3_BYTES) {
      const chunk = await readBytes(offset + 8, offset + 8 + size);
      const genre = isInfo ? riffInfoGenre(chunk) : cleanGenre(parseId3(chunk).genre);
      if (genre) return genre;
    }
    offset += 8 + size + (size & 1);
  }
  return null;
}

function riffInfoGenre(chunk) {
  let offset = 4;
  while (offset + 8 <= chunk.length) {
    const size = littleEndian(chunk, offset + 4);
    if (ascii(chunk, offset, 4) === 'IGNR') return cleanGenre(new TextDecoder().decode(chunk.subarray(offset + 8, offset + 8 + size)).replace(/\0.*$/s, ''));
    offset += 8 + size + (size & 1);
  }
  return null;
}

export function presetForGenre(genre) {
  if (!genre) return null;
  const text = genre.toLowerCase();
  return GENRE_PRESETS.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
}

export async function readGenreTag(file) {
  const readBytes = async (from, to) => new Uint8Array(await file.slice(from, to).arrayBuffer());
  let head = await readBytes(0, HEAD_BYTES);
  const id3 = parseId3(head);
  if (id3.size > head.length && id3.size <= MAX_ID3_BYTES) {
    head = await readBytes(0, id3.size);
    Object.assign(id3, parseId3(head));
  }
  const tagged = cleanGenre(id3.genre);
  if (tagged) return tagged;
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WAVE') return wavGenre(readBytes, file.size);
  if (ascii(head, 4, 4) === 'ftyp') {
    const moov = await findMp4Moov(readBytes, file.size);
    return moov ? mp4BoxGenre(moov) : null;
  }
  const start = id3.size;
  const body = start > 0 ? await readBytes(start, start + HEAD_BYTES) : head;
  return parseHeadGenre(body) ?? (file.size >= 128 ? parseId3v1Genre(await readBytes(file.size - 128, file.size)) : null);
}
