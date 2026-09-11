import test from 'node:test';
import assert from 'node:assert/strict';
import { groupRows, mergeMessages, playableMessages, roundState, hasBothAnswers, hasFirstAnswer, openingExcerpt } from '../src/components/round-model.ts';

const message = (seq, author, extra = {}) => ({ seq, id: String(seq), thread_id: 'thread', author, addressed_to: author === 'user' ? 'both' : 'none', body: `Reply ${seq}`, spoken_summary: null, reply_to: null, kind: 'message', stopped_for: [], created_at: new Date(seq * 1000).toISOString(), ...extra });

test('delayed linked answers stay under their own question, including a follow-up to a reply', () => {
  const rows = groupRows([message(1, 'user'), message(2, 'user'), message(3, 'claude', { reply_to: '1' }), message(4, 'chatgpt', { reply_to: '1' }), message(5, 'claude', { reply_to: '3' })]);
  assert.deepEqual(rows[0].claude.map(m => m.seq), [3, 5]);
  assert.deepEqual(rows[0].chatgpt.map(m => m.seq), [4]);
  assert.equal(rows[1].claude.length, 0);
});

test('compare requests and delayed compare replies live under the original question', () => {
  const rows = groupRows([message(1, 'user'), message(2, 'claude', { reply_to: '1' }), message(3, 'chatgpt', { reply_to: '1' }), message(4, 'user', { kind: 'compare', reply_to: '1' }), message(5, 'user'), message(6, 'chatgpt', { reply_to: '4' }), message(7, 'claude', { reply_to: '4' })]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].comparison.chatgpt.map(m => m.seq), [6]);
  assert.equal(hasBothAnswers(rows[0].comparison), true);
  assert.equal(rows[1].chatgpt.length, 0);
});

test('a held first answer never enters playback; both enter in arrival order on reveal', () => {
  const first = [message(1, 'user'), message(2, 'chatgpt', { reply_to: '1' })];
  assert.deepEqual(playableMessages(groupRows(first), 4000).map(m => m.seq), [1]);
  assert.deepEqual(playableMessages(groupRows([...first, message(3, 'claude', { reply_to: '1' })]), 4000).map(m => m.seq), [1, 2, 3]);
});

test('stopping ChatGPT releases the other answer without marking the round complete', () => {
  const rows = groupRows([message(1, 'user', { stopped_for: ['chatgpt'] }), message(2, 'claude', { reply_to: '1' })]);
  assert.deepEqual(roundState(rows[0], rows, 4000), { held: false, paired: false });
  assert.deepEqual(playableMessages(rows, 4000).map(m => m.seq), [1, 2]);
});

test("stopping Claude releases ChatGPT's answer without marking the round complete", () => {
  const rows = groupRows([message(1, 'user', { stopped_for: ['claude'] }), message(2, 'chatgpt', { reply_to: '1' })]);
  assert.deepEqual(roundState(rows[0], rows, 4000), { held: false, paired: false });
  assert.deepEqual(playableMessages(rows, 4000).map(m => m.seq), [1, 2]);
});

test('unlinked progress does not reveal a modern round or enable Compare', () => {
  const rows = groupRows([message(1, 'user'), message(2, 'chatgpt'), message(3, 'claude', { reply_to: '1' })]);
  assert.deepEqual(roundState(rows[0], rows, 4000), { held: true, paired: false });
  assert.equal(hasFirstAnswer(rows[0], 'chatgpt'), false, 'Progress cannot claim Answer ready');
  assert.equal(hasFirstAnswer(rows[0], 'claude'), true);
});

test('Live mode reveals and plays the first answer immediately, but Compare still waits for two answers', () => {
  const first = [message(1, 'user', { blind_round: false }), message(2, 'claude', { reply_to: '1' })];
  const rows = groupRows(first);
  assert.deepEqual(roundState(rows[0], rows, 4000), { held: false, paired: false });
  assert.deepEqual(playableMessages(rows, 4000).map(m => m.seq), [1, 2]);
  const complete = groupRows([...first, message(3, 'chatgpt', { reply_to: '1' })]);
  assert.deepEqual(roundState(complete[0], complete, 4000), { held: false, paired: true });
});

test('Live and separate questions retain their own behavior in the same conversation', () => {
  const rows = groupRows([message(1, 'user', { blind_round: true }), message(2, 'claude', { reply_to: '1' }), message(3, 'user', { blind_round: false }), message(4, 'claude', { reply_to: '3' })]);
  assert.deepEqual(roundState(rows[0], rows, 5000), { held: true, paired: false });
  assert.deepEqual(roundState(rows[1], rows, 5000), { held: false, paired: false });
  assert.deepEqual(playableMessages(rows, 5000).map(m => m.seq), [1, 3, 4]);
});

test('expired and moved-on rounds release available text without claiming both answered', () => {
  const rows = groupRows([message(1, 'user'), message(2, 'chatgpt', { reply_to: '1' })]);
  assert.deepEqual(roundState(rows[0], rows, 3 * 60 * 60 * 1000), { held: false, paired: false });
  const moved = groupRows([message(1, 'user'), message(2, 'chatgpt', { reply_to: '1' }), message(3, 'user'), message(4, 'claude', { reply_to: '3' })]);
  assert.deepEqual(roundState(moved[0], moved, 5000), { held: false, paired: false });
});

test('one-assistant questions and notes do not become blind rounds', () => {
  const rows = groupRows([message(1, 'user', { addressed_to: 'chatgpt' }), message(2, 'chatgpt'), message(3, 'user', { addressed_to: 'none' })]);
  assert.deepEqual(playableMessages(rows).map(m => m.seq), [1, 2, 3]);
});

test('legacy replies fall back to the latest question and unknown explicit links stay separate', () => {
  const rows = groupRows([message(1, 'user'), message(2, 'claude'), message(3, 'chatgpt', { reply_to: 'deleted-question' })]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].claude.map(m => m.seq), [2]);
  assert.equal(rows[0].chatgpt.length, 0);
});

test('overlapping poll and POST responses merge without duplicates, lost older replies, or stale fields', () => {
  const result = mergeMessages([message(1, 'user'), message(4, 'user')], [message(3, 'chatgpt'), message(1, 'user', { body: 'Updated' }), message(4, 'user')]);
  assert.deepEqual(result.map(m => m.seq), [1, 3, 4]);
  assert.equal(result[0].body, 'Updated');
});

test('opening excerpts strip code and link destinations and mark truncation honestly', () => {
  const text = openingExcerpt('# Recommendation\nRead [the documentation](https://example.com/private).\n```js\nsecretCode()\n```\nThen run the checks.', 5);
  assert.equal(text, 'Recommendation Read the documentation. Then…');
  assert.ok(!text.includes('example.com'));
  assert.ok(!text.includes('secretCode'));
});
