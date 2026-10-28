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

def model_metadata(path):
    """Validate the optional Colab sidecar; legacy S2 exports remain supported."""
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    sidecar = path.with_suffix('.metadata.json')
    if not sidecar.exists():
        return digest, {}
    metadata = json.loads(sidecar.read_text())
    expected = {"input_size": [224, 224], "color_mode": "RGB", "input_dtype": "float32",
                "input_range": [0, 255], "resize_method": "bilinear", "preprocessing_inside_model": True}
    if metadata.get('format_version') == 2:
        expected.update({"task": "parking_three_class", "class_names": ["vacant", "occupied", "blocked"],
                         "app_statuses": ["vacant", "occupied", "blocked"], "output_activation": "softmax"})
    else:
        expected.update({"format_version": 1, "class_names": ["unoccupied", "occupied"],
                         "app_statuses": ["vacant", "occupied"], "occupied_threshold": 0.5})
    if metadata.get('sha256') != digest:
        raise ValueError("Model and metadata do not match. Copy both files from the same Colab export.")
    if any(metadata.get(key) != value for key, value in expected.items()):
        raise ValueError("Model metadata does not match the app's RGB input and label contract.")
    return digest, metadata

def classify_scores(scores, classes, minimum):
    """Map explicit model outputs to database statuses; never infer label order."""
    if classes == ["vacant", "occupied"] and len(scores) == 1:
        probabilities = [1 - float(scores[0]), float(scores[0])]
        winner = 1 if probabilities[1] >= 0.5 else 0
    elif classes == ["vacant", "occupied", "blocked"] and len(scores) == 3:
        probabilities = [float(value) for value in scores]
        if not math.isclose(sum(probabilities), 1.0, abs_tol=0.001):
            raise ValueError("Expected three softmax probabilities that sum to one.")
        winner = max(range(3), key=probabilities.__getitem__)
    else:
        raise ValueError("Model outputs do not match the declared classes.")
    if any(not math.isfinite(value) or not 0 <= value <= 1 for value in probabilities):
        raise ValueError("The model returned an invalid class score.")
    confidence = probabilities[winner]
    return {"status": classes[winner], "occupancyScore": probabilities[1],
            "obstructionScore": probabilities[2] if len(probabilities) == 3 else None,
            "classScores": dict(zip(classes, probabilities)), "confidence": confidence,
            "requiresReview": confidence < minimum}

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

def analyze(model, tf, np, Image, ImageOps, payload, classes=None):
    classes = classes or ["vacant", "occupied"]
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
    scores = np.asarray(model(tf.stack(tensors), training=False))
    expected_outputs = 3 if len(classes) == 3 else 1
    if scores.shape != (len(regions), expected_outputs):
        raise ValueError("Model output does not match the number of parking regions.")
    results = []
    for region, score in zip(regions, scores):
        results.append({"regionId": region["id"], **classify_scores(score, classes, minimum)})
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
            digest, metadata = model_metadata(path)
            model = tf.keras.models.load_model(path, compile=False)
            outputs = 3 if metadata.get('format_version') == 2 else 1
            if tuple(model.input_shape[1:]) != (224, 224, 3) or tuple(model.output_shape[1:]) != (outputs,):
                raise ValueError("Expected 224×224 RGB input and outputs matching the model metadata. Three-class exports require their matching sidecar.")
            model(tf.zeros((1, 224, 224, 3), dtype=tf.float32), training=False)
        info = {"name": model.name, "version": digest[:12],
                "classes": metadata.get('app_statuses', ["vacant", "occupied"]), "tensorflow": tf.__version__}
        info['supportsObstruction'] = 'blocked' in info['classes']
        emit({"type": "ready", "model": info})
    except Exception as error:
        emit({"type": "fatal", "error": str(error)})
        return 1
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            with contextlib.redirect_stdout(sys.stderr):
                result = analyze(model, tf, np, Image, ImageOps, request.get("payload", {}), info['classes'])
            emit({"id": request["id"], "result": {**result, "model": info}})
        except Exception as error:
            emit({"id": request.get("id"), "error": str(error)})
    return 0

if __name__ == "__main__":
    sys.exit(main())
