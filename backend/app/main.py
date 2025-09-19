from __future__ import annotations

import asyncio
import json
import uuid
from typing import AsyncGenerator, List

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .services.planner import ai_generate_plan
from .workers.celery_app import celery_app, redis_sub

app = FastAPI(title="AI Industry Explorer API")
app.mount("/static", StaticFiles(directory="app/static"), name="static")


class PlanRequest(BaseModel):
    industry: str = Field(..., min_length=2)


class PlanResponse(BaseModel):
    directories: List[str]
    angles: List[str]


@app.post("/plan", response_model=PlanResponse)
async def create_plan(body: PlanRequest) -> PlanResponse:
    try:
        plan = await ai_generate_plan(body.industry)
    except httpx.HTTPError:
        raise HTTPException(status_code=503, detail="AI planner unavailable. Start Ollama.")
    if not plan.directories or not plan.angles:
        raise HTTPException(status_code=502, detail="Planner returned no results.")
    return PlanResponse(directories=plan.directories, angles=plan.angles)


class SearchStartRequest(BaseModel):
    industry: str
    directories: List[str]
    angles: List[str]


class SearchStartResponse(BaseModel):
    job_id: str


@app.post("/search/start", response_model=SearchStartResponse)
async def start_search(body: SearchStartRequest) -> SearchStartResponse:
    job_id = str(uuid.uuid4())
    celery_app.send_task(
        "tasks.run_search",
        kwargs={
            "job_id": job_id,
            "industry": body.industry,
            "directories": body.directories,
            "angles": body.angles,
        },
    )
    return SearchStartResponse(job_id=job_id)


async def _stream_events(job_id: str) -> AsyncGenerator[bytes, None]:
    channel = f"jobs:{job_id}"
    pubsub = redis_sub.pubsub()
    await pubsub.subscribe(channel)
    try:
        yield b"event: ping\n\n"
        while True:
            message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=5.0)
            if message and message.get("type") == "message":
                data = message.get("data")
                if isinstance(data, bytes):
                    data = data.decode("utf-8", errors="ignore")
                try:
                    payload = json.loads(data)
                except Exception:
                    payload = {"type": "log", "data": data}
                if payload.get("type") == "done":
                    yield b"event: done\n\n"
                    break
                else:
                    yield ("data: " + json.dumps(payload) + "\n\n").encode("utf-8")
            await asyncio.sleep(0.05)
    finally:
        await pubsub.unsubscribe(channel)
        await pubsub.aclose()


@app.get("/search/stream/{job_id}")
async def stream_search(job_id: str):
    return StreamingResponse(_stream_events(job_id), media_type="text/event-stream")


@app.get("/health")
async def health():
    return JSONResponse({"status": "ok"})


@app.get("/")
async def index():
    try:
        with open("app/static/index.html", "r", encoding="utf-8") as f:
            return HTMLResponse(f.read())
    except FileNotFoundError:
        return JSONResponse({"message": "UI not built"}, status_code=404)
