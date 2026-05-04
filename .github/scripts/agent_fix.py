#!/usr/bin/env python3
# ABOUTME: Minimal ReAct agent that fixes CI failures using the Seren Gateway (OpenAI-compatible).
# ABOUTME: Reads issue context from env, loops over tool calls until done, then opens a PR.

import json
import os
import subprocess
import sys

import httpx
from openai import OpenAI

SEREN_API_KEY = os.environ["SEREN_API_KEY"]
ISSUE_NUMBER = os.environ["ISSUE_NUMBER"]
ISSUE_TITLE = os.environ["ISSUE_TITLE"]
ISSUE_BODY = os.environ["ISSUE_BODY"]
MODEL = os.environ.get("AGENT_MODEL", "anthropic/claude-sonnet-4-6")
MAX_TURNS = int(os.environ.get("MAX_TURNS", "40"))

# Guard: only run on CI-failure issues, not feature requests or other issue types.
# The issue title is set by ci.yml as "CI failure: <job> on main".
if not ISSUE_TITLE.startswith("CI failure:"):
    print(f"Issue #{ISSUE_NUMBER} is not a CI failure (\"{ISSUE_TITLE}\"). Skipping.")
    sys.exit(0)

GATEWAY_BASE = "https://api.serendb.com/publishers/seren-models"

client = OpenAI(
    api_key=SEREN_API_KEY,
    base_url=f"{GATEWAY_BASE}/",
    http_client=httpx.Client(event_hooks={
        "response": [lambda r: print(f"[http] {r.status_code} {r.url}", file=sys.stderr)],
    }),
)

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "bash",
            "description": "Run a shell command and return stdout+stderr. Working directory is the repo root.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "The shell command to run."},
                    "timeout": {"type": "integer", "description": "Timeout in seconds (default 120).", "default": 120},
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read the contents of a file.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Path relative to repo root."},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Write (overwrite) a file with new contents.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Path relative to repo root."},
                    "content": {"type": "string", "description": "New file contents."},
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "done",
            "description": "Signal that the task is complete. Call this when the PR is open and the issue is commented.",
            "parameters": {
                "type": "object",
                "properties": {
                    "summary": {"type": "string", "description": "One-sentence summary of what was fixed."},
                },
                "required": ["summary"],
            },
        },
    },
]

SYSTEM = f"""You are a senior software engineer fixing a CI failure in the seren-desktop repo.
You have shell access (bash tool) to the full repo and can read/write files.

Rules (from CLAUDE.md):
- Find the ROOT CAUSE. Never fix symptoms or add workarounds.
- Make the smallest reasonable change.
- Never skip pre-commit hooks (never use --no-verify).
- All new branches must follow the pattern: fix/issue-{{number}}.
- Commit subject (first line) MUST be a Conventional Commit ≤72 chars
  (CI enforces via scripts/check-commit-msg.sh, see #1778). Put any
  implementation detail, file paths, line numbers, and rationale in the
  commit body — separated from the subject by a blank line. Do NOT bundle
  multi-paragraph summaries into the subject line.
- Commit body must end with:
  Taariq Lewis, SerenAI, Paloma, and Volume at https://serendb.com
  Email: hello@serendb.com

Your task:
1. Understand the CI failure from the issue below.
2. Reproduce it locally with the relevant test/lint command.
3. Find and fix the root cause.
4. Create branch fix/issue-{ISSUE_NUMBER}, commit, push.
5. Open a PR that closes issue #{ISSUE_NUMBER}.
6. Comment on issue #{ISSUE_NUMBER} with the PR URL.
7. Call the done() tool.

Issue #{ISSUE_NUMBER}: {ISSUE_TITLE}
{ISSUE_BODY}
"""


def run_tool(name: str, args: dict) -> str:
    if name == "bash":
        timeout = args.get("timeout", 120)
        result = subprocess.run(
            args["command"],
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        output = result.stdout + result.stderr
        return output[:8000] if len(output) > 8000 else output

    if name == "read_file":
        path = args["path"]
        try:
            with open(path) as f:
                content = f.read()
            return content[:8000] if len(content) > 8000 else content
        except Exception as e:
            return f"Error reading {path}: {e}"

    if name == "write_file":
        path = args["path"]
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w") as f:
            f.write(args["content"])
        return f"Wrote {path}"

    if name == "done":
        print(f"Agent complete: {args['summary']}")
        sys.exit(0)

    return f"Unknown tool: {name}"


def main():
    messages = [{"role": "system", "content": SYSTEM}]
    messages.append({"role": "user", "content": "Please fix the CI failure described above."})

    for turn in range(MAX_TURNS):
        response = client.chat.completions.create(
            model=MODEL,
            messages=messages,
            tools=TOOLS,
            tool_choice="auto",
        )

        if not response.choices:
            print(f"[error] Empty choices in response. Full response: {response.model_dump_json()}", file=sys.stderr)
            sys.exit(1)

        choice = response.choices[0]
        messages.append(choice.message.model_dump(exclude_unset=False))

        if choice.finish_reason == "stop" or not choice.message.tool_calls:
            print("Agent stopped without calling done(). Exiting.")
            break

        for tc in choice.message.tool_calls:
            args = json.loads(tc.function.arguments)
            print(f"[tool] {tc.function.name}({json.dumps(args)[:120]})")
            result = run_tool(tc.function.name, args)
            print(f"[result] {result[:300]}")
            messages.append({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": result,
            })

    print(f"Reached max turns ({MAX_TURNS}) without completion.")
    sys.exit(1)


if __name__ == "__main__":
    main()
