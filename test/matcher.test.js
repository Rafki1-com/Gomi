'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isCompatible, findCompatible } = require('../src/matcher');

test('ANY preference matches any country when both users agree', () => {
  assert.equal(isCompatible({ country: 'ID', desiredCountry: 'ANY' }, { country: 'JP', desiredCountry: 'ANY' }), true);
});

test('country preferences are bilateral', () => {
  assert.equal(isCompatible({ country: 'ID', desiredCountry: 'JP' }, { country: 'JP', desiredCountry: 'ID' }), true);
  assert.equal(isCompatible({ country: 'ID', desiredCountry: 'JP' }, { country: 'JP', desiredCountry: 'MY' }), false);
});

test('matcher skips self, incompatible and blocked users', () => {
  const current = { socketId: 's1', userId: 'u1', country: 'ID', desiredCountry: 'ANY' };
  const queue = [
    { socketId: 's1', userId: 'u1', country: 'ID', desiredCountry: 'ANY' },
    { socketId: 's2', userId: 'u2', country: 'JP', desiredCountry: 'MY' },
    { socketId: 's3', userId: 'u3', country: 'MY', desiredCountry: 'ANY' }
  ];
  const found = findCompatible(queue, current, (a, b) => a === 'u1' && b === 'u3');
  assert.equal(found, null);
  const foundWithoutBlock = findCompatible(queue, current, () => false);
  assert.equal(foundWithoutBlock.userId, 'u3');
});

test('matcher returns first compatible, non-blocked entry', () => {
  const current = { socketId: 's1', userId: 'u1', country: 'ID', desiredCountry: 'ANY' };
  const queue = [
    { socketId: 's2', userId: 'u2', country: 'JP', desiredCountry: 'ANY' },
    { socketId: 's3', userId: 'u3', country: 'MY', desiredCountry: 'ANY' }
  ];
  const found = findCompatible(queue, current, (a, b) => a === 'u1' && b === 'u2');
  assert.equal(found.userId, 'u3');
});
