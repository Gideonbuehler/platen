import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { queryBoolean } from './query.js';

describe('queryBoolean', () => {
  it('reads true and 1 as true', () => {
    assert.equal(queryBoolean.parse('true'), true);
    assert.equal(queryBoolean.parse('1'), true);
  });

  it('reads false and 0 as false, unlike z.coerce.boolean', () => {
    assert.equal(queryBoolean.parse('false'), false);
    assert.equal(queryBoolean.parse('0'), false);
  });

  it('refuses anything else rather than guessing', () => {
    assert.equal(queryBoolean.safeParse('yes').success, false);
    assert.equal(queryBoolean.safeParse('').success, false);
  });
});
