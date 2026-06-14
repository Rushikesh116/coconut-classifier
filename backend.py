import base64
import hashlib
import json
import math
import os
import random
import re
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any


def load_local_env_file(path: Path = Path(".env")) -> None:
    if not path.exists():
        return

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


load_local_env_file()

try:
    import cv2
except ImportError:
    cv2 = None

try:
    import numpy as np
except ImportError:
    np = None

from flask import Flask, jsonify, request, send_file
from werkzeug.utils import secure_filename

app = Flask(__name__)

ALLOWED_ORIGIN = "http://localhost:3000"
ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
# Empirically calibrated for the close-range phone captures used in this project.
PIXELS_PER_CM = 55.0
MAX_AXIS_MODEL_DIMENSION = 1280
ROBOFLOW_API_URL = os.environ.get("ROBOFLOW_API_URL", "https://detect.roboflow.com")
ROBOFLOW_API_KEY = os.environ.get("ROBOFLOW_API_KEY", "")
ROBOFLOW_MODEL_ID = os.environ.get("ROBOFLOW_MODEL_ID", "")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY", "")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-1.5-flash")
SARVAM_API_KEY = os.environ.get("SARVAM_API_KEY", "")
SARVAM_STT_MODEL = os.environ.get("SARVAM_STT_MODEL", "saaras:v3")
SARVAM_TTS_MODEL = os.environ.get("SARVAM_TTS_MODEL", "bulbul:v3")
SARVAM_TTS_SPEAKER = os.environ.get("SARVAM_TTS_SPEAKER", "shubh")
CAPTURES_DIR = Path("captures")
DB_PATH = Path("coconuts.db")
SYSTEM_PROMPT = (
    "You are an expert coconut quality inspector working for an export facility. "
    "Prioritize visible image evidence over assumptions. Brown, dried, rough, mature husk "
    "should NOT be called tender. Tender coconuts are usually green/young with fresh surface cues. "
    "If visible mold, rot, black patches, severe discoloration, cracks, or damage are present, mark "
    "surface_quality Poor, mold_detected true when appropriate, export_suitable false, and color_grade D. "
    "Analyze this coconut image and return ONLY a JSON object with these exact "
    "fields: surface_quality (string: Excellent/Good/Fair/Poor), "
    "crack_confidence (float 0-1), mold_detected (boolean), "
    "color_grade (string: A/B/C/D), texture_notes (string max 20 words), "
    "export_suitable (boolean), summary (string max 30 words describing quality)"
)
TEXT_TO_SQL_SYSTEM_PROMPT = (
    "You are a SQLite query generator. Given a question about coconut quality assessment data, "
    "generate ONLY a valid SQLite SELECT query. No explanation, no markdown, just the raw SQL. "
    "The table is called 'assessments' with these columns: id, timestamp, grade, weight_kg, "
    "height_cm, moisture_percent (estimated water level percent), major_axis_cm, minor_axis_cm, volume_cm3, density_g_cm3, "
    "surface_quality, crack_confidence, mold_detected (0 or 1), color_grade, export_suitable "
    "(0 or 1), ai_summary, confidence_score. The timestamp column is stored as a local ISO string "
    "like 2026-04-18T02:17:20.392760, so for questions about today, yesterday, this week, or other "
    "current date/time windows, use SQLite local time functions such as date('now','localtime') and "
    "datetime('now','localtime'). Prefer substr(timestamp, 1, 10) for calendar-date comparisons. "
    "If the question cannot be answered with SQL, "
    "return the string: NOT_SQL"
)
SQL_ANSWER_SYSTEM_PROMPT = (
    "You are a helpful assistant for a coconut export facility. Answer the user's question "
    "using the provided data. Be concise and specific. If numbers are involved, include them "
    "directly in your answer. If the user asks in Hindi, English, or another Indian language, "
    "answer in the same language as much as possible."
)
COPILOT_FALLBACK_SYSTEM_PROMPT = (
    "You are a helpful assistant for a coconut export facility and a general coconut quality "
    "expert. Answer concisely and specifically. If the user asks for database-specific numbers "
    "and no query results are available, say you could not safely retrieve that data. If the user "
    "asks in Hindi, English, or another Indian language, answer in the same language as much as possible."
)
SESSION_REPORT_SYSTEM_PROMPT = (
    "You are a quality control manager writing a shift report for a coconut export facility. "
    "Write a professional but concise report (under 200 words) covering: overall quality summary, "
    "key findings, any concerning patterns (high defect rates, low export suitability), and a "
    "recommendation. Use plain language a factory supervisor would understand."
)

CAPTURES_DIR.mkdir(parents=True, exist_ok=True)


def _log(message: str) -> None:
    print(f"[Backend] {message}")


@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = ALLOWED_ORIGIN
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
    return response


@app.route("/api/<path:_path>", methods=["OPTIONS"])
def api_options(_path: str):
    return ("", 204)


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "model": GEMINI_MODEL, "roboflow": "connected"})


class BackendError(Exception):
    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


@app.errorhandler(BackendError)
def handle_backend_error(error: BackendError):
    return jsonify({"error": error.message}), error.status_code


@app.errorhandler(413)
def handle_too_large(_error):
    return jsonify({"error": "Upload is too large for the server to process."}), 413


def get_db_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def get_readonly_db_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS assessments (
            id TEXT PRIMARY KEY,
            timestamp TEXT,
            image_path TEXT,
            image_hash TEXT,
            grade TEXT,
            weight_kg REAL,
            height_cm REAL,
            moisture_percent REAL,
            major_axis_cm REAL,
            minor_axis_cm REAL,
            volume_cm3 REAL,
            density_g_cm3 REAL,
            surface_quality TEXT,
            crack_confidence REAL,
            mold_detected INTEGER,
            color_grade TEXT,
            export_suitable INTEGER,
            ai_summary TEXT,
            yolo_detections_json TEXT,
            confidence_score REAL
        )
        """
    )

    existing_columns = {row[1] for row in cursor.execute("PRAGMA table_info(assessments)").fetchall()}
    required_columns = {
        "timestamp": "TEXT",
        "image_path": "TEXT",
        "image_hash": "TEXT",
        "grade": "TEXT",
        "weight_kg": "REAL",
        "height_cm": "REAL",
        "height_source": "TEXT",
        "height_confidence": "REAL",
        "moisture_percent": "REAL",
        "classification_label": "TEXT",
        "classification_confidence": "REAL",
        "classification_reason": "TEXT",
        "major_axis_cm": "REAL",
        "minor_axis_cm": "REAL",
        "volume_cm3": "REAL",
        "density_g_cm3": "REAL",
        "surface_quality": "TEXT",
        "crack_confidence": "REAL",
        "mold_detected": "INTEGER",
        "color_grade": "TEXT",
        "export_suitable": "INTEGER",
        "ai_summary": "TEXT",
        "yolo_detections_json": "TEXT",
        "confidence_score": "REAL",
    }

    for name, sql_type in required_columns.items():
        if name not in existing_columns:
            cursor.execute(f"ALTER TABLE assessments ADD COLUMN {name} {sql_type}")
            _log(f"Added missing column: {name}")

    conn.commit()
    conn.close()


init_db()


def allowed_file(filename: str) -> bool:
    return Path(filename).suffix.lower() in ALLOWED_EXTENSIONS


def build_capture_path(filename: str) -> Path:
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    safe_name = secure_filename(filename) or "upload.jpg"
    return CAPTURES_DIR / f"{timestamp}_{safe_name}"


def compute_image_hash(image_bytes: bytes) -> str:
    return hashlib.sha256(image_bytes).hexdigest()


def find_existing_capture_path(image_hash: str) -> Path | None:
    conn = get_db_connection()
    try:
        rows = conn.execute(
            """
            SELECT image_path FROM assessments
            WHERE image_hash = ? AND image_path IS NOT NULL
            ORDER BY timestamp ASC
            """,
            (image_hash,),
        ).fetchall()
    finally:
        conn.close()

    for row in rows:
        candidate = Path(str(row["image_path"]))
        if candidate.exists() and candidate.is_file():
            return candidate
    return None


def get_or_store_capture_path(filename: str, image_bytes: bytes, image_hash: str) -> tuple[Path, bool]:
    existing_path = find_existing_capture_path(image_hash)
    if existing_path is not None:
        return existing_path, True

    image_path = build_capture_path(filename)
    image_path.write_bytes(image_bytes)
    return image_path, False


def require_backend_dependencies() -> None:
    if cv2 is None or np is None:
        raise BackendError(
            "Missing backend dependencies: opencv-python and numpy are required.",
            500,
        )


class DirectRoboflowClient:
    """Direct HTTP client for Roboflow cloud inference API."""

    def __init__(self, api_url: str, api_key: str):
        self.api_url = api_url.rstrip("/")
        self.api_key = api_key

    def infer(self, image_path: str, model_id: str) -> dict[str, Any]:
        encoded_image = base64.b64encode(Path(image_path).read_bytes())
        endpoint = f"{self.api_url}/{urllib.parse.quote(model_id, safe='/')}"
        if self.api_key:
            endpoint = f"{endpoint}?api_key={urllib.parse.quote(self.api_key)}"
        request_obj = urllib.request.Request(
            endpoint,
            data=encoded_image,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )

        try:
            with urllib.request.urlopen(request_obj, timeout=90) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="ignore")
            raise BackendError(f"Roboflow inference failed: {body or exc.reason}", 500)
        except urllib.error.URLError as exc:
            raise BackendError(f"Roboflow inference failed: {exc.reason}", 500)


def create_roboflow_client() -> DirectRoboflowClient:
    if not ROBOFLOW_API_KEY:
        _log("WARNING: ROBOFLOW_API_KEY not set.")
    else:
        _log("Using Roboflow cloud inference.")
    return DirectRoboflowClient(api_url=ROBOFLOW_API_URL, api_key=ROBOFLOW_API_KEY)


def run_roboflow_inference(
    image_path: Path,
    roboflow_client: DirectRoboflowClient,
) -> tuple[dict[str, Any], str | None]:
    if not ROBOFLOW_MODEL_ID:
        warning = "Roboflow model is not configured. Continuing with vision-only assessment."
        _log(f"WARNING: {warning}")
        return {}, warning

    if not ROBOFLOW_API_KEY:
        warning = "Roboflow API key is missing. Continuing with vision-only assessment."
        _log(f"WARNING: {warning}")
        return {}, warning

    try:
        return roboflow_client.infer(str(image_path), model_id=ROBOFLOW_MODEL_ID), None
    except BackendError as exc:
        warning = f"{exc.message} Continuing with vision-only assessment."
        _log(f"WARNING: {warning}")
        return {}, warning


def extract_yolo_detections(raw_results: dict[str, Any] | None) -> list[dict[str, Any]]:
    predictions = []
    if raw_results:
        predictions = raw_results.get("predictions") or raw_results.get("detections") or []

    cleaned = []
    for pred in predictions:
        confidence = float(pred.get("confidence", 0.0))
        label = str(pred.get("class") or pred.get("label") or "unknown")
        cleaned.append(
            {
                "class": label,
                "confidence": round(confidence, 4),
                "x": pred.get("x"),
                "y": pred.get("y"),
                "width": pred.get("width"),
                "height": pred.get("height"),
                "source": "roboflow",
            }
        )
    return cleaned


def find_coconut_bbox(detections: list[dict[str, Any]]) -> dict[str, Any] | None:
    coconut_candidates = [
        det for det in detections if "coconut" in str(det.get("class", "")).lower()
    ]
    if not coconut_candidates:
        return None
    return max(coconut_candidates, key=lambda det: float(det.get("confidence", 0.0)))


def empty_axis_measurements(
    *,
    axis_source: str = "unavailable",
    axis_warning: str | None = None,
) -> dict[str, Any]:
    return {
        "major_axis_cm": None,
        "minor_axis_cm": None,
        "volume_cm3": None,
        "density_g_cm3": None,
        "axis_detected": False,
        "axis_source": axis_source,
        "axis_angle_degrees": None,
        "axis_confidence": None,
        "axis_warning": axis_warning,
    }


def resize_for_axis_model(frame: Any) -> tuple[Any, float]:
    height, width = frame.shape[:2]
    longest_side = max(height, width)
    if longest_side <= MAX_AXIS_MODEL_DIMENSION:
        return frame.copy(), 1.0

    scale = MAX_AXIS_MODEL_DIMENSION / float(longest_side)
    resized = cv2.resize(
        frame,
        (int(round(width * scale)), int(round(height * scale))),
        interpolation=cv2.INTER_AREA,
    )
    return resized, scale


def build_grabcut_mask(frame: Any) -> Any:
    height, width = frame.shape[:2]
    mask = np.full((height, width), cv2.GC_PR_BGD, dtype=np.uint8)

    margin_x = max(8, int(width * 0.04))
    margin_y = max(8, int(height * 0.04))
    mask[:margin_y, :] = cv2.GC_BGD
    mask[-margin_y:, :] = cv2.GC_BGD
    mask[:, :margin_x] = cv2.GC_BGD
    mask[:, -margin_x:] = cv2.GC_BGD

    center = (width // 2, height // 2)
    probable_axes = (max(40, int(width * 0.24)), max(60, int(height * 0.34)))
    sure_top_left = (int(width * 0.28), int(height * 0.12))
    sure_bottom_right = (int(width * 0.72), int(height * 0.9))

    cv2.ellipse(mask, center, probable_axes, 0, 0, 360, cv2.GC_PR_FGD, -1)
    cv2.rectangle(mask, sure_top_left, sure_bottom_right, cv2.GC_FGD, -1)
    return mask


def postprocess_axis_mask(mask: Any) -> Any:
    kernel_large = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15))
    kernel_small = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    cleaned = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel_large, iterations=2)
    cleaned = cv2.morphologyEx(cleaned, cv2.MORPH_OPEN, kernel_small, iterations=1)
    return cleaned


def contour_center(contour: Any) -> tuple[float, float]:
    moments = cv2.moments(contour)
    if moments["m00"]:
        return moments["m10"] / moments["m00"], moments["m01"] / moments["m00"]
    x, y, width, height = cv2.boundingRect(contour)
    return x + (width / 2.0), y + (height / 2.0)


def score_coconut_contour(contour: Any, image_shape: tuple[int, int, int]) -> tuple[float, float]:
    height, width = image_shape[:2]
    image_area = float(height * width)
    area = cv2.contourArea(contour)
    if area <= image_area * 0.03:
        return -1.0, area

    x, y, box_width, box_height = cv2.boundingRect(contour)
    if min(box_width, box_height) <= 0:
        return -1.0, area

    aspect_ratio = max(box_width, box_height) / float(min(box_width, box_height))
    if aspect_ratio > 2.4:
        return -1.0, area

    hull = cv2.convexHull(contour)
    hull_area = cv2.contourArea(hull) or 1.0
    solidity = area / hull_area
    if solidity < 0.75:
        return -1.0, area

    cx, cy = contour_center(contour)
    center_distance = math.hypot(cx - (width / 2.0), cy - (height / 2.0))
    normalized_distance = center_distance / max(math.hypot(width / 2.0, height / 2.0), 1.0)
    border_touch_penalty = 0.0
    if x <= width * 0.02 or y <= height * 0.02 or (x + box_width) >= width * 0.98 or (y + box_height) >= height * 0.98:
        border_touch_penalty = 0.2

    score = (area / image_area) * 2.5
    score += solidity * 0.8
    score -= normalized_distance * 0.9
    score -= abs(aspect_ratio - 1.0) * 0.25
    score -= border_touch_penalty
    return score, area


def pick_best_coconut_contour(mask: Any, frame: Any) -> Any | None:
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    scored: list[tuple[float, float, Any]] = []
    for contour in contours:
        if len(contour) < 5:
            continue
        score, area = score_coconut_contour(contour, frame.shape)
        if score < 0:
            continue
        scored.append((score, area, contour))

    if not scored:
        return None

    scored.sort(key=lambda item: (item[0], item[1]), reverse=True)
    return scored[0][2]


def detect_coconut_with_local_model(image_path: Path) -> dict[str, Any] | None:
    if cv2 is None or np is None:
        return None

    frame = cv2.imread(str(image_path))
    if frame is None:
        return None

    resized, scale = resize_for_axis_model(frame)
    mask = build_grabcut_mask(resized)
    bgd_model = np.zeros((1, 65), np.float64)
    fgd_model = np.zeros((1, 65), np.float64)

    try:
        cv2.grabCut(resized, mask, None, bgd_model, fgd_model, 4, cv2.GC_INIT_WITH_MASK)
        foreground_mask = np.where(
            (mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD),
            255,
            0,
        ).astype("uint8")
        foreground_mask = postprocess_axis_mask(foreground_mask)
        contour = pick_best_coconut_contour(foreground_mask, resized)
    except cv2.error:
        contour = None

    if contour is None:
        gray = cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY)
        blurred = cv2.GaussianBlur(gray, (11, 11), 0)
        _, thresholded = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        if cv2.countNonZero(thresholded) > (thresholded.shape[0] * thresholded.shape[1]) / 2:
            thresholded = cv2.bitwise_not(thresholded)
        thresholded = postprocess_axis_mask(thresholded)
        contour = pick_best_coconut_contour(thresholded, resized)

    if contour is None or len(contour) < 5:
        return None

    ellipse_center, ellipse_axes, ellipse_angle = cv2.fitEllipse(contour)
    axis_a, axis_b = ellipse_axes
    major_axis_px = max(axis_a, axis_b) / scale
    minor_axis_px = min(axis_a, axis_b) / scale
    major_angle = ellipse_angle if axis_a >= axis_b else (ellipse_angle + 90.0) % 180.0

    x, y, width, height = cv2.boundingRect(contour)
    x = int(round(x / scale))
    y = int(round(y / scale))
    width = int(round(width / scale))
    height = int(round(height / scale))

    contour_score, contour_area = score_coconut_contour(contour, resized.shape)
    confidence = max(0.55, min(0.98, 0.58 + max(contour_score, 0.0) * 0.18))
    area_ratio = contour_area / float(resized.shape[0] * resized.shape[1])

    return {
        "class": "coconut_local",
        "confidence": round(confidence, 4),
        "x": round(float(ellipse_center[0]) / scale, 2),
        "y": round(float(ellipse_center[1]) / scale, 2),
        "width": width,
        "height": height,
        "source": "local_shape_model",
        "major_axis_px": round(float(major_axis_px), 2),
        "minor_axis_px": round(float(minor_axis_px), 2),
        "axis_angle_degrees": round(float(major_angle), 2),
        "area_ratio": round(float(area_ratio), 4),
    }


def measure_coconut_axes(image_path: Path, coconut_detection: dict[str, Any] | None) -> dict[str, Any]:
    if cv2 is None:
        return empty_axis_measurements(axis_warning="OpenCV is not available for axis measurement.")

    if coconut_detection is None:
        return empty_axis_measurements(axis_warning="No coconut region was detected for axis measurement.")

    if coconut_detection.get("source") == "local_shape_model" and coconut_detection.get("major_axis_px") is not None:
        major_axis_cm = round(float(coconut_detection["major_axis_px"]) / PIXELS_PER_CM, 2)
        minor_axis_cm = round(float(coconut_detection["minor_axis_px"]) / PIXELS_PER_CM, 2)
        return {
            "major_axis_cm": major_axis_cm,
            "minor_axis_cm": minor_axis_cm,
            "volume_cm3": None,
            "density_g_cm3": None,
            "axis_detected": True,
            "axis_source": "local_shape_model",
            "axis_angle_degrees": coconut_detection.get("axis_angle_degrees"),
            "axis_confidence": coconut_detection.get("confidence"),
            "axis_warning": None,
        }

    frame = cv2.imread(str(image_path))
    if frame is None:
        return empty_axis_measurements(axis_warning="Could not read the uploaded image for axis measurement.")

    x = float(coconut_detection.get("x", 0))
    y = float(coconut_detection.get("y", 0))
    width = float(coconut_detection.get("width", 0))
    height = float(coconut_detection.get("height", 0))
    x1 = max(0, int(x - width / 2))
    y1 = max(0, int(y - height / 2))
    x2 = min(frame.shape[1], int(x + width / 2))
    y2 = min(frame.shape[0], int(y + height / 2))

    if x2 <= x1 or y2 <= y1:
        return empty_axis_measurements(
            axis_source=str(coconut_detection.get("source") or "yolo_guided"),
            axis_warning="The detected coconut region was invalid for axis measurement.",
        )

    roi = frame[y1:y2, x1:x2]
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (9, 9), 0)
    _, thresh = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    if cv2.countNonZero(thresh) > (thresh.shape[0] * thresh.shape[1]) / 2:
        thresh = cv2.bitwise_not(thresh)

    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    cleaned = cv2.morphologyEx(thresh, cv2.MORPH_OPEN, kernel, iterations=2)
    contours, _ = cv2.findContours(cleaned, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    valid_contours = [cnt for cnt in contours if len(cnt) >= 5]

    if not valid_contours:
        return empty_axis_measurements(
            axis_source=str(coconut_detection.get("source") or "yolo_guided"),
            axis_warning="A contour could not be fit inside the detected coconut region.",
        )

    contour = max(valid_contours, key=cv2.contourArea)
    if cv2.contourArea(contour) <= 0:
        return empty_axis_measurements(
            axis_source=str(coconut_detection.get("source") or "yolo_guided"),
            axis_warning="The detected coconut contour had no measurable area.",
        )

    (_, _), (d1, d2), angle = cv2.fitEllipse(contour)
    major_axis_cm = round(max(d1, d2) / PIXELS_PER_CM, 2)
    minor_axis_cm = round(min(d1, d2) / PIXELS_PER_CM, 2)
    major_angle = angle if d1 >= d2 else (angle + 90.0) % 180.0
    return {
        "major_axis_cm": major_axis_cm,
        "minor_axis_cm": minor_axis_cm,
        "volume_cm3": None,
        "density_g_cm3": None,
        "axis_detected": True,
        "axis_source": str(coconut_detection.get("source") or "yolo_guided"),
        "axis_angle_degrees": round(float(major_angle), 2),
        "axis_confidence": float(coconut_detection.get("confidence", 0.0)) or None,
        "axis_warning": None,
    }


def analyze_local_color_cues(image_path: Path, coconut_detection: dict[str, Any] | None) -> dict[str, Any]:
    default = {
        "green_ratio": 0.0,
        "brown_ratio": 0.0,
        "dark_ratio": 0.0,
        "visual_tender_cue": False,
        "visual_mature_cue": False,
        "visual_bad_cue": False,
        "dominant_visual_cue": "unknown",
    }
    if cv2 is None or np is None or coconut_detection is None:
        return default

    frame = cv2.imread(str(image_path))
    if frame is None:
        return default

    x = float(coconut_detection.get("x", frame.shape[1] / 2))
    y = float(coconut_detection.get("y", frame.shape[0] / 2))
    width = float(coconut_detection.get("width", 0))
    height = float(coconut_detection.get("height", 0))
    if width <= 0 or height <= 0:
        return default

    x1 = max(0, int(x - width / 2))
    y1 = max(0, int(y - height / 2))
    x2 = min(frame.shape[1], int(x + width / 2))
    y2 = min(frame.shape[0], int(y + height / 2))
    if x2 <= x1 or y2 <= y1:
        return default

    roi = frame[y1:y2, x1:x2]
    if roi.size == 0:
        return default

    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    mask = np.zeros(roi.shape[:2], dtype=np.uint8)
    center = (roi.shape[1] // 2, roi.shape[0] // 2)
    axes = (max(1, int(roi.shape[1] * 0.42)), max(1, int(roi.shape[0] * 0.42)))
    cv2.ellipse(mask, center, axes, 0, 0, 360, 255, -1)
    sample = mask > 0
    total = int(np.count_nonzero(sample))
    if total == 0:
        return default

    hue = hsv[:, :, 0]
    sat = hsv[:, :, 1]
    val = hsv[:, :, 2]
    green = sample & (hue >= 35) & (hue <= 95) & (sat >= 35) & (val >= 45)
    brown = sample & (hue >= 5) & (hue <= 32) & (sat >= 35) & (val >= 35)
    dark = sample & (val <= 60) & (sat >= 25)

    green_ratio = round(float(np.count_nonzero(green)) / total, 3)
    brown_ratio = round(float(np.count_nonzero(brown)) / total, 3)
    dark_ratio = round(float(np.count_nonzero(dark)) / total, 3)
    visual_tender_cue = green_ratio >= 0.25 and dark_ratio < 0.25
    visual_mature_cue = brown_ratio >= 0.35 and green_ratio < 0.25
    visual_bad_cue = dark_ratio >= 0.34 and green_ratio < 0.18

    if visual_bad_cue:
        dominant = "dark_defect"
    elif visual_tender_cue:
        dominant = "green_tender"
    elif visual_mature_cue:
        dominant = "brown_mature"
    else:
        dominant = "mixed"

    return {
        "green_ratio": green_ratio,
        "brown_ratio": brown_ratio,
        "dark_ratio": dark_ratio,
        "visual_tender_cue": visual_tender_cue,
        "visual_mature_cue": visual_mature_cue,
        "visual_bad_cue": visual_bad_cue,
        "dominant_visual_cue": dominant,
    }


def clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


def predict_height_from_axes(
    major_axis_cm: float | None,
    minor_axis_cm: float | None,
    *,
    axis_confidence: float | None = None,
) -> tuple[float | None, str | None, float | None]:
    if major_axis_cm is None or minor_axis_cm is None:
        return None, None, None

    if major_axis_cm <= 0 or minor_axis_cm <= 0:
        return None, None, None

    shape_ratio = clamp(minor_axis_cm / major_axis_cm, 0.55, 1.0)
    elongation = 1.0 - shape_ratio

    # Axis-based empirical estimator:
    # Start from the measured major axis and add a small elongation bonus to
    # compensate for perspective/pose when the fruit is slightly tilted.
    estimated_height_cm = major_axis_cm * (1.04 + (elongation * 0.30))
    estimated_height_cm = clamp(estimated_height_cm, major_axis_cm * 0.98, major_axis_cm * 1.18)

    base_confidence = axis_confidence if axis_confidence is not None else 0.74
    height_confidence = clamp(base_confidence * (0.88 + (shape_ratio * 0.12)), 0.6, 0.95)
    return round(estimated_height_cm, 1), "axis_regression_estimate", round(height_confidence, 3)


def generate_mock_sensor_values(predicted_height_cm: float | None) -> dict[str, float | str | None]:
    return {
        "weight_kg": round(random.uniform(0.8, 2.2), 2),
        "height_cm": predicted_height_cm if predicted_height_cm is not None else round(random.uniform(15.0, 28.0), 1),
        "height_source": "axis_regression_estimate" if predicted_height_cm is not None else "simulated_sensor",
        "moisture_percent": round(random.uniform(40.0, 75.0), 1),
    }


def compute_volume_and_density(
    major_axis_cm: float | None,
    minor_axis_cm: float | None,
    height_cm: float,
    weight_kg: float,
) -> tuple[float | None, float | None]:
    if major_axis_cm is None or minor_axis_cm is None:
        return None, None

    volume_cm3 = round((math.pi / 6.0) * major_axis_cm * minor_axis_cm * height_cm, 2)
    if volume_cm3 <= 0:
        return volume_cm3, None

    density_g_cm3 = round((weight_kg * 1000.0) / volume_cm3, 3)
    return volume_cm3, density_g_cm3


def extract_gemini_text(response_payload: dict[str, Any]) -> str:
    try:
        candidate = response_payload["candidates"][0]
        parts = candidate.get("content", {}).get("parts", [])
        text = "".join(str(part.get("text", "")) for part in parts).strip()
        if text:
            return text

        finish_reason = candidate.get("finishReason") or response_payload.get("promptFeedback", {}).get("blockReason")
        raise BackendError(f"Gemini returned no text content. Finish reason: {finish_reason or 'unknown'}", 500)
    except Exception as exc:
        if isinstance(exc, BackendError):
            raise
        raise BackendError(f"Gemini response parsing failed: {exc}", 500)


def parse_json_object(text: str) -> dict[str, Any]:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    match = re.search(r"\{.*\}", cleaned, flags=re.DOTALL)
    if match:
        cleaned = match.group(0)
    return json.loads(cleaned)


def build_fallback_vision_analysis(reason: str) -> dict[str, Any]:
    _log(f"Gemini vision fallback used: {reason}")
    return {
        "surface_quality": "Fair",
        "crack_confidence": 0.25,
        "mold_detected": False,
        "color_grade": "C",
        "texture_notes": "Gemini vision unavailable; local assessment fallback used.",
        "export_suitable": False,
        "summary": "Vision AI response was unavailable, so a conservative fallback was used.",
    }


def call_gemini_generate_content(
    contents: list[dict[str, Any]],
    *,
    system_instruction: str | None = None,
    max_tokens: int = 300,
    temperature: float = 0.2,
    json_response: bool = False,
) -> str:
    if not GEMINI_API_KEY:
        raise BackendError("GEMINI_API_KEY is not set.", 500)

    payload: dict[str, Any] = {
        "contents": contents,
        "generationConfig": {
            "maxOutputTokens": max_tokens,
            "temperature": temperature,
        },
    }
    if system_instruction:
        payload["systemInstruction"] = {"parts": [{"text": system_instruction}]}
    if json_response:
        payload["generationConfig"]["responseMimeType"] = "application/json"

    encoded_model = urllib.parse.quote(GEMINI_MODEL, safe="")
    encoded_key = urllib.parse.quote(GEMINI_API_KEY, safe="")
    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{encoded_model}:generateContent?key={encoded_key}"
    )

    request_obj = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(request_obj, timeout=60) as response:
            response_payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="ignore")
        raise BackendError(f"Gemini request failed: {body or exc.reason}", 500)
    except urllib.error.URLError as exc:
        raise BackendError(f"Gemini request failed: {exc.reason}", 500)
    except Exception as exc:
        raise BackendError(f"Gemini request failed: {exc}", 500)

    return extract_gemini_text(response_payload)


def call_gemini_chat(
    messages: list[dict[str, Any]],
    *,
    max_tokens: int = 300,
    temperature: float = 0.2,
    response_format: dict[str, Any] | None = None,
) -> str:
    contents = []
    system_parts = []
    for message in messages:
        role = str(message.get("role", "user")).lower()
        content = message.get("content", "")
        if role == "system":
            system_parts.append({"text": str(content)})
            continue
        gemini_role = "model" if role == "assistant" else "user"
        contents.append(
            {
                "role": gemini_role,
                "parts": [{"text": str(content)}],
            }
        )

    system_instruction = "\n\n".join(part["text"] for part in system_parts) if system_parts else None
    return call_gemini_generate_content(
        contents,
        system_instruction=system_instruction,
        max_tokens=max_tokens,
        temperature=temperature,
        json_response=response_format is not None,
    )


def normalize_conversation_history(history: Any) -> list[dict[str, str]]:
    if not isinstance(history, list):
        return []

    normalized: list[dict[str, str]] = []
    for item in history[-12:]:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role", "")).strip().lower()
        content = str(item.get("content", "")).strip()
        if role not in {"user", "assistant"} or not content:
            continue
        normalized.append({"role": role, "content": content[:2000]})
    return normalized


def build_copilot_context(question: str, conversation_history: list[dict[str, str]]) -> str:
    context_lines = []
    for message in conversation_history:
        speaker = "User" if message["role"] == "user" else "Assistant"
        context_lines.append(f"{speaker}: {message['content']}")

    if context_lines:
        return (
            "Conversation history:\n"
            + "\n".join(context_lines)
            + f"\n\nCurrent question:\n{question}"
        )
    return f"Current question:\n{question}"


def clean_sql_candidate(raw_sql: str) -> str:
    sql = raw_sql.strip()
    if sql.startswith("```"):
        sql = re.sub(r"^```(?:sql)?\s*", "", sql, flags=re.IGNORECASE)
        sql = re.sub(r"\s*```$", "", sql)
    sql = sql.strip().rstrip(";").strip()
    return sql


def normalize_sql_time_functions(sql: str) -> str:
    normalized = sql
    replacements = {
        "date('now')": "date('now','localtime')",
        'date("now")': 'date("now","localtime")',
        "datetime('now')": "datetime('now','localtime')",
        'datetime("now")': 'datetime("now","localtime")',
        "time('now')": "time('now','localtime')",
        'time("now")': 'time("now","localtime")',
    }
    for old, new in replacements.items():
        normalized = re.sub(re.escape(old), new, normalized, flags=re.IGNORECASE)
    return normalized


def is_safe_select_query(sql: str) -> bool:
    if not sql:
        return False
    if ";" in sql:
        return False
    if not re.match(r"^(SELECT|WITH)\b", sql, re.IGNORECASE):
        return False
    if not re.search(r"\bassessments\b", sql, re.IGNORECASE):
        return False

    forbidden_patterns = [
        r"\b(ALTER|ATTACH|CREATE|DELETE|DETACH|DROP|INSERT|PRAGMA|REINDEX|REPLACE|TRUNCATE|UPDATE|VACUUM)\b",
        r"--",
        r"/\*",
    ]
    return not any(re.search(pattern, sql, re.IGNORECASE) for pattern in forbidden_patterns)


def execute_copilot_query(sql: str) -> list[dict[str, Any]]:
    conn = get_readonly_db_connection()
    try:
        rows = conn.execute(sql, ()).fetchall()
    except sqlite3.Error as exc:
        raise BackendError(f"Failed to execute generated SQL safely: {exc}", 400)
    finally:
        conn.close()

    return [dict(row) for row in rows]


def answer_common_copilot_question(question: str) -> dict[str, Any] | None:
    normalized = re.sub(r"[^a-z0-9\s]", " ", question.lower())
    normalized = re.sub(r"\s+", " ", normalized).strip()

    if "today" in normalized and any(word in normalized for word in ("count", "many", "much", "graded", "assessed")):
        sql = (
            "SELECT COUNT(*) AS coconuts_graded_today "
            "FROM assessments WHERE substr(timestamp, 1, 10) = date('now','localtime')"
        )
        rows = execute_copilot_query(sql)
        count = int(rows[0]["coconuts_graded_today"]) if rows else 0
        noun = "coconut was" if count == 1 else "coconuts were"
        return {
            "answer": f"{count} {noun} graded today.",
            "data": rows,
            "query_used": sql,
        }

    if "export" in normalized and any(word in normalized for word in ("percentage", "percent", "suitable", "ready")):
        sql = (
            "SELECT COUNT(*) AS total, "
            "SUM(CASE WHEN export_suitable = 1 THEN 1 ELSE 0 END) AS export_suitable_count, "
            "ROUND(100.0 * SUM(CASE WHEN export_suitable = 1 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 1) "
            "AS export_suitable_percent FROM assessments"
        )
        rows = execute_copilot_query(sql)
        percent = rows[0]["export_suitable_percent"] if rows and rows[0]["export_suitable_percent"] is not None else 0
        ready = rows[0]["export_suitable_count"] if rows else 0
        total = rows[0]["total"] if rows else 0
        return {
            "answer": f"{percent}% of assessed coconuts are export suitable ({ready} out of {total}).",
            "data": rows,
            "query_used": sql,
        }

    if "grade d" in normalized or "defective" in normalized:
        sql = (
            "SELECT id, timestamp, grade, surface_quality, ai_summary, confidence_score "
            "FROM assessments WHERE grade = 'D' ORDER BY timestamp DESC LIMIT 20"
        )
        rows = execute_copilot_query(sql)
        return {
            "answer": f"I found {len(rows)} recent Grade D coconut assessments.",
            "data": rows,
            "query_used": sql,
        }

    if "average" in normalized and "weight" in normalized and "grade" in normalized:
        sql = (
            "SELECT grade, ROUND(AVG(weight_kg), 2) AS average_weight_kg, COUNT(*) AS count "
            "FROM assessments GROUP BY grade ORDER BY grade"
        )
        rows = execute_copilot_query(sql)
        if not rows:
            answer = "No assessments are available yet to calculate average weight by grade."
        else:
            parts = [f"Grade {row['grade']}: {row['average_weight_kg']} kg" for row in rows]
            answer = "Average weight by grade: " + ", ".join(parts) + "."
        return {
            "answer": answer,
            "data": rows,
            "query_used": sql,
        }

    return None


def answer_copilot_with_data(
    question: str,
    conversation_history: list[dict[str, str]],
    sql: str,
    rows: list[dict[str, Any]],
) -> str:
    prompt = build_copilot_context(question, conversation_history)
    data_json = json.dumps(rows, default=str)
    return call_gemini_chat(
        [
            {"role": "system", "content": SQL_ANSWER_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": f"{prompt}\n\nSQL query used:\n{sql}\n\nQuery results JSON:\n{data_json}",
            },
        ],
        max_tokens=300,
        temperature=0.2,
    )


def answer_copilot_fallback(question: str, conversation_history: list[dict[str, str]]) -> str:
    messages: list[dict[str, Any]] = [{"role": "system", "content": COPILOT_FALLBACK_SYSTEM_PROMPT}]
    messages.extend(conversation_history)
    messages.append({"role": "user", "content": question})
    return call_gemini_chat(messages, max_tokens=300, temperature=0.4)


def generate_copilot_sql(question: str, conversation_history: list[dict[str, str]]) -> str:
    prompt = build_copilot_context(question, conversation_history)
    raw_sql = call_gemini_chat(
        [
            {"role": "system", "content": TEXT_TO_SQL_SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ],
        max_tokens=220,
        temperature=0,
    )
    return normalize_sql_time_functions(raw_sql)


def call_gemini_vision(image_path: Path) -> dict[str, Any]:
    suffix = image_path.suffix.lower()
    if suffix == ".png":
        mime_type = "png"
    elif suffix == ".webp":
        mime_type = "webp"
    else:
        mime_type = "jpeg"

    encoded_image = base64.b64encode(image_path.read_bytes()).decode("utf-8")
    try:
        content = call_gemini_generate_content(
            [
                {
                    "role": "user",
                    "parts": [
                        {"text": "Analyze this coconut image and respond with JSON only."},
                        {
                            "inline_data": {
                                "mime_type": f"image/{mime_type}",
                                "data": encoded_image,
                            }
                        },
                    ],
                }
            ],
            system_instruction=SYSTEM_PROMPT,
            max_tokens=300,
            temperature=0.2,
            json_response=True,
        )
        analysis = parse_json_object(content)
    except Exception as exc:
        return build_fallback_vision_analysis(str(exc))

    return {
        "surface_quality": str(analysis.get("surface_quality", "Fair")),
        "crack_confidence": round(float(analysis.get("crack_confidence", 0.0)), 3),
        "mold_detected": bool(analysis.get("mold_detected", False)),
        "color_grade": str(analysis.get("color_grade", "C")),
        "texture_notes": str(analysis.get("texture_notes", ""))[:120],
        "export_suitable": bool(analysis.get("export_suitable", False)),
        "summary": str(analysis.get("summary", ""))[:200],
    }


def classify_defects(detections: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], bool]:
    defect_hits = []
    severe_defect = False
    keywords = ("crack", "mold", "defect", "damage", "spot", "bruise", "rot")

    for det in detections:
        label = str(det.get("class", "")).lower()
        if any(keyword in label for keyword in keywords):
            defect_hits.append(det)
            if "mold" in label or ("crack" in label and float(det.get("confidence", 0)) > 0.6):
                severe_defect = True

    return defect_hits, severe_defect


def classify_coconut_category(
    *,
    detections: list[dict[str, Any]],
    vision_analysis: dict[str, Any],
    local_visual: dict[str, Any],
    grade: str,
    moisture_percent: float | None,
    density_g_cm3: float | None,
    major_axis_cm: float | None,
    minor_axis_cm: float | None,
) -> tuple[str, float, str]:
    searchable_text = " ".join(
        [
            str(vision_analysis.get("summary") or ""),
            str(vision_analysis.get("texture_notes") or ""),
            " ".join(str(det.get("class") or "") for det in detections),
        ]
    ).lower()

    surface_quality = str(vision_analysis.get("surface_quality") or "")
    mold_detected = bool(vision_analysis.get("mold_detected"))
    crack_confidence = float(vision_analysis.get("crack_confidence") or 0.0)
    export_suitable = bool(vision_analysis.get("export_suitable"))
    local_tender = bool(local_visual.get("visual_tender_cue"))
    local_mature = bool(local_visual.get("visual_mature_cue"))
    local_bad = bool(local_visual.get("visual_bad_cue"))
    detection_labels = [str(det.get("class") or "").lower() for det in detections]
    has_whole_coconut_signal = any("coconut" in label for label in detection_labels) or any(
        keyword in searchable_text for keyword in ("whole coconut", "tender coconut", "ripe coconut", "rotten coconut")
    )
    rotten_visual_cues = (
        "mold",
        "mould",
        "rot",
        "rotten",
        "decay",
        "black patch",
        "black patches",
        "severe discoloration",
        "dark discoloration",
        "crack",
        "cracked",
        "damage",
        "damaged",
        "spoiled",
        "poor surface",
    )
    mature_brown_cues = (
        "brown",
        "mature",
        "ripe",
        "dried",
        "dry husk",
        "fibrous",
        "rough husk",
        "woody",
        "tan",
    )
    tender_visual_cues = (
        "green",
        "young",
        "tender",
        "fresh green",
        "smooth green",
        "immature",
    )
    has_rotten_visual_cue = any(keyword in searchable_text for keyword in rotten_visual_cues)
    has_mature_brown_cue = any(keyword in searchable_text for keyword in mature_brown_cues)
    has_tender_visual_cue = any(keyword in searchable_text for keyword in tender_visual_cues)

    if any(keyword in searchable_text for keyword in ("fibre section", "fiber section", "coir section", "sectioned fibre", "section cut")) or any(
        any(token in label for token in ("fibre", "fiber", "coir")) for label in detection_labels
    ):
        return "Fibre Section", 0.9, "Fibrous or sectioned coconut cues were detected in the image analysis."

    if (
        not has_whole_coconut_signal
        and any(keyword in searchable_text for keyword in ("husk only", "husked section", "outer shell", "outer layer", "peeled outer", "just husk"))
    ) or any("husk" in label for label in detection_labels):
        return "Husk", 0.88, "The result text suggests the image is focused on the coconut husk or outer layer."

    if local_tender and not local_mature:
        return "Tender Coconut", 0.88, "Local color analysis detected dominant green young-coconut cues."

    if local_bad or mold_detected or crack_confidence >= 0.65 or surface_quality == "Poor" or has_rotten_visual_cue:
        return "Rotten Coconut", 0.93, "Mold, severe cracking, or poor surface quality indicates a rotten coconut."

    if has_tender_visual_cue and not has_mature_brown_cue and moisture_percent is not None and moisture_percent >= 60.0 and density_g_cm3 is not None and density_g_cm3 <= 0.35:
        return "Tender Coconut", 0.84, "High estimated water level and low density are consistent with a tender coconut."

    if has_tender_visual_cue and not has_mature_brown_cue and moisture_percent is not None and moisture_percent >= 64.0:
        return "Tender Coconut", 0.8, "The estimated water level is high enough to classify the coconut as tender."

    if local_mature or has_mature_brown_cue:
        return "Ripe Coconut", 0.82, "Brown mature husk cues indicate a ripe coconut rather than a tender coconut."

    if (
        export_suitable
        and grade in {"A", "B", "C"}
        and major_axis_cm is not None
        and minor_axis_cm is not None
        and (major_axis_cm + minor_axis_cm) / 2 >= 15.0
    ):
        return "Ripe Coconut", 0.8, "The quality and size profile best match a mature ripe coconut."

    return "Ripe Coconut", 0.68, "No rotten, husk-only, fibre-section, or tender indicators dominated the assessment."


def grade_assessment(
    mock_sensors: dict[str, float],
    detections: list[dict[str, Any]],
    vision_analysis: dict[str, Any],
    local_visual: dict[str, Any],
) -> tuple[str, float]:
    weight_kg = mock_sensors["weight_kg"]
    surface_quality = vision_analysis["surface_quality"]
    crack_confidence = vision_analysis["crack_confidence"]
    mold_detected = vision_analysis["mold_detected"]
    export_suitable = vision_analysis["export_suitable"]
    local_tender = bool(local_visual.get("visual_tender_cue"))
    local_bad = bool(local_visual.get("visual_bad_cue"))
    color_grade = str(vision_analysis.get("color_grade") or "C").upper()
    vision_text = " ".join(
        [
            str(vision_analysis.get("summary") or ""),
            str(vision_analysis.get("texture_notes") or ""),
        ]
    ).lower()
    bad_visual_keywords = (
        "mold",
        "mould",
        "rot",
        "rotten",
        "decay",
        "black patch",
        "severe discoloration",
        "dark discoloration",
        "crack",
        "cracked",
        "damage",
        "damaged",
        "spoiled",
        "poor surface",
    )
    has_bad_visual_cue = any(keyword in vision_text for keyword in bad_visual_keywords)
    defect_hits, severe_defect = classify_defects(detections)
    defect_count = len(defect_hits)
    max_detection_conf = max((float(det.get("confidence", 0.0)) for det in detections), default=0.0)
    confidence_score = round(max(max_detection_conf, crack_confidence), 3)

    if local_tender and defect_count == 0 and not severe_defect:
        if not mold_detected and crack_confidence <= 0.55 and not local_bad and not has_bad_visual_cue:
            return "A", max(confidence_score, 0.72)
        if surface_quality in {"Excellent", "Good", "Fair"}:
            return "A", max(confidence_score, 0.72)
        return "B", max(confidence_score, 0.65)

    if local_bad or mold_detected or crack_confidence > 0.7 or surface_quality == "Poor" or color_grade == "D" or has_bad_visual_cue:
        return "D", confidence_score

    if defect_count == 0 and surface_quality in {"Excellent", "Good"} and export_suitable and weight_kg >= 1.2:
        return "A", confidence_score

    if defect_count <= 1 and not severe_defect and surface_quality == "Good" and export_suitable and weight_kg >= 1.0:
        return "B", confidence_score

    if surface_quality == "Fair" and weight_kg >= 0.8:
        return "C", confidence_score

    if surface_quality == "Good" and weight_kg >= 1.0:
        return "B", confidence_score

    return "D", confidence_score


def assessment_searchable_text(data: dict[str, Any], detections: list[dict[str, Any]]) -> str:
    return " ".join(
        [
            str(data.get("summary") or data.get("ai_summary") or data.get("geminiAnalysis") or ""),
            str(data.get("texture_notes") or ""),
            str(data.get("classification_reason") or ""),
            str(data.get("surface_quality") or ""),
            " ".join(str(det.get("class") or "") for det in detections),
        ]
    ).lower()


def has_positive_text_signal(searchable_text: str, keywords: tuple[str, ...]) -> bool:
    negation_markers = ("no", "not", "without", "free of", "absent", "none")
    for keyword in keywords:
        for match in re.finditer(re.escape(keyword), searchable_text):
            before = searchable_text[max(0, match.start() - 28) : match.start()].strip()
            if any(before.endswith(marker) or before.endswith(f"{marker} visible") for marker in negation_markers):
                continue
            return True
    return False


def has_hole_signal(searchable_text: str) -> bool:
    return has_positive_text_signal(
        searchable_text,
        ("hole", "holes", "puncture", "punctured", "pierced", "borer", "insect hole", "drilled"),
    )


def has_dark_patch_signal(searchable_text: str, local_visual: dict[str, Any] | None = None) -> bool:
    if bool((local_visual or {}).get("visual_bad_cue")):
        return True
    return has_positive_text_signal(
        searchable_text,
        (
            "dark patch",
            "dark patches",
            "dark brown patch",
            "dark brown patches",
            "dark brown spot",
            "dark brown spots",
            "very dark brown",
            "black patch",
            "black patches",
            "deep brown patch",
            "deep brown patches",
            "severe discoloration",
            "dark discoloration",
            "mold",
            "mould",
            "rot",
            "rotten",
            "decay",
        )
    )


def has_export_blocking_defect(
    data: dict[str, Any],
    detections: list[dict[str, Any]],
    local_visual: dict[str, Any] | None = None,
) -> bool:
    searchable_text = assessment_searchable_text(data, detections)
    surface_quality = str(data.get("surface_quality") or "").lower()
    crack_confidence = float(data.get("crack_confidence") or 0.0)
    return (
        has_hole_signal(searchable_text)
        or has_dark_patch_signal(searchable_text, local_visual)
        or bool(data.get("mold_detected"))
        or crack_confidence >= 0.65
        or surface_quality == "poor"
    )


def determine_export_suitability(
    *,
    vision_analysis: dict[str, Any],
    classification_label: str,
    grade: str,
    detections: list[dict[str, Any]],
    local_visual: dict[str, Any],
) -> bool:
    if has_export_blocking_defect(vision_analysis, detections, local_visual):
        return False

    label = classification_label.lower()
    surface_quality = str(vision_analysis.get("surface_quality") or "").lower()
    local_tender = bool(local_visual.get("visual_tender_cue"))

    if "tender" in label and local_tender:
        return True
    if "tender" in label and grade in {"A", "B"} and surface_quality in {"excellent", "good", "fair"}:
        return True
    if any(blocked_label in label for blocked_label in ("rotten", "fibre", "fiber", "husk")):
        return False
    if grade == "D":
        return False
    if "ripe" in label and grade in {"A", "B"} and surface_quality in {"excellent", "good"}:
        return True

    return bool(vision_analysis.get("export_suitable")) and surface_quality != "poor"


def is_live_camera_source(input_source: str | None, filename: str | None) -> bool:
    source = str(input_source or "").strip().lower()
    name = str(filename or "").lower()
    return source == "camera" or name.startswith("camera-capture-")


def has_live_camera_blocking_defect(
    vision_analysis: dict[str, Any],
    detections: list[dict[str, Any]],
    local_visual: dict[str, Any],
) -> bool:
    searchable_text = assessment_searchable_text(vision_analysis, detections)
    crack_confidence = float(vision_analysis.get("crack_confidence") or 0.0)
    severe_text = any(
        keyword in searchable_text
        for keyword in (
            "severe crack",
            "deep crack",
            "major crack",
            "broken",
            "crushed",
            "damaged",
            "spoiled",
        )
    )
    return (
        has_hole_signal(searchable_text)
        or has_dark_patch_signal(searchable_text, local_visual)
        or bool(vision_analysis.get("mold_detected"))
        or crack_confidence >= 0.72
        or severe_text
    )


def should_apply_live_camera_tender_override(
    *,
    input_source: str | None,
    filename: str | None,
    vision_analysis: dict[str, Any],
    detections: list[dict[str, Any]],
    local_visual: dict[str, Any],
) -> bool:
    if not is_live_camera_source(input_source, filename):
        return False

    if has_live_camera_blocking_defect(vision_analysis, detections, local_visual):
        return False

    searchable_text = assessment_searchable_text(vision_analysis, detections)
    green_ratio = float(local_visual.get("green_ratio") or 0.0)
    brown_ratio = float(local_visual.get("brown_ratio") or 0.0)
    dark_ratio = float(local_visual.get("dark_ratio") or 0.0)
    local_green_signal = (
        bool(local_visual.get("visual_tender_cue"))
        or (green_ratio >= 0.14 and dark_ratio <= 0.32 and green_ratio >= (brown_ratio * 0.35))
    )
    text_green_signal = (
        "green" in searchable_text
        or "young coconut" in searchable_text
        or "tender coconut" in searchable_text
        or "fresh" in searchable_text
    )
    mature_negative_signal = any(
        keyword in searchable_text
        for keyword in ("dry husk", "dried", "woody", "fully brown", "old coconut")
    )
    return (local_green_signal or text_green_signal) and not mature_negative_signal


def format_factor_number(value: Any, suffix: str, decimals: int = 2) -> str:
    if value is None:
        return "Not estimated"
    try:
        number = float(value)
    except (TypeError, ValueError):
        return "Not estimated"
    formatted = f"{number:.{decimals}f}".rstrip("0").rstrip(".")
    return f"{formatted}{suffix}"


def water_level_factor(
    value: Any,
    classification_label: Any = None,
    local_visual: dict[str, Any] | None = None,
) -> str:
    label = str(classification_label or "").lower()
    if "tender" in label or bool((local_visual or {}).get("visual_tender_cue")):
        if value is None:
            return "High Water Level"
        return f"High Water Level ({format_factor_number(value, '%', 1)})"
    if "rotten" in label:
        return "Low / unsafe to accept"

    if value is None:
        return "Not estimated"
    try:
        level = float(value)
    except (TypeError, ValueError):
        return "Not estimated"
    if level >= 62.0:
        band = "High"
    elif level >= 45.0:
        band = "Medium"
    else:
        band = "Low"
    return f"{band} ({format_factor_number(level, '%', 1)})"


def color_factor(color_grade: Any, local_visual: dict[str, Any] | None) -> str:
    dominant = str((local_visual or {}).get("dominant_visual_cue") or "").lower()
    if dominant == "green_tender":
        return "Green / tender"
    if dominant == "brown_mature":
        return "Brown / mature"
    if dominant == "dark_defect":
        return "Dark / defective"
    if dominant == "mixed":
        return "Mixed colour"
    return f"Grade {color_grade}" if color_grade else "Not estimated"


def presence_factor(searchable_text: str, keywords: tuple[str, ...], positive_label: str, negative_label: str) -> str:
    return positive_label if any(keyword in searchable_text for keyword in keywords) else negative_label


def size_factor(major_axis_cm: Any, minor_axis_cm: Any) -> str:
    try:
        major = float(major_axis_cm)
        minor = float(minor_axis_cm)
    except (TypeError, ValueError):
        return "Not estimated"

    average_axis = (major + minor) / 2.0
    if average_axis >= 18.0:
        label = "Large"
    elif average_axis >= 13.0:
        label = "Medium"
    else:
        label = "Small"
    return f"{label} ({format_factor_number(average_axis, ' cm', 1)})"


def pulp_content_factor(classification_label: Any, searchable_text: str) -> str:
    label = str(classification_label or "").lower()
    if "tender" in label:
        return "Soft tender pulp"
    if "ripe" in label:
        return "High pulp content"
    if "rotten" in label:
        return "Poor pulp quality"
    if "fibre" in label or "fiber" in label:
        return "Fibrous content visible"
    if "husk" in label:
        return "Pulp not visible"
    if any(keyword in searchable_text for keyword in ("mature", "ripe", "brown", "firm")):
        return "Firm mature pulp"
    return "Estimated from maturity cues"


def process_output_factor(data: dict[str, Any], searchable_text: str, local_visual: dict[str, Any] | None = None) -> str:
    label = str(data.get("classification_label") or "").lower()
    water_level = data.get("moisture_percent")
    if "tender" in label:
        try:
            water = float(water_level)
        except (TypeError, ValueError):
            water = 0.0
        if bool((local_visual or {}).get("visual_tender_cue")) or water >= 62.0:
            return "High Water Level"
        return "Normal Tender"
    if "ripe" in label:
        return "High Pulp Content"
    if "rotten" in label:
        return "Rotten Coconut"
    if "fibre" in label or "fiber" in label:
        return "Fibre Section"
    if "husk" in label:
        if "semi" in searchable_text:
            return "Semi Husked"
        if "full" in searchable_text or "fully" in searchable_text:
            return "Full Husked"
        return "Husk"
    return str(data.get("classification_label") or "Not estimated")


def build_classification_factors(
    *,
    data: dict[str, Any],
    detections: list[dict[str, Any]],
    local_visual: dict[str, Any] | None = None,
) -> dict[str, str]:
    searchable_text = assessment_searchable_text(data, detections)

    if has_dark_patch_signal(searchable_text, local_visual):
        patches = "Dark patches detected"
    else:
        patches = presence_factor(
            searchable_text,
            ("patch", "patches", "spot", "spots", "stain", "discolor", "blemish"),
            "Minor patches visible",
            "Not prominent",
        )

    return {
        "label": str(data.get("classification_label") or "Not estimated"),
        "process_output": process_output_factor(data, searchable_text, local_visual),
        "colour": color_factor(data.get("color_grade"), local_visual),
        "water_level": water_level_factor(data.get("moisture_percent"), data.get("classification_label"), local_visual),
        "holes": "Detected / visible" if has_hole_signal(searchable_text) else "Not detected",
        "patches": patches,
        "size": size_factor(data.get("major_axis_cm"), data.get("minor_axis_cm")),
        "pulp_content": pulp_content_factor(data.get("classification_label"), searchable_text),
        "volume": format_factor_number(data.get("volume_cm3"), " cm3", 2),
        "density": format_factor_number(data.get("density_g_cm3"), " g/cm3", 3),
        "weight": format_factor_number(data.get("weight_kg"), " kg", 2),
    }


def serialize_assessment(row_or_dict: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
    data = dict(row_or_dict)
    raw_detections = data.get("yolo_detections_json") or "[]"
    try:
        detections = json.loads(raw_detections) if isinstance(raw_detections, str) else raw_detections
    except json.JSONDecodeError:
        detections = []

    assessment = {
        "id": data.get("id"),
        "timestamp": data.get("timestamp") or data.get("createdAt"),
        "image_path": data.get("image_path") or data.get("imagePath"),
        "grade": data.get("grade"),
        "weight_kg": data.get("weight_kg"),
        "height_cm": data.get("height_cm"),
        "height_source": data.get("height_source"),
        "height_confidence": data.get("height_confidence"),
        "moisture_percent": data.get("moisture_percent"),
        "water_level_percent": data.get("moisture_percent"),
        "classification_label": data.get("classification_label"),
        "classification_confidence": data.get("classification_confidence"),
        "classification_reason": data.get("classification_reason"),
        "major_axis_cm": data.get("major_axis_cm"),
        "minor_axis_cm": data.get("minor_axis_cm"),
        "volume_cm3": data.get("volume_cm3"),
        "density_g_cm3": data.get("density_g_cm3"),
        "surface_quality": data.get("surface_quality"),
        "crack_confidence": data.get("crack_confidence"),
        "mold_detected": bool(data.get("mold_detected")),
        "color_grade": data.get("color_grade"),
        "export_suitable": bool(data.get("export_suitable")),
        "ai_summary": data.get("ai_summary") or data.get("geminiAnalysis") or "",
        "yolo_detections": detections,
        "confidence_score": data.get("confidence_score"),
        "inference_warning": data.get("inference_warning"),
        "axis_detected": bool(data.get("axis_detected")) if data.get("axis_detected") is not None else False,
        "axis_source": data.get("axis_source"),
        "axis_angle_degrees": data.get("axis_angle_degrees"),
        "axis_confidence": data.get("axis_confidence"),
        "axis_warning": data.get("axis_warning"),
        "classification_factors": data.get("classification_factors")
        or build_classification_factors(
            data=data,
            detections=detections if isinstance(detections, list) else [],
            local_visual=data.get("local_visual") if isinstance(data.get("local_visual"), dict) else None,
        ),
    }

    assessment.update(
        {
            "createdAt": assessment["timestamp"],
            "imagePath": assessment["image_path"],
            "weight": assessment["weight_kg"],
            "height": assessment["height_cm"],
            "heightSource": assessment["height_source"],
            "heightConfidence": assessment["height_confidence"],
            "waterContent": assessment["moisture_percent"],
            "waterLevel": assessment["water_level_percent"],
            "classificationLabel": assessment["classification_label"],
            "classificationConfidence": assessment["classification_confidence"],
            "classificationReason": assessment["classification_reason"],
            "diameter": assessment["major_axis_cm"],
            "majorAxis": assessment["major_axis_cm"],
            "minorAxis": assessment["minor_axis_cm"],
            "volume": assessment["volume_cm3"],
            "density": assessment["density_g_cm3"],
            "moldSpots": assessment["mold_detected"],
            "cracksDamage": assessment["crack_confidence"] is not None and assessment["crack_confidence"] > 0.7,
            "shellColor": assessment["color_grade"],
            "geminiAnalysis": assessment["ai_summary"],
            "predictions": assessment["yolo_detections"],
            "score": int(round((assessment["confidence_score"] or 0) * 100)),
            "axisDetected": assessment["axis_detected"],
            "axisSource": assessment["axis_source"],
            "axisAngleDegrees": assessment["axis_angle_degrees"],
            "axisConfidence": assessment["axis_confidence"],
            "issues": [],
            "recommendations": [],
        }
    )
    return assessment


def save_assessment(record: dict[str, Any]) -> dict[str, Any]:
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute(
        """
        INSERT INTO assessments (
            id, timestamp, image_path, image_hash, grade, weight_kg, height_cm, height_source, height_confidence, moisture_percent,
            classification_label, classification_confidence, classification_reason,
            major_axis_cm, minor_axis_cm, volume_cm3, density_g_cm3, surface_quality,
            crack_confidence, mold_detected, color_grade, export_suitable, ai_summary,
            yolo_detections_json, confidence_score
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            record["id"],
            record["timestamp"],
            record["image_path"],
            record["image_hash"],
            record["grade"],
            record["weight_kg"],
            record["height_cm"],
            record["height_source"],
            record["height_confidence"],
            record["moisture_percent"],
            record["classification_label"],
            record["classification_confidence"],
            record["classification_reason"],
            record["major_axis_cm"],
            record["minor_axis_cm"],
            record["volume_cm3"],
            record["density_g_cm3"],
            record["surface_quality"],
            record["crack_confidence"],
            1 if record["mold_detected"] else 0,
            record["color_grade"],
            1 if record["export_suitable"] else 0,
            record["ai_summary"],
            json.dumps(record["yolo_detections"]),
            record["confidence_score"],
        ),
    )
    conn.commit()
    conn.close()
    return serialize_assessment(record)


def process_uploaded_image(image_file, roboflow_client=None, input_source: str | None = None) -> dict[str, Any]:
    require_backend_dependencies()

    if roboflow_client is None:
        roboflow_client = create_roboflow_client()

    if not image_file or not image_file.filename:
        raise BackendError("No image file selected.", 400)
    if not allowed_file(image_file.filename):
        raise BackendError("Unsupported file type. Use jpg, png, or webp.", 400)

    image_bytes = image_file.read()
    if not image_bytes:
        raise BackendError("Uploaded image is empty.", 400)

    image_hash = compute_image_hash(image_bytes)
    image_path, reused_existing_image = get_or_store_capture_path(image_file.filename, image_bytes, image_hash)

    raw_results, inference_warning = run_roboflow_inference(image_path, roboflow_client)

    detections = extract_yolo_detections(raw_results)
    yolo_coconut_detection = find_coconut_bbox(detections)
    local_coconut_detection = detect_coconut_with_local_model(image_path)
    coconut_detection = yolo_coconut_detection or local_coconut_detection
    measurements = measure_coconut_axes(image_path, coconut_detection)
    local_visual = analyze_local_color_cues(image_path, coconut_detection)
    predicted_height_cm, height_source, height_confidence = predict_height_from_axes(
        measurements["major_axis_cm"],
        measurements["minor_axis_cm"],
        axis_confidence=measurements["axis_confidence"],
    )
    mock_sensors = generate_mock_sensor_values(predicted_height_cm)
    volume_cm3, density_g_cm3 = compute_volume_and_density(
        measurements["major_axis_cm"],
        measurements["minor_axis_cm"],
        float(mock_sensors["height_cm"]),
        float(mock_sensors["weight_kg"]),
    )

    if inference_warning and measurements["axis_detected"] and measurements["axis_source"] == "local_shape_model":
        inference_warning = f"{inference_warning} Local shape model used to recover coconut axis detection."
    elif inference_warning and not measurements["axis_detected"]:
        inference_warning = f"{inference_warning} Local axis model could not isolate the coconut contour."

    vision_analysis = call_gemini_vision(image_path)
    grade, confidence_score = grade_assessment(mock_sensors, detections, vision_analysis, local_visual)
    classification_label, classification_confidence, classification_reason = classify_coconut_category(
        detections=detections,
        vision_analysis=vision_analysis,
        local_visual=local_visual,
        grade=grade,
        moisture_percent=float(mock_sensors["moisture_percent"]),
        density_g_cm3=density_g_cm3,
        major_axis_cm=measurements["major_axis_cm"],
        minor_axis_cm=measurements["minor_axis_cm"],
    )
    live_camera_tender_override = should_apply_live_camera_tender_override(
        input_source=input_source,
        filename=image_file.filename,
        vision_analysis={
            **vision_analysis,
            "classification_label": classification_label,
            "classification_reason": classification_reason,
        },
        detections=detections,
        local_visual=local_visual,
    )
    if live_camera_tender_override:
        grade = "A"
        confidence_score = max(float(confidence_score or 0.0), 0.78)
        classification_label = "Tender Coconut"
        classification_confidence = max(float(classification_confidence or 0.0), 0.88)
        classification_reason = "Live camera green-coconut cue detected; light surface scratches are treated as tender quality unless holes, dark patches, mold, or severe cracks are present."
        local_visual = {
            **local_visual,
            "visual_tender_cue": True,
            "visual_mature_cue": False,
            "dominant_visual_cue": "green_tender",
            "live_camera_tender_override": True,
        }
        final_export_suitable = True
    else:
        final_export_suitable = determine_export_suitability(
            vision_analysis={
                **vision_analysis,
                "classification_label": classification_label,
                "classification_reason": classification_reason,
            },
            classification_label=classification_label,
            grade=grade,
            detections=detections,
            local_visual=local_visual,
        )

    record = {
        "id": str(uuid.uuid4()),
        "timestamp": datetime.now().isoformat(),
        "image_path": str(image_path).replace("\\", "/"),
        "image_hash": image_hash,
        "grade": grade,
        "weight_kg": mock_sensors["weight_kg"],
        "height_cm": mock_sensors["height_cm"],
        "height_source": height_source or mock_sensors["height_source"],
        "height_confidence": height_confidence,
        "moisture_percent": mock_sensors["moisture_percent"],
        "classification_label": classification_label,
        "classification_confidence": classification_confidence,
        "classification_reason": classification_reason,
        "major_axis_cm": measurements["major_axis_cm"],
        "minor_axis_cm": measurements["minor_axis_cm"],
        "volume_cm3": volume_cm3,
        "density_g_cm3": density_g_cm3,
        "surface_quality": vision_analysis["surface_quality"],
        "crack_confidence": vision_analysis["crack_confidence"],
        "mold_detected": vision_analysis["mold_detected"],
        "color_grade": vision_analysis["color_grade"],
        "export_suitable": final_export_suitable,
        "ai_summary": vision_analysis["summary"],
        "texture_notes": vision_analysis["texture_notes"],
        "yolo_detections": detections,
        "confidence_score": confidence_score,
        "coconut_detected": coconut_detection is not None,
        "axis_detected": measurements["axis_detected"],
        "axis_source": measurements["axis_source"],
        "axis_angle_degrees": measurements["axis_angle_degrees"],
        "axis_confidence": measurements["axis_confidence"],
        "axis_warning": measurements["axis_warning"],
        "inference_warning": inference_warning,
        "local_visual": local_visual,
        "input_source": input_source or "upload",
    }

    saved = save_assessment(record)
    saved["texture_notes"] = vision_analysis["texture_notes"]
    saved["coconut_detected"] = coconut_detection is not None
    saved["axis_detected"] = measurements["axis_detected"]
    saved["axis_source"] = measurements["axis_source"]
    saved["axis_angle_degrees"] = measurements["axis_angle_degrees"]
    saved["axis_confidence"] = measurements["axis_confidence"]
    saved["axis_warning"] = measurements["axis_warning"]
    saved["filename"] = image_file.filename
    saved["reused_existing_image"] = reused_existing_image
    saved["local_visual"] = local_visual
    saved["input_source"] = input_source or "upload"
    return saved


def build_batch_error_result(image_file, error_message: str) -> dict[str, Any]:
    return {
        "id": None,
        "timestamp": datetime.now().isoformat(),
        "image_path": None,
        "grade": None,
        "weight_kg": None,
        "height_cm": None,
        "height_source": None,
        "height_confidence": None,
        "moisture_percent": None,
        "classification_label": None,
        "classification_confidence": None,
        "classification_reason": None,
        "major_axis_cm": None,
        "minor_axis_cm": None,
        "volume_cm3": None,
        "density_g_cm3": None,
        "surface_quality": None,
        "crack_confidence": None,
        "mold_detected": None,
        "color_grade": None,
        "export_suitable": False,
        "ai_summary": "",
        "texture_notes": "",
        "confidence_score": 0,
        "yolo_detections": [],
        "coconut_detected": False,
        "axis_detected": False,
        "axis_source": None,
        "axis_angle_degrees": None,
        "axis_confidence": None,
        "axis_warning": None,
        "filename": getattr(image_file, "filename", "unknown"),
        "error": error_message,
        "createdAt": datetime.now().isoformat(),
        "imagePath": None,
        "weight": None,
        "height": None,
        "heightSource": None,
        "heightConfidence": None,
        "waterContent": None,
        "classificationLabel": None,
        "classificationConfidence": None,
        "classificationReason": None,
        "diameter": None,
        "majorAxis": None,
        "minorAxis": None,
        "volume": None,
        "density": None,
        "moldSpots": False,
        "cracksDamage": False,
        "shellColor": None,
        "geminiAnalysis": "",
        "predictions": [],
        "score": 0,
        "axisDetected": False,
        "axisSource": None,
        "axisAngleDegrees": None,
        "axisConfidence": None,
        "issues": [],
        "recommendations": [],
    }


def build_batch_summary(results: list[dict[str, Any]], processing_time_seconds: float) -> dict[str, Any]:
    grade_breakdown = {"A": 0, "B": 0, "C": 0, "D": 0}
    export_suitable_count = 0
    weights = []
    moisture_values = []

    for item in results:
        grade = item.get("grade")
        if grade in grade_breakdown:
            grade_breakdown[grade] += 1
        if item.get("export_suitable"):
            export_suitable_count += 1
        if item.get("weight_kg") is not None:
            weights.append(float(item["weight_kg"]))
        if item.get("moisture_percent") is not None:
            moisture_values.append(float(item["moisture_percent"]))

    average_weight = round(sum(weights) / len(weights), 2) if weights else 0.0
    average_moisture = round(sum(moisture_values) / len(moisture_values), 2) if moisture_values else 0.0

    return {
        "type": "batch_summary",
        "total_processed": len(results),
        "grade_breakdown": grade_breakdown,
        "export_suitable_count": export_suitable_count,
        "average_weight": average_weight,
        "average_moisture": average_moisture,
        "average_water_level": average_moisture,
        "processing_time_seconds": round(processing_time_seconds, 2),
    }


def parse_iso_timestamp(value: str, param_name: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise BackendError(f"{param_name} cannot be empty.", 400)

    candidate = normalized.replace("Z", "+00:00")
    try:
        datetime.fromisoformat(candidate)
    except ValueError as exc:
        raise BackendError(f"{param_name} must be a valid ISO timestamp.", 400) from exc
    return normalized


def fetch_report_session_rows(start_time: str | None, end_time: str | None) -> list[sqlite3.Row]:
    query = "SELECT * FROM assessments"
    params: list[Any] = []
    conditions = []

    if start_time:
        conditions.append("timestamp >= ?")
        params.append(start_time)
    if end_time:
        conditions.append("timestamp <= ?")
        params.append(end_time)

    if conditions:
        query += " WHERE " + " AND ".join(conditions)
        query += " ORDER BY timestamp DESC"
    else:
        query += " ORDER BY timestamp DESC LIMIT 50"

    conn = get_readonly_db_connection()
    try:
        return conn.execute(query, params).fetchall()
    finally:
        conn.close()


def average_or_none(values: list[float]) -> float | None:
    if not values:
        return None
    return round(sum(values) / len(values), 2)


def extract_common_defects_from_summaries(rows: list[sqlite3.Row]) -> list[dict[str, Any]]:
    defect_patterns = {
        "cracks": (r"\bcrack(?:ed|s)?\b",),
        "mold": (r"\bmold(?:y)?\b",),
        "discoloration": (r"\bdiscolor(?:ation|ed)?\b",),
        "surface marks": (r"\bmark(?:s)?\b", r"\bblemish(?:es)?\b", r"\bimperfection(?:s)?\b"),
        "rot": (r"\brot(?:ten)?\b",),
        "bruising": (r"\bbruise(?:d|s)?\b", r"\bbruising\b"),
        "damage": (r"\bdamage\b", r"\bdamaged\b", r"\bdefect(?:s)?\b"),
        "dryness": (r"\bdry\b", r"\bdryness\b",),
    }

    counts: dict[str, int] = {label: 0 for label in defect_patterns}
    total = len(rows)

    for row in rows:
        summary = str(row["ai_summary"] or "").lower()
        if not summary:
            continue
        for label, patterns in defect_patterns.items():
            if any(re.search(pattern, summary) for pattern in patterns):
                counts[label] += 1

    ranked = [
        {
            "defect": label,
            "count": count,
            "percent": round((count / total) * 100, 1) if total else 0.0,
        }
        for label, count in counts.items()
        if count > 0
    ]
    ranked.sort(key=lambda item: (-item["count"], item["defect"]))
    return ranked[:5]


def compute_report_session_stats(
    rows: list[sqlite3.Row],
    *,
    start_time: str | None,
    end_time: str | None,
) -> dict[str, Any]:
    total = len(rows)
    grade_counts = {"A": 0, "B": 0, "C": 0, "D": 0}
    export_suitable_count = 0
    weights: list[float] = []
    heights: list[float] = []
    moisture_values: list[float] = []
    confidence_values: list[float] = []

    for row in rows:
        grade = str(row["grade"] or "").upper()
        if grade in grade_counts:
            grade_counts[grade] += 1
        if row["export_suitable"]:
            export_suitable_count += 1
        if row["weight_kg"] is not None:
            weights.append(float(row["weight_kg"]))
        if row["height_cm"] is not None:
            heights.append(float(row["height_cm"]))
        if row["moisture_percent"] is not None:
            moisture_values.append(float(row["moisture_percent"]))
        if row["confidence_score"] is not None:
            confidence_values.append(float(row["confidence_score"]))

    grade_breakdown_percent = {
        grade: round((count / total) * 100, 1) if total else 0.0 for grade, count in grade_counts.items()
    }
    highest_confidence = round(max(confidence_values), 3) if confidence_values else None
    lowest_confidence = round(min(confidence_values), 3) if confidence_values else None

    return {
        "total_assessed": total,
        "time_range": {
            "start_time": start_time,
            "end_time": end_time,
            "mode": "custom_range" if (start_time or end_time) else "latest_50",
        },
        "grade_breakdown_count": grade_counts,
        "grade_breakdown_percent": grade_breakdown_percent,
        "grade_ab_percent": round(
            ((grade_counts["A"] + grade_counts["B"]) / total) * 100, 1
        ) if total else 0.0,
        "export_suitable_count": export_suitable_count,
        "export_suitable_percent": round((export_suitable_count / total) * 100, 1) if total else 0.0,
        "average_weight_kg": average_or_none(weights),
        "average_height_cm": average_or_none(heights),
        "average_moisture_percent": average_or_none(moisture_values),
        "average_water_level_percent": average_or_none(moisture_values),
        "most_common_defects": extract_common_defects_from_summaries(rows),
        "highest_confidence_score": highest_confidence,
        "lowest_confidence_score": lowest_confidence,
    }


def generate_report_session_text(stats: dict[str, Any]) -> str:
    return call_gemini_chat(
        [
            {"role": "system", "content": SESSION_REPORT_SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(stats, default=str)},
        ],
        max_tokens=220,
        temperature=0.3,
    )


def build_multipart_body(
    fields: dict[str, str],
    files: dict[str, tuple[str, bytes, str]],
) -> tuple[bytes, str]:
    boundary = f"----coconut-grader-{uuid.uuid4().hex}"
    chunks: list[bytes] = []

    for name, value in fields.items():
        chunks.extend(
            [
                f"--{boundary}\r\n".encode("utf-8"),
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8"),
                str(value).encode("utf-8"),
                b"\r\n",
            ]
        )

    for name, (filename, file_bytes, content_type) in files.items():
        safe_name = secure_filename(filename) or "voice-question.webm"
        chunks.extend(
            [
                f"--{boundary}\r\n".encode("utf-8"),
                (
                    f'Content-Disposition: form-data; name="{name}"; '
                    f'filename="{safe_name}"\r\n'
                ).encode("utf-8"),
                f"Content-Type: {content_type or 'application/octet-stream'}\r\n\r\n".encode("utf-8"),
                file_bytes,
                b"\r\n",
            ]
        )

    chunks.append(f"--{boundary}--\r\n".encode("utf-8"))
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def call_sarvam_speech_to_text(
    audio_bytes: bytes,
    *,
    filename: str,
    content_type: str,
    language_code: str = "unknown",
) -> dict[str, Any]:
    if not SARVAM_API_KEY:
        raise BackendError("SARVAM_API_KEY is not set.", 500)

    body, multipart_content_type = build_multipart_body(
        {
            "model": SARVAM_STT_MODEL,
            "mode": "codemix" if SARVAM_STT_MODEL == "saaras:v3" else "transcribe",
            "language_code": language_code or "unknown",
        },
        {"file": (filename, audio_bytes, content_type)},
    )
    request_obj = urllib.request.Request(
        "https://api.sarvam.ai/speech-to-text",
        data=body,
        headers={
            "api-subscription-key": SARVAM_API_KEY,
            "Content-Type": multipart_content_type,
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request_obj, timeout=60) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode("utf-8", errors="ignore")
        raise BackendError(f"Sarvam speech-to-text failed: {body_text or exc.reason}", 500)
    except urllib.error.URLError as exc:
        raise BackendError(f"Sarvam speech-to-text failed: {exc.reason}", 500)
    except Exception as exc:
        raise BackendError(f"Sarvam speech-to-text failed: {exc}", 500)


def call_sarvam_text_to_speech(
    text: str,
    *,
    language_code: str = "hi-IN",
) -> dict[str, Any]:
    if not SARVAM_API_KEY:
        raise BackendError("SARVAM_API_KEY is not set.", 500)

    payload = {
        "text": text[:2400],
        "target_language_code": language_code or "hi-IN",
        "speaker": SARVAM_TTS_SPEAKER,
        "model": SARVAM_TTS_MODEL,
        "pace": 0.95,
        "speech_sample_rate": 24000,
        "output_audio_codec": "wav",
        "temperature": 0.45,
    }
    request_obj = urllib.request.Request(
        "https://api.sarvam.ai/text-to-speech",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "api-subscription-key": SARVAM_API_KEY,
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request_obj, timeout=60) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode("utf-8", errors="ignore")
        raise BackendError(f"Sarvam text-to-speech failed: {body_text or exc.reason}", 500)
    except urllib.error.URLError as exc:
        raise BackendError(f"Sarvam text-to-speech failed: {exc.reason}", 500)
    except Exception as exc:
        raise BackendError(f"Sarvam text-to-speech failed: {exc}", 500)


@app.route("/api/assess", methods=["POST"])
def assess_coconut():
    if "image" not in request.files:
        raise BackendError("No image file uploaded. Use form field 'image'.", 400)
    input_source = str(request.form.get("input_source") or "upload")
    saved = process_uploaded_image(request.files["image"], input_source=input_source)
    return jsonify(saved)


@app.route("/api/assess/batch", methods=["POST"])
def assess_coconut_batch():
    files = request.files.getlist("images")
    if not files:
        raise BackendError("No image files uploaded. Use form field 'images'.", 400)
    if len(files) > 20:
        raise BackendError("Batch limit exceeded. Upload up to 20 images per request.", 400)

    batch_started = time.time()
    roboflow_client = create_roboflow_client()
    results = []

    for image_file in files:
        try:
            results.append(process_uploaded_image(image_file, roboflow_client=roboflow_client))
        except BackendError as exc:
            results.append(build_batch_error_result(image_file, exc.message))
        except Exception as exc:
            results.append(build_batch_error_result(image_file, str(exc)))

    results.append(build_batch_summary(results, time.time() - batch_started))
    return jsonify(results)


@app.route("/api/history", methods=["GET"])
def get_history():
    conn = get_db_connection()
    rows = conn.execute("SELECT * FROM assessments ORDER BY timestamp DESC LIMIT 100").fetchall()
    conn.close()
    return jsonify([serialize_assessment(row) for row in rows])


@app.route("/api/history-image/<record_id>", methods=["GET"])
def get_history_image(record_id: str):
    conn = get_db_connection()
    row = conn.execute("SELECT image_path FROM assessments WHERE id = ?", (record_id,)).fetchone()
    conn.close()

    if not row or not row["image_path"]:
        return jsonify({"error": "Image not found"}), 404

    image_path = Path(str(row["image_path"]))
    if not image_path.exists() or not image_path.is_file():
        return jsonify({"error": "Image file missing"}), 404

    return send_file(image_path)


@app.route("/api/stats", methods=["GET"])
def get_stats():
    conn = get_db_connection()
    rows = conn.execute("SELECT grade, confidence_score, export_suitable FROM assessments").fetchall()
    conn.close()

    total = len(rows)
    grade_counts = {"A": 0, "B": 0, "C": 0, "D": 0}
    avg_confidence = 0.0
    export_ready = 0

    for row in rows:
        grade = row["grade"]
        if grade in grade_counts:
            grade_counts[grade] += 1
        avg_confidence += float(row["confidence_score"] or 0.0)
        export_ready += int(row["export_suitable"] or 0)

    if total:
        avg_confidence = round(avg_confidence / total, 3)

    return jsonify(
        {
            "total": total,
            "grade_counts": grade_counts,
            "average_confidence": avg_confidence,
            "export_ready": export_ready,
        }
    )


@app.route("/api/report/session", methods=["GET"])
def get_report_session():
    start_time = request.args.get("start_time")
    end_time = request.args.get("end_time")

    normalized_start = parse_iso_timestamp(start_time, "start_time") if start_time is not None else None
    normalized_end = parse_iso_timestamp(end_time, "end_time") if end_time is not None else None
    if normalized_start and normalized_end and normalized_start > normalized_end:
        raise BackendError("start_time must be earlier than or equal to end_time.", 400)

    rows = fetch_report_session_rows(normalized_start, normalized_end)
    stats = compute_report_session_stats(rows, start_time=normalized_start, end_time=normalized_end)

    if stats["total_assessed"] == 0:
        report_text = "No assessments were found for the selected period, so there is no shift summary to report yet."
    else:
        report_text = generate_report_session_text(stats)

    return jsonify(
        {
            "report_text": report_text,
            "stats": stats,
            "generated_at": datetime.now().isoformat(),
        }
    )


@app.route("/api/sarvam/speech-to-text", methods=["POST"])
def sarvam_speech_to_text():
    if "audio" not in request.files:
        raise BackendError("No audio file uploaded. Use form field 'audio'.", 400)

    audio_file = request.files["audio"]
    audio_bytes = audio_file.read()
    if not audio_bytes:
        raise BackendError("Audio recording is empty.", 400)

    language_code = str(request.form.get("language_code") or "unknown")
    response_payload = call_sarvam_speech_to_text(
        audio_bytes,
        filename=audio_file.filename or "voice-question.webm",
        content_type=audio_file.content_type or "audio/webm",
        language_code=language_code,
    )
    return jsonify(
        {
            "transcript": response_payload.get("transcript", ""),
            "language_code": response_payload.get("language_code"),
            "language_probability": response_payload.get("language_probability"),
        }
    )


@app.route("/api/sarvam/text-to-speech", methods=["POST"])
def sarvam_text_to_speech():
    data = request.get_json(silent=True) or {}
    text = str(data.get("text", "")).strip()
    if not text:
        raise BackendError("Text is required.", 400)

    language_code = str(data.get("language_code") or "hi-IN")
    response_payload = call_sarvam_text_to_speech(text, language_code=language_code)
    audios = response_payload.get("audios") or []
    if not audios:
        raise BackendError("Sarvam did not return audio.", 500)

    return jsonify(
        {
            "audio_base64": audios[0],
            "audio_mime_type": "audio/wav",
            "request_id": response_payload.get("request_id"),
        }
    )


@app.route("/api/coconut-assessments/<record_id>", methods=["DELETE"])
def delete_record(record_id: str):
    conn = get_db_connection()
    row = conn.execute("SELECT image_path FROM assessments WHERE id = ?", (record_id,)).fetchone()
    conn.execute("DELETE FROM assessments WHERE id = ?", (record_id,))
    conn.commit()

    still_used = 0
    if row and row["image_path"]:
        still_used = conn.execute(
            "SELECT COUNT(*) FROM assessments WHERE image_path = ?",
            (row["image_path"],),
        ).fetchone()[0]
    conn.close()

    if row and row["image_path"] and still_used == 0:
        image_path = Path(row["image_path"])
        if image_path.exists():
            try:
                image_path.unlink()
            except OSError:
                _log(f"Could not delete image: {image_path}")

    return jsonify({"status": "deleted"})


@app.route("/api/copilot", methods=["POST"])
def copilot():
    data = request.get_json(silent=True) or {}
    question = str(data.get("question", "")).strip()
    if not question:
        raise BackendError("Question is required.", 400)

    conversation_history = normalize_conversation_history(data.get("conversation_history"))
    direct_answer = answer_common_copilot_question(question)
    if direct_answer is not None:
        return jsonify(direct_answer)

    if not GEMINI_API_KEY:
        return jsonify(
            {
                "answer": "AI assistant is not available. Set GEMINI_API_KEY to enable copilot responses.",
                "data": [],
                "query_used": None,
            }
        )

    sql_candidate = clean_sql_candidate(generate_copilot_sql(question, conversation_history))
    if sql_candidate.upper() == "NOT_SQL":
        answer = answer_copilot_fallback(question, conversation_history)
        return jsonify({"answer": answer, "data": [], "query_used": None})

    if not is_safe_select_query(sql_candidate):
        answer = answer_copilot_fallback(question, conversation_history)
        return jsonify({"answer": answer, "data": [], "query_used": None})

    try:
        rows = execute_copilot_query(sql_candidate)
    except BackendError:
        answer = answer_copilot_fallback(question, conversation_history)
        return jsonify({"answer": answer, "data": [], "query_used": None})

    answer = answer_copilot_with_data(question, conversation_history, sql_candidate, rows)
    return jsonify({"answer": answer, "data": rows, "query_used": sql_candidate})


if __name__ == "__main__":
    init_db()
    _log("Upload mode backend ready.")
    app.run(host="0.0.0.0", port=5000, debug=True)
