"""
LLM provider adapters supporting streaming and batch modes.
All async generators yield str tokens; raise StopAsyncIteration when done.
"""

import os
import json
from typing import AsyncGenerator, Optional


def _key(env: str, override: Optional[str]) -> str:
    return override or os.environ.get(env, "")


LENGTH_TOKENS = {"low": 80, "medium": 300, "high": 900}

TOOL_SCHEMAS = {
    "get_cart_total": {
        "name": "get_cart_total",
        "description": "Return the total price of all items in the cart.",
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
    "add_to_cart": {
        "name": "add_to_cart",
        "description": "Add a product tier to the shopping cart.",
        "parameters": {
            "type": "object",
            "properties": {
                "product_name": {"type": "string", "description": "Exact product name, e.g. 'Nimbus CRM'"},
                "tier_name": {"type": "string", "description": "Tier name, e.g. 'Starter'"},
                "seats": {"type": "integer", "description": "Number of seats/users", "default": 1},
            },
            "required": ["product_name", "tier_name"],
        },
    },
    "remove_from_cart": {
        "name": "remove_from_cart",
        "description": "Remove an item from the cart by index (0-based).",
        "parameters": {
            "type": "object",
            "properties": {"index": {"type": "integer"}},
            "required": ["index"],
        },
    },
    "clear_cart": {
        "name": "clear_cart",
        "description": "Remove all items from the cart.",
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
    "checkout_item": {
        "name": "checkout_item",
        "description": "Checkout a single cart item by index.",
        "parameters": {
            "type": "object",
            "properties": {"index": {"type": "integer"}},
            "required": ["index"],
        },
    },
    "checkout_all": {
        "name": "checkout_all",
        "description": "Complete checkout for all cart items.",
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
    "get_pricing_annual": {
        "name": "get_pricing_annual",
        "description": "Get the annual price (monthly×12 billed annually) for a product tier.",
        "parameters": {
            "type": "object",
            "properties": {
                "product_name": {"type": "string"},
                "tier_name": {"type": "string"},
            },
            "required": ["product_name", "tier_name"],
        },
    },
    "calculate_savings": {
        "name": "calculate_savings",
        "description": "Calculate % savings when paying annually vs monthly for a product tier.",
        "parameters": {
            "type": "object",
            "properties": {
                "product_name": {"type": "string"},
                "tier_name": {"type": "string"},
            },
            "required": ["product_name", "tier_name"],
        },
    },
    "sort_products": {
        "name": "sort_products",
        "description": "List all products sorted by starting price.",
        "parameters": {
            "type": "object",
            "properties": {
                "order": {"type": "string", "enum": ["asc", "desc"], "default": "asc"}
            },
            "required": [],
        },
    },
    "get_top_k_expensive": {
        "name": "get_top_k_expensive",
        "description": "Get the k most expensive products by their highest tier price.",
        "parameters": {
            "type": "object",
            "properties": {"k": {"type": "integer", "default": 5}},
            "required": [],
        },
    },
    "get_cart_items": {
        "name": "get_cart_items",
        "description": "Return the current contents of the shopping cart.",
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
}


def _openai_tools(enabled: list[str]) -> list[dict]:
    return [
        {"type": "function", "function": TOOL_SCHEMAS[t]}
        for t in enabled
        if t in TOOL_SCHEMAS
    ]


async def stream_openai(
    messages: list[dict],
    model: str,
    max_tokens: int,
    tools_enabled: list[str],
    api_key: Optional[str],
    temperature: float = 0.7,
) -> AsyncGenerator[dict, None]:
    import openai
    client = openai.AsyncOpenAI(api_key=_key("OPENAI_API_KEY", api_key))
    tools = _openai_tools(tools_enabled)
    kwargs = dict(model=model, messages=messages, max_tokens=max_tokens, temperature=temperature, stream=True)
    if tools:
        kwargs["tools"] = tools
        kwargs["tool_choice"] = "auto"

    tool_calls_buf: dict[int, dict] = {}

    async with await client.chat.completions.create(**kwargs) as stream:
        async for chunk in stream:
            delta = chunk.choices[0].delta if chunk.choices else None
            if not delta:
                continue
            if delta.content:
                yield {"type": "token", "data": delta.content}
            if delta.tool_calls:
                for tc in delta.tool_calls:
                    idx = tc.index
                    if idx not in tool_calls_buf:
                        tool_calls_buf[idx] = {"id": tc.id or "", "name": "", "args": ""}
                    if tc.function.name:
                        tool_calls_buf[idx]["name"] += tc.function.name
                    if tc.function.arguments:
                        tool_calls_buf[idx]["args"] += tc.function.arguments

    for tc in tool_calls_buf.values():
        try:
            args = json.loads(tc["args"]) if tc["args"] else {}
        except Exception:
            args = {}
        yield {"type": "tool_call", "data": {"name": tc["name"], "args": args, "id": tc["id"]}}


async def stream_gemini(
    messages: list[dict],
    model: str,
    max_tokens: int,
    tools_enabled: list[str],
    api_key: Optional[str],
    temperature: float = 0.7,
) -> AsyncGenerator[dict, None]:
    import google.generativeai as genai
    genai.configure(api_key=_key("GOOGLE_API_KEY", api_key))

    system = next((m["content"] for m in messages if m["role"] == "system"), "")
    history = [
        {"role": "user" if m["role"] == "user" else "model", "parts": [m["content"]]}
        for m in messages
        if m["role"] in ("user", "assistant")
    ]
    user_msg = history.pop() if history and history[-1]["role"] == "user" else {"role": "user", "parts": [""]}

    gemini_model = genai.GenerativeModel(model, system_instruction=system)
    chat = gemini_model.start_chat(history=history[:-1] if history else [])
    response = await chat.send_message_async(
        user_msg["parts"][0],
        generation_config=genai.types.GenerationConfig(max_output_tokens=max_tokens, temperature=temperature),
        stream=True,
    )
    async for chunk in response:
        if chunk.text:
            yield {"type": "token", "data": chunk.text}


async def stream_anthropic(
    messages: list[dict],
    model: str,
    max_tokens: int,
    tools_enabled: list[str],
    api_key: Optional[str],
    temperature: float = 0.7,
) -> AsyncGenerator[dict, None]:
    import anthropic
    client = anthropic.AsyncAnthropic(api_key=_key("ANTHROPIC_API_KEY", api_key))

    system = next((m["content"] for m in messages if m["role"] == "system"), "")
    conv = [m for m in messages if m["role"] in ("user", "assistant")]

    anthropic_tools = [
        {
            "name": TOOL_SCHEMAS[t]["name"],
            "description": TOOL_SCHEMAS[t]["description"],
            "input_schema": TOOL_SCHEMAS[t]["parameters"],
        }
        for t in tools_enabled
        if t in TOOL_SCHEMAS
    ]

    kwargs = dict(model=model, max_tokens=max_tokens, system=system, messages=conv, temperature=temperature, stream=True)
    if anthropic_tools:
        kwargs["tools"] = anthropic_tools

    async with client.messages.stream(**kwargs) as stream:
        async for text in stream.text_stream:
            yield {"type": "token", "data": text}


def get_streamer(provider: str):
    return {"openai": stream_openai, "gemini": stream_gemini, "anthropic": stream_anthropic}.get(provider)
