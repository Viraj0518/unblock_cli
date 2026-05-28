import { describe, expect, it } from 'vitest';
import {
  buildEnvelope,
  chatDmSubject,
  chatFirehoseSubject,
  chatQuestionSubject,
  chatReplySubject,
  normalizeChatName,
  parseEnvelope,
} from '../../src/comms/wire.js';

describe('subject builders', () => {
  it('firehose subject is workspace-prefixed', () => {
    expect(chatFirehoseSubject('default')).toBe('unblock.chat.ws.default.firehose');
    expect(chatFirehoseSubject('org-xyz')).toBe('unblock.chat.ws.org-xyz.firehose');
  });

  // ─── PR-pin: recipient case normalization (lowercase) ───────────────────────
  //
  // Repro of the 2026-05-28 01:24 UTC silent-drop bug. NATS subjects are
  // case-sensitive — `to.Viraj-Alpha` and `to.viraj-alpha` are DIFFERENT
  // subjects. The fix point is `chatDmSubject`: it canonicalises the
  // recipient to lowercase via `normalizeChatName` so a sender writing
  // `Viraj-Alpha` doesn't silently miss the `viraj-alpha` listener that the
  // auth-issuer minted into the persona's `comms-v3.env`.
  it('dm subject lowercases mixed-case recipient (P0 silent-drop fix)', () => {
    expect(chatDmSubject('default', 'Viraj-Alpha')).toBe(
      'unblock.chat.ws.default.to.viraj-alpha',
    );
    // All-lowercase input is a no-op.
    expect(chatDmSubject('default', 'haiku-a')).toBe(
      'unblock.chat.ws.default.to.haiku-a',
    );
    // Workspace id is preserved verbatim (not a chat handle).
    expect(chatDmSubject('Org-XYZ', 'Codex')).toBe(
      'unblock.chat.ws.Org-XYZ.to.codex',
    );
  });

  it('normalizeChatName is idempotent + lowercases ASCII', () => {
    expect(normalizeChatName('Viraj-Alpha')).toBe('viraj-alpha');
    expect(normalizeChatName('viraj-alpha')).toBe('viraj-alpha');
    expect(normalizeChatName(normalizeChatName('Viraj-Alpha'))).toBe('viraj-alpha');
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
