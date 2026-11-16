import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseId3 } from '../docs/src/audio-info.js';
import { cleanGenre, mp4BoxGenre, parseHeadGenre, parseId3v1Genre, presetForGenre, readGenreTag } from '../docs/src/genre.js';

const text = (value) => [...new TextEncoder().encode(value)];
const be32 = (value) => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
const le32 = (value) => [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255];
const syncsafe = (value) => [(value >> 21) & 127, (value >> 14) & 127, (value >> 7) & 127, value & 127];

function id3v2(frames) {
  const body = frames.flatMap(([id, value]) => {
    const content = [3, ...text(value)];
    return [...text(id), ...be32(content.length), 0, 0, ...content];
  });
  return [...text('ID3'), 3, 0, 0, ...syncsafe(body.length), ...body];
}

function vorbisComment(comments) {
  const vendor = text('test');
  return [...le32(vendor.length), ...vendor, ...le32(comments.length), ...comments.flatMap((comment) => [...le32(text(comment).length), ...text(comment)])];
}

function mp4Box(type, body) {
  const name = [...type].map((character) => character.charCodeAt(0));
  return [...be32(8 + body.length), ...name, ...body];
}

function riffChunk(type, body) {
  return [...text(type), ...le32(body.length), ...body, ...(body.length & 1 ? [0] : [])];
}

const bytes = (values) => Uint8Array.from(values);

test('ID3v1 references in a genre tag become names', () => {
  assert.equal(cleanGenre('(17)'), 'Rock');
  assert.equal(cleanGenre('17'), 'Rock');
  assert.equal(cleanGenre('(17)Rock & Roll'), 'Rock & Roll');
  assert.equal(cleanGenre('Electronic; Dance'), 'Electronic');
  assert.equal(cleanGenre('(12)'), null);
  assert.equal(cleanGenre(''), null);
});

test('genre names map to the preset that fits them', () => {
  const expected = {
    'Heavy Metal': 'Rock', 'Classic Rock': 'Rock', 'Deep House': 'Dance', 'Drum & Bass': 'Dance', Electronic: 'Dance',
    'Hip-Hop': 'Hip-Hop', 'Gangsta Rap': 'Hip-Hop', 'R&B': 'Hip-Hop', Classical: 'Classical', Soundtrack: 'Classical',
    Bebop: 'Jazz', Soul: 'Jazz', Folk: 'Acoustic', Country: 'Acoustic', Podcast: 'Vocal', 'K-Pop': 'Pop', Pop: 'Pop',
  };
  for (const [genre, preset] of Object.entries(expected)) assert.equal(presetForGenre(genre), preset, genre);
  assert.equal(presetForGenre('Polka'), null);
  assert.equal(presetForGenre('Therapy'), null);
  assert.equal(presetForGenre(null), null);
});

test('an ID3v2 genre frame is read beside the title and artist', () => {
  const tag = parseId3(bytes(id3v2([['TIT2', 'Song'], ['TCON', '(9)'], ['TPE1', 'Band']])));
  assert.deepEqual([tag.title, tag.artist, cleanGenre(tag.genre)], ['Song', 'Band', 'Metal']);
});

test('an ID3v1 tag at the end of the file gives its genre', () => {
  const tail = new Uint8Array(128);
  tail.set(text('TAG'));
  tail[127] = 8;
  assert.equal(parseId3v1Genre(tail), 'Jazz');
  tail[127] = 255;
  assert.equal(parseId3v1Genre(tail), null);
});

test('a FLAC Vorbis comment gives its genre', () => {
  const comment = vorbisComment(['TITLE=Song', 'genre=Trance']);
  const streamInfo = [0, 0, 0, 34, ...new Array(34).fill(0)];
  const flac = [...text('fLaC'), ...streamInfo, 0x84, 0, (comment.length >> 8) & 255, comment.length & 255, ...comment];
  assert.equal(parseHeadGenre(bytes(flac)), 'Trance');
});

test('an Ogg Vorbis comment header gives its genre', () => {
  const page = (payload) => [...text('OggS'), ...new Array(22).fill(0), 1, payload.length, ...payload];
  const identification = [1, ...text('vorbis'), ...new Array(23).fill(0)];
  const comment = [3, ...text('vorbis'), ...vorbisComment(['GENRE=Blues'])];
  assert.equal(parseHeadGenre(bytes([...page(identification), ...page(comment)])), 'Blues');
});

test('an MP4 genre atom gives its genre, as text or as an ID3v1 number', () => {
  const data = (value) => mp4Box('data', [0, 0, 0, 1, 0, 0, 0, 0, ...value]);
  const moov = (atom) => bytes(mp4Box('moov', mp4Box('udta', mp4Box('meta', [0, 0, 0, 0, ...mp4Box('ilst', atom)]))));
  assert.equal(mp4BoxGenre(moov(mp4Box('\xa9gen', data(text('Reggae'))))), 'Reggae');
  assert.equal(mp4BoxGenre(moov(mp4Box('gnre', data([0, 33])))), 'Classical');
});

test('reading a file finds the genre wherever its format keeps it', async () => {
  const mp3 = new File([bytes([...id3v2([['TCON', 'Dance']]), 0xff, 0xfb, 0x90, 0x00])], 'a.mp3');
  assert.equal(await readGenreTag(mp3), 'Dance');

  const ftyp = mp4Box('ftyp', text('M4A 0000'));
  const mdat = mp4Box('mdat', new Array(100).fill(0));
  const moov = mp4Box('moov', mp4Box('udta', mp4Box('meta', [0, 0, 0, 0, ...mp4Box('ilst', mp4Box('\xa9gen', mp4Box('data', [0, 0, 0, 1, 0, 0, 0, 0, ...text('Jazz')])))])));
  assert.equal(await readGenreTag(new File([bytes([...ftyp, ...mdat, ...moov])], 'a.m4a')), 'Jazz');

  const info = riffChunk('LIST', [...text('INFO'), ...riffChunk('IGNR', [...text('Hard Rock'), 0])]);
  const wav = [...text('RIFF'), ...le32(0), ...text('WAVE'), ...riffChunk('data', [0, 0, 0, 0]), ...info];
  assert.equal(await readGenreTag(new File([bytes(wav)], 'a.wav')), 'Hard Rock');

  assert.equal(await readGenreTag(new File([new Uint8Array(400)], 'untagged.mp3')), null);
});
