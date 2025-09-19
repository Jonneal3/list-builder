from __future__ import annotations

import os
import redis  # sync client for Celery publisher
import redis.asyncio as redis_async  # async client for SSE subscriber
from celery import Celery

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")

celery_app = Celery(
    "ai_explorer",
    broker=REDIS_URL,
    backend=REDIS_URL,
)

# Sync for publisher (Celery tasks)
redis_pub = redis.from_url(REDIS_URL)

# Async for subscriber (FastAPI SSE)
redis_sub = redis_async.from_url(REDIS_URL)
