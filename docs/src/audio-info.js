const MPEG_RATES = [44100, 48000, 32000];

function ascii(bytes, start, length) {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function syncsafe(bytes, start) {
  return ((bytes[start] & 0x7f) << 21) | ((bytes[start + 1] & 0x7f) << 14) | ((bytes[start + 2] & 0x7f) << 7) | (bytes[start + 3] & 0x7f);
}

function bigEndian(bytes, start) {
  return ((bytes[start] << 24) | (bytes[start + 1] << 16) | (bytes[start + 2] << 8) | bytes[start + 3]) >>> 0;
}

function decodeText(bytes) {
  const [encoding] = bytes;
  const body = bytes.subarray(1);
  let label = 'latin1';
  if (encoding === 1) label = body[0] === 0xfe ? 'utf-16be' : 'utf-16le';
  if (encoding === 2) label = 'utf-16be';
  if (encoding === 3) label = 'utf-8';
  return new TextDecoder(label).decode(body).replace(/^﻿/, '').replace(/\0.*$/s, '').trim();
}

export function parseId3(bytes) {
  if (bytes.length < 10 || ascii(bytes, 0, 3) !== 'ID3') return { size: 0 };
  const version = bytes[3];
  const size = syncsafe(bytes, 6) + 10;
  const result = { size };
  if (version !== 3 && version !== 4) return result;

  let offset = 10;
  if (bytes[5] & 0x40) offset += version === 4 ? syncsafe(bytes, 10) : bigEndian(bytes, 10) + 4;
  const end = Math.min(size, bytes.length);
  while (offset + 10 <= end && bytes[offset] !== 0) {
    const id = ascii(bytes, offset, 4);
    const frameSize = version === 4 ? syncsafe(bytes, offset + 4) : bigEndian(bytes, offset + 4);
    if (frameSize === 0 || offset + 10 + frameSize > end) break;
    if (id === 'TIT2' || id === 'TPE1') {
      const text = decodeText(bytes.subarray(offset + 10, offset + 10 + frameSize));
      if (text) result[id === 'TIT2' ? 'title' : 'artist'] = text;
    }
    offset += 10 + frameSize;
  }
  return result;
}

function parseMpeg(bytes) {
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] !== 0xff || (bytes[i + 1] & 0xe0) !== 0xe0) continue;
    const version = (bytes[i + 1] >> 3) & 3;
    const layer = (bytes[i + 1] >> 1) & 3;
    const bitrate = bytes[i + 2] >> 4;
    const rate = (bytes[i + 2] >> 2) & 3;
    if (version === 1 || layer === 0 || bitrate === 15 || rate === 3) continue;
    const divisor = { 3: 1, 2: 2, 0: 4 }[version];
    return { sampleRate: MPEG_RATES[rate] / divisor, channels: bytes[i + 3] >> 6 === 3 ? 1 : 2 };
  }
  return {};
}

function parseWav(bytes) {
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const size = bytes[offset + 4] | (bytes[offset + 5] << 8) | (bytes[offset + 6] << 16) | (bytes[offset + 7] << 24);
    if (ascii(bytes, offset, 4) === 'fmt ') {
      return {
        channels: bytes[offset + 10] | (bytes[offset + 11] << 8),
        sampleRate: bytes[offset + 12] | (bytes[offset + 13] << 8) | (bytes[offset + 14] << 16),
      };
    }
    offset += 8 + size + (size & 1);
  }
  return {};
}

export function parseFormat(bytes) {
  if (bytes.length < 4) return {};
  if (ascii(bytes, 0, 4) === 'fLaC' && bytes.length >= 21) {
    return { sampleRate: (bytes[18] << 12) | (bytes[19] << 4) | (bytes[20] >> 4), channels: ((bytes[20] >> 1) & 7) + 1 };
  }
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') return parseWav(bytes);
  if (ascii(bytes, 0, 4) === 'OggS' || ascii(bytes, 4, 4) === 'ftyp') return {};
  return parseMpeg(bytes);
}

export function averageKbps(bytes, seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.round((bytes * 8) / seconds / 1000);
}
