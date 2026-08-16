"""VoxNote 本地 Breeze ASR 服務。"""

import asyncio
import logging
import os
import subprocess
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Annotated, Any, Callable

import numpy as np
from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from opencc import OpenCC

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("voxnote.asr")

# WhisperX 內部固定以 16 kHz 單聲道處理音訊，前處理輸出必須與其一致
ASR_SAMPLE_RATE = 16000
# int16 轉 float32 的正規化係數，與 whisperx.load_audio 相同
INT16_MAX_ABS = 32768.0

app = FastAPI(title="VoxNote Local ASR", version="0.1.0")
opencc = OpenCC("s2twp")

TASK_RETENTION_SECONDS = 60 * 60
MAX_COMPLETED_TASKS = 1000


class TaskStatus(str, Enum):
    """轉錄任務的生命週期狀態。"""

    QUEUED = "queued"
    PROCESSING = "processing"
    DONE = "done"
    FAILED = "failed"


@dataclass
class TranscriptionTask:
    """記憶體中的轉錄任務狀態。"""

    status: TaskStatus = TaskStatus.QUEUED
    progress: int = 0
    result: dict[str, object] | None = None
    error: str | None = None
    created_at: float = 0.0
    completed_at: float | None = None


tasks: dict[str, TranscriptionTask] = {}
tasks_lock = threading.Lock()
transcription_lock = asyncio.Lock()


@dataclass
class TranscriptSegment:
    """供 app 端格式化的單一逐字稿片段。"""

    start: float
    end: float
    text: str
    speaker: str | None = None


def _cleanup_tasks_locked() -> None:
    """清除過期或超過上限的已完成任務；呼叫端必須持有 tasks_lock。"""
    now = time.time()
    expired_ids = [
        task_id
        for task_id, task in tasks.items()
        if task.status in (TaskStatus.DONE, TaskStatus.FAILED)
        and task.completed_at is not None
        and now - task.completed_at >= TASK_RETENTION_SECONDS
    ]
    for task_id in expired_ids:
        del tasks[task_id]

    completed_ids = [
        (task.completed_at or task.created_at, task_id)
        for task_id, task in tasks.items()
        if task.status in (TaskStatus.DONE, TaskStatus.FAILED)
    ]
    completed_ids.sort()
    for _, task_id in completed_ids[:-MAX_COMPLETED_TASKS]:
        del tasks[task_id]


def _task_response(task: TranscriptionTask) -> dict[str, object]:
    """將任務狀態轉成不暴露內部欄位的 API 回應。"""
    response: dict[str, object] = {
        "status": task.status.value,
        "progress": task.progress,
    }
    if task.result is not None:
        response["result"] = task.result
    if task.error is not None:
        response["error"] = task.error
    return response


def _update_task(
    task_id: str,
    *,
    status: TaskStatus | None = None,
    progress: int | None = None,
    result: dict[str, object] | None = None,
    error: str | None = None,
) -> None:
    """以執行緒安全方式更新任務狀態。"""
    with tasks_lock:
        task = tasks.get(task_id)
        if task is None:
            return
        if status is not None:
            task.status = status
        if progress is not None:
            task.progress = progress
        if result is not None:
            task.result = result
        if error is not None:
            task.error = error
        if task.status in (TaskStatus.DONE, TaskStatus.FAILED):
            task.completed_at = time.time()


def _validate_speaker_options(
    min_speakers: int | None,
    max_speakers: int | None,
) -> None:
    """驗證語者數量參數。"""
    if min_speakers is not None and min_speakers < 1:
        raise HTTPException(status_code=422, detail="min_speakers 必須大於 0")
    if max_speakers is not None and max_speakers < 1:
        raise HTTPException(status_code=422, detail="max_speakers 必須大於 0")
    if min_speakers and max_speakers and min_speakers > max_speakers:
        raise HTTPException(status_code=422, detail="min_speakers 不可大於 max_speakers")


def _build_audio_filters() -> str:
    """組出音訊前處理的 ffmpeg filter 字串；停用時回傳空字串。

    會議錄音（尤其是手機置於桌面收音）常見兩個問題：低頻的冷氣與桌面震動噪音，
    以及整體響度偏低使語音接近底噪。前者以高通濾波移除，後者以響度標準化拉高，
    可改善 VAD 的語音邊界判斷與語者分離的聲紋品質。
    """
    if os.getenv("AUDIO_PREPROCESS", "1") not in ("1", "true", "True"):
        return ""

    filters: list[str] = []

    highpass_hz = os.getenv("AUDIO_HIGHPASS_HZ", "80").strip()
    if highpass_hz and highpass_hz != "0":
        filters.append(f"highpass=f={highpass_hz}")

    # 響度標準化方式。實測含解碼的 60 分鐘音訊耗時，以及語音與靜音段的訊噪比
    # （SNR 越高代表語音相對底噪越清楚，直接影響語者分離的聲紋品質）：
    #
    #   方式                     耗時     SNR      語音提升
    #   原始（未處理）            1.4 秒   33.7 dB   —
    #   loudnorm                 35 秒    33.2 dB   +21.0 dB
    #   dynaudnorm f=250:m=20    2.3 秒   27.2 dB   +16.9 dB
    #
    # dynaudnorm 雖快得多，但逐段調整增益會在語音停頓處把底噪一併放大，實測損失
    # 約 6.5 dB SNR，與提升語者分離的目標相反，故預設採 loudnorm；長錄音若無法
    # 接受其耗時，可改設 dynaudnorm 或 none。
    normalizer = os.getenv("AUDIO_NORMALIZER", "loudnorm").strip().lower()
    if normalizer == "loudnorm":
        loudnorm_i = os.getenv("AUDIO_LOUDNORM_I", "-23").strip()
        loudnorm_tp = os.getenv("AUDIO_LOUDNORM_TP", "-2").strip()
        loudnorm_lra = os.getenv("AUDIO_LOUDNORM_LRA", "7").strip()
        filters.append(f"loudnorm=I={loudnorm_i}:TP={loudnorm_tp}:LRA={loudnorm_lra}")
    elif normalizer == "dynaudnorm":
        # f 為分析視窗長度（毫秒）、g 為高斯平滑視窗大小（非增益）、p 為峰值上限、
        # m 為最大放大倍率。視窗越窄、m 越大，靜音段的底噪被放大得越嚴重。
        frame = os.getenv("AUDIO_DYNAUDNORM_FRAME", "500").strip()
        gausssize = os.getenv("AUDIO_DYNAUDNORM_GAUSSSIZE", "31").strip()
        peak = os.getenv("AUDIO_DYNAUDNORM_PEAK", "0.9").strip()
        max_gain = os.getenv("AUDIO_DYNAUDNORM_MAXGAIN", "10").strip()
        filters.append(f"dynaudnorm=f={frame}:g={gausssize}:p={peak}:m={max_gain}")

    return ",".join(filters)


def load_audio_preprocessed(audio_path: Path) -> np.ndarray:
    """以 ffmpeg 解碼音訊並套用前處理，輸出與 whisperx.load_audio 相同的格式。

    WhisperX 本來就會呼叫 ffmpeg 解碼成 16 kHz 單聲道，此處只是在同一條命令上
    追加 filter，不額外增加 I/O；停用前處理時行為與 whisperx.load_audio 等價。
    """
    filters = _build_audio_filters()

    command = ["ffmpeg", "-nostdin", "-threads", "0", "-i", str(audio_path)]
    if filters:
        command += ["-af", filters]
    command += [
        "-f", "s16le",
        "-ac", "1",
        "-acodec", "pcm_s16le",
        "-ar", str(ASR_SAMPLE_RATE),
        "-",
    ]

    try:
        # stderr 導向 DEVNULL：ffmpeg 的進度輸出對長檔案可達數十 KB，
        # 以 PIPE 接收卻未同步讀取時，pipe 滿載會使 ffmpeg 阻塞
        result = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=True,
        )
    except FileNotFoundError as error:
        raise RuntimeError("找不到 ffmpeg，無法解碼音訊") from error
    except subprocess.CalledProcessError as error:
        raise RuntimeError(f"音訊解碼失敗（ffmpeg 結束碼 {error.returncode}）") from error

    if not result.stdout:
        raise RuntimeError("音訊解碼結果為空，請確認檔案格式是否正確")

    if filters:
        logger.info("音訊前處理已套用：%s", filters)

    return np.frombuffer(result.stdout, np.int16).astype(np.float32) / INT16_MAX_ABS


def _needs_space_boundary(left: str, right: str) -> bool:
    """判斷兩個相鄰字詞之間是否需要插入空白。

    WhisperX 中文斷詞為單一漢字，重組時不應插入空白；英文縮寫（如 NAS、DEBUG）在
    中文語境下也常被拆成單一字母的字詞（如 'D'、'E'、'B'...），故長度為 1 的字詞
    一律視為緊鄰、不加空白，無論其為漢字或單一英數字元。只有兩側皆為長度大於 1
    的英數字詞（真正的獨立英文單字，如 "OPS" 與 "電源" 之間、或兩個英文單字之間）
    才需要空白分隔，否則會黏成一串無法閱讀。
    """
    if not left or not right:
        return False
    if len(left) == 1 or len(right) == 1:
        return False
    return left[-1].isascii() and left[-1].isalnum() and right[0].isascii() and right[0].isalnum()


def _join_words(words: list[dict[str, Any]]) -> str:
    """將字級 `word` 欄位重組為分段文字，依相鄰字詞的語言特性決定是否插入空白。"""
    tokens = [str(word.get("word", "")).strip() for word in words]
    tokens = [token for token in tokens if token]
    if not tokens:
        return ""
    parts = [tokens[0]]
    for previous, current in zip(tokens, tokens[1:]):
        if _needs_space_boundary(previous, current):
            parts.append(" ")
        parts.append(current)
    return "".join(parts).strip()


def _first_word_time(words: list[dict[str, Any]], key: str) -> float | None:
    """取字級清單中第一個含有效時間戳之字的值；forced alignment 可能遺漏個別字的時間戳。"""
    for word in words:
        value = word.get(key)
        if value is not None:
            try:
                return float(value)
            except (TypeError, ValueError):
                continue
    return None


def _last_word_time(words: list[dict[str, Any]], key: str) -> float | None:
    """取字級清單中最後一個含有效時間戳之字的值，用途同 `_first_word_time`。"""
    for word in reversed(words):
        value = word.get(key)
        if value is not None:
            try:
                return float(value)
            except (TypeError, ValueError):
                continue
    return None


def _apply_clustering_threshold(pyannote_pipeline: Any, threshold: float) -> bool:
    """覆寫 pyannote pipeline 的分群門檻，保留其餘既有參數，回傳是否成功套用。

    WhisperX 的 `DiarizationPipeline` 不暴露分群超參數（上游 issue #1579 已標記
    wontfix），門檻位於其包裝的底層 pyannote pipeline（`self.model`）。
    pyannote 的 `instantiate()` 需要完整參數字典，僅傳入 `{"clustering":
    {"threshold": x}}` 會使 `min_cluster_size`、segmentation 相關參數等其餘既有
    設定遺失，故 MUST 先以 `parameters(instantiated=True)` 取得完整參數，覆寫
    `clustering.threshold` 後整份傳回 `instantiate()`。

    存取此內部結構或找不到預期的 `clustering.threshold` 鍵時視為失敗並回傳
    False，呼叫端須降級為模型預設值、記錄 log，不得中斷轉錄。
    """
    try:
        parameters = pyannote_pipeline.parameters(instantiated=True)
    except Exception:
        logger.warning("無法取得 pyannote pipeline 參數，分群門檻將採模型預設值", exc_info=True)
        return False

    clustering = parameters.get("clustering") if isinstance(parameters, dict) else None
    if not isinstance(clustering, dict) or "threshold" not in clustering:
        logger.warning(
            "pyannote pipeline 參數不含 clustering.threshold（可用鍵：%s），"
            "分群門檻將採模型預設值",
            list(parameters.keys()) if isinstance(parameters, dict) else type(parameters),
        )
        return False

    clustering["threshold"] = threshold
    try:
        pyannote_pipeline.instantiate(parameters)
    except Exception:
        logger.warning("套用分群門檻失敗，將採模型預設值", exc_info=True)
        return False
    return True


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

        # pyannote AHC 分群門檻（cosine 距離，範圍 0-2）。未設定時採模型預設值，
        # 行為與本變更前一致；調低傾向拆細、調高傾向合併（見 server/README.md）。
        self._clustering_threshold: float | None = None
        threshold_raw = os.getenv("DIARIZATION_CLUSTERING_THRESHOLD", "").strip()
        if threshold_raw:
            try:
                self._clustering_threshold = float(threshold_raw)
            except ValueError:
                logger.warning(
                    "DIARIZATION_CLUSTERING_THRESHOLD 非合法數值：%s，將採模型預設值",
                    threshold_raw,
                )

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
            if self._clustering_threshold is not None:
                # DiarizationPipeline 包裝底層 pyannote pipeline 於 self.model；
                # 此為未公開介面，版本升級可能變動（詳見 _apply_clustering_threshold）
                _apply_clustering_threshold(
                    self._diarize_pipeline.model, self._clustering_threshold
                )
        return self._diarize_pipeline

    def transcribe(
        self,
        audio_path: Path,
        language: str | None,
        diarize: bool,
        min_speakers: int | None,
        max_speakers: int | None,
        progress_callback: Callable[[int], None] | None = None,
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

        # 以自訂解碼取代 whisperx.load_audio，以便在同一條 ffmpeg 命令中套用前處理
        audio = load_audio_preprocessed(audio_path)

        # 1. 轉錄
        result = asr_model.transcribe(
            audio,
            batch_size=self._batch_size,
            language=language,
        )
        if progress_callback:
            progress_callback(33)
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

        if progress_callback:
            progress_callback(66)

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

        if progress_callback:
            progress_callback(100)
        return self._to_segments(result.get("segments", []))

    @staticmethod
    def _to_segments(raw_segments: list[dict[str, Any]]) -> list[TranscriptSegment]:
        """將 WhisperX segments 轉為 TranscriptSegment，語者標籤正規化為講者 A、B、C。

        `assign_word_speakers` 已產生字級講者標籤（`words[i]["speaker"]`），故以此
        切分：相鄰字講者不同時切開為獨立分段，時間戳取自該分段涵蓋的字級區間。
        `words` 缺失或不含任何講者標籤時（未啟用語者分離、或對齊失敗），退回既有的
        segment 層級行為。
        """
        speaker_map: dict[str, str] = {}

        def resolve_label(raw_speaker: str | None) -> str | None:
            if not raw_speaker:
                return None
            # pyannote 輸出如 SPEAKER_00，正規化為由 A 起算的講者代號
            if raw_speaker not in speaker_map:
                speaker_map[raw_speaker] = _speaker_code(len(speaker_map))
            return speaker_map[raw_speaker]

        segments: list[TranscriptSegment] = []
        for raw in raw_segments:
            words = raw.get("words")
            has_word_speakers = bool(words) and any(
                isinstance(word, dict) and word.get("speaker") for word in words
            )
            if not has_word_speakers:
                text = str(raw.get("text", "")).strip()
                if not text:
                    continue
                segments.append(
                    TranscriptSegment(
                        start=float(raw.get("start", 0.0)),
                        end=float(raw.get("end", 0.0)),
                        text=text,
                        speaker=resolve_label(raw.get("speaker")),
                    )
                )
                continue

            segments.extend(WhisperXTranscriber._split_segment_by_word_speaker(raw, words, resolve_label))
        return segments

    @staticmethod
    def _split_segment_by_word_speaker(
        raw: dict[str, Any],
        words: list[Any],
        resolve_label: Callable[[str | None], str | None],
    ) -> list[TranscriptSegment]:
        """依字級講者標籤將單一 segment 切分為多個分段。

        缺漏標籤的字沿用前一字的標籤（whisperX issue #1072：`assign_word_speakers`
        會間歇性遺漏部分字的 speaker 鍵，缺值代表資訊未知而非講者變更）。段落首字
        即缺漏時，沿用該 segment 內第一個有標籤之字的標籤；全數缺漏時視為單一講者
        （等同未分離）。
        """
        segment_start = float(raw.get("start", 0.0))
        segment_end = float(raw.get("end", 0.0))

        # 段落首字缺漏標籤時，以第一個有標籤的字回填，避免整段落入 None 講者
        carry_speaker: str | None = None
        for word in words:
            if isinstance(word, dict) and word.get("speaker"):
                carry_speaker = str(word["speaker"])
                break

        runs: list[tuple[str | None, list[dict[str, Any]]]] = []
        for word in words:
            if not isinstance(word, dict):
                continue
            raw_speaker = word.get("speaker")
            if raw_speaker:
                carry_speaker = str(raw_speaker)
            if runs and runs[-1][0] == carry_speaker:
                runs[-1][1].append(word)
            else:
                runs.append((carry_speaker, [word]))

        if not runs:
            text = str(raw.get("text", "")).strip()
            if not text:
                return []
            return [
                TranscriptSegment(
                    start=segment_start,
                    end=segment_end,
                    text=text,
                    speaker=resolve_label(raw.get("speaker")),
                )
            ]

        if len(runs) == 1:
            # 講者一致：不切分，維持原 segment 文字與時間戳（逐字重組可能因語言
            # 相依的分隔規則與原文不同，故直接沿用原文避免無謂差異）
            text = str(raw.get("text", "")).strip()
            if not text:
                return []
            return [
                TranscriptSegment(
                    start=segment_start,
                    end=segment_end,
                    text=text,
                    speaker=resolve_label(runs[0][0]),
                )
            ]

        result: list[TranscriptSegment] = []
        for run_speaker, run_words in runs:
            text = _join_words(run_words)
            if not text:
                continue
            start = _first_word_time(run_words, "start")
            end = _last_word_time(run_words, "end")
            result.append(
                TranscriptSegment(
                    start=start if start is not None else segment_start,
                    end=end if end is not None else segment_end,
                    text=text,
                    speaker=resolve_label(run_speaker),
                )
            )
        return result


class IncrementalTranscriber:
    """低延遲路徑：直接使用 faster-whisper，不做對齊或語者分離。"""

    def __init__(self) -> None:
        self._model: Any | None = None
        self._model_dir = os.getenv("ASR_INCREMENTAL_MODEL") or os.getenv(
            "ASR_MODEL", "MediaTek-Research/Breeze-ASR-26"
        )
        self._device = os.getenv("ASR_INCREMENTAL_DEVICE", os.getenv("ASR_DEVICE", "cuda"))
        self._compute_type = os.getenv(
            "ASR_INCREMENTAL_COMPUTE_TYPE", os.getenv("ASR_COMPUTE_TYPE", "int8")
        )

    def _ensure_model(self) -> Any:
        if self._model is None:
            try:
                from faster_whisper import WhisperModel

                self._model = WhisperModel(
                    self._model_dir,
                    device=self._device,
                    compute_type=self._compute_type,
                )
            except Exception as error:
                raise RuntimeError(f"低延遲 ASR 模型載入失敗：{error}") from error
        return self._model

    def transcribe(self, audio: np.ndarray, language: str | None) -> str:
        model = self._ensure_model()
        segments, _ = model.transcribe(
            audio,
            language=language,
            beam_size=1,
            vad_filter=False,
            condition_on_previous_text=False,
        )
        # faster-whisper 的 segments 是惰性 generator，必須在此完整消費才會執行推論。
        return opencc.convert("".join(segment.text for segment in segments)).strip()


transcriber = WhisperXTranscriber()
incremental_transcriber = IncrementalTranscriber()


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
    background_tasks: BackgroundTasks,
    file: Annotated[UploadFile, File()],
    language: Annotated[str | None, Form()] = None,
    diarize: Annotated[bool, Form()] = False,
    min_speakers: Annotated[int | None, Form()] = None,
    max_speakers: Annotated[int | None, Form()] = None,
    sync: Annotated[bool, Form()] = False,
) -> dict[str, object]:
    """接收音訊；預設建立背景任務，sync=true 時直接回傳逐字稿。"""
    _validate_speaker_options(min_speakers, max_speakers)

    upload_dir = Path(os.getenv("UPLOAD_DIR", tempfile.gettempdir())) / "voxnote-asr"
    upload_dir.mkdir(parents=True, exist_ok=True)
    # 以唯一檔名保存，避免同名錄音的並行請求互相覆寫或誤刪；保留原副檔名供 ffmpeg 判斷格式
    suffix = Path(file.filename or "audio.wav").suffix or ".wav"
    audio_path = upload_dir / f"{uuid.uuid4().hex}{suffix}"

    try:
        audio_path.write_bytes(await file.read())
        await file.close()

        if sync:
            try:
                # 同步模式刻意不使用任務表或 BackgroundTasks，供即時字幕使用。
                # WhisperX pipeline 會在轉錄期間修改共用的 tokenizer；同步請求也
                # 必須與背景任務共用序列化鎖，否則多個檔案同時送入會發生 tokenizer=None。
                async with transcription_lock:
                    return await _transcribe_audio(
                        audio_path,
                        language,
                        diarize,
                        min_speakers,
                        max_speakers,
                    )
            except RuntimeError as error:
                logger.error("轉錄前置條件不符：%s", error, exc_info=True)
                raise HTTPException(status_code=503, detail=str(error)) from error
            except Exception as error:
                logger.exception("轉錄失敗")
                raise HTTPException(status_code=500, detail=f"轉錄失敗：{error}") from error
            finally:
                audio_path.unlink(missing_ok=True)

        task_id = uuid.uuid4().hex
        with tasks_lock:
            _cleanup_tasks_locked()
            tasks[task_id] = TranscriptionTask(created_at=time.time())
        background_tasks.add_task(
            _run_transcription_task,
            task_id,
            audio_path,
            language,
            diarize,
            min_speakers,
            max_speakers,
        )
        return {"task_id": task_id, "status": TaskStatus.QUEUED.value, "progress": 0}
    except HTTPException:
        await file.close()
        audio_path.unlink(missing_ok=True)
        raise
    except Exception:
        await file.close()
        audio_path.unlink(missing_ok=True)
        raise


@app.post("/v1/audio/transcriptions/incremental")
async def create_incremental_transcription(
    file: Annotated[UploadFile, File()],
    language: Annotated[str | None, Form()] = None,
) -> dict[str, object]:
    """以 faster-whisper 直接轉錄短音訊視窗，不建立背景任務。"""
    upload_dir = Path(os.getenv("UPLOAD_DIR", tempfile.gettempdir())) / "voxnote-asr"
    upload_dir.mkdir(parents=True, exist_ok=True)
    suffix = Path(file.filename or "audio.wav").suffix or ".wav"
    audio_path = upload_dir / f"{uuid.uuid4().hex}{suffix}"

    try:
        audio_path.write_bytes(await file.read())
        await file.close()
        audio = await run_in_threadpool(load_audio_preprocessed, audio_path)
        text = await run_in_threadpool(
            incremental_transcriber.transcribe,
            audio,
            language if language and language != "auto" else None,
        )
        return {"text": text, "language": language or "auto"}
    except RuntimeError as error:
        logger.error("低延遲轉錄前置條件不符：%s", error, exc_info=True)
        raise HTTPException(status_code=503, detail=str(error)) from error
    except Exception as error:
        logger.exception("低延遲轉錄失敗")
        raise HTTPException(status_code=500, detail=f"低延遲轉錄失敗：{error}") from error
    finally:
        await file.close()
        audio_path.unlink(missing_ok=True)


async def _transcribe_audio(
    audio_path: Path,
    language: str | None,
    diarize: bool,
    min_speakers: int | None,
    max_speakers: int | None,
    progress_callback: Callable[[int], None] | None = None,
) -> dict[str, object]:
    """執行共用的轉錄與輸出格式化流程。"""
    segments = await run_in_threadpool(
        transcriber.transcribe,
        audio_path,
        language if language and language != "auto" else None,
        diarize,
        min_speakers,
        max_speakers,
        progress_callback,
    )
    normalized_segments = [normalize_segment(segment, diarize) for segment in segments]
    return {
        "text": "\n".join(str(segment["text"]) for segment in normalized_segments),
        "segments": normalized_segments,
        "language": language or "auto",
        "diarization_enabled": diarize,
    }


async def _run_transcription_task(
    task_id: str,
    audio_path: Path,
    language: str | None,
    diarize: bool,
    min_speakers: int | None,
    max_speakers: int | None,
) -> None:
    """在單一程序內循序執行背景轉錄任務。"""
    try:
        async with transcription_lock:
            _update_task(task_id, status=TaskStatus.PROCESSING, progress=0)
            result = await _transcribe_audio(
                audio_path,
                language,
                diarize,
                min_speakers,
                max_speakers,
                lambda progress: _update_task(task_id, progress=progress),
            )
            _update_task(
                task_id,
                status=TaskStatus.DONE,
                progress=100,
                result=result,
            )
    except RuntimeError as error:
        logger.error("轉錄前置條件不符：%s", error, exc_info=True)
        _update_task(task_id, status=TaskStatus.FAILED, error=f"轉錄失敗：{error}")
    except Exception as error:
        logger.exception("轉錄失敗")
        _update_task(task_id, status=TaskStatus.FAILED, error=f"轉錄失敗：{error}")
    finally:
        audio_path.unlink(missing_ok=True)


@app.get("/v1/tasks/{task_id}")
async def get_transcription_task(task_id: str) -> dict[str, object]:
    """查詢背景轉錄任務狀態與完成結果。"""
    with tasks_lock:
        _cleanup_tasks_locked()
        task = tasks.get(task_id)
        if task is None:
            raise HTTPException(status_code=404, detail=f"找不到轉錄任務：{task_id}")
        return {"task_id": task_id, **_task_response(task)}
