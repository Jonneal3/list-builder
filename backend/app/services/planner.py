from __future__ import annotations

import json
from typing import List

import httpx
from pydantic import BaseModel


class Plan(BaseModel):
    directories: List[str]
    angles: List[str]


OLLAMA_URL = "http://localhost:11434/api/chat"
MODEL = "llama3.1:8b"


async def _ollama_chat(messages: list[dict], timeout: float = 12.0) -> str:
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(
            OLLAMA_URL,
            json={
                "model": MODEL,
                "messages": messages,
                "stream": False,
                "options": {"temperature": 0.2},
            },
        )
        resp.raise_for_status()
        data = resp.json()
        return data.get("message", {}).get("content", "")


def _parse_json_array(text: str) -> list[str]:
    start = text.find("[")
    end = text.rfind("]")
    if start == -1 or end == -1 or end <= start:
        return []
    arr = json.loads(text[start : end + 1])
    return [x.strip() for x in arr if isinstance(x, str) and x.strip()]


async def ai_generate_plan(industry: str) -> Plan:
    dirs_prompt = [
        {
            "role": "system",
            "content": "Return 25 US business directory domains relevant to the user industry. Output ONLY a JSON array of domains, e.g., [\"yellowpages.com\", \"manta.com\"].",
        },
        {"role": "user", "content": f"Industry: {industry}"},
    ]
    dir_text = await _ollama_chat(dirs_prompt)
    directories = _parse_json_array(dir_text)[:50]

    angles_prompt = [
        {
            "role": "system",
            "content": "Return 8 concise search angles to discover companies for the industry. Output ONLY a JSON array of short phrases.",
        },
        {"role": "user", "content": f"Industry: {industry}"},
    ]
    ang_text = await _ollama_chat(angles_prompt)
    angles = _parse_json_array(ang_text)[:10]

    return Plan(directories=directories, angles=angles)
