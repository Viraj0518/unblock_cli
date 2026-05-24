import { describe, expect, it } from 'vitest';
import {
  buildEnvelope,
  chatDmSubject,
  chatFirehoseSubject,
  chatQuestionSubject,
  chatReplySubject,
  parseEnvelope,
} from '../../src/comms/wire.js';

describe('subject builders', () => {
  it('firehose subject is workspace-prefixed', () => {
    expect(chatFirehoseSubject('default')).toBe('unblock.chat.ws.default.firehose');
    expect(chatFirehoseSubject('org-xyz')).toBe('unblock.chat.ws.org-xyz.firehose');
  });

  it('dm subject embeds recipient', () => {
    expect(chatDmSubject('default', 'Viraj-Alpha')).toBe(
      'unblock.chat.ws.default.to.Viraj-Alpha',
    );
  });

  it('question + reply share the same question_id', () => {
    expect(chatQuestionSubject('default', 'q1')).toBe('unblock.chat.ws.default.q.q1');
    expect(chatReplySubject('default', 'q1')).toBe('unblock.chat.ws.default.a.q1');
  });
});

describe('envelope', () => {
  it('build → parse round-trips deterministically with injected now()', () => {
    const now = (): number => 1700000000000;
    const data = buildEnvelope('say', 'Viraj-Alpha', { msg: 'hi' }, now);
    const env = parseEnvelope(data);
    expect(env).toEqual({
      kind: 'say',
      source: 'Viraj-Alpha',
      ts: 1700000000000,
      msg: 'hi',
    });
  });

  it('parseEnvelope returns null on bad JSON', () => {
    expect(parseEnvelope(new TextEncoder().encode('{not-json'))).toBeNull();
  });

  it('parseEnvelope returns null on missing required fields', () => {
    expect(parseEnvelope(new TextEncoder().encode('{"kind":"say"}'))).toBeNull();
    expect(parseEnvelope(new TextEncoder().encode('[]'))).toBeNull();
  });

  it('build preserves extra keys', () => {
    const data = buildEnvelope('ask', 's', { msg: 'q', question_id: 'qid', options: ['a', 'b'] });
    const env = parseEnvelope(data);
    expect(env?.['question_id']).toBe('qid');
    expect(env?.['options']).toEqual(['a', 'b']);
  });
});
