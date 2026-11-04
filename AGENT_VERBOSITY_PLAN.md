# Agent Verbosity & Latency Optimization Plan

This document analyzes why Bionic Editor's AI Agent currently takes significantly longer than interacting with OpenCode directly, why it re-reads files on every interaction, and outlines technical options to achieve equivalent speed and efficiency.

---

## 1. Executive Summary & Root Cause Analysis

When interacting with Bionic Editor's AI agent across multiple chat turns, users observe two distinct latency issues:
1. **Re-reading files every turn**: The agent repeatedly calls `read_file` or `list_files` on files it already examined in previous turns.
2. **Prolonged turn execution time**: Tasks that take seconds in OpenCode take 30–60+ seconds in Bionic Editor.

### Why does the agent read in all files again every time?

#### Root Cause 1: Conversation History Stripping of Tool Results Across Turns
In `client/src/App.tsx`, when a user sends a follow-up prompt, messages are sent to `/api/agent/chat` as:
```typescript
const apiMessages = [...messages, userMsg].map(m => ({
  role: m.role,
  content: m.content
}));
```
Inside `server/services/agent.ts`, during a single turn, the model invokes tools (`read_file`, `run_python`, etc.) and receives tool outputs. However:
- Only the **final assistant text summary** (`event.delta` / `finalText`) is preserved in the client's `messages` state.
- The actual **`tool_calls`** and the **`tool` results containing the file contents** are completely omitted from the multi-turn chat history.
- Consequently, on Turn 2, the LLM receives only:
  - User Turn 1: *"Examine the gene expression data"*
  - Assistant Turn 1: *"I inspected data/raw/gene_expression_sample.csv and computed log2 fold changes..."*
  - User Turn 2: *"Now add a volcano plot script"*
- The LLM has **zero file content in its context window** on Turn 2. To write or modify the script, it has no choice but to issue `read_file('src/analyze.py')` and `read_file('data/raw/gene_expression_sample.csv')` all over again from scratch.

#### Root Cause 2: Ingestion of Entire Files (Absence of Slicing, Grep, or Glob)
- In OpenCode, tools are surgical:
  - `grep`: Searches for exact regex/string patterns across files without reading whole files into context.
  - `glob`: Rapidly finds file paths matching patterns (`**/*.py`).
  - `read`: Accepts `offset` and `limit` to inspect specific lines or headers.
- In Bionic Editor, the only tool provided is `read_file(path)`. If a CSV dataset has 10,000 rows or a script is 500 lines, Bionic Editor dumps the entire file into the conversation context. This inflates prompt token size, increases network payload, and causes LLM prefill latency to skyrocket.

#### Root Cause 3: Full-File Rewriting (`write_file`) vs. Targeted Replacement (`edit`)
- In Bionic Editor, the agent only has `write_file(path, content)`.
- Even to change a single parameter or fix a one-line typo in `src/analyze.py` or `SPEC.md`, the model must regenerate the entire 200–500 line document from scratch.
- At typical LLM completion generation speeds (50–90 tokens/sec), generating 2,000 tokens takes 20–40 seconds of pure output generation time per turn.
- OpenCode uses `edit(path, oldString, newString)`, generating only 10–30 tokens to apply a patch in less than 1 second.

#### Root Cause 4: Strictly Sequential Tool Execution
In `server/services/agent.ts`:
```typescript
for (const tc of choice.message.tool_calls) {
  const result = await executeToolDetailed(fnName, fnArgs, config.sessionId);
  conversation.push({ role: 'tool', tool_call_id: tc.id, content: result.output });
}
```
If the model issues 3 tool calls in a turn (e.g., reading 3 files), Bionic Editor executes them sequentially one after another with network/filesystem waits in between. OpenCode executes independent tool calls concurrently using `Promise.allSettled`.

#### Root Cause 5: Missing Prompt Caching / KV-Cache Hit Rate of 0%
Modern LLM APIs (Anthropic Claude 3.5 Sonnet, OpenAI GPT-4o, Google Gemini 2.5 Flash) feature prompt caching for identical prefix tokens. Because Bionic Editor flattens messages into plain text strings without stable message ID structures or cached tool responses, every request incurs full prompt token processing latency and higher API costs.

---

## 2. Technical Solution Options

### Option 1: Multi-Turn Tool History Persistence (Fastest & Immediate Win)
**Concept**: Store the complete tool calling history (`tool_calls` and `tool` responses) inside the active session so subsequent turns retain the context of files already read.

**Implementation**:
1. In `client/src/types.ts`, update `ChatMessage` to retain `toolCalls` and `toolResults`.
2. In `server/services/sessionManager.ts`, ensure `saveSession` and `getSession` persist these structures.
3. In `server/services/agent.ts`, reconstruct the conversation array containing both user/assistant messages and intermediate tool calls/results.
4. Add a lightweight token compaction step: if total conversation tokens exceed 60% of model context, compact older tool outputs into concise summaries.

- **Pros**: Immediately stops the model from re-reading files on follow-up turns; requires no tool schema redesign.
- **Cons**: Context window grows as turns increase; needs compaction for long sessions.

---

### Option 2: Targeted Surgical Tools (`grep`, `glob`, `read` slice, and `edit`) (Recommended)
**Concept**: Adopt the proven OpenCode tool design pattern inside Bionic Editor's tool schema.

**Implementation**:
1. Add `edit_file(path, old_text, new_text)`:
   - Finds unique occurrences of `old_text` and replaces with `new_text`.
   - Replaces 2,000-token full-file overwrites with 50-token patches.
2. Add `read_file_range(path, offset, limit)`:
   - Reads only the requested slice of a file (e.g. first 50 lines for CSV headers and structure).
3. Add `grep_search(pattern, path?, include?)`:
   - Rapid regex or literal pattern search across workspace files.
4. Keep `write_file` only for creating new files or complete replacements.

- **Pros**: Reduces turn execution latency by 70–85%; slashes token consumption and cost; prevents catastrophic file truncation bugs caused by full rewrites.
- **Cons**: Requires adding tool implementations to `server/services/workspace.ts` and updating `agent.ts` system prompt instructions.

---

### Option 3: Parallel Tool Execution & Streaming Events
**Concept**: Execute non-conflicting tool calls simultaneously within each turn.

**Implementation**:
1. When `choice.message.tool_calls` contains multiple read or query actions (e.g. `read_file`, `list_files`), execute them concurrently via:
   ```typescript
   await Promise.allSettled(
     choice.message.tool_calls.map(async (tc) => { ... })
   );
   ```
2. Stream tool execution progress events (`step_start`, `step_done`) to the client over SSE in real time as each promise settles.

- **Pros**: Cuts multi-file inspection latency in half; provides smoother UI feedback.
- **Cons**: Mutation tools (`write_file`, `run_python`) must maintain execution ordering if dependent on earlier reads.

---

### Option 4: Workspace File State Cache with FileWatcher Integration
**Concept**: Maintain an in-memory digest of workspace files synced via `server/services/fileWatcher.ts`.

**Implementation**:
1. The server maintains an in-memory cache of file metadata, key file outlines, and active editor files.
2. When the user sends a message, the server automatically injects a compact "Workspace Outline" (e.g. directory tree, column names of CSVs in `data/raw/`, and current `BASE_SPEC` headers) into the system prompt.
3. The LLM immediately knows the current state of the project without needing to call `list_files` or `read_file` just to discover file names and schema.

- **Pros**: Completely eliminates "orientation turns" where the model spends 1–2 turns just listing directory contents.
- **Cons**: Must ensure the outline remains concise (<500 tokens) so it does not crowd the context window.

---

## 3. Recommended Implementation Roadmap

1. **Phase 1 (Quick Win)**:
   - Update `client/src/App.tsx` and `server/services/agent.ts` to preserve tool calls and tool responses across turns in the active session.
   - Run parallel read tool calls via `Promise.allSettled`.
2. **Phase 2 (Speed & Token Reduction)**:
   - Introduce `edit_file` (find/replace) to replace full `write_file` calls for existing scripts.
   - Introduce `read_file_range` with offset/limit parameters.
3. **Phase 3 (Polished Experience)**:
   - Integrate `fileWatcher` cache for instant workspace awareness in system prompt.
   - Add prompt prefix caching headers for Gemini and Anthropic.
