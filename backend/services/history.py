"""
Per-session conversation history.
Keeps last N turns verbatim; older turns compressed to a running summary.
"""

import asyncio
import os
from collections import deque
from typing import Optional

_sessions: dict[str, dict] = {}


def get_session(session_id: str) -> dict:
    if session_id not in _sessions:
        _sessions[session_id] = {"turns": deque(), "summary": ""}
    return _sessions[session_id]


def add_turn(session_id: str, role: str, content: str) -> None:
    s = get_session(session_id)
    s["turns"].append({"role": role, "content": content})


def get_messages(
    session_id: str,
    system_prompt: str,
    verbatim_n: int = 5,
    rag_context: Optional[str] = None,
) -> list[dict]:
    s = get_session(session_id)
    turns = list(s["turns"])

    system = system_prompt
    if rag_context:
        system += f"\n\n--- Retrieved context ---\n{rag_context}\n--- End context ---"

    messages = [{"role": "system", "content": system}]

    if s["summary"] and len(turns) > verbatim_n:
        messages.append({
            "role": "user",
            "content": f"[Earlier conversation summary: {s['summary']}]",
        })
        messages.append({"role": "assistant", "content": "Understood."})

    verbatim = turns[-verbatim_n:] if verbatim_n > 0 else []
    messages.extend(verbatim)
    return messages


async def maybe_compress(session_id: str, verbatim_n: int, api_key: Optional[str] = None) -> None:
    """Drop the oldest turn out of verbatim window into the summary."""
    s = get_session(session_id)
    turns = s["turns"]
    if len(turns) <= verbatim_n:
        return

    # Collect turns that will be dropped
    to_drop = list(turns)[: len(turns) - verbatim_n]
    if not to_drop:
        return

    drop_text = "\n".join(f"{t['role'].upper()}: {t['content']}" for t in to_drop)

    try:
        import openai
        key = api_key or os.environ.get("OPENAI_API_KEY", "")
        client = openai.AsyncOpenAI(api_key=key)
        resp = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{
                "role": "user",
                "content": (
                    f"Summarize this conversation fragment in 1-2 sentences, "
                    f"preserving key facts (products mentioned, cart state, questions asked):\n\n{drop_text}"
                ),
            }],
            max_tokens=120,
        )
        new_summary = resp.choices[0].message.content.strip()
        s["summary"] = (s["summary"] + " " + new_summary).strip() if s["summary"] else new_summary
    except Exception as e:
        print(f"History compression failed: {e}")

    # Remove dropped turns from deque
    for _ in range(len(to_drop)):
        if turns:
            turns.popleft()


def clear_session(session_id: str) -> None:
    _sessions.pop(session_id, None)
