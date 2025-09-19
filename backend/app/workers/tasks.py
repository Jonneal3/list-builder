from __future__ import annotations

import json
import time
from typing import List

from ..workers.celery_app import celery_app, redis_pub


def _publish(job_id: str, payload: dict) -> None:
    channel = f"jobs:{job_id}"
    redis_pub.publish(channel, json.dumps(payload))


@celery_app.task(name="tasks.run_search")
def run_search(job_id: str, industry: str, directories: List[str], angles: List[str]) -> None:
    # naive streaming placeholder: send planned pairs first, then done
    count = 0
    for d in directories[:50]:
        for a in angles[:10]:
            _publish(job_id, {"type": "plan", "directory": d, "angle": a})
            count += 1
            if count % 10 == 0:
                time.sleep(0.1)
    _publish(job_id, {"type": "done"})
