"""Exercise training/export/worker with synthetic fixtures, never deployment weights.

Run from the repo root: python -m scripts.smoke_training
Uses no downloads, GPU, Supabase, user photos, or existing model file.
"""
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import zipfile

os.environ.setdefault('TF_CPP_MIN_LOG_LEVEL', '2')
os.environ.setdefault('MPLBACKEND', 'Agg')
os.environ.setdefault('TF_NUM_INTEROP_THREADS', '2')
os.environ.setdefault('TF_NUM_INTRAOP_THREADS', '2')

import numpy as np
import pandas as pd
from PIL import Image
import tensorflow as tf

from ml.training_data import audit_manifest, save_crop
from ml.training_model import (balanced_training_frame, evaluate_holdout,
                               export_vehicle_model, make_dataset, train_stages,
                               unfreeze_top_blocks, validation_weights)


def main():
    tf.keras.utils.set_random_seed(42)
    with tempfile.TemporaryDirectory(prefix='parkvision-training-smoke-') as temp:
        root = Path(temp)
        rng = np.random.default_rng(42)
        records = []
        for source in ('pklot', 'coco', 'site'):
            for split in ('train', 'val', 'test'):
                for label in (0, 1):
                    for n in range(6):
                        image = Image.fromarray(rng.integers(0, 256, (48, 64, 3), dtype=np.uint8))
                        unique = f'{source}_{split}_{label}_{n}'
                        records.append(save_crop(image, (0, 0, 64, 48), root / 'crops', source=source,
                                                 group_id=f'{source}_{split}', split=split, label=label,
                                                 source_id=unique, source_sha=unique))
        manifest, _ = audit_manifest(pd.DataFrame(records))
        train = manifest[manifest.split == 'train']
        val = manifest[manifest.split == 'val']
        weights = dict(pklot=1, coco=2, site=4)
        balanced = balanced_training_frame(train, weights, max_samples=14)
        assert set(balanced.path) <= set(train.path)
        for _, group in balanced.groupby('source'):
            assert group.label.value_counts().nunique() == 1
        val_weights = validation_weights(val, weights)
        assert np.isclose(val_weights.mean(), 1)
        train_ds = make_dataset(balanced, batch_size=4, training=True)
        val_ds = make_dataset(val.head(6), batch_size=4, weights=val_weights[:6])
        # Scratch weights are deliberate: this verifies mechanics, not accuracy.
        model, info, _ = train_stages(train_ds, val_ds, root, head_epochs=1, fine_epochs=1, weights=None)
        unfreeze_top_blocks(model)
        base = model.get_layer('efficientnetb0')
        assert any(layer.trainable for layer in base.layers)
        assert all(not layer.trainable for layer in base.layers if isinstance(layer, tf.keras.layers.BatchNormalization))
        manifest.to_csv(root / 'manifest.csv', index=False)
        report, predictions = evaluate_holdout(model, manifest, root, batch_size=6)
        assert len(predictions) == len(manifest[manifest.split == 'test'])
        exported, metadata, archive = export_vehicle_model(model, manifest, report, info, root, {'VEHICLE_CATEGORIES': ['car', 'truck', 'bus']})
        assert len(exported.layers) == 4  # Input, EfficientNet, pooling, sigmoid.
        assert metadata['save_reload_parity_passed']
        with zipfile.ZipFile(archive) as bundle:
            assert {'parkvision_efficientnetb0.keras', 'parkvision_efficientnetb0.metadata.json', 'metrics.json'} <= set(bundle.namelist())
        # Run the real production worker against the new export, leaving the
        # installed model untouched, and assert raw model/worker parity.
        sample = manifest.iloc[0]
        request = {'id': 'smoke', 'payload': {'image': base64.b64encode(Path(sample.path).read_bytes()).decode(),
                   'regions': [{'id': 'fixture', 'x': 0, 'y': 0, 'width': 1, 'height': 1}], 'minimumConfidence': 0.8}}
        result = subprocess.run([sys.executable, '-u', 'ml/worker.py', str(root / 'export/parkvision_efficientnetb0.keras')],
                                input=json.dumps(request) + '\n', text=True, capture_output=True, timeout=120, check=True)
        messages = [json.loads(line) for line in result.stdout.splitlines()]
        assert messages[0]['type'] == 'ready', messages
        assert messages[0]['model']['name'] == 'ParkVision_EfficientNetB0_VehiclePresence'
        assert messages[0]['model']['version'] == metadata['sha256'][:12]
        prediction = messages[1]['result']['results'][0]
        batch = next(iter(make_dataset(manifest.head(1), 1)))[0]
        expected = float(np.asarray(exported(batch, training=False)).reshape(-1)[0])
        assert abs(prediction['occupancyScore'] - expected) < 1e-5
        assert prediction['status'] == ('occupied' if expected >= 0.5 else 'vacant')
        assert prediction['requiresReview'] == (max(expected, 1 - expected) < 0.8)
        print('PASS: two-stage training, export/reload parity, metadata, ZIP, and real worker inference.')
        print('Synthetic-fixture scores are not model accuracy. Installed weights were untouched.')


if __name__ == '__main__':
    main()
