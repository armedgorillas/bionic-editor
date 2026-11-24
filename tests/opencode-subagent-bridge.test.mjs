import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bionic-subagent-test-'));
process.env.WORKSPACE_DIR = tempDir;

const { OpenCodeServerBridge } = await import('../dist-server/services/opencodeServer.js');
const { getSession, saveSession } = await import('../dist-server/services/sessionManager.js');

test('OpenCode V2 Subagent & Background Completion Bridge Suite', async (t) => {
  await t.test('streams live subagent_updated events and pushes post-turn background completion over WS + persists session', async () => {
    const bridge = new OpenCodeServerBridge();
    const broadcasts = [];
    bridge.setBroadcast((payload) => broadcasts.push(payload));

    const bionicSessionId = 'session_subagent_demo';
    const ocParentId = 'ses_parent_001';
    const ocChildId = 'ses_child_001';

    // Seed an existing saved session (as after the parent's initial turn finished and closed SSE)
    saveSession({
      id: bionicSessionId,
      title: 'Check data quality with subagent',
      createdAt: Date.now() - 5000,
      updatedAt: Date.now() - 5000,
      messages: [
        { id: 'u1', role: 'user', content: 'Launch a subagent to check raw CSVs', timestamp: Date.now() - 4000 },
        { id: 'a1', role: 'assistant', content: 'Launched a background subagent.', timestamp: Date.now() - 3000 }
      ],
      tokens: { promptTokens: 100, completionTokens: 50, totalTokens: 150, estimatedCostUsd: 0.001 }
    });

    bridge.registerSessionMapping(bionicSessionId, ocParentId);

    // 1. Subagent starts running in background
    bridge.handleOpenCodeEvent({
      type: 'experimental.job.updated',
      data: {
        info: {
          kind: 'subagent',
          id: 'job_sub_1',
          sessionID: ocParentId,
          childSessionID: ocChildId,
          agent: 'explore',
          description: 'Check CSV headers and missing values',
          status: 'running',
          time: { started: 1700000000000 }
        }
      }
    });

    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].type, 'subagent_updated');
    assert.equal(broadcasts[0].sessionId, bionicSessionId);
    assert.equal(broadcasts[0].job.status, 'running');
    assert.equal(broadcasts[0].job.agent, 'explore');

    // 2. Subagent finishes in background
    bridge.handleOpenCodeEvent({
      type: 'experimental.job.updated',
      data: {
        info: {
          kind: 'subagent',
          id: 'job_sub_1',
          sessionID: ocParentId,
          childSessionID: ocChildId,
          agent: 'explore',
          description: 'Check CSV headers and missing values',
          status: 'completed',
          time: { started: 1700000000000, completed: 1700000012000 }
        }
      }
    });

    assert.equal(broadcasts[1].type, 'subagent_updated');
    assert.equal(broadcasts[1].job.status, 'completed');
    assert.equal(bridge.getTrackedSubagents(bionicSessionId)[0].status, 'completed');

    // 3. OpenCode wakes up parent session in background (NO foreground HTTP request open!)
    bridge.handleOpenCodeEvent({
      type: 'session.execution.started',
      data: { sessionID: ocParentId }
    });
    bridge.handleOpenCodeEvent({
      type: 'session.text.delta',
      data: { sessionID: ocParentId, assistantMessageID: 'msg_2', ordinal: 0, delta: 'Subagent finished: ' }
    });
    bridge.handleOpenCodeEvent({
      type: 'session.text.delta',
      data: { sessionID: ocParentId, assistantMessageID: 'msg_2', ordinal: 1, delta: 'all 3 CSVs passed QC. Updated `RESULTS.md`.' }
    });
    bridge.handleOpenCodeEvent({
      type: 'session.step.ended',
      data: {
        sessionID: ocParentId,
        assistantMessageID: 'msg_2',
        finish: 'stop',
        cost: 0.0025,
        tokens: { input: 200, output: 80, reasoning: 20, cache: { read: 0, write: 0 } }
      }
    });
    bridge.handleOpenCodeEvent({
      type: 'session.idle',
      data: { sessionID: ocParentId }
    });

    // Verify live WebSocket agent_event broadcasts were emitted
    const agentEvents = broadcasts.filter((b) => b.type === 'agent_event');
    assert.ok(agentEvents.some((e) => e.event.type === 'background_turn_start'));
    assert.ok(agentEvents.some((e) => e.event.type === 'text_delta' && e.event.delta.includes('RESULTS.md')));
    const finalEvt = agentEvents.find((e) => e.event.type === 'final');
    assert.ok(finalEvt, 'Background turn must broadcast final event on session.idle');
    assert.equal(
      finalEvt.event.delta,
      'Subagent finished: all 3 CSVs passed QC. Updated `RESULTS.md`.'
    );
    assert.equal(finalEvt.event.tokens.totalTokens, 300);

    // Verify the completed background turn was auto-persisted to .bionic/sessions/
    const persisted = getSession(bionicSessionId);
    assert.ok(persisted);
    assert.equal(persisted.messages.length, 3);
    assert.equal(
      persisted.messages[2].content,
      'Subagent finished: all 3 CSVs passed QC. Updated `RESULTS.md`.'
    );
    assert.equal(persisted.tokens.totalTokens, 450);

    // Verify syncSession reconciles persisted session + subagents
    const synced = await bridge.syncSession(bionicSessionId);
    assert.ok(synced.session && synced.session.messages.length === 3);
    assert.equal(synced.subagents.length, 1);
    assert.equal(synced.subagents[0].status, 'completed');

    // Verify OpenCode V2 Session.Message.Assistant.Tool formatting (state.input & state.content)
    const formatted = bridge.formatOpenCodeMessages([
      {
        type: 'assistant',
        content: [
          {
            type: 'tool',
            name: 'read',
            state: {
              status: 'completed',
              input: { path: 'PLAN.md' },
              content: [{ type: 'text', text: '# Research Question' }]
            }
          },
          { type: 'text', text: 'All checks passed.' }
        ]
      }
    ]);
    assert.equal(formatted.length, 1);
    assert.equal(formatted[0].tools[0].title, 'read PLAN.md');
    assert.equal(formatted[0].tools[0].output, '# Research Question');
    assert.equal(formatted[0].text, 'All checks passed.');
  });

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
