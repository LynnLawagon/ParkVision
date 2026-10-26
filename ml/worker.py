"""Persistent local JSON-lines inference process. Never connects to Supabase."""
import base64
import contextlib
import hashlib
import io
import json
import math
import os
import sys
import time
from pathlib import Path

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")

def emit(value):
    sys.stdout.write(json.dumps(value, allow_nan=False) + "\n")
    sys.stdout.flush()

def validate_regions(regions):
    if not isinstance(regions, list) or not 1 <= len(regions) <= 100:
        raise ValueError("Choose between 1 and 100 parking regions.")
    seen = set()
    for region in regions:
        if not isinstance(region, dict) or not isinstance(region.get("id"), str) or not region["id"]:
            raise ValueError("Every region needs an ID.")
        if region["id"] in seen:
            raise ValueError("Region IDs must be unique.")
        seen.add(region["id"])
        values = [region.get(k) for k in ("x", "y", "width", "height")]
        if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in values):
            raise ValueError("Region coordinates must be finite numbers.")
        x, y, width, height = values
        if x < 0 or y < 0 or width <= 0 or height <= 0 or x + width > 1.00000001 or y + height > 1.00000001:
            raise ValueError("Parking regions must fit inside the image.")
    return regions

def analyze(model, tf, np, Image, ImageOps, payload):
    regions = validate_regions(payload.get("regions"))
    minimum = payload.get("minimumConfidence", 0.8)
    if isinstance(minimum, bool) or not isinstance(minimum, (float, int)) or not 0.5 <= minimum <= 1:
        raise ValueError("Minimum confidence must be between 0.5 and 1.")
    encoded = payload.get("image", "")
    if not isinstance(encoded, str) or len(encoded) > 12_000_000:
        raise ValueError("Image is too large.")
    raw = base64.b64decode(encoded, validate=True)
    with Image.open(io.BytesIO(raw)) as source:
        if source.format not in ("JPEG", "PNG", "WEBP"):
            raise ValueError("Use a JPEG, PNG, or WebP image.")
        if source.width * source.height > 20_000_000:
            raise ValueError("Resize the image to fewer than 20 megapixels.")
        image = ImageOps.exif_transpose(source).convert("RGB")
    image_width, image_height = image.size
    tensors = []
    for region in regions:
        left = max(0, math.floor(region["x"] * image_width))
        top = max(0, math.floor(region["y"] * image_height))
        right = min(image_width, math.ceil((region["x"] + region["width"]) * image_width))
        bottom = min(image_height, math.ceil((region["y"] + region["height"]) * image_height))
        if right - left < 8 or bottom - top < 8:
            raise ValueError("A parking region is too small; draw a larger box.")
        crop = np.asarray(image.crop((left, top, right, bottom)), dtype=np.float32)
        tensors.append(tf.image.resize(crop, [224, 224], method="bilinear"))
    started = time.perf_counter()
    scores = np.asarray(model(tf.stack(tensors), training=False)).reshape(-1)
    if len(scores) != len(regions):
        raise ValueError("Model output does not match the number of parking regions.")
    results = []
    for region, score in zip(regions, scores):
        p = float(score)
        if not math.isfinite(p) or not 0 <= p <= 1:
            raise ValueError("The model returned an invalid occupancy score.")
        confidence = p if p >= 0.5 else 1 - p
        results.append({"regionId": region["id"], "status": "occupied" if p >= 0.5 else "vacant",
                        "occupancyScore": p, "confidence": confidence, "requiresReview": confidence < minimum})
    return {"results": results, "width": image_width, "height": image_height,
            "inferenceMs": round((time.perf_counter() - started) * 1000, 1), "minimumConfidence": minimum}

def main():
    try:
        with contextlib.redirect_stdout(sys.stderr):
            import numpy as np
            import tensorflow as tf
            from PIL import Image, ImageOps
            Image.MAX_IMAGE_PIXELS = 20_000_000
            path = Path(sys.argv[1]).expanduser().resolve()
            if not path.is_file():
                raise ValueError("Model file missing. Place the trained .keras export in ml/models or set MODEL_PATH.")
            model = tf.keras.models.load_model(path, compile=False)
            if tuple(model.input_shape[1:]) != (224, 224, 3) or model.output_shape[-1] != 1:
                raise ValueError("Expected the S2 binary model with 224×224 RGB input and one output.")
            model(tf.zeros((1, 224, 224, 3), dtype=tf.float32), training=False)
        info = {"name": "EfficientNetB0_PKLot", "version": hashlib.sha256(path.read_bytes()).hexdigest()[:12],
                "classes": ["vacant", "occupied"], "tensorflow": tf.__version__}
        emit({"type": "ready", "model": info})
    except Exception as error:
        emit({"type": "fatal", "error": str(error)})
        return 1
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            with contextlib.redirect_stdout(sys.stderr):
                result = analyze(model, tf, np, Image, ImageOps, request.get("payload", {}))
            emit({"id": request["id"], "result": {**result, "model": info}})
        except Exception as error:
            emit({"id": request.get("id"), "error": str(error)})
    return 0

if __name__ == "__main__":
    sys.exit(main())
