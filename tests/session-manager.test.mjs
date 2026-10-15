import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bionic-sess-test-'));
process.env.WORKSPACE_DIR = tempDir;

const {
  listSessions,
  getSession,
  saveSession,
  deleteSession
} = await import('../dist-server/services/sessionManager.js');

test('Session Manager Unit Tests', async (t) => {
  await t.test('saveSession creates session file in .bionic/sessions', () => {
    const session = saveSession({
      id: 'session-abc-123',
      title: 'CRISPR Target Screening',
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      messages: [{ role: 'user', content: 'Find gRNA candidates' }]
    });

    assert.equal(session.id, 'session-abc-123');
    assert.equal(session.title, 'CRISPR Target Screening');
    assert.ok(fs.existsSync(path.join(tempDir, '.bionic/sessions/session-abc-123.json')));
  });

  await t.test('getSession retrieves saved session by id', () => {
    const session = getSession('session-abc-123');
    assert.ok(session);
    assert.equal(session.id, 'session-abc-123');
    assert.equal(session.title, 'CRISPR Target Screening');
    assert.equal(session.messages.length, 1);
  });

  await t.test('getSession returns null for non-existent session', () => {
    const session = getSession('non-existent-session-id');
    assert.equal(session, null);
  });

  await t.test('listSessions returns summary list sorted by updatedAt', () => {
    saveSession({
      id: 'session-older',
      title: 'Older Session',
      createdAt: 100,
      updatedAt: 100,
      messages: []
    });

    saveSession({
      id: 'session-newer',
      title: 'Newer Session',
      createdAt: 200,
      updatedAt: 200,
      messages: [{ role: 'user', content: 'test' }]
    });

    const list = listSessions();
    assert.ok(Array.isArray(list));
    assert.ok(list.length >= 2);
    // Newest first
    const newerIdx = list.findIndex(s => s.id === 'session-newer');
    const olderIdx = list.findIndex(s => s.id === 'session-older');
    assert.ok(newerIdx < olderIdx, 'Newer session should precede older session');
  });

  await t.test('listSessions gracefully ignores corrupted session files', () => {
    const corruptFile = path.join(tempDir, '.bionic/sessions/corrupt.json');
    fs.writeFileSync(corruptFile, 'not-valid-json{{{', 'utf-8');

    const list = listSessions();
    assert.ok(Array.isArray(list));
    assert.ok(!list.some(s => s.id === 'corrupt'));
  });

  await t.test('deleteSession removes file and returns boolean status', () => {
    const deleted = deleteSession('session-abc-123');
    assert.equal(deleted, true);
    assert.equal(getSession('session-abc-123'), null);

    const deletedAgain = deleteSession('session-abc-123');
    assert.equal(deletedAgain, false);
  });

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
