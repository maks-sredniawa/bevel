const DATABASE = 'retro-music-player';
const FILES = 'files';
const STATE = 'state';
const STATE_KEY = 'playlist';

function finished(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function committed(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

export class Library {
  #database;

  constructor(database) {
    this.#database = database;
  }

  static async open() {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(FILES);
      request.result.createObjectStore(STATE);
    };
    return new Library(await finished(request));
  }

  #write(stores, work) {
    const transaction = this.#database.transaction(stores, 'readwrite', { durability: 'strict' });
    work(transaction);
    return committed(transaction);
  }

  putFile(id, file) {
    return this.#write(FILES, (transaction) => transaction.objectStore(FILES).put(file, id));
  }

  saveState(state) {
    return this.#write(STATE, (transaction) => transaction.objectStore(STATE).put(state, STATE_KEY));
  }

  deleteFiles(ids) {
    return this.#write(FILES, (transaction) => {
      const files = transaction.objectStore(FILES);
      ids.forEach((id) => files.delete(id));
    });
  }

  async load() {
    const transaction = this.#database.transaction([FILES, STATE], 'readonly');
    const files = transaction.objectStore(FILES);
    const [state, keys, values] = await Promise.all([
      finished(transaction.objectStore(STATE).get(STATE_KEY)),
      finished(files.getAllKeys()),
      finished(files.getAll()),
    ]);
    return { state: state ?? null, files: new Map(keys.map((key, index) => [key, values[index]])) };
  }
}
