"""VoxNote 本地 Breeze ASR 服務。"""

import logging
import os
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from opencc import OpenCC

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("voxnote.asr")

app = FastAPI(title="VoxNote Local ASR", version="0.1.0")
opencc = OpenCC("s2twp")


@dataclass
class TranscriptSegment:
    """供 app 端格式化的單一逐字稿片段。"""

    start: float
    end: float
    text: str
    speaker: str | None = None


def _speaker_code(index: int) -> str:
    """將語者序號轉為講者代號：0->A、25->Z、26->AA，超過 26 位仍可正確標示。"""
    code = ""
    index += 1
    while index > 0:
        index, remainder = divmod(index - 1, 26)
        code = chr(ord("A") + remainder) + code
    return code


class WhisperXTranscriber:
    """封裝 WhisperX 轉錄流程，ASR 模型可透過環境變數指定。

    採惰性載入：首次呼叫 transcribe 時才載入模型，避免服務啟動即佔用 VRAM。
    ASR 模型可為任何 CTranslate2 格式的 Whisper 系模型（原版 Whisper、Breeze
    或其他 fine-tune），預設為台灣用語最佳的 Breeze-ASR-26。
    模型與執行參數皆可透過環境變數調整，以因應不同 VRAM 的 GPU。
    """

    def __init__(self) -> None:
        # 轉錄模型（faster-whisper / CTranslate2 後端）
        self._asr_model: Any | None = None
        # 詞級對齊模型與其 metadata（依語言載入，故以字典快取）
        self._align_cache: dict[str, tuple[Any, Any]] = {}
        # pyannote 語者分離 pipeline（啟用 diarize 時才載入）
        self._diarize_pipeline: Any | None = None

        # ASR 模型：CTranslate2 模型目錄、HF repo 名稱，或 WhisperX 內建模型代號
        # （如 large-v3）。ASR_MODEL 為主，BREEZE_MODEL_DIR 為向後相容別名。
        self._model_dir = (
            os.getenv("ASR_MODEL")
            or os.getenv("BREEZE_MODEL_DIR")
            or "MediaTek-Research/Breeze-ASR-26"
        )
        # 語者分離模型。採 community-1：語者計數與指派優於 3.1，於中文會議語料
        # （AliMeeting、AISHELL-4）改善尤為明顯，且僅需接受單一授權；3.1 另需
        # 額外接受相依的 pyannote/segmentation-3.0 授權。
        # 組織名為 pyannote-community；WhisperX 內建預設指向受限的 pyannote/ 鏡像，
        # 故明確指定以免 403。
        self._diarization_model = os.getenv(
            "DIARIZATION_MODEL", "pyannote-community/speaker-diarization-community-1"
        )
        self._device = os.getenv("ASR_DEVICE", "cuda")
        # VRAM 較小建議 int8 或 int8_float16；較充裕可用 float16
        self._compute_type = os.getenv("ASR_COMPUTE_TYPE", "int8")
        self._batch_size = int(os.getenv("ASR_BATCH_SIZE", "8"))

    def _ensure_asr_model(self) -> Any:
        """惰性載入 ASR 轉錄模型（依 ASR_MODEL 設定）。"""
        if self._asr_model is None:
            import whisperx

            self._asr_model = whisperx.load_model(
                self._model_dir,
                device=self._device,
                compute_type=self._compute_type,
            )
        return self._asr_model

    def _ensure_align_model(self, language_code: str) -> tuple[Any, Any]:
        """依語言惰性載入並快取詞級對齊模型。"""
        if language_code not in self._align_cache:
            import whisperx

            align_model, metadata = whisperx.load_align_model(
                language_code=language_code,
                device=self._device,
            )
            self._align_cache[language_code] = (align_model, metadata)
        return self._align_cache[language_code]

    def _ensure_diarize_pipeline(self) -> Any:
        """惰性載入 pyannote 3.1 語者分離 pipeline（需 HF token 同意授權）。"""
        if self._diarize_pipeline is None:
            # DiarizationPipeline 僅存在於 whisperx.diarize 子模組，未於頂層匯出
            from whisperx.diarize import DiarizationPipeline

            hf_token = read_hf_token()
            if not hf_token:
                raise RuntimeError(
                    "啟用語者分離需要 Hugging Face token：請設定 HF_TOKEN 或 "
                    f"HF_TOKEN_FILE，並先於 HF 網站同意 {self._diarization_model} 的授權條款"
                )
            self._diarize_pipeline = DiarizationPipeline(
                model_name=self._diarization_model,
                token=hf_token,
                device=self._device,
            )
        return self._diarize_pipeline

    def transcribe(
        self,
        audio_path: Path,
        language: str | None,
        diarize: bool,
        min_speakers: int | None,
        max_speakers: int | None,
    ) -> list[TranscriptSegment]:
        """執行轉錄、詞級對齊及可選的語者分離。"""
        import whisperx

        try:
            asr_model = self._ensure_asr_model()
        except Exception as error:
            # 對應 design 的 fallback 策略：CTranslate2 載入失敗時的明確提示
            raise RuntimeError(
                f"ASR 模型載入失敗（請確認 ASR_MODEL 指向有效的 CTranslate2 權重 "
                f"或 WhisperX 內建模型代號；自訂 fine-tune 需先轉為 CTranslate2）：{error}"
            ) from error

        audio = whisperx.load_audio(str(audio_path))

        # 1. 轉錄
        result = asr_model.transcribe(
            audio,
            batch_size=self._batch_size,
            language=language,
        )
        detected_language = result.get("language", language or "zh")

        # 2. 詞級強制對齊
        try:
            align_model, metadata = self._ensure_align_model(detected_language)
            result = whisperx.align(
                result["segments"],
                align_model,
                metadata,
                audio,
                self._device,
                return_char_alignments=False,
            )
        except Exception:
            # 對齊失敗不應中斷整體轉錄，退回未對齊的分段結果；但須留下記錄，
            # 因為缺少詞級時間戳會使後續語者分離無法正確指派
            logger.warning("詞級對齊失敗，將以未對齊的分段結果繼續", exc_info=True)
            aligned = False
        else:
            aligned = True

        if diarize and not aligned:
            logger.warning("詞級對齊未完成，語者分離結果可能不完整")

        # 3. 可選的語者分離
        if diarize:
            diarize_pipeline = self._ensure_diarize_pipeline()
            diarize_kwargs: dict[str, int] = {}
            if min_speakers:
                diarize_kwargs["min_speakers"] = min_speakers
            if max_speakers:
                diarize_kwargs["max_speakers"] = max_speakers
            diarize_segments = diarize_pipeline(audio, **diarize_kwargs)
            result = whisperx.assign_word_speakers(diarize_segments, result)

        return self._to_segments(result.get("segments", []))

    @staticmethod
    def _to_segments(raw_segments: list[dict[str, Any]]) -> list[TranscriptSegment]:
        """將 WhisperX segments 轉為 TranscriptSegment，語者標籤正規化為講者 A、B、C。"""
        speaker_map: dict[str, str] = {}
        segments: list[TranscriptSegment] = []
        for raw in raw_segments:
            text = str(raw.get("text", "")).strip()
            if not text:
                continue
            speaker_label: str | None = None
            raw_speaker = raw.get("speaker")
            if raw_speaker:
                # pyannote 輸出如 SPEAKER_00，正規化為由 A 起算的講者代號
                if raw_speaker not in speaker_map:
                    speaker_map[raw_speaker] = _speaker_code(len(speaker_map))
                speaker_label = speaker_map[raw_speaker]
            segments.append(
                TranscriptSegment(
                    start=float(raw.get("start", 0.0)),
                    end=float(raw.get("end", 0.0)),
                    text=text,
                    speaker=speaker_label,
                )
            )
        return segments


transcriber = WhisperXTranscriber()


def read_hf_token() -> str | None:
    """讀取 Docker 掛載的 Hugging Face token，避免將機密寫入映像檔。"""
    token = os.getenv("HF_TOKEN")
    if token:
        return token

    token_file = os.getenv("HF_TOKEN_FILE")
    if token_file and Path(token_file).is_file():
        return Path(token_file).read_text(encoding="utf-8").strip() or None
    return None


def normalize_segment(segment: TranscriptSegment, diarize: bool) -> dict[str, object]:
    """將文字轉為繁體中文台灣用語並輸出穩定 API 格式。"""
    result: dict[str, object] = {
        "start": segment.start,
        "end": segment.end,
        "text": opencc.convert(segment.text).strip(),
    }
    if diarize and segment.speaker:
        result["speaker"] = segment.speaker
    return result


@app.get("/health")
async def health() -> dict[str, str]:
    """提供 app 設定頁與維運監控使用的健康檢查。"""
    return {"status": "ok", "service": "voxnote-local-asr"}


@app.post("/v1/audio/transcriptions")
async def create_transcription(
    file: Annotated[UploadFile, File()],
    language: Annotated[str | None, Form()] = None,
    diarize: Annotated[bool, Form()] = False,
    min_speakers: Annotated[int | None, Form()] = None,
    max_speakers: Annotated[int | None, Form()] = None,
) -> dict[str, object]:
    """以 OpenAI 相容 multipart 契約接收音訊並回傳逐字稿與片段。"""
    if min_speakers is not None and min_speakers < 1:
        raise HTTPException(status_code=422, detail="min_speakers 必須大於 0")
    if max_speakers is not None and max_speakers < 1:
        raise HTTPException(status_code=422, detail="max_speakers 必須大於 0")
    if min_speakers and max_speakers and min_speakers > max_speakers:
        raise HTTPException(status_code=422, detail="min_speakers 不可大於 max_speakers")

    upload_dir = Path(os.getenv("UPLOAD_DIR", tempfile.gettempdir())) / "voxnote-asr"
    upload_dir.mkdir(parents=True, exist_ok=True)
    # 以唯一檔名保存，避免同名錄音的並行請求互相覆寫或誤刪；保留原副檔名供 ffmpeg 判斷格式
    suffix = Path(file.filename or "audio.wav").suffix or ".wav"
    audio_path = upload_dir / f"{uuid.uuid4().hex}{suffix}"

    try:
        audio_path.write_bytes(await file.read())
        segments = await run_in_threadpool(
            transcriber.transcribe,
            audio_path,
            language if language and language != "auto" else None,
            diarize,
            min_speakers,
            max_speakers,
        )
    except RuntimeError as error:
        # 設定或環境問題（模型載入失敗、缺少 token 等），記錄後回報 503
        logger.error("轉錄前置條件不符：%s", error, exc_info=True)
        raise HTTPException(status_code=503, detail=str(error)) from error
    except Exception as error:
        # 未預期錯誤須記錄完整 traceback，否則僅憑 HTTP 回應無法診斷
        logger.exception("轉錄失敗")
        raise HTTPException(status_code=500, detail=f"轉錄失敗：{error}") from error
    finally:
        await file.close()
        audio_path.unlink(missing_ok=True)

    normalized_segments = [normalize_segment(segment, diarize) for segment in segments]
    return {
        "text": "\n".join(str(segment["text"]) for segment in normalized_segments),
        "segments": normalized_segments,
        "language": language or "auto",
        "diarization_enabled": diarize,
    }
