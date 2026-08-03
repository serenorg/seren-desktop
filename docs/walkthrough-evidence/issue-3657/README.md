# Issue 3657 live walkthrough

Date: 2026-08-03

Platform: macOS native Tauri validation app

State: isolated local project, signed out. Seren authentication is not required for LM Studio.

## Failure audit

The private support log recorded an LM Studio HTTP 400 while converting MCP tool schemas with local JSON Schema references. The pre-fix adapter copied `properties`, `required`, and `additionalProperties`, but discarded the matching `$defs`, leaving those references unresolved.

The original server response could not be replayed against the currently installed LM Studio build: its present converter accepted both the old reduced schema and the corrected schema in a direct probe. The broken code path and request shape were therefore protected with a focused request-builder regression test rather than presenting a simulated “before” walkthrough.

The audit also found that starting any local agent while signed out opened Seren's sign-in flow. That made local LM Studio incorrectly depend on Seren authentication and is fixed in the same branch.

## Fixed walkthrough

1. Launch the native validation app with isolated app data and no Seren session.
2. Open **+ New** and choose **LM Studio**. No sign-in dialog appears.
3. Open the agent model picker and compare every rendered option with `lms ls --llm --json` from the installed LM Studio CLI.
4. Send a real local chat prompt through LM Studio's OpenAI-compatible endpoint.
5. Confirm the assistant completes the requested marker with no sign-in prompt, schema-conversion error, or runtime error.

## Scrubbed native evidence

The captures retain only the app state needed for review. Private paths, account data, tokens, control metadata, and screenshot metadata are excluded.

The provider launcher is open while the title bar still shows **Sign In**:

![Signed-out provider launcher](./01-signed-out-provider-launcher.png)

All five installed chat models appear in the same order as the live LM Studio CLI inventory:

![Complete live LM Studio model menu](./02-live-model-menu.png)

The real local assistant response completes while the app remains signed out:

![Signed-out LM Studio response](./03-signed-out-response.png)

## Completeness result

- Five of five downloaded chat models were rendered in exact CLI order.
- No extra model option was rendered.
- The installed embedding model was excluded from this chat-model picker.
- The first live chat model remained selected for the walkthrough request.
- The assistant returned `LMSTUDIO_SCHEMA_OK_3657` without showing the prior schema-conversion error.
- Seren sign-in was never requested.

Machine-readable results are recorded in [verification.json](./verification.json).

## Network path

The signed-out changed path has no Seren publisher slug or third-party cloud API call. Model discovery invokes the installed `lms` CLI, and inference goes to LM Studio's local OpenAI-compatible `POST /v1/chat/completions` endpoint on loopback. Optional signed-in MCP tools are discovered dynamically; no provider, publisher, permission, tool, or model list is hardcoded by this change.
