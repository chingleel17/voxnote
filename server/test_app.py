import asyncio
import os
import sys
import time
import unittest
from pathlib import Path
from types import ModuleType
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
    segments = [app.TranscriptSegment(0.0, 1.0, "測試結果", "A" if diarize else None)]
    embeddings = {"A": [0.1, 0.2, 0.3]} if diarize else {}
    return segments, embeddings, True


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


    def test_diarize_response_includes_embeddings_and_model(self):
        async def scenario():
            async with client() as http:
                response = await http.post(
                    "/v1/audio/transcriptions",
                    files={"file": ("test.wav", b"audio", "audio/wav")},
                    data={"sync": "true", "diarize": "true"},
                )
                assert response.status_code == 200
                payload = response.json()
                assert payload["speaker_embeddings"] == {"A": [0.1, 0.2, 0.3]}
                assert payload["diarization_model"] == app.transcriber.diarization_model
                assert payload["diarization_degraded"] is False

        with patch.object(app.transcriber, "transcribe", fake_result):
            self.run_async(scenario())

    def test_embedding_keys_match_segment_speaker_labels(self):
        async def scenario():
            async with client() as http:
                response = await http.post(
                    "/v1/audio/transcriptions",
                    files={"file": ("test.wav", b"audio", "audio/wav")},
                    data={"sync": "true", "diarize": "true"},
                )
                payload = response.json()
                segment_speakers = {segment["speaker"] for segment in payload["segments"]}
                assert set(payload["speaker_embeddings"].keys()) == segment_speakers

        with patch.object(app.transcriber, "transcribe", fake_result):
            self.run_async(scenario())

    def test_non_diarized_response_omits_embeddings(self):
        async def scenario():
            async with client() as http:
                response = await http.post(
                    "/v1/audio/transcriptions",
                    files={"file": ("test.wav", b"audio", "audio/wav")},
                    data={"sync": "true"},
                )
                payload = response.json()
                assert "speaker_embeddings" not in payload
                assert "diarization_model" not in payload
                assert payload["diarization_degraded"] is False

        with patch.object(app.transcriber, "transcribe", fake_result):
            self.run_async(scenario())

    def test_sync_and_async_responses_include_the_same_diarization_quality(self):
        def degraded_result(audio_path, language, diarize, min_speakers, max_speakers, callback=None):
            return [app.TranscriptSegment(0.0, 1.0, "測試結果", "A")], {}, False

        async def scenario():
            app.transcription_lock = asyncio.Lock()
            async with client() as http:
                sync_response = await http.post(
                    "/v1/audio/transcriptions",
                    files={"file": ("sync.wav", b"audio", "audio/wav")},
                    data={"sync": "true", "diarize": "true"},
                )
                async_response = await http.post(
                    "/v1/audio/transcriptions",
                    files={"file": ("async.wav", b"audio", "audio/wav")},
                    data={"diarize": "true"},
                )

                assert sync_response.json()["diarization_degraded"] is True
                task_id = async_response.json()["task_id"]
                status = await http.get(f"/v1/tasks/{task_id}")
                assert status.json()["result"]["diarization_degraded"] is True

        with patch.object(app.transcriber, "transcribe", degraded_result):
            self.run_async(scenario())

    def test_alignment_failure_continues_transcription_and_marks_degraded(self):
        class FakeAsrModel:
            def transcribe(self, audio, batch_size, language):
                return {
                    "language": "zh",
                    "segments": [{"start": 0.0, "end": 1.0, "text": "測試結果"}],
                }

        class FakeDiarizePipeline:
            def __call__(self, audio, return_embeddings=False, **kwargs):
                segments = [{"start": 0.0, "end": 1.0, "speaker": "SPEAKER_00"}]
                return (segments, {}) if return_embeddings else segments

        whisperx = ModuleType("whisperx")
        whisperx.align = lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("alignment failed"))
        whisperx.assign_word_speakers = lambda diarize_segments, result: {
            **result,
            "segments": [{**result["segments"][0], "speaker": diarize_segments[0]["speaker"]}],
        }

        transcriber = app.WhisperXTranscriber()
        transcriber._asr_model = FakeAsrModel()
        transcriber._align_cache["zh"] = (object(), object())
        transcriber._diarize_pipeline = FakeDiarizePipeline()

        with patch.dict(sys.modules, {"whisperx": whisperx}), patch.object(
            app, "load_audio_preprocessed", return_value=object()
        ):
            segments, _, alignment_complete = transcriber.transcribe(
                Path("test.wav"), "zh", True, None, None
            )

        assert segments[0].text == "測試結果"
        assert segments[0].speaker == "A"
        assert alignment_complete is False

    def test_embedding_extraction_failure_does_not_break_transcription(self):
        def result_without_embeddings(audio_path, language, diarize, min_speakers, max_speakers, callback=None):
            segments = [app.TranscriptSegment(0.0, 1.0, "測試結果", "A" if diarize else None)]
            return segments, {}, True

        async def scenario():
            async with client() as http:
                response = await http.post(
                    "/v1/audio/transcriptions",
                    files={"file": ("test.wav", b"audio", "audio/wav")},
                    data={"sync": "true", "diarize": "true"},
                )
                assert response.status_code == 200
                payload = response.json()
                assert payload["text"] == "測試結果"
                assert "speaker_embeddings" not in payload

        with patch.object(app.transcriber, "transcribe", result_without_embeddings):
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
            return [app.TranscriptSegment(0.0, 1.0, "完成")], {}, True

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

    def test_sync_requests_are_processed_serially(self):
        active = 0
        maximum = 0

        def serialized(*args, **kwargs):
            nonlocal active, maximum
            active += 1
            maximum = max(maximum, active)
            time.sleep(0.02)
            active -= 1
            return [app.TranscriptSegment(0.0, 1.0, "完成")], {}, True

        async def scenario():
            async with client() as http:
                first, second = await asyncio.gather(
                    http.post(
                        "/v1/audio/transcriptions",
                        files={"file": ("one.wav", b"audio", "audio/wav")},
                        data={"sync": "true"},
                    ),
                    http.post(
                        "/v1/audio/transcriptions",
                        files={"file": ("two.wav", b"audio", "audio/wav")},
                        data={"sync": "true"},
                    ),
                )
                assert first.status_code == second.status_code == 200
                assert maximum == 1

        with patch.object(app.transcriber, "transcribe", serialized):
            self.run_async(scenario())

    def test_incremental_endpoint_returns_plain_text_without_task(self):
        def incremental(audio, language):
            assert language == "en"
            return "we are testing"

        async def scenario():
            async with client() as http:
                response = await http.post(
                    "/v1/audio/transcriptions/incremental",
                    files={"file": ("test.wav", b"audio", "audio/wav")},
                    data={"language": "en"},
                )
                assert response.status_code == 200
                assert response.json() == {"text": "we are testing", "language": "en"}
                assert app.tasks == {}

        with patch.object(app, "load_audio_preprocessed", return_value=object()), patch.object(
            app.incremental_transcriber, "transcribe", incremental
        ):
            self.run_async(scenario())

    def test_incremental_endpoint_reports_unavailable_model(self):
        async def scenario():
            async with client() as http:
                response = await http.post(
                    "/v1/audio/transcriptions/incremental",
                    files={"file": ("test.wav", b"audio", "audio/wav")},
                )
                assert response.status_code == 503
                assert "模型" in response.json()["detail"]

        with patch.object(app, "load_audio_preprocessed", return_value=object()), patch.object(
            app.incremental_transcriber,
            "transcribe",
            side_effect=RuntimeError("模型未載入"),
        ):
            self.run_async(scenario())


class TestToSegments(unittest.TestCase):
    """`_to_segments` 的字級講者切分行為（tasks.md 第 2 節）。"""

    def test_word_reconstruction_does_not_insert_spaces_between_chinese_characters(self):
        raw = {
            "start": 0.0,
            "end": 0.6,
            "text": "大家好",
            "words": [
                {"word": "大", "start": 0.0, "end": 0.2, "speaker": "SPEAKER_00"},
                {"word": "家", "start": 0.2, "end": 0.4, "speaker": "SPEAKER_01"},
                {"word": "好", "start": 0.4, "end": 0.6, "speaker": "SPEAKER_01"},
            ],
        }
        segments, _ = app.WhisperXTranscriber._to_segments([raw])
        assert [s.text for s in segments] == ["大", "家好"]

    def test_word_reconstruction_does_not_space_out_english_acronyms(self):
        # WhisperX 在中文語境下常將英文縮寫拆成單一字母的字詞（如 D、E、B、U、G）
        raw = {
            "start": 0.0,
            "end": 1.0,
            "text": "他們在測DEBUG的",
            "words": [
                {"word": "他", "start": 0.0, "end": 0.1, "speaker": "SPEAKER_00"},
                {"word": "們", "start": 0.1, "end": 0.2, "speaker": "SPEAKER_00"},
                {"word": "在", "start": 0.2, "end": 0.3, "speaker": "SPEAKER_00"},
                {"word": "測", "start": 0.3, "end": 0.4, "speaker": "SPEAKER_00"},
                {"word": "D", "start": 0.4, "end": 0.5, "speaker": "SPEAKER_00"},
                {"word": "E", "start": 0.5, "end": 0.6, "speaker": "SPEAKER_00"},
                {"word": "B", "start": 0.6, "end": 0.7, "speaker": "SPEAKER_00"},
                {"word": "U", "start": 0.7, "end": 0.8, "speaker": "SPEAKER_00"},
                {"word": "G", "start": 0.8, "end": 0.9, "speaker": "SPEAKER_00"},
                {"word": "的", "start": 0.9, "end": 1.0, "speaker": "SPEAKER_00"},
            ],
        }
        segments, _ = app.WhisperXTranscriber._to_segments([raw])
        assert len(segments) == 1
        assert segments[0].text == "他們在測DEBUG的"

    def test_word_reconstruction_spaces_separate_english_words(self):
        raw = {
            "start": 0.0,
            "end": 1.0,
            "text": "hello world",
            "words": [
                {"word": "hello", "start": 0.0, "end": 0.4, "speaker": "SPEAKER_00"},
                {"word": "world", "start": 0.4, "end": 0.8, "speaker": "SPEAKER_00"},
            ],
        }
        segments, _ = app.WhisperXTranscriber._to_segments([raw])
        assert len(segments) == 1
        assert segments[0].text == "hello world"

    def test_speaker_change_within_segment_splits_into_multiple_segments(self):
        raw = {
            "start": 0.0,
            "end": 1.2,
            "text": "你好嗎我很好",
            "speaker": "SPEAKER_00",
            "words": [
                {"word": "你", "start": 0.0, "end": 0.2, "speaker": "SPEAKER_00"},
                {"word": "好", "start": 0.2, "end": 0.4, "speaker": "SPEAKER_00"},
                {"word": "嗎", "start": 0.4, "end": 0.6, "speaker": "SPEAKER_00"},
                {"word": "我", "start": 0.6, "end": 0.8, "speaker": "SPEAKER_01"},
                {"word": "很", "start": 0.8, "end": 1.0, "speaker": "SPEAKER_01"},
                {"word": "好", "start": 1.0, "end": 1.2, "speaker": "SPEAKER_01"},
            ],
        }
        segments, _ = app.WhisperXTranscriber._to_segments([raw])
        assert len(segments) == 2
        assert segments[0].speaker == "A"
        assert segments[1].speaker == "B"

    def test_consistent_speaker_does_not_split(self):
        raw = {
            "start": 0.0,
            "end": 0.6,
            "text": "大家好",
            "speaker": "SPEAKER_00",
            "words": [
                {"word": "大", "start": 0.0, "end": 0.2, "speaker": "SPEAKER_00"},
                {"word": "家", "start": 0.2, "end": 0.4, "speaker": "SPEAKER_00"},
                {"word": "好", "start": 0.4, "end": 0.6, "speaker": "SPEAKER_00"},
            ],
        }
        segments, _ = app.WhisperXTranscriber._to_segments([raw])
        assert len(segments) == 1
        assert segments[0].text == "大家好"
        assert segments[0].speaker == "A"

    def test_split_segments_use_word_level_timestamps(self):
        raw = {
            "start": 0.0,
            "end": 1.2,
            "text": "你好嗎我很好",
            "words": [
                {"word": "你", "start": 0.0, "end": 0.2, "speaker": "SPEAKER_00"},
                {"word": "好", "start": 0.2, "end": 0.4, "speaker": "SPEAKER_00"},
                {"word": "嗎", "start": 0.4, "end": 0.6, "speaker": "SPEAKER_00"},
                {"word": "我", "start": 0.6, "end": 0.8, "speaker": "SPEAKER_01"},
                {"word": "很", "start": 0.8, "end": 1.0, "speaker": "SPEAKER_01"},
                {"word": "好", "start": 1.0, "end": 1.2, "speaker": "SPEAKER_01"},
            ],
        }
        segments, _ = app.WhisperXTranscriber._to_segments([raw])
        assert segments[0].start == 0.0
        assert segments[0].end == 0.6
        assert segments[1].start == 0.6
        assert segments[1].end == 1.2

    def test_missing_mid_word_speaker_carries_previous_label(self):
        raw = {
            "start": 0.0,
            "end": 0.6,
            "text": "ABC",
            "words": [
                {"word": "A", "start": 0.0, "end": 0.2, "speaker": "SPEAKER_00"},
                {"word": "B", "start": 0.2, "end": 0.4},
                {"word": "C", "start": 0.4, "end": 0.6, "speaker": "SPEAKER_00"},
            ],
        }
        segments, _ = app.WhisperXTranscriber._to_segments([raw])
        assert len(segments) == 1
        assert segments[0].speaker == "A"
        assert segments[0].text == "ABC"

    def test_missing_first_word_speaker_does_not_break(self):
        raw = {
            "start": 0.0,
            "end": 0.4,
            "text": "AB",
            "words": [
                {"word": "A", "start": 0.0, "end": 0.2},
                {"word": "B", "start": 0.2, "end": 0.4, "speaker": "SPEAKER_00"},
            ],
        }
        segments, _ = app.WhisperXTranscriber._to_segments([raw])
        assert len(segments) == 1
        assert segments[0].speaker == "A"

    def test_missing_words_falls_back_to_segment_level_speaker(self):
        raw = {"start": 0.0, "end": 1.0, "text": "hello", "speaker": "SPEAKER_00"}
        segments, _ = app.WhisperXTranscriber._to_segments([raw])
        assert len(segments) == 1
        assert segments[0].speaker == "A"
        assert segments[0].text == "hello"

    def test_diarization_disabled_yields_no_speaker(self):
        raw = {"start": 0.0, "end": 1.0, "text": "hello"}
        segments, _ = app.WhisperXTranscriber._to_segments([raw])
        assert len(segments) == 1
        assert segments[0].speaker is None

    def test_split_is_deterministic(self):
        raw = {
            "start": 0.0,
            "end": 1.2,
            "text": "你好嗎我很好",
            "words": [
                {"word": "你", "start": 0.0, "end": 0.2, "speaker": "SPEAKER_00"},
                {"word": "好", "start": 0.2, "end": 0.4, "speaker": "SPEAKER_00"},
                {"word": "嗎", "start": 0.4, "end": 0.6, "speaker": "SPEAKER_00"},
                {"word": "我", "start": 0.6, "end": 0.8, "speaker": "SPEAKER_01"},
                {"word": "很", "start": 0.8, "end": 1.0, "speaker": "SPEAKER_01"},
                {"word": "好", "start": 1.0, "end": 1.2, "speaker": "SPEAKER_01"},
            ],
        }
        first = app.WhisperXTranscriber._to_segments([raw])
        second = app.WhisperXTranscriber._to_segments([raw])
        assert first == second


class TestMapEmbeddingsToLabels(unittest.TestCase):
    """`_map_embeddings_to_labels` 的講者代號對應行為（tasks.md 第 1 節）。"""

    def test_maps_raw_speaker_ids_to_normalized_labels(self):
        raw_embeddings = {"SPEAKER_00": [0.1, 0.2], "SPEAKER_01": [0.3, 0.4]}
        speaker_map = {"SPEAKER_00": "A", "SPEAKER_01": "B"}
        result = app._map_embeddings_to_labels(raw_embeddings, speaker_map)
        assert result == {"A": [0.1, 0.2], "B": [0.3, 0.4]}

    def test_drops_speakers_absent_from_speaker_map(self):
        # SPEAKER_02 從未被指派到任何字，speaker_map 中無對應代號
        raw_embeddings = {"SPEAKER_00": [0.1], "SPEAKER_02": [0.9]}
        speaker_map = {"SPEAKER_00": "A"}
        result = app._map_embeddings_to_labels(raw_embeddings, speaker_map)
        assert result == {"A": [0.1]}

    def test_none_embeddings_returns_empty_dict(self):
        assert app._map_embeddings_to_labels(None, {"SPEAKER_00": "A"}) == {}


class StubPyannotePipeline:
    """模擬 pyannote pipeline 的 `parameters`/`instantiate` 契約，供不依賴 whisperx 的測試。"""

    def __init__(self, params):
        self._params = params
        self.instantiated_with = None

    def parameters(self, instantiated=True):
        return self._params

    def instantiate(self, params):
        self.instantiated_with = params


class TestClusteringThreshold(unittest.TestCase):
    """分群門檻可設定與參數保留行為（tasks.md 第 4 節）。"""

    def test_unset_threshold_keeps_model_default(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("DIARIZATION_CLUSTERING_THRESHOLD", None)
            transcriber = app.WhisperXTranscriber()
        assert transcriber._clustering_threshold is None

    def test_env_var_threshold_is_parsed_into_transcriber(self):
        with patch.dict(os.environ, {"DIARIZATION_CLUSTERING_THRESHOLD": "0.65"}):
            transcriber = app.WhisperXTranscriber()
        assert transcriber._clustering_threshold == 0.65

    def test_configured_threshold_is_applied(self):
        pipeline = StubPyannotePipeline(
            {"clustering": {"threshold": 0.7, "method": "centroid"}}
        )
        applied = app._apply_clustering_threshold(pipeline, 0.9)
        assert applied is True
        assert pipeline.instantiated_with["clustering"]["threshold"] == 0.9

    def test_override_preserves_other_existing_parameters(self):
        pipeline = StubPyannotePipeline(
            {
                "clustering": {"threshold": 0.7, "method": "centroid"},
                "segmentation": {"min_duration_off": 0.5},
            }
        )
        app._apply_clustering_threshold(pipeline, 0.9)
        assert pipeline.instantiated_with["clustering"]["method"] == "centroid"
        assert pipeline.instantiated_with["segmentation"]["min_duration_off"] == 0.5

    def test_internal_structure_access_failure_degrades_safely(self):
        class BrokenPipeline:
            def parameters(self, instantiated=True):
                raise AttributeError("self.model 不存在")

        applied = app._apply_clustering_threshold(BrokenPipeline(), 0.9)
        assert applied is False

    def test_missing_clustering_key_degrades_safely(self):
        pipeline = StubPyannotePipeline({"segmentation": {"min_duration_off": 0.5}})
        applied = app._apply_clustering_threshold(pipeline, 0.9)
        assert applied is False
