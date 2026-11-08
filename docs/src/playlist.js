export const REPEAT_MODES = ['off', 'all', 'one'];

function shuffled(items, random) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export class Playlist {
  #random;
  #shuffleOrder = [];

  constructor({ random = Math.random } = {}) {
    this.#random = random;
    this.tracks = [];
    this.currentId = null;
    this.shuffle = false;
    this.repeat = 'off';
  }

  get current() {
    return this.tracks.find((track) => track.id === this.currentId) ?? null;
  }

  get ordered() {
    if (!this.shuffle) return this.tracks;
    const byId = new Map(this.tracks.map((track) => [track.id, track]));
    return this.#shuffleOrder.map((id) => byId.get(id)).filter(Boolean);
  }

  add(tracks) {
    this.tracks.push(...tracks);
    this.#insertIntoRound(tracks.map((track) => track.id));
    this.currentId ??= this.#order()[0] ?? null;
  }

  snapshot() {
    return { currentId: this.currentId, shuffleOrder: [...this.#shuffleOrder], shuffle: this.shuffle };
  }

  restore(tracks, { currentId, shuffleOrder, shuffle }) {
    this.tracks = tracks;
    this.shuffle = Boolean(shuffle);
    const ids = tracks.map((track) => track.id);
    const kept = (shuffleOrder ?? []).filter((id) => ids.includes(id));
    this.#shuffleOrder = [...kept, ...ids.filter((id) => !kept.includes(id))];
    this.currentId = ids.includes(currentId) ? currentId : (ids[0] ?? null);
  }

  remove(id) {
    const order = this.#order();
    const position = order.indexOf(id);
    if (position === -1) return;
    this.tracks = this.tracks.filter((track) => track.id !== id);
    this.#shuffleOrder = this.#shuffleOrder.filter((other) => other !== id);
    if (this.currentId === id) {
      this.currentId = order[position + 1] ?? order[position - 1] ?? null;
    }
  }

  clear() {
    this.tracks = [];
    this.#shuffleOrder = [];
    this.currentId = null;
  }

  move(id, toIndex) {
    if (this.shuffle) {
      const rest = this.#shuffleOrder.filter((other) => other !== id);
      rest.splice(Math.max(0, Math.min(toIndex, rest.length)), 0, id);
      this.#shuffleOrder = rest;
      return;
    }
    const from = this.tracks.findIndex((track) => track.id === id);
    if (from === -1) return;
    const [track] = this.tracks.splice(from, 1);
    this.tracks.splice(Math.max(0, Math.min(toIndex, this.tracks.length)), 0, track);
  }

  select(id) {
    if (id === this.currentId || !this.tracks.some((track) => track.id === id)) return;
    if (this.shuffle) {
      this.#shuffleOrder = this.#shuffleOrder.filter((other) => other !== id);
      this.#shuffleOrder.splice(this.#shuffleOrder.indexOf(this.currentId) + 1, 0, id);
    }
    this.currentId = id;
  }

  setShuffle(on) {
    this.shuffle = on;
    this.#reshuffle();
  }

  startRound() {
    return this.tracks.length > 0 ? this.#startNewRound() : null;
  }

  cycleRepeat() {
    this.repeat = REPEAT_MODES[(REPEAT_MODES.indexOf(this.repeat) + 1) % REPEAT_MODES.length];
    return this.repeat;
  }

  next({ auto = false } = {}) {
    if (auto && this.repeat === 'one') return this.current;
    return this.#step(1);
  }

  previous() {
    return this.#step(-1);
  }

  search(query) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return this.ordered.filter((track) => {
      const text = `${track.artist ?? ''} ${track.title ?? ''}`.toLowerCase();
      return words.every((word) => text.includes(word));
    });
  }

  #order() {
    return this.shuffle ? this.#shuffleOrder : this.tracks.map((track) => track.id);
  }

  #reshuffle() {
    const others = this.tracks.map((track) => track.id).filter((id) => id !== this.currentId);
    const rest = shuffled(others, this.#random);
    this.#shuffleOrder = this.currentId === null ? rest : [this.currentId, ...rest];
  }

  #insertIntoRound(ids) {
    for (const id of ids) {
      const firstUnplayed = this.#shuffleOrder.indexOf(this.currentId) + 1;
      const room = this.#shuffleOrder.length - firstUnplayed + 1;
      this.#shuffleOrder.splice(firstUnplayed + Math.floor(this.#random() * room), 0, id);
    }
  }

  #startNewRound() {
    const round = shuffled(this.tracks.map((track) => track.id), this.#random);
    if (round.length > 1 && round[0] === this.currentId) [round[0], round[1]] = [round[1], round[0]];
    this.#shuffleOrder = round;
    this.currentId = round[0];
    return this.current;
  }

  #step(direction) {
    const order = this.#order();
    if (order.length === 0) return null;
    const target = order.indexOf(this.currentId) + direction;
    if (target >= 0 && target < order.length) {
      this.currentId = order[target];
      return this.current;
    }
    if (this.shuffle) return direction > 0 ? this.#startNewRound() : null;
    if (this.repeat === 'off') return null;
    this.currentId = order[(target + order.length) % order.length];
    return this.current;
  }
}
