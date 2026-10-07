# 🤖 Agent Chat Interface Frameworks: Evaluation & Implementation Plan

**Branch:** `feat/agent-chat-frameworks`  
**Date:** October 2026  
**Audience:** Bionic Editor Core Architecture Review

---

## 1. Executive Summary

As Bionic Editor expands, the AI chat interface needs more production-grade capabilities without adding excessive engineering maintenance:
1. **Stopping Work**: Instantly interrupting LLM generation and killing active background processes (`python` / `bash` execution).
2. **Saving & Reviewing Past Chats**: Multi-thread session management, thread history sidebar, searching past analyses, and persisting chat logs alongside project data.
3. **Coding Harness Transparency**: Interleaved reasoning/plan cards, unabridged command outputs, error traces, and token usage accounting.
4. **Architectural Constraints**: Must run inside our existing React frontend, match the clean Bear aesthetic, and multiplex cleanly over our **single exposed port**.

We evaluated open-source React agent chat frameworks to determine whether to adopt an off-the-shelf library or supercharge our existing custom architecture.

---

## 2. Framework Comparison Matrix

| Framework | Architecture Type | Stop / Abort Work | Session / Thread History | Coding Harness Tool Cards | Single-Port IDE Fit | Styling & Ergonomics | Recommendation |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **assistant-ui** (`@assistant-ui/react`) | Modular UI Component Library (Headless + Radix) | ✅ Native `<ThreadPrimitive.Cancel />` | ✅ Built-in `ThreadList` & session drawer | ✅ Excellent via `makeAssistantToolUI` & reasoning primitives | ⭐⭐⭐⭐⭐ Ideal embedded component | Highly customizable (Tailwind / shadcn style) | **Top Framework Pick** |
| **Vercel AI SDK** (`ai` / `@ai-sdk/react`) | Headless Hooks Primitive (`useChat`) | ✅ Built-in `stop()` method | ⚠️ Headless only (requires custom UI for thread list) | ✅ Flexible tool invocation state | ⭐⭐⭐⭐⭐ Seamless | 100% custom UI control | **Strong Foundation** |
| **CopilotKit** (`@copilotkit/react-ui`) | Embedded Copilot Sidebar | ⚠️ Limited direct abort control | ⚠️ Basic thread support | ⚠️ Geared for app UI actions, not terminal harnesses | ⭐⭐⭐ Good, but opinionated | Heavily branded; clashes with Bear theme | Not Recommended |
| **LibreChat / Chatbot UI** | Standalone Full-Stack Web App | ✅ Full support | ✅ Full multi-user DB history | ⚠️ Standalone chat, not an embedded IDE harness | ❌ Incompatible (requires separate DB & Docker ports) | ChatGPT replica UI | Not Recommended (Wrong paradigm) |
| **Current Custom Harness** | Lightweight In-House React + SSE/WS | 🔄 Straightforward to add (`AbortController`) | 🔄 Straightforward to add (JSON sessions) | ✅ Already purpose-built for scientific tools | ⭐⭐⭐⭐⭐ Native, 0 extra deps | Perfect match with Bear design | **Strong Lightweight Alternative** |

---

## 3. Deep Dive into Top Candidates

### Option 1: `assistant-ui` (`@assistant-ui/react`)
`assistant-ui` is currently the leading open-source component library built specifically for complex AI agent interfaces in React.

#### Strengths:
- **Built for Agents, not just Chatbots**: First-class support for tool execution cards, reasoning streams, and multi-turn loops.
- **Built-in Session Management**: Provides `<ThreadList />` and thread storage adapters out of the box, letting users create new conversations, switch between previous analysis sessions, and rename threads.
- **Native Cancellation**: Integrates directly with `AbortController` via `<ThreadPrimitive.Cancel />` to halt token streaming and notify the server.
- **Runtime Agnostic**: Works with custom REST/SSE backends, Vercel AI SDK, or LangGraph.
- **Radix UI & Tailwind Foundations**: Matches our exact styling stack without enforcing rigid stylesheets.

#### Trade-offs:
- Adds dependencies (`@assistant-ui/react`, `@radix-ui/*`).
- Requires mapping our server tool events to `assistant-ui`'s tool state lifecycle.

---

### Option 2: Supercharged Custom Architecture (Targeted Feature Addition)
Our existing custom agent harness is already ~80% tailored to the requirements (interleaved chronological plans, real bash/python cards, full stack traces, token tracker, and single-port SSE).

#### Strengths:
- **Zero Framework Lock-in**: Zero external chat library bloat or breaking API changes.
- **Total Aesthetic Consistency**: Guaranteed to match the Bear minimalism and science-first UX.
- **Low Effort for Desired Features**:
  - **Stopping Work**: Requires a client-side `AbortController.abort()` + a backend `POST /api/agent/cancel` endpoint to kill spawned child processes (spawning `proc.kill('SIGTERM')`).
  - **Reviewing Past Chats**: Persisting sessions as `workspace/.bionic/sessions/{id}.json` files so chat histories travel with the scientific project and can be committed to Git alongside `SPEC.md`.

---

## 4. Proposed Solution: The Two Pathways

We propose two viable paths for your review:

### Pathway A: Adopt `assistant-ui`
Migrate the right-hand panel to `@assistant-ui/react` with customized tool primitives.

- **Frontend**:
  - Install `@assistant-ui/react`.
  - Use `<Thread />` with custom `<AssistantMessage.Tool />` mapping for our bash/python cards.
  - Implement `<ThreadList />` in a collapsible drawer at the top of the agent panel for session switching.
- **Backend**:
  - Add `POST /api/agent/abort` to terminate child processes when the user clicks Stop.
  - Add session storage endpoints:
    - `GET /api/agent/sessions` (list saved chats)
    - `GET /api/agent/sessions/:id` (load chat)
    - `POST /api/agent/sessions` (save/update chat)
    - `DELETE /api/agent/sessions/:id` (delete chat)

### Pathway B: Enhance Current Lightweight Harness (Recommended for Speed & Control)
Retain our bespoke, clean React panel and directly implement the missing power features:

1. **Stop / Cancel Button**:
   - Add a red **Stop Generating (■)** button in the chat input whenever `isStreaming === true`.
   - Client calls `abortController.abort()` to close the SSE stream and pings `/api/agent/cancel` with the current request ID.
   - Server immediately kills any running Python/Bash child processes in `.venv` and emits an *"Execution cancelled by user"* card.

2. **Project-Backed Session Manager**:
   - Store sessions as clean JSON files inside `workspace/.bionic/chats/{timestamp}_{slug}.json`:
     ```json
     {
       "id": "deg_analysis_2026_10_07",
       "title": "Differential Expression & Volcano Plot",
       "createdAt": 1728300000000,
       "messages": [...],
       "tokens": { "totalTokens": 4520, "estimatedCostUsd": 0.012 }
     }
     ```
   - **Session Drawer / History Dropdown**: A small history icon next to the Settings gear that slides out a session list:
     - "New Analysis Chat (+)"
     - "Recent Sessions" with timestamps, token counts, and delete actions.
   - Scientists can commit their `.bionic/chats/` to Git, ensuring their analysis conversation history is **auditable and reproducible** alongside their data and `SPEC.md`.

3. **Session Export to Markdown**:
   - One-click button to export the conversation as an auditable scientific report (`REPORT.md`).

---

## 5. Implementation Roadmap (Phased)

### Phase 1: Stopping Work & Process Cancellation
- [ ] Connect client `AbortController` to chat stream.
- [ ] Add active execution tracking on backend (`activeProcessMap` keyed by session ID).
- [ ] Add `POST /api/agent/cancel` endpoint that sends `SIGTERM` / `SIGKILL` to running shell commands.
- [ ] Update UI with a red **Stop** button and status tag (*"Cancelled by user"*).

### Phase 2: Project-Backed Chat Session Storage
- [ ] Implement backend `/api/agent/sessions` CRUD endpoints saving to `workspace/.bionic/chats/`.
- [ ] Add "New Chat" button and a Session History drawer in `AgentPanel.tsx`.
- [ ] Persist active session ID and auto-save after each turn.
- [ ] Add session switching with instant message hydration.

### Phase 3: Framework Integration Decision
- **If Pathway A**: Replace `AgentPanel.tsx` internals with `@assistant-ui/react` primitives.
- **If Pathway B**: Polish custom session cards, search filter for past chats, and Markdown export.

---

## 6. Feedback & Decision Needed

Before writing code on `feat/agent-chat-frameworks`, please review and let us know:
1. Do you prefer **Pathway A (`assistant-ui`)** for third-party ecosystem features, or **Pathway B (Supercharged Custom)** to keep zero dependencies and direct control over the Bear aesthetic?
2. Should chat histories be saved in the local browser (`localStorage`) or committed to the project filesystem (`workspace/.bionic/chats/`) so other researchers can inspect them?
