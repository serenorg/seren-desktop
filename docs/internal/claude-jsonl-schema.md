# Claude Code JSONL Schema (Internal Reference)

**Captured against bundled CLI version `2.1.118` on 2026-04-27.**
This is internal reference for `buildSyntheticTranscript` and the
schema-drift gate. The CLI's transcript format is undocumented and may
change on auto-update. Re-capture after every CLI bump.

## File location

```
<claudeProjectsRoot()>/<encodeProjectDirName(cwd)>/<sessionId>.jsonl
```

- `claudeProjectsRoot()` resolves to `~/.claude/projects`.
- `encodeProjectDirName(cwd)` converts `/Users/x/p` → `-Users-x-p`.
- One JSONL file per session, named `<uuid>.jsonl`.
- No `/sessions/` subdir.

Reference: `bin/browser-local/claude-runtime.mjs:199-208,278-316`.

## Per-line record types

Every line is a JSON object with a top-level `type` field. Observed types:

| `type` | Purpose | Has `uuid` | Has `parentUuid` | Has per-line `sessionId` |
|---|---|---|---|---|
| `user` | user message turn | yes | yes (nullable on first) | yes |
| `assistant` | assistant message turn | yes | yes | yes |
| `attachment` | image/file/deferred-tool delta | no | yes | no (inferred via parent) |
| `file-history-snapshot` | working-tree backup | no | no | no |
| `queue-operation` | queue enqueue/dequeue | no | no | yes |
| `ai-title` | derived chat title | no | no | yes |
| `last-prompt` | most-recent user prompt cache | no | no | yes |

Records `user`/`assistant` are the message turns that form the model's
visible conversation history. Other records are CLI bookkeeping.

## `user` record

```json
{
  "parentUuid": null | "<uuid>",
  "isSidechain": false,
  "promptId": "<uuid>",
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      { "type": "text", "text": "..." }
    ]
  },
  "uuid": "<uuid>",
  "timestamp": "2026-04-27T22:29:20.762Z",
  "permissionMode": "auto" | "plan" | "default" | ...,
  "userType": "external",
  "entrypoint": "claude-vscode" | "claude-code" | ...,
  "cwd": "/abs/path",
  "sessionId": "<uuid>",
  "version": "2.1.118",
  "gitBranch": "main"
}
```

`message.content` may also contain `tool_result` blocks (from a prior
`tool_use`):

```json
{ "tool_use_id": "<id>", "type": "tool_result", "content": "...", "is_error": false }
```

In that case the record additionally carries a top-level `toolUseResult`
mirror with `stdout`/`stderr`/etc.

## `assistant` record

```json
{
  "parentUuid": "<uuid>",
  "isSidechain": false,
  "message": {
    "model": "claude-opus-4-7",
    "id": "msg_<id>",
    "type": "message",
    "role": "assistant",
    "content": [
      { "type": "thinking", "thinking": "...", "signature": "..." },
      { "type": "text", "text": "..." },
      { "type": "tool_use", "id": "toolu_<id>", "name": "Bash", "input": {...}, "caller": {"type":"direct"} }
    ],
    "stop_reason": "tool_use" | "end_turn" | ...,
    "stop_sequence": null,
    "stop_details": null,
    "usage": { ... }
  },
  "requestId": "req_<id>",
  "type": "assistant",
  "uuid": "<uuid>",
  "timestamp": "...",
  "userType": "external",
  "entrypoint": "...",
  "cwd": "...",
  "sessionId": "<uuid>",
  "version": "2.1.118",
  "gitBranch": "main"
}
```

## `attachment` record

```json
{
  "parentUuid": "<uuid>",
  "isSidechain": false,
  "attachment": {
    "type": "deferred_tools_delta" | "image" | "file" | ...,
    "addedNames": [...],
    "addedLines": [...]
  }
}
```

Has no top-level `sessionId` field on the records observed. Chained off
the parent message via `parentUuid`.

## `queue-operation`, `ai-title`, `last-prompt`

Bookkeeping records keyed by `sessionId`. Format is small and stable.
The CLI tolerates their absence (sessions resumed without these fields
still initialize). The synthetic builder MAY drop them.

## `file-history-snapshot`

```json
{
  "type": "file-history-snapshot",
  "messageId": "<uuid>",
  "snapshot": { "messageId": "<uuid>", "trackedFileBackups": {}, "timestamp": "..." },
  "isSnapshotUpdate": false
}
```

Tied to a message via `messageId`. Synthetic builder MAY drop these for
preserved tail turns since the working tree state isn't replayed.

## parentUuid chain (load-bearing)

`user` and `assistant` records form a linked list via `parentUuid`:

```
T0 (user, parentUuid=null) → T0.uuid
T1 (assistant, parentUuid=T0.uuid) → T1.uuid
T2 (user, parentUuid=T1.uuid) → T2.uuid
...
```

Tool-use turns are interleaved as additional assistant→user pairs:

```
A (assistant, content=[tool_use]) → A.uuid
B (user, content=[tool_result], parentUuid=A.uuid) → B.uuid
C (assistant, content=[text], parentUuid=B.uuid) → C.uuid
```

A "turn pair" in the synthetic-builder sense therefore is **not a fixed
2-record window** — a single user-visible exchange may include many
tool_use/tool_result intermediates. The builder slices on user-message
boundaries (last N user-keyed exchanges including all tool intermediates
between them).

## Splice safety requirements (Codex P1)

When constructing a synthetic transcript by concatenating `[summary user,
summary assistant, ...tail]`:

1. Every retained record's `sessionId` field MUST be rewritten to the
   new synthetic session UUID. Bookkeeping records (`queue-operation`,
   `ai-title`, `last-prompt`) carry `sessionId`; if preserved they must
   also be rewritten.
2. The first retained `user`/`assistant` record's `parentUuid` MUST be
   rewritten to point at the synthetic-ack assistant record's `uuid`,
   replacing whatever the parent originally pointed at.
3. UUIDs of retained records SHOULD be preserved. Inner `parentUuid`
   chain inside the retained tail is preserved verbatim.
4. The synthetic summary user record sets `parentUuid: null` (root).
5. The synthetic summary assistant record sets `parentUuid` to the
   summary user's `uuid`.

## Constraint references

- stream-json input only accepts `type: "user"` per
  [claude-runtime.mjs:1611-1618]. Cannot inject `assistant` turns over
  stdin — must place them on disk before `--resume`.
- `--resume <id>` is wired in `buildClaudeArgs` at
  [claude-runtime.mjs:651-661]. Applied once at spawn.
- `findSessionJsonlPath` resolves files at
  [claude-runtime.mjs:278-316].

## Re-read semantics (open question, deferred)

It is **not verified** whether the running CLI re-reads the JSONL
between turns. Until proven, post-init mutation of the on-disk file is
unsafe (placeholder-summary trick is OUT per design doc v2 §4.6). A
follow-up spike may test this; if positive, we can layer on the
placeholder-summary latency optimization without touching the synthetic
builder itself.
