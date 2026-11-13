import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SKINS, mergeSettings } from '../docs/src/settings.js';

const defaults = { skin: 'oatmeal', compact: false, mini: false, eq: { enabled: true, preamp: 0 } };

test('an unknown saved skin falls back to the default skin', () => {
  assert.equal(mergeSettings(defaults, { skin: 'bogus' }).skin, 'oatmeal');
  assert.equal(mergeSettings(defaults, { skin: 42 }).skin, 'oatmeal');
});

test('every known skin is kept', () => {
  for (const [skin] of SKINS) assert.equal(mergeSettings(defaults, { skin }).skin, skin);
});

test('saved layout and equaliser values override the defaults', () => {
  const merged = mergeSettings(defaults, { compact: true, mini: true, eq: { preamp: 3 } });
  assert.deepEqual(merged, { skin: 'oatmeal', compact: true, mini: true, eq: { enabled: true, preamp: 3 } });
});

test('nothing saved gives the defaults', () => {
  assert.deepEqual(mergeSettings(defaults, null), defaults);
});
