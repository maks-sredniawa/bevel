import { averageKbps, parseFormat, parseId3 } from './audio-info.js';
import { AudioEngine } from './engine.js';
import { BAND_FREQUENCIES, MAX_GAIN_DB, PRESETS, clampGain } from './equalizer.js';
import { createDJ } from './dj/mixer.js';
import { bindPanel } from './dj/panel.js';
import { Library } from './library.js';
import { measureFile } from './levelling.js';
import { levelGainDb, tooLongToLevel } from './loudness.js';
import { Playlist } from './playlist.js';
import { formatTime, groupIntoPlaylists, isAudioFile, parseTrackName, sortByName } from './tracks.js';
import { Visualiser } from './visualiser.js';

const APP_NAME = 'Bevel';
const SETTINGS_KEY = 'retro-music-player';
const SKINS = [['oatmeal', 'Oatmeal'], ['nightshift', 'Night shift'], ['cobalt', 'Cobalt']];
const PROBE_WORKERS = 3;
const PROBE_TIMEOUT_MS = 15000;
const HEAD_BYTES = 65536;
const FORMAT_BYTES = 16384;
const SEEK_STEP = 5;
const VOLUME_STEP = 5;
const RESTART_AFTER = 3;
const SAVE_DELAY_MS = 300;
const SAVE_POSITION_EVERY = 5;
const PLAY_ICON = 'M3 2l9 5-9 5z';
const PAUSE_ICON = 'M2 2h4v10H2zM8 2h4v10H8z';

const byId = (id) => document.getElementById(id);
const mini = {
  root: byId('mini'),
  lcd: byId('mini-lcd'),
  marquee: byId('mini-marquee'),
  play: byId('mini-play'),
  icon: byId('mini-play-icon'),
};
let miniWindow = null;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const defaults = {
  skin: 'oatmeal',
  volume: 72,
  muted: false,
  shuffle: false,
  repeat: 'off',
  vizMode: reducedMotion ? 'off' : 'spectrum',
  compact: false,
  mini: false,
  dj: false,
  levelling: false,
  eq: { enabled: true, preset: 'Flat', preamp: 0, gains: [...PRESETS.Flat] },
};

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY)) ?? {};
    return { ...defaults, ...saved, eq: { ...defaults.eq, ...saved.eq } };
  } catch {
    return structuredClone(defaults);
  }
}

const settings = loadSettings();

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Private windows can refuse storage; the player works without it.
  }
}

const audio = byId('audio');
const engine = new AudioEngine(audio);
let playlists = [];
let active = null;
let playlist = null;
const visualiser = new Visualiser(byId('viz'), {
  getAnalyser: () => engine.analyser,
  getSampleRate: () => engine.sampleRate,
});

const DEFAULT_PLAYLIST_NAME = 'My music';
let pendingSeek = 0;
let loadedId = null;
let objectUrl = null;
let nextId = 1;
let selectedId = null;
let failures = 0;
let seekDragging = false;
let renderQueued = false;
let skippedNote = '';
let storageNote = '';
let library = null;
let libraryWrites = Promise.resolve();
let saveTimer = null;
let savedPosition = 0;
let askedToPersist = false;
const probeQueue = [];
let probesRunning = 0;
const levelQueue = [];
let levelRunning = false;

function setPressed(element, on) {
  element.setAttribute('aria-pressed', String(on));
}

function lcdTime(seconds) {
  return formatTime(seconds).padStart(5, '0');
}

function trackLabel(track) {
  return track.artist ? `${track.artist} - ${track.title}` : track.title;
}

function setStatus(text) {
  byId('status').textContent = text;
}

function playlistSummary() {
  if (playlist.tracks.length === 0) return 'No tracks';
  const total = playlist.tracks.reduce((sum, track) => sum + (track.duration || 0), 0);
  const count = `${playlist.tracks.length} track${playlist.tracks.length === 1 ? '' : 's'}`;
  return `${count} · ${formatTime(total)} total`;
}

function renderDeck() {
  const track = playlist.current;
  const playing = !audio.paused;
  byId('lcd').classList.toggle('idle', !track);
  byId('flag-play').textContent = !playing && loadedId && audio.currentTime > 0 ? 'PAUSE' : 'PLAY';
  byId('flag-play').classList.toggle('on', playing || (Boolean(loadedId) && audio.currentTime > 0));
  byId('flag-shuffle').classList.toggle('on', settings.shuffle);
  byId('flag-repeat').classList.toggle('on', settings.repeat !== 'off');
  byId('flag-repeat').textContent = settings.repeat === 'off' ? 'RPT' : `RPT:${settings.repeat.toUpperCase()}`;
  byId('flag-eq').classList.toggle('on', settings.eq.enabled);
  byId('flag-lvl').classList.toggle('on', settings.levelling);
  byId('flag-mute').classList.toggle('on', settings.muted);

  const position = track ? playlist.ordered.indexOf(track) + 1 : 0;
  byId('track-number').textContent = track
    ? `TRK ${String(position).padStart(2, '0')}/${String(playlist.tracks.length).padStart(2, '0')}`
    : 'TRK --/--';

  const marquee = byId('marquee');
  const text = track ? trackLabel(track).toUpperCase() : 'NO MEDIA · DROP OR OPEN';
  if (marquee.textContent !== text) {
    marquee.textContent = text;
    marquee.style.animationDuration = `${Math.max(10, text.length * 0.3)}s`;
    mini.marquee.textContent = track ? text : 'NO MEDIA';
    mini.marquee.style.animationDuration = marquee.style.animationDuration;
  }
  mini.lcd.classList.toggle('idle', !track);

  byId('format-line').textContent = track ? `${track.format} ${track.kbps ?? '---'} KBPS` : '--- KBPS';
  const channels = { 1: ' MONO', 2: ' STEREO' }[track?.channels] ?? '';
  byId('rate-line').textContent = `${track?.sampleRate ?? '-----'} HZ${channels}`;
  byId('status-format').textContent = track
    ? `${track.format} ${track.kbps ? `${track.kbps} kbps ` : ''}${track.sampleRate ? `${track.sampleRate / 1000} kHz` : ''}`.trim()
    : 'Ready';

  byId('play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  setPressed(byId('play'), playing);
  byId('play-icon').setAttribute('d', playing ? PAUSE_ICON : PLAY_ICON);
  mini.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  setPressed(mini.play, playing);
  mini.icon.setAttribute('d', playing ? PAUSE_ICON : PLAY_ICON);

  const title = track ? trackLabel(track) : APP_NAME;
  byId('window-title').textContent = track ? title : APP_NAME;
  document.title = track && playing ? `${title} - ${APP_NAME}` : APP_NAME;
  renderTime();
}

function renderTime() {
  const duration = audio.duration;
  const known = Boolean(loadedId) && Number.isFinite(duration);
  const seek = byId('seek');
  const time = seekDragging ? Number(seek.value) : audio.currentTime;
  byId('elapsed').textContent = known || loadedId ? lcdTime(time) : '--:--';
  byId('remaining').textContent = known ? `-${lcdTime(Math.max(0, duration - time))}` : '';
  seek.disabled = !known;
  if (!seekDragging) {
    seek.max = known ? String(duration) : '1';
    seek.value = known ? String(time) : '0';
  }
  const progress = `${known && duration > 0 ? (time / duration) * 100 : 0}%`;
  seek.style.setProperty('--v', progress);
  mini.lcd.style.setProperty('--v', progress);
  seek.setAttribute('aria-valuetext', known ? `${formatTime(time)} of ${formatTime(duration)}` : 'Nothing loaded');
}

function makeSvgButtonIcon(pathData, viewBox) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', pathData);
  svg.append(path);
  return svg;
}

function cell(className, text) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

function buildLoadCell(track) {
  const cellElement = cell('load', '');
  ['a', 'b'].forEach((deck) => {
    const button = document.createElement('button');
    button.className = 'ld out';
    button.type = 'button';
    button.tabIndex = -1;
    button.dataset.deck = deck;
    button.textContent = deck.toUpperCase();
    setPressed(button, rowDecks[deck] === track.title);
    button.setAttribute('aria-label', `Load ${track.title} to deck ${deck.toUpperCase()}`);
    cellElement.append(button);
  });
  return cellElement;
}

function buildRow(track, number, activeId) {
  const row = document.createElement('li');
  row.className = 'row';
  row.dataset.id = track.id;
  row.tabIndex = track.id === activeId ? 0 : -1;
  row.classList.toggle('current', track.id === playlist.currentId);
  row.classList.toggle('selected', track.id === selectedId);
  row.classList.toggle('failed', Boolean(track.failed));
  if (track.id === playlist.currentId) row.setAttribute('aria-current', 'true');
  row.setAttribute('aria-label', `${number}. ${trackLabel(track)}, ${formatTime(track.duration)}`);

  const grip = cell('grip', '');
  grip.append(makeSvgButtonIcon('M0 1h10v2H0zM0 5h10v2H0zM0 9h10v2H0z', '0 0 10 12'));
  const remove = document.createElement('button');
  remove.className = 'rm';
  remove.tabIndex = -1;
  remove.setAttribute('aria-label', `Remove ${track.title}`);
  remove.append(makeSvgButtonIcon('M1 0l4 4 4-4 1 1-4 4 4 4-1 1-4-4-4 4-1-1 4-4-4-4z', '0 0 10 10'));

  row.append(
    grip,
    cell('no', String(number).padStart(2, '0')),
    cell('t', track.title),
    cell('art', track.artist),
    cell('fmt', track.format),
    cell('dur', formatTime(track.duration)),
    buildLoadCell(track),
    remove,
  );
  return row;
}

function renderTabs() {
  const container = byId('playlist-tabs');
  const focusedTab = document.activeElement?.closest?.('.pl-tab')?.dataset.id;
  container.replaceChildren(...playlists.map((record) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'pl-tab';
    tab.dataset.id = record.id;
    setPressed(tab, record === active);
    const count = cell('count', String(record.list.tracks.length));
    count.append(cell('sr-only', ' tracks'));
    tab.append(cell('ind', ''), cell('name', record.name), count);
    return tab;
  }));
  if (focusedTab) container.querySelector(`[data-id="${focusedTab}"]`)?.focus();
  byId('playlist-delete').disabled = playlists.length === 1 && playlist.tracks.length === 0;
}

function askName({ title, value, ok, hint, currentName }) {
  const dialog = byId('name-dialog');
  const input = byId('name-input');
  byId('name-title').textContent = title;
  byId('name-ok').textContent = ok;
  byId('name-hint').textContent = hint;
  input.value = value;
  const validate = () => {
    const name = input.value.trim();
    const taken = name !== currentName && playlists.some((record) => record.name === name);
    input.setCustomValidity(taken ? 'There is already a playlist with this name' : '');
  };
  validate();
  input.oninput = validate;
  input.onkeydown = (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    input.form.requestSubmit(byId('name-ok'));
  };
  dialog.returnValue = '';
  dialog.showModal();
  input.select();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      resolve(dialog.returnValue === 'ok' ? input.value.trim() : null);
    }, { once: true });
  });
}

function confirmDelete(message) {
  const dialog = byId('delete-dialog');
  byId('delete-message').textContent = message;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
  });
}

async function newPlaylist() {
  const name = await askName({ title: 'New playlist', value: '', ok: 'Create', hint: 'Add songs to it with Add… or by dropping them here.', currentName: null });
  if (name) activate(makePlaylist(name));
}

async function renamePlaylist() {
  const name = await askName({ title: 'Rename playlist', value: active.name, ok: 'OK', hint: 'The songs are kept.', currentName: active.name });
  if (!name) return;
  active.name = name;
  active.isDefault = false;
  renderPlaylist();
}

async function deletePlaylist() {
  const record = active;
  const count = record.list.tracks.length;
  const songs = count > 0 ? ` and its ${count} stored song${count === 1 ? '' : 's'}` : '';
  const room = count > 0 ? ' This frees the space they take in this browser and cannot be undone.' : '';
  if (!await confirmDelete(`Delete "${record.name}"${songs}?${room}`)) return;
  const ids = record.list.tracks.map((track) => track.id);
  audio.pause();
  const index = playlists.indexOf(record);
  const neighbour = playlists[index + 1] ?? playlists[index - 1] ?? makePlaylist(DEFAULT_PLAYLIST_NAME, { isDefault: true });
  active = record;
  activate(neighbour);
  playlists = playlists.filter((other) => other !== record);
  queueLibraryWrite(() => library.deleteFiles(ids));
  renderPlaylist();
  renderDeck();
}

function renderPlaylist() {
  renderTabs();
  const query = byId('search').value.trim();
  const ordered = playlist.ordered;
  const numbers = new Map(ordered.map((track, index) => [track.id, index + 1]));
  const visible = query ? playlist.search(query) : ordered;
  const list = byId('tracks');
  const focusedId = document.activeElement?.closest?.('.row')?.dataset.id;
  const activeId = selectedId ?? playlist.currentId ?? visible[0]?.id;
  const isEmpty = playlist.tracks.length === 0;

  byId('empty').hidden = !isEmpty;
  byId('list-wrap').hidden = isEmpty;
  list.classList.toggle('filtering', Boolean(query));

  list.replaceChildren(...visible.map((track) => buildRow(track, numbers.get(track.id), activeId)));
  if (query && visible.length === 0) {
    const none = document.createElement('li');
    none.className = 'none';
    none.textContent = 'No tracks match this filter';
    list.append(none);
  }
  if (focusedId) list.querySelector(`[data-id="${focusedId}"]`)?.focus({ preventScroll: true });

  byId('remove').disabled = selectedId === null;
  byId('clear').disabled = isEmpty;
  const hint = isEmpty ? '' : storageNote || skippedNote || ' · drag rows to reorder';
  setStatus(query ? `${visible.length} of ${playlist.tracks.length} tracks match` : `${playlistSummary()}${hint}`);
  scheduleSave();
}

function queueLibraryWrite(write) {
  if (!library) return libraryWrites;
  libraryWrites = libraryWrites.then(write).catch(() => {});
  return libraryWrites;
}

function rememberPosition() {
  if (loadedId && loadedId === playlist.currentId) active.position = audio.currentTime;
}

function libraryState() {
  rememberPosition();
  return {
    activeId: active.id,
    playlists: playlists.map((record) => ({
      id: record.id,
      name: record.name,
      position: record.position,
      isDefault: record.isDefault,
      tracks: record.list.tracks.map(({ file, ...details }) => details),
      ...record.list.snapshot(),
    })),
  };
}

function makePlaylist(name, { isDefault = false } = {}) {
  const list = new Playlist();
  list.repeat = settings.repeat;
  list.shuffle = settings.shuffle;
  const record = { id: String(nextId++), name, list, position: 0, isDefault };
  playlists.push(record);
  return record;
}

function activate(record) {
  const wasPlaying = active && !audio.paused;
  if (active) {
    rememberPosition();
    unload();
  }
  active = record;
  playlist = record.list;
  playlist.repeat = settings.repeat;
  if (playlist.shuffle !== settings.shuffle) {
    playlist.setShuffle(settings.shuffle);
    if (settings.shuffle && record.position < 1) playlist.startRound();
  }
  selectedId = null;
  byId('search').value = '';
  renderPlaylist();
  const track = playlist.current;
  if (track) {
    loadTrack(track, { announce: false });
    pendingSeek = record.position;
    if (wasPlaying) play();
  }
  renderDeck();
}

function scheduleSave() {
  if (!library || saveTimer !== null) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    savedPosition = audio.currentTime;
    const state = libraryState();
    queueLibraryWrite(() => library.saveState(state));
  }, SAVE_DELAY_MS);
}

function setStorageNote(text) {
  storageNote = text;
  renderPlaylist();
}

function storeFiles(tracks) {
  if (!library) return;
  if (!askedToPersist) {
    askedToPersist = true;
    navigator.storage?.persist?.();
  }
  let stored = 0;
  let refused = 0;
  tracks.forEach((track) => {
    libraryWrites = libraryWrites.then(async () => {
      try {
        await library.putFile(track.id, track.file);
        stored++;
      } catch {
        refused++;
      }
      const left = tracks.length - stored - refused;
      if (left > 0) setStorageNote(` · saving for next time: ${stored + refused}/${tracks.length}`);
      else setStorageNote(refused > 0 ? ` · no room to keep ${refused} of these after you close the page` : '');
    });
  });
}

function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderPlaylist();
    renderDeck();
  });
}

function makeTrack(file) {
  return {
    id: String(nextId++),
    file,
    ...parseTrackName(file.name),
    format: file.name.split('.').pop().toUpperCase(),
    duration: null,
    probed: false,
    kbps: null,
    sampleRate: null,
    channels: null,
    failed: false,
  };
}

function readDuration(file) {
  return new Promise((resolve) => {
    const probe = new Audio();
    const url = URL.createObjectURL(file);
    const finish = (duration) => {
      URL.revokeObjectURL(url);
      probe.removeAttribute('src');
      resolve(duration);
    };
    const giveUp = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
    probe.preload = 'metadata';
    probe.addEventListener('loadedmetadata', () => {
      clearTimeout(giveUp);
      finish(probe.duration);
    }, { once: true });
    probe.addEventListener('error', () => {
      clearTimeout(giveUp);
      finish(null);
    }, { once: true });
    probe.src = url;
  });
}

async function probeTrack(track) {
  try {
    const head = new Uint8Array(await track.file.slice(0, HEAD_BYTES).arrayBuffer());
    const tag = parseId3(head);
    const start = tag.size;
    const audioBytes = new Uint8Array(await track.file.slice(start, start + FORMAT_BYTES).arrayBuffer());
    Object.assign(track, parseFormat(audioBytes));
    if (tag.title) track.title = tag.title;
    if (tag.artist) track.artist = tag.artist;
    track.duration = await readDuration(track.file);
    track.kbps = averageKbps(track.file.size - start, track.duration);
  } catch {
    track.duration = null;
  }
  track.probed = true;
  queueRender();
  if (settings.levelling) queueLevelling([track], { first: track.id === loadedId });
}

function pumpProbes() {
  while (probesRunning < PROBE_WORKERS && probeQueue.length > 0) {
    probesRunning++;
    probeTrack(probeQueue.shift()).finally(() => {
      probesRunning--;
      pumpProbes();
    });
  }
}

function addItems(items) {
  return startup.then(() => addItemsNow(items));
}

function addItemsNow(items) {
  const audioItems = sortByName(items.filter((item) => isAudioFile(item.name)));
  const skipped = items.length - audioItems.length;
  if (audioItems.length === 0) {
    if (items.length > 0) setStatus('No audio files found there');
    return;
  }
  const added = [];
  let firstTouched = null;
  for (const group of groupIntoPlaylists(audioItems)) {
    const record = group.name === null ? active : playlists.find((other) => other.name === group.name) ?? makePlaylist(group.name);
    firstTouched ??= record;
    const known = new Set(record.list.tracks.map((track) => `${track.file.name}|${track.file.size}`));
    const fresh = group.items.filter((item) => !known.has(`${item.file.name}|${item.file.size}`)).map((item) => makeTrack(item.file));
    record.list.add(fresh);
    added.push(...fresh);
  }
  probeQueue.push(...added);
  pumpProbes();
  skippedNote = skipped > 0 ? ` · skipped ${skipped} non-audio file${skipped === 1 ? '' : 's'}` : '';
  storeFiles(added);
  if (firstTouched !== active && (audio.paused || playlist.tracks.length === 0)) activate(firstTouched);
  playlists = playlists.filter((record) => record === active || record.list.tracks.length > 0 || !record.isDefault);
  renderPlaylist();
  renderDeck();
  byId('announcer').textContent = `${added.length} tracks added`;
}

function loadTrack(track, { announce = true } = {}) {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(track.file);
  pendingSeek = 0;
  audio.src = objectUrl;
  loadedId = track.id;
  applyLevel();
  if (settings.levelling) queueLevelling([track], { first: true });
  playlist.select(track.id);
  updateMediaSession(track);
  if (announce) byId('announcer').textContent = `Now playing ${trackLabel(track)}`;
  renderPlaylist();
  renderDeck();
  scrollToCurrent();
}

function scrollRowIntoList(row) {
  if (!row) return;
  const scroller = byId('tracks-scroll');
  const bounds = scroller.getBoundingClientRect();
  const top = bounds.top + scroller.querySelector('.thead').offsetHeight;
  const rect = row.getBoundingClientRect();
  if (rect.top < top) scroller.scrollTop -= top - rect.top;
  else if (rect.bottom > bounds.bottom) scroller.scrollTop += rect.bottom - bounds.bottom;
}

function scrollToCurrent() {
  scrollRowIntoList(byId('tracks').querySelector('.current'));
}

async function play() {
  const track = playlist.current;
  if (!track) {
    byId('file-input').click();
    return;
  }
  if (loadedId !== track.id) loadTrack(track);
  try {
    await engine.start();
    if (engine.noOutput) setStatus('No sound output found. Check your speakers or headphones.');
    await audio.play();
  } catch (error) {
    if (error.name !== 'AbortError') setStatus(`Could not play ${track.title}`);
  }
}

function playTrack(track) {
  loadTrack(track);
  return play();
}

function togglePlay() {
  if (audio.paused) play();
  else audio.pause();
}

function unload() {
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  loadedId = null;
  renderDeck();
}

function stop() {
  audio.pause();
  if (loadedId) audio.currentTime = 0;
  renderDeck();
}

function next() {
  const wasPlaying = !audio.paused;
  const track = playlist.next();
  if (!track) return;
  if (wasPlaying) playTrack(track);
  else loadTrack(track);
}

function previous() {
  if (audio.currentTime > RESTART_AFTER) {
    audio.currentTime = 0;
    return;
  }
  const wasPlaying = !audio.paused;
  const track = playlist.previous();
  if (!track) return;
  if (wasPlaying) playTrack(track);
  else loadTrack(track);
}

function advanceAfterEnd() {
  const track = playlist.next({ auto: true });
  if (track) {
    playTrack(track);
  } else {
    audio.currentTime = 0;
    renderDeck();
  }
}

function handlePlaybackError() {
  const track = playlist.tracks.find((item) => item.id === loadedId);
  if (!track) return;
  track.failed = true;
  failures++;
  setStatus(`Can't play ${track.title}: this browser doesn't support it`);
  renderPlaylist();
  const following = failures < playlist.tracks.length ? playlist.next() : null;
  if (following) playTrack(following);
  else unload();
}

function removeTrack(id) {
  const wasLoaded = loadedId === id;
  const wasPlaying = !audio.paused;
  playlist.remove(id);
  queueLibraryWrite(() => library.deleteFiles([id]));
  if (selectedId === id) selectedId = null;
  if (wasLoaded) {
    const replacement = playlist.current;
    if (replacement && wasPlaying) playTrack(replacement);
    else unload();
  }
  renderPlaylist();
  renderDeck();
}

function clearPlaylist() {
  const ids = playlist.tracks.map((track) => track.id);
  unload();
  playlist.clear();
  active.position = 0;
  probeQueue.length = 0;
  levelQueue.length = 0;
  selectedId = null;
  storageNote = '';
  queueLibraryWrite(() => library.deleteFiles(ids));
  byId('search').value = '';
  renderPlaylist();
  renderDeck();
}

function select(id, { focus = false } = {}) {
  selectedId = id;
  byId('tracks').querySelectorAll('.row').forEach((row) => {
    const chosen = row.dataset.id === id;
    row.classList.toggle('selected', chosen);
    row.tabIndex = chosen ? 0 : -1;
  });
  byId('remove').disabled = id === null;
  if (focus) {
    const row = byId('tracks').querySelector(`[data-id="${id}"]`);
    row?.focus({ preventScroll: true });
    scrollRowIntoList(row);
  }
}

function applySkin() {
  document.documentElement.dataset.skin = settings.skin;
  if (miniWindow) miniWindow.document.documentElement.dataset.skin = settings.skin;
  document.querySelectorAll('[data-skin-choice]').forEach((button) => {
    setPressed(button, button.dataset.skinChoice === settings.skin);
  });
  visualiser.draw(audio.paused);
}

function setSkin(skin) {
  settings.skin = skin;
  saveSettings();
  applySkin();
}

function applyVolume() {
  const input = byId('volume');
  input.value = String(settings.volume);
  input.style.setProperty('--v', `${settings.volume}%`);
  byId('volume-value').textContent = `${settings.volume}%`;
  setPressed(byId('mute'), settings.muted);
  engine.setVolume(settings.volume / 100, settings.muted);
  renderDeck();
}

function setVolume(volume) {
  settings.volume = Math.max(0, Math.min(100, Math.round(volume)));
  if (settings.muted && settings.volume > 0) settings.muted = false;
  saveSettings();
  applyVolume();
}

function applyLevel({ smooth = false } = {}) {
  const track = playlist?.tracks.find((other) => other.id === loadedId);
  engine.setLevel(settings.levelling && track ? levelGainDb(track.loudness) : 0, { smooth });
}

async function measureNextLevel() {
  const track = levelQueue.shift();
  if (track.loudness !== undefined || tooLongToLevel(track.duration, track.file.size)) return;
  try {
    track.loudness = await measureFile(track.file);
  } catch {
    track.loudness = null;
  }
  scheduleSave();
  if (track.id === loadedId) applyLevel({ smooth: true });
}

async function pumpLevelling() {
  if (levelRunning) return;
  levelRunning = true;
  while (settings.levelling && levelQueue.length > 0) await measureNextLevel();
  levelRunning = false;
}

function queueLevelling(tracks, { first = false } = {}) {
  const waiting = tracks.filter((track) => track.probed && track.loudness === undefined);
  if (first) levelQueue.unshift(...waiting);
  else levelQueue.push(...waiting);
  pumpLevelling();
}

function setLevelling(on) {
  settings.levelling = on;
  saveSettings();
  setPressed(byId('level'), on);
  if (on) {
    const current = playlist?.tracks.find((track) => track.id === loadedId);
    queueLevelling([...(current ? [current] : []), ...playlists.flatMap((record) => record.list.tracks)]);
  }
  applyLevel({ smooth: true });
  dj?.setLevelling(on);
  renderDeck();
}

function toggleMute() {
  settings.muted = !settings.muted;
  saveSettings();
  applyVolume();
}

function setShuffle(on) {
  settings.shuffle = on;
  playlist.setShuffle(on);
  if (audio.paused && audio.currentTime < 1 && playlist.tracks.length > 0) {
    loadTrack(on ? playlist.startRound() : playlist.tracks[0], { announce: false });
  }
  setPressed(byId('shuffle'), on);
  saveSettings();
  renderPlaylist();
  byId('tracks-scroll').scrollTop = 0;
  renderDeck();
}

function applyRepeat() {
  playlist.repeat = settings.repeat;
  byId('repeat-label').textContent = `Repeat: ${settings.repeat}`;
  setPressed(byId('repeat'), settings.repeat !== 'off');
  renderDeck();
}

function cycleRepeat() {
  settings.repeat = playlist.cycleRepeat();
  saveSettings();
  applyRepeat();
}

function setVizMode(mode) {
  settings.vizMode = mode;
  visualiser.mode = mode;
  byId('viz-axis').hidden = mode !== 'spectrum';
  document.querySelectorAll('input[name=viz-mode]').forEach((radio) => {
    radio.checked = radio.value === mode;
  });
  saveSettings();
  visualiser.draw(audio.paused);
}

function setCompact(on) {
  settings.compact = on;
  byId('app').classList.toggle('compact', on);
  setPressed(byId('compact'), on);
  saveSettings();
}

function setMini(on) {
  miniWindow?.close();
  const changed = settings.mini !== on;
  settings.mini = on;
  byId('app').classList.toggle('mini', on);
  saveSettings();
  if (changed) (on ? mini.play : byId('mini-toggle')).focus();
}

async function popOutMini() {
  if (miniWindow) return;
  try {
    miniWindow = await window.documentPictureInPicture.requestWindow({ width: 360, height: 72 });
  } catch {
    setMini(true);
    return;
  }
  const { document: floating } = miniWindow;
  floating.documentElement.dataset.skin = settings.skin;
  const stylesheet = floating.createElement('link');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = new URL('styles.css', location.href).href;
  floating.head.append(stylesheet);
  floating.title = APP_NAME;
  floating.body.className = 'pip';
  const frame = floating.createElement('div');
  frame.className = 'app mini';
  frame.append(floating.adoptNode(mini.root));
  floating.body.append(frame);
  miniWindow.addEventListener('pagehide', () => {
    byId('app').querySelector('.titlebar').after(document.adoptNode(mini.root));
    miniWindow = null;
  }, { once: true });
}

function formatGain(gain) {
  return gain > 0 ? `+${gain}` : String(gain);
}

function applyEq() {
  const { enabled, preamp, gains, preset } = settings.eq;
  byId('eq-enabled').checked = enabled;
  byId('eq-preset').value = preset;
  byId('faders').querySelectorAll('.fader').forEach((fader) => {
    const band = fader.dataset.band;
    const gain = band === 'pre' ? preamp : gains[Number(band)];
    const input = fader.querySelector('input');
    input.value = String(gain);
    input.setAttribute('aria-valuetext', `${formatGain(gain)} dB`);
    fader.querySelector('output').textContent = formatGain(gain);
  });
  engine.setEq({ enabled, preamp, gains });
  saveSettings();
  renderDeck();
}

function setPreset(name) {
  if (!PRESETS[name]) return;
  settings.eq.preset = name;
  settings.eq.gains = [...PRESETS[name]];
  applyEq();
}

function buildFaders() {
  const bands = [['pre', 'PRE', 'Preamp'], ...BAND_FREQUENCIES.map((frequency, index) => {
    const short = frequency >= 1000 ? `${frequency / 1000}k` : String(frequency);
    return [String(index), short, frequency >= 1000 ? `${frequency / 1000} kHz` : `${frequency} Hz`];
  })];
  byId('faders').replaceChildren(...bands.map(([band, short, label]) => {
    const fader = document.createElement('div');
    fader.className = `fader${band === 'pre' ? ' preamp' : ''}`;
    fader.dataset.band = band;
    const output = document.createElement('output');
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(-MAX_GAIN_DB);
    input.max = String(MAX_GAIN_DB);
    input.step = '1';
    input.setAttribute('aria-label', label);
    input.addEventListener('input', () => {
      const gain = clampGain(Number(input.value));
      if (band === 'pre') {
        settings.eq.preamp = gain;
      } else {
        settings.eq.gains[Number(band)] = gain;
        settings.eq.preset = 'Custom';
      }
      applyEq();
    });
    const small = document.createElement('small');
    small.textContent = short;
    fader.append(output, input, small);
    return fader;
  }));

  const presets = [...Object.keys(PRESETS), 'Custom'];
  byId('eq-preset').replaceChildren(...presets.map((name) => new Option(name, name)));
}

function menuItems() {
  return {
    File: [
      ['Open files…', () => byId('file-input').click()],
      ['Open folder…', () => byId('folder-input').click()],
    ],
    Playlist: [
      ['Shuffle', () => setShuffle(!settings.shuffle)],
      ['Repeat: next mode', cycleRepeat],
      null,
      ['Clear playlist', clearPlaylist],
      null,
      ['New playlist…', newPlaylist],
      ['Rename playlist…', renamePlaylist],
      ['Delete playlist…', deletePlaylist],
    ],
    View: [
      ['DJ mode (advanced)', () => setDjMode(!settings.dj)],
      ['Compact mode', () => setCompact(!settings.compact)],
      ['Mini player', () => setMini(!settings.mini)],
      ['Mini player in floating window', popOutMini],
      null,
      ['Spectrum', () => setVizMode('spectrum')],
      ['Oscilloscope', () => setVizMode('scope')],
      ['Visualiser off', () => setVizMode('off')],
    ],
    Skin: SKINS.map(([skin, label]) => [label, () => setSkin(skin)]),
    Help: [
      ['Keyboard and privacy', () => byId('help').showModal()],
    ],
  };
}

function closeMenus(except) {
  document.querySelectorAll('.menu.open').forEach((menu) => {
    if (menu === except) return;
    menu.classList.remove('open');
    menu.firstElementChild.setAttribute('aria-expanded', 'false');
  });
}

function buildMenus() {
  const bar = byId('menubar');
  Object.entries(menuItems()).forEach(([name, items]) => {
    const menu = document.createElement('div');
    menu.className = 'menu';
    const trigger = document.createElement('button');
    trigger.textContent = name;
    trigger.setAttribute('aria-haspopup', 'true');
    trigger.setAttribute('aria-expanded', 'false');
    const panel = document.createElement('div');
    panel.className = 'menu-panel out';
    items.forEach((item) => {
      if (!item) {
        panel.append(document.createElement('hr'));
        return;
      }
      const [label, action] = item;
      const button = document.createElement('button');
      button.textContent = label;
      button.addEventListener('click', () => {
        closeMenus();
        trigger.focus();
        action();
      });
      panel.append(button);
    });
    trigger.addEventListener('click', () => {
      const opening = !menu.classList.contains('open');
      closeMenus();
      menu.classList.toggle('open', opening);
      trigger.setAttribute('aria-expanded', String(opening));
      if (opening) panel.querySelector('button').focus();
    });
    panel.addEventListener('keydown', (event) => {
      const buttons = [...panel.querySelectorAll('button')];
      const index = buttons.indexOf(document.activeElement);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus();
      }
      if (event.key === 'Escape') {
        closeMenus();
        trigger.focus();
      }
    });
    menu.append(trigger, panel);
    bar.append(menu);
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.menu')) closeMenus();
  });
}

function updateMediaSession(track) {
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: track.title, artist: track.artist, album: APP_NAME });
  }
}

function bindMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const session = navigator.mediaSession;
  session.setActionHandler('play', play);
  session.setActionHandler('pause', () => audio.pause());
  session.setActionHandler('stop', stop);
  session.setActionHandler('nexttrack', next);
  session.setActionHandler('previoustrack', previous);
}

function bindReorder() {
  const list = byId('tracks');
  let drag = null;

  const clearMarkers = () => {
    list.querySelectorAll('.drop-before, .drop-after').forEach((row) => row.classList.remove('drop-before', 'drop-after'));
  };

  list.addEventListener('pointerdown', (event) => {
    const grip = event.target.closest('.grip');
    if (!grip || byId('search').value.trim()) return;
    event.preventDefault();
    grip.setPointerCapture(event.pointerId);
    drag = { id: grip.closest('.row').dataset.id, grip, target: null };
  });

  list.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const scroller = byId('tracks-scroll');
    const bounds = scroller.getBoundingClientRect();
    if (event.clientY < bounds.top + 44) scroller.scrollTop -= 12;
    if (event.clientY > bounds.bottom - 24) scroller.scrollTop += 12;
    const others = [...list.querySelectorAll('.row')].filter((row) => row.dataset.id !== drag.id);
    drag.target = others.filter((row) => {
      const rect = row.getBoundingClientRect();
      return rect.top + rect.height / 2 < event.clientY;
    }).length;
    clearMarkers();
    if (others[drag.target]) others[drag.target].classList.add('drop-before');
    else others.at(-1)?.classList.add('drop-after');
  });

  const finish = () => {
    if (!drag) return;
    const { id, target } = drag;
    drag = null;
    clearMarkers();
    if (target !== null) {
      playlist.move(id, target);
      renderPlaylist();
      renderDeck();
    }
  };
  list.addEventListener('pointerup', finish);
  list.addEventListener('pointercancel', () => {
    drag = null;
    clearMarkers();
  });
}

async function loadToDeck(deck, trackId) {
  const track = playlist.tracks.find((item) => item.id === trackId);
  if (!track) return;
  try {
    await dj.enable(true);
    await dj.loadTrack(deck, track, active.name);
  } catch (error) {
    setStatus(error.message);
  }
}

function setRowDecks(decks) {
  if (decks.a === rowDecks.a && decks.b === rowDecks.b) return;
  rowDecks = decks;
  byId('tracks').querySelectorAll('.row').forEach((row) => {
    const title = row.querySelector('.t').textContent;
    row.querySelectorAll('.ld').forEach((button) => setPressed(button, rowDecks[button.dataset.deck] === title));
  });
}

function applyDjMode() {
  byId('app').classList.toggle('dj-on', settings.dj);
  setPressed(byId('dj-switch'), settings.dj);
  byId('main-deck-legend').textContent = settings.dj ? 'Master' : 'Deck';
  if (settings.dj) djPanel.show();
  else djPanel.hide();
}

async function setDjMode(on) {
  settings.dj = on;
  saveSettings();
  applyDjMode();
  await dj.enable(on);
  if (on) visualiser.run();
  else if (audio.paused) visualiser.stop();
}

function buildDjSwitch() {
  const button = document.createElement('button');
  button.className = 'btn out dj-switch';
  button.id = 'dj-switch';
  button.title = 'Two decks, crossfader, loops, effects and Auto DJ';
  button.setAttribute('aria-pressed', 'false');
  const light = document.createElement('span');
  light.className = 'ind';
  button.append(light, 'Advanced: DJ mode');
  button.addEventListener('click', () => setDjMode(!settings.dj));
  byId('menubar').append(button);
}

function bindPlaylistEvents() {
  const list = byId('tracks');

  list.addEventListener('click', (event) => {
    const row = event.target.closest('.row');
    if (!row) return;
    const id = row.dataset.id;
    const loadButton = event.target.closest('.ld');
    if (loadButton) {
      loadToDeck(loadButton.dataset.deck, id);
      return;
    }
    if (event.target.closest('.rm')) {
      removeTrack(id);
      return;
    }
    if (event.pointerType === 'touch') {
      const track = playlist.tracks.find((item) => item.id === id);
      selectedId = id;
      playTrack(track);
      return;
    }
    select(id, { focus: true });
  });

  list.addEventListener('dblclick', (event) => {
    const row = event.target.closest('.row');
    if (!row || event.target.closest('.rm, .grip, .ld')) return;
    playTrack(playlist.tracks.find((item) => item.id === row.dataset.id));
  });

  list.addEventListener('keydown', (event) => {
    const row = event.target.closest('.row');
    if (!row) return;
    const id = row.dataset.id;
    const rows = [...list.querySelectorAll('.row')];
    const index = rows.indexOf(row);
    if (event.key === 'Enter') {
      event.preventDefault();
      playTrack(playlist.tracks.find((item) => item.id === id));
    } else if (event.key === 'Delete') {
      event.preventDefault();
      const neighbour = rows[index + 1]?.dataset.id ?? rows[index - 1]?.dataset.id ?? null;
      removeTrack(id);
      if (neighbour) select(neighbour, { focus: true });
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      if (event.altKey && !byId('search').value.trim()) {
        playlist.move(id, playlist.ordered.findIndex((item) => item.id === id) + delta);
        renderPlaylist();
        select(id, { focus: true });
        renderDeck();
      } else if (rows[index + delta]) {
        select(rows[index + delta].dataset.id, { focus: true });
      }
    }
  });

  bindReorder();
  byId('playlist-tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('.pl-tab');
    if (tab && tab.dataset.id !== active.id) activate(playlists.find((record) => record.id === tab.dataset.id));
  });
  byId('playlist-new').addEventListener('click', newPlaylist);
  byId('playlist-rename').addEventListener('click', renamePlaylist);
  byId('playlist-delete').addEventListener('click', deletePlaylist);
  byId('search').addEventListener('input', renderPlaylist);
  byId('remove').addEventListener('click', () => {
    if (selectedId) removeTrack(selectedId);
  });
  byId('clear').addEventListener('click', clearPlaylist);
  byId('shuffle').addEventListener('click', () => setShuffle(!settings.shuffle));
  byId('repeat').addEventListener('click', cycleRepeat);
}

function fileItems(fileList) {
  return [...fileList].map((file) => ({ name: file.webkitRelativePath || file.name, file }));
}

function readEntry(entry, path = '') {
  if (entry.isFile) {
    return new Promise((resolve) => {
      entry.file((file) => resolve([{ name: `${path}${file.name}`, file }]), () => resolve([]));
    });
  }
  const reader = entry.createReader();
  const readBatch = () => new Promise((resolve) => reader.readEntries(resolve, () => resolve([])));
  return (async () => {
    const entries = [];
    for (let batch = await readBatch(); batch.length > 0; batch = await readBatch()) entries.push(...batch);
    const nested = await Promise.all(entries.map((child) => readEntry(child, `${path}${entry.name}/`)));
    return nested.flat();
  })();
}

function bindFileInputs() {
  const fileInput = byId('file-input');
  const folderInput = byId('folder-input');
  [fileInput, folderInput].forEach((input) => {
    input.addEventListener('change', () => {
      addItems(fileItems(input.files));
      input.value = '';
    });
  });
  byId('open').addEventListener('click', () => fileInput.click());
  byId('add').addEventListener('click', () => fileInput.click());
  byId('open-files').addEventListener('click', () => fileInput.click());
  byId('open-folder').addEventListener('click', () => folderInput.click());
}

function bindDragAndDrop() {
  const overlay = byId('drop-overlay');
  let depth = 0;
  const carriesFiles = (event) => event.dataTransfer?.types.includes('Files');

  window.addEventListener('dragenter', (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    depth++;
    const count = event.dataTransfer.items.length;
    byId('drop-count').textContent = count > 0 ? `Drop to add ${count} item${count === 1 ? '' : 's'}` : 'Drop to add files';
    overlay.hidden = false;
  });
  window.addEventListener('dragover', (event) => {
    if (carriesFiles(event)) event.preventDefault();
  });
  window.addEventListener('dragleave', (event) => {
    if (!carriesFiles(event)) return;
    depth--;
    if (depth <= 0) {
      depth = 0;
      overlay.hidden = true;
    }
  });
  window.addEventListener('drop', async (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    depth = 0;
    overlay.hidden = true;
    const entries = [...event.dataTransfer.items].map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
    if (entries.length > 0) addItems((await Promise.all(entries.map((entry) => readEntry(entry)))).flat());
    else addItems(fileItems(event.dataTransfer.files));
  });
}

function bindTransport() {
  byId('play').addEventListener('click', togglePlay);
  byId('stop').addEventListener('click', stop);
  byId('next').addEventListener('click', next);
  byId('prev').addEventListener('click', previous);

  const seek = byId('seek');
  let seekDragPointer = null;
  seek.addEventListener('pointerdown', (event) => {
    seekDragging = true;
    seekDragPointer ??= event.pointerId;
  });
  const stopSeekDragging = (event) => {
    if (event.pointerId !== seekDragPointer) return;
    seekDragPointer = null;
    seekDragging = false;
  };
  window.addEventListener('pointerup', stopSeekDragging);
  window.addEventListener('pointercancel', stopSeekDragging);
  seek.addEventListener('input', () => {
    seekDragging = true;
    renderTime();
  });
  seek.addEventListener('change', () => {
    audio.currentTime = Number(seek.value);
    seekDragging = false;
    renderTime();
  });

  byId('volume').addEventListener('input', (event) => setVolume(Number(event.target.value)));
  byId('mute').addEventListener('click', toggleMute);
  byId('level').addEventListener('click', () => setLevelling(!settings.levelling));

  audio.addEventListener('play', () => {
    visualiser.run();
    renderDeck();
  });
  audio.addEventListener('pause', () => {
    visualiser.stop();
    scheduleSave();
    renderDeck();
  });
  audio.addEventListener('playing', () => {
    failures = 0;
  });
  audio.addEventListener('timeupdate', () => {
    renderTime();
    if (Math.abs(audio.currentTime - savedPosition) >= SAVE_POSITION_EVERY) scheduleSave();
  });
  audio.addEventListener('loadedmetadata', () => {
    if (pendingSeek > 0) audio.currentTime = pendingSeek;
    pendingSeek = 0;
    renderDeck();
  });
  audio.addEventListener('ended', advanceAfterEnd);
  audio.addEventListener('error', () => {
    if (audio.getAttribute('src')) handlePlaybackError();
  });
}

function bindSettingsControls() {
  byId('compact').addEventListener('click', () => setCompact(!settings.compact));
  byId('mini-toggle').addEventListener('click', popOutMini);
  byId('mini-prev').addEventListener('click', previous);
  mini.play.addEventListener('click', togglePlay);
  byId('mini-next').addEventListener('click', next);
  byId('mini-restore').addEventListener('click', () => {
    if (miniWindow) miniWindow.close();
    else setMini(false);
  });
  document.querySelectorAll('[data-skin-choice]').forEach((button) => {
    button.addEventListener('click', () => setSkin(button.dataset.skinChoice));
  });
  document.querySelectorAll('input[name=viz-mode]').forEach((radio) => {
    radio.addEventListener('change', () => setVizMode(radio.value));
  });
  byId('eq-enabled').addEventListener('change', (event) => {
    settings.eq.enabled = event.target.checked;
    applyEq();
  });
  byId('eq-preset').addEventListener('change', (event) => setPreset(event.target.value));
  byId('eq-reset').addEventListener('click', () => {
    settings.eq.preamp = 0;
    setPreset('Flat');
  });
}

function bindKeyboard() {
  window.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target.closest?.('input, select, textarea, dialog')) return;
    if (event.key === ' ' && event.target.closest?.('button, a')) return;
    const actions = {
      ' ': togglePlay,
      n: next,
      p: previous,
      s: stop,
      m: toggleMute,
      ArrowLeft: () => { audio.currentTime = Math.max(0, audio.currentTime - SEEK_STEP); },
      ArrowRight: () => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + SEEK_STEP); },
      ArrowUp: () => setVolume(settings.volume + VOLUME_STEP),
      ArrowDown: () => setVolume(settings.volume - VOLUME_STEP),
    };
    const action = actions[event.key.length === 1 ? event.key.toLowerCase() : event.key];
    if (!action) return;
    event.preventDefault();
    action();
  });
}

async function restoreLibrary() {
  try {
    library = await Library.open();
    const { state, files } = await library.load();
    if (!state) return;
    const saved = state.playlists ?? [{ id: '0', name: DEFAULT_PLAYLIST_NAME, position: state.position, ...state }];
    const ids = saved.flatMap((record) => [Number(record.id), ...record.tracks.map((track) => Number(track.id))]);
    nextId = Math.max(0, ...ids) + 1;
    playlists = saved.map((record) => {
      const tracks = record.tracks
        .filter((details) => files.has(details.id))
        .map((details) => ({ ...details, file: files.get(details.id), failed: false, probed: details.duration !== null }));
      const list = new Playlist();
      list.repeat = settings.repeat;
      list.restore(tracks, record);
      probeQueue.push(...tracks.filter((track) => track.duration === null));
      return { id: record.id, name: record.name, list, position: record.position ?? 0, isDefault: Boolean(record.isDefault) };
    });
    pumpProbes();
    restoredActiveId = state.activeId ?? playlists[0]?.id ?? null;
  } catch {
    library = null;
    playlists = [];
  }
}

let restoredActiveId = null;
let dj = null;
let djPanel = null;
let rowDecks = { a: null, b: null };
let startup = Promise.resolve();

async function startPlayer() {
  await restoreLibrary();
  if (playlists.length === 0) makePlaylist(DEFAULT_PLAYLIST_NAME, { isDefault: true });
  activate(playlists.find((record) => record.id === restoredActiveId) ?? playlists[0]);
  bindPlaylistEvents();
  bindTransport();
  bindSettingsControls();
  bindKeyboard();
  bindMediaSession();
  applySkin();
  applyVolume();
  setLevelling(settings.levelling);
  setPressed(byId('shuffle'), settings.shuffle);
  applyRepeat();
  setVizMode(settings.vizMode);
  setCompact(settings.compact);
  setMini(settings.mini);
  applyEq();
  renderPlaylist();
  renderDeck();
  addEventListener('resize', () => visualiser.draw(audio.paused));
  dj = createDJ({
    engine,
    visualiser,
    pauseNormalPlayer: () => audio.pause(),
    getLevelling: () => settings.levelling,
    getPlaylists: () => playlists.map((record) => ({ name: record.name, tracks: record.list.tracks })),
  });
  window.retroDJ = dj;
  djPanel = bindPanel({ dj, getActivePlaylist: () => active.name, setRowDecks });
  buildDjSwitch();
  applyDjMode();
  audio.addEventListener('play', () => dj.pauseDecks());
}

function init() {
  buildFaders();
  buildMenus();
  bindFileInputs();
  bindDragAndDrop();
  startup = startPlayer();
  if ('serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register('sw.js');
}

init();
