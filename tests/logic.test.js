import assert from 'node:assert/strict';
import { test } from 'node:test';
import { averageKbps, parseFormat, parseId3 } from '../docs/src/audio-info.js';
import { BAND_FREQUENCIES, PRESETS, clampGain, headroomDb } from '../docs/src/equalizer.js';
import { Playlist } from '../docs/src/playlist.js';
import { formatTime, groupIntoPlaylists, isAudioFile, parseTrackName, sortByName } from '../docs/src/tracks.js';
import { logBands } from '../docs/src/visualiser.js';

const tracks = (...ids) => ids.map((id) => ({ id, artist: `Artist ${id}`, title: `Song ${id}` }));

function playlistOf(...ids) {
  const playlist = new Playlist();
  playlist.add(tracks(...ids));
  return playlist;
}

function playRound(playlist) {
  const played = [playlist.currentId];
  while (played.length < playlist.tracks.length) played.push(playlist.next().id);
  return played;
}

test('adding to an empty playlist selects the first track', () => {
  assert.equal(playlistOf('a', 'b').currentId, 'a');
});

test('next stops at the end when repeat is off', () => {
  const playlist = playlistOf('a', 'b');
  assert.equal(playlist.next().id, 'b');
  assert.equal(playlist.next(), null);
  assert.equal(playlist.currentId, 'b');
});

test('repeat all wraps in both directions', () => {
  const playlist = playlistOf('a', 'b');
  playlist.repeat = 'all';
  assert.equal(playlist.previous().id, 'b');
  assert.equal(playlist.next().id, 'a');
});

test('repeat one holds the track at its end but the next button still moves on', () => {
  const playlist = playlistOf('a', 'b');
  playlist.repeat = 'one';
  assert.equal(playlist.next({ auto: true }).id, 'a');
  assert.equal(playlist.next().id, 'b');
});

test('repeat cycles off, all, one and back', () => {
  const playlist = playlistOf('a');
  assert.deepEqual([playlist.cycleRepeat(), playlist.cycleRepeat(), playlist.cycleRepeat()], ['all', 'one', 'off']);
});

test('shuffle plays every track once, starting from the current one', () => {
  const playlist = playlistOf('a', 'b', 'c', 'd', 'e');
  playlist.setShuffle(true);
  const played = playRound(playlist);
  assert.equal(played[0], 'a');
  assert.deepEqual([...played].sort(), ['a', 'b', 'c', 'd', 'e']);
});

test('removing the current track moves to the following one', () => {
  const playlist = playlistOf('a', 'b', 'c');
  playlist.select('b');
  playlist.remove('b');
  assert.equal(playlist.currentId, 'c');
});

test('removing the last remaining track leaves nothing selected', () => {
  const playlist = playlistOf('a');
  playlist.remove('a');
  assert.equal(playlist.current, null);
});

test('a removed track never comes back in shuffle', () => {
  const playlist = playlistOf('a', 'b', 'c');
  playlist.setShuffle(true);
  playlist.remove('b');
  assert.deepEqual(playRound(playlist).sort(), ['a', 'c']);
});

test('move reorders without changing the current track', () => {
  const playlist = playlistOf('a', 'b', 'c');
  playlist.move('c', 0);
  assert.deepEqual(playlist.tracks.map((track) => track.id), ['c', 'a', 'b']);
  assert.equal(playlist.currentId, 'a');
});

test('search needs every word, in any order and case', () => {
  const playlist = playlistOf('a', 'b');
  assert.deepEqual(playlist.search('song ARTIST b').map((track) => track.id), ['b']);
});

test('file names become artist and title', () => {
  assert.deepEqual(parseTrackName('004_Numb_-_Linkin_Park.mp3'), { artist: 'Numb', title: 'Linkin Park' });
  assert.deepEqual(parseTrackName('03 - Some Artist - Some Song.flac'), { artist: 'Some Artist', title: 'Some Song' });
  assert.deepEqual(parseTrackName('Polka.mp3'), { artist: '', title: 'Polka' });
});

test('a title that is only a number is kept', () => {
  assert.deepEqual(parseTrackName('1979.mp3'), { artist: '', title: '1979' });
});

test('only audio files are accepted', () => {
  assert.equal(isAudioFile('song.FLAC'), true);
  assert.equal(isAudioFile('cover.jpg'), false);
});

test('files sort with numbers in number order', () => {
  const sorted = sortByName([{ name: '10.mp3' }, { name: '2.mp3' }]);
  assert.deepEqual(sorted.map((file) => file.name), ['2.mp3', '10.mp3']);
});

test('times are shown as minutes and seconds, with hours when needed', () => {
  assert.equal(formatTime(65), '1:05');
  assert.equal(formatTime(3725), '1:02:05');
  assert.equal(formatTime(NaN), '--:--');
});

test('every preset has one gain per band, within range', () => {
  for (const gains of Object.values(PRESETS)) {
    assert.equal(gains.length, BAND_FREQUENCIES.length);
    assert.deepEqual(gains, gains.map(clampGain));
  }
});

test('headroom cancels the loudest boost and ignores cuts', () => {
  assert.equal(headroomDb([3, 8, -2]), -8);
  assert.equal(headroomDb([-3, -1]), 0);
});

function id3v23(frames) {
  const body = frames.flatMap(([id, payload]) => {
    const size = payload.length;
    return [...Buffer.from(id), (size >>> 24) & 255, (size >>> 16) & 255, (size >>> 8) & 255, size & 255, 0, 0, ...payload];
  });
  const size = body.length;
  const header = [...Buffer.from('ID3'), 3, 0, 0, (size >> 21) & 127, (size >> 14) & 127, (size >> 7) & 127, size & 127];
  return new Uint8Array([...header, ...body]);
}

test('ID3 title and artist are read, including Polish letters in UTF-16', () => {
  const utf16 = [...Buffer.from('Łąka', 'utf16le')];
  const tag = parseId3(id3v23([['TIT2', [1, 0xff, 0xfe, ...utf16]], ['TPE1', [3, ...Buffer.from('Żółw')]]]));
  assert.equal(tag.title, 'Łąka');
  assert.equal(tag.artist, 'Żółw');
  assert.equal(tag.size, 10 + 10 + 11 + 10 + 7 + 1);
});

test('a file with no ID3 tag has nothing to skip', () => {
  assert.deepEqual(parseId3(new Uint8Array(20)), { size: 0 });
});

test('a truncated ID3 frame stops the reader without throwing', () => {
  const bytes = id3v23([['TIT2', [3, ...Buffer.from('Whole title')]]]);
  assert.equal(parseId3(bytes.subarray(0, 16)).title, undefined);
});

test('MP3 frame headers give the sample rate and channels', () => {
  assert.deepEqual(parseFormat(new Uint8Array([0, 0xff, 0xfb, 0x90, 0x00])), { sampleRate: 44100, channels: 2 });
  assert.deepEqual(parseFormat(new Uint8Array([0xff, 0xfb, 0x94, 0xc0])), { sampleRate: 48000, channels: 1 });
});

test('MPEG-2 files report half the rate', () => {
  assert.equal(parseFormat(new Uint8Array([0xff, 0xf3, 0x90, 0x00])).sampleRate, 22050);
});

test('WAV and FLAC headers give the sample rate and channels', () => {
  const wav = Buffer.alloc(44);
  wav.write('RIFF', 0); wav.write('WAVE', 8); wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(48000, 24);
  assert.deepEqual(parseFormat(new Uint8Array(wav)), { channels: 2, sampleRate: 48000 });

  const flac = Buffer.alloc(42);
  flac.write('fLaC', 0);
  const packed = (44100 << 12) | (1 << 9);
  flac.writeUInt32BE(packed >>> 0, 18);
  assert.deepEqual(parseFormat(new Uint8Array(flac)), { sampleRate: 44100, channels: 2 });
});

test('formats with no simple header report nothing rather than guessing', () => {
  assert.deepEqual(parseFormat(new Uint8Array([...Buffer.from('OggS'), 0, 0, 0xff, 0xfb, 0x90, 0])), {});
});

test('average bitrate comes from size and length, and needs a real length', () => {
  assert.equal(averageKbps(3_000_000, 125), 192);
  assert.equal(averageKbps(3_000_000, NaN), null);
});

test('spectrum bands put a low tone on the left and a high tone on the right', () => {
  const sampleRate = 44100;
  const bins = 1024;
  const tone = (hz) => {
    const data = new Uint8Array(bins);
    data[Math.round(hz / (sampleRate / 2 / bins))] = 255;
    return logBands(data, sampleRate);
  };
  assert.ok(tone(100).indexOf(1) < 8);
  assert.ok(tone(10000).indexOf(1) > 14);
});

test('a saved shuffle round carries on where it left off after a restore', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const playlist = playlistOf(...ids);
  playlist.setShuffle(true);
  const played = [playlist.currentId, playlist.next().id];
  const saved = playlist.snapshot();

  const restored = new Playlist();
  restored.setShuffle(true);
  restored.restore(tracks(...ids), saved);
  assert.equal(restored.currentId, played[1]);
  while (played.length < ids.length) played.push(restored.next().id);
  assert.deepEqual([...played].sort(), ids);
});

test('a restore tolerates a saved song whose file is gone', () => {
  const playlist = new Playlist();
  playlist.restore(tracks('a', 'c'), { currentId: 'b', shuffleOrder: ['b', 'c', 'a'] });
  assert.equal(playlist.currentId, 'a');
  assert.deepEqual(playlist.snapshot().shuffleOrder, ['c', 'a']);
});

const grouped = (...paths) => groupIntoPlaylists(paths.map((name) => ({ name }))).map((group) => [group.name, group.items.length]);

test('a folder of CD folders makes one playlist per CD, nested folders included', () => {
  assert.deepEqual(
    grouped('Music/CD01/a.mp3', 'Music/CD01/b.mp3', 'Music/CD02_Rock/c.mp3', 'Music/CD06_Wife/1_Fav/d.mp3', 'Music/CD06_Wife/2_Film/e.mp3'),
    [['CD01', 2], ['CD02_Rock', 1], ['CD06_Wife', 2]],
  );
});

test('a single folder of songs makes one playlist named after it', () => {
  assert.deepEqual(grouped('CD01/a.mp3', 'CD01/b.mp3'), [['CD01', 2]]);
});

test('several folders dropped together make one playlist each', () => {
  assert.deepEqual(grouped('CD01/a.mp3', 'CD02/b.mp3'), [['CD01', 1], ['CD02', 1]]);
});

test('loose files have no playlist of their own', () => {
  assert.deepEqual(grouped('a.mp3', 'b.mp3'), [[null, 2]]);
});

test('songs beside the subfolders go in a playlist named after the top folder', () => {
  assert.deepEqual(grouped('Music/loose.mp3', 'Music/CD01/a.mp3'), [['Music', 1], ['CD01', 1]]);
});

test('starting a round picks a different first song and still plays every song once', () => {
  const ids = ['a', 'b', 'c', 'd'];
  for (let attempt = 0; attempt < 50; attempt++) {
    const playlist = playlistOf(...ids);
    playlist.setShuffle(true);
    assert.notEqual(playlist.startRound().id, 'a');
    assert.deepEqual(playRound(playlist).sort(), ids);
  }
});

test('a saved playlist remembers whether it was shuffled', () => {
  const playlist = playlistOf('a', 'b');
  playlist.setShuffle(true);
  const restored = new Playlist();
  restored.restore(tracks('a', 'b'), playlist.snapshot());
  assert.equal(restored.shuffle, true);
  const never = new Playlist();
  never.restore(tracks('a', 'b'), { currentId: 'a', shuffleOrder: ['a', 'b'] });
  assert.equal(never.shuffle, false);
});

test('with shuffle on the list shows the real play order', () => {
  const playlist = playlistOf('a', 'b', 'c', 'd', 'e');
  playlist.setShuffle(true);
  playlist.startRound();
  const shown = playlist.ordered.map((track) => track.id);
  assert.deepEqual(playRound(playlist), shown);
  playlist.setShuffle(false);
  assert.deepEqual(playlist.ordered.map((track) => track.id), ['a', 'b', 'c', 'd', 'e']);
});

test('moving a song while shuffled changes the play order, not the saved order', () => {
  const playlist = playlistOf('a', 'b', 'c', 'd');
  playlist.setShuffle(true);
  const last = playlist.ordered.at(-1).id;
  playlist.move(last, 1);
  assert.equal(playlist.ordered[1].id, last);
  assert.deepEqual(playlist.tracks.map((track) => track.id), ['a', 'b', 'c', 'd']);
});

test('search results follow the shuffled order', () => {
  const playlist = playlistOf('a', 'b', 'c');
  playlist.setShuffle(true);
  assert.deepEqual(playlist.search('song').map((track) => track.id), playlist.ordered.map((track) => track.id));
});

test('after every song has played once, shuffle starts a fresh round of every song', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  const playlist = playlistOf(...ids);
  playlist.setShuffle(true);
  playRound(playlist);
  for (let round = 0; round < 50; round++) {
    const previousLast = playlist.currentId;
    const first = playlist.next().id;
    assert.notEqual(first, previousLast);
    assert.deepEqual([first, ...Array.from({ length: ids.length - 1 }, () => playlist.next().id)].sort(), ids);
  }
});

test('shuffle keeps going at the end of a round when it is an automatic advance', () => {
  const playlist = playlistOf('a', 'b');
  playlist.setShuffle(true);
  playRound(playlist);
  assert.ok(playlist.next({ auto: true }));
});

test('repeat one still holds the song while shuffle is on', () => {
  const playlist = playlistOf('a', 'b', 'c');
  playlist.setShuffle(true);
  playlist.repeat = 'one';
  assert.equal(playlist.next({ auto: true }).id, 'a');
});

test('songs added mid-round join what is left and nothing played comes back', () => {
  const playlist = playlistOf('a', 'b', 'c', 'd');
  playlist.setShuffle(true);
  const played = [playlist.currentId, playlist.next().id];
  playlist.add(tracks('e', 'f'));
  while (played.length < 6) played.push(playlist.next().id);
  assert.deepEqual([...played].sort(), ['a', 'b', 'c', 'd', 'e', 'f']);
});

test('picking a song mid-round does not skip the rest of the round', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  const playlist = playlistOf(...ids);
  playlist.setShuffle(true);
  const upcoming = playlist.next().id;
  const chosen = ids.find((id) => id !== 'a' && id !== upcoming);
  playlist.select(chosen);
  const played = ['a', upcoming, chosen];
  while (played.length < ids.length) played.push(playlist.next().id);
  assert.deepEqual([...played].sort(), ids);
});

test('previous stops at the start of a shuffle round', () => {
  const playlist = playlistOf('a', 'b');
  playlist.setShuffle(true);
  assert.equal(playlist.previous(), null);
  assert.equal(playlist.currentId, 'a');
});
