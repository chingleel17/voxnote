import asyncio
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

import app


def client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app.app),
        base_url="http://testserver",
    )


def fake_result(audio_path: Path, language, diarize, min_speakers, max_speakers, callback=None):
    if callback:
        callback(33)
        callback(66)
        callback(100)
    return [app.TranscriptSegment(0.0, 1.0, "測試結果", "A" if diarize else None)]


class TestTranscriptionApi(unittest.TestCase):
    def setUp(self):
        app.tasks.clear()

    def tearDown(self):
        app.tasks.clear()

    def run_async(self, coroutine):
        return asyncio.run(coroutine)

    def test_async_task_lifecycle_and_result(self):
        async def scenario():
            async with client() as http:
                response = await http.post(
                    "/v1/audio/transcriptions",
                    files={"file": ("test.wav", b"audio", "audio/wav")},
                    data={"diarize": "true"},
                )
                assert response.status_code == 200
                created = response.json()
                assert created["status"] == "queued"
                assert created["progress"] == 0

                status = await http.get(f"/v1/tasks/{created['task_id']}")
                assert status.status_code == 200
                payload = status.json()
                assert payload["status"] == "done"
                assert payload["progress"] == 100
                assert payload["result"]["segments"][0]["speaker"] == "A"

        with patch.object(app.transcriber, "transcribe", fake_result):
            self.run_async(scenario())


    def test_sync_mode_returns_result_without_task(self):
        async def scenario():
            async with client() as http:
                response = await http.post(
                    "/v1/audio/transcriptions",
                    files={"file": ("test.wav", b"audio", "audio/wav")},
                    data={"sync": "true"},
                )
                assert response.status_code == 200
                assert response.json()["text"] == "測試結果"
                assert app.tasks == {}

        with patch.object(app.transcriber, "transcribe", fake_result):
            self.run_async(scenario())


    def test_failed_task_and_missing_task(self):
        def fail(*args, **kwargs):
            raise RuntimeError("模型不存在")

        async def scenario():
            async with client() as http:
                response = await http.post(
                    "/v1/audio/transcriptions",
                    files={"file": ("test.wav", b"audio", "audio/wav")},
                )
                task_id = response.json()["task_id"]
                status = await http.get(f"/v1/tasks/{task_id}")
                assert status.json()["status"] == "failed"
                assert "模型不存在" in status.json()["error"]

                missing = await http.get("/v1/tasks/not-found")
                assert missing.status_code == 404

        with patch.object(app.transcriber, "transcribe", fail):
            self.run_async(scenario())


    def test_tasks_are_processed_serially(self):
        active = 0
        maximum = 0

        def serialized(*args, **kwargs):
            nonlocal active, maximum
            active += 1
            maximum = max(maximum, active)
            active -= 1
            return [app.TranscriptSegment(0.0, 1.0, "完成")]

        async def scenario():
            async with client() as http:
                first, second = await asyncio.gather(
                    http.post(
                        "/v1/audio/transcriptions",
                        files={"file": ("one.wav", b"audio", "audio/wav")},
                    ),
                    http.post(
                        "/v1/audio/transcriptions",
                        files={"file": ("two.wav", b"audio", "audio/wav")},
                    ),
                )
                assert first.status_code == second.status_code == 200
                assert maximum == 1

        with patch.object(app.transcriber, "transcribe", serialized):
            self.run_async(scenario())
