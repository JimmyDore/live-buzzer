import assert from 'node:assert/strict';
import test from 'node:test';

import { ALPHABET, LONGUEUR_CODE, estCodeValide, genererCode, normaliserCode } from '../codes.mjs';
import { seeded } from './helpers.mjs';

test("l'alphabet ne contient aucun confusable : ni I/1/L, ni O/0, ni S/5, ni B/8, ni Z/2", () => {
  assert.equal(ALPHABET, 'ACDEFGHJKMNPQRTUVWXY346789', "l'alphabet est figé par le contrat");
  // Ces caractères-là sont bannis d'office : ils n'ont aucun sosie utilisable.
  for (const interdit of ['I', '1', 'L', 'O', '0']) {
    assert.equal(ALPHABET.includes(interdit), false, `« ${interdit} » se confond avec un autre`);
  }
  // Ces paires-là ne peuvent pas cohabiter : on garde au plus un des deux.
  for (const [a, b] of [
    ['S', '5'],
    ['B', '8'],
    ['Z', '2'],
  ]) {
    assert.equal(
      ALPHABET.includes(a) && ALPHABET.includes(b),
      false,
      `« ${a} » et « ${b} » ensemble, c'est un code mal recopié`,
    );
  }
  assert.equal(ALPHABET.length, 26);
  assert.equal(new Set(ALPHABET).size, 26, 'aucune lettre en double');
  assert.equal(LONGUEUR_CODE, 4);
});

test('un code tiré fait 4 caractères, tous dans l’alphabet, et le tirage est reproductible', () => {
  const code = genererCode(seeded(1));
  assert.equal(code.length, 4);
  assert.equal(estCodeValide(code), true);
  assert.equal(genererCode(seeded(1)), code, 'même graine, même code : les tests restent déterministes');
});

test('la saisie est tolérante : minuscules, espaces et tirets', () => {
  const attendu = normaliserCode('ACDE');
  assert.equal(attendu, 'ACDE');
  assert.equal(normaliserCode('acde'), 'ACDE');
  assert.equal(normaliserCode(' a c d e '), 'ACDE');
  assert.equal(normaliserCode('ac-de'), 'ACDE');
});

test('un code hors alphabet ou de mauvaise longueur est rejeté proprement', () => {
  for (const mauvais of ['', 'ABC', 'ACDEF', 'AIDE', 'AB0D', 'ACD€', 'ZZZZ', null, undefined, 42, {}]) {
    assert.equal(normaliserCode(mauvais), null, `« ${String(mauvais)} » n'est pas un code`);
  }
  assert.equal(estCodeValide('ACDE'), true);
});
