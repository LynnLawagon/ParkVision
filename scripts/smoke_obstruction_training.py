"""Test three-class training/export/real worker on temporary synthetic fixtures.
Run: python -m scripts.smoke_obstruction_training. Never installs test weights.
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
from ml.obstruction_data import save_status_crop, audit_three
from ml.obstruction_model import balanced_three, three_validation_weights, fit_three, evaluate_three, export_three
from ml.training_model import make_dataset


def main():
    tf.keras.utils.set_random_seed(42)
    with tempfile.TemporaryDirectory(prefix='parkvision-threeclass-smoke-') as temp:
        root = Path(temp); rng = np.random.default_rng(42); rows = []
        for source, labels in [('pklot', [0, 1]), ('openimages', [0, 1, 2]), ('tracon', [2]), ('site', [0, 1, 2])]:
            for split in ('train', 'val', 'test'):
                for label in labels:
                    for n in range(6):
                        unique = f'{source}_{split}_{label}_{n}'
                        image = Image.fromarray(rng.integers(0, 256, (48, 64, 3), dtype=np.uint8))
                        rows.append(save_status_crop(image, (0, 0, 64, 48), root / 'crops', label=label,
                            source=source, group_id=f'{source}_{split}', split=split,
                            source_id=unique, source_sha=unique, subtype='fixture'))
        manifest, _ = audit_three(pd.DataFrame(rows))
        train = manifest[manifest.split == 'train'].reset_index(drop=True)
        val = manifest[manifest.split == 'val'].reset_index(drop=True)
        weights = dict(pklot=1, openimages=1.5, tracon=.6, site=4)
        sampled = balanced_three(train, weights, max_samples=18)
        assert set(sampled.path) <= set(train.path)
        sample_val = val.groupby('label', group_keys=False).head(2).reset_index(drop=True)
        val_weights = three_validation_weights(sample_val, weights)
        assert np.isclose(val_weights.mean(), 1)
        model, info, _ = fit_three(make_dataset(sampled, 6, training=True), make_dataset(sample_val, 6, weights=val_weights),
                                  root, head_epochs=1, fine_epochs=1, weights=None)
        assert model.output_shape == (None, 3)
        # These random fixtures test mechanics, never measured accuracy.
        report, predictions = evaluate_three(model, manifest, root, batch_size=12)
        assert len(predictions) == len(manifest[manifest.split == 'test'])
        exported, metadata, archive = export_three(model, manifest, report, info, root, {})
        assert metadata['format_version'] == 2 and metadata['augmentation_removed']
        assert metadata['app_statuses'] == ['vacant', 'occupied', 'blocked']
        assert len(exported.layers) == 4
        with zipfile.ZipFile(archive) as bundle:
            assert {'parkvision_efficientnetb0.keras', 'parkvision_efficientnetb0.metadata.json', 'metrics.json'} <= set(bundle.namelist())
        sample = manifest.head(1)
        payload = {'image': base64.b64encode(Path(sample.iloc[0].path).read_bytes()).decode(),
                   'regions': [dict(id='fixed-box', x=0, y=0, width=1, height=1)], 'minimumConfidence': .8}
        result = subprocess.run([sys.executable, '-u', 'ml/worker.py', str(root / 'export/parkvision_efficientnetb0.keras')],
            input=json.dumps(dict(id='fixture', payload=payload))+'\n', text=True, capture_output=True, timeout=120, check=True)
        messages = [json.loads(line) for line in result.stdout.splitlines()]
        assert messages[0]['type'] == 'ready', messages
        assert messages[0]['model']['supportsObstruction']
        assert messages[0]['model']['version'] == metadata['sha256'][:12]
        prediction = messages[1]['result']['results'][0]
        images = next(iter(make_dataset(sample, 1)))[0]
        scores = np.asarray(exported(images, training=False))[0]
        np.testing.assert_allclose(list(prediction['classScores'].values()), scores, atol=1e-5)
        assert prediction['status'] == metadata['app_statuses'][int(scores.argmax())]
        assert prediction['requiresReview'] == (float(scores.max()) < .8)
        print('PASS: three-class head/fine-tune, holdout reports, native export/reload, metadata/ZIP, actual production-worker parity.')
        print('Temporary synthetic fixture weights only. Installed model unchanged. These scores are NOT real accuracy.')

if __name__ == '__main__': main()
