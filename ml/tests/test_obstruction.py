"""Three-class labels, leakage prevention and app mapping; no hosted writes."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import pandas as pd
from PIL import Image

from ml.obstruction_data import audit_three, build_openimages, build_site_three, build_tracon, perceptual_groups
from ml.worker import classify_scores, model_metadata


def fixture():
    return pd.DataFrame([dict(path=f'{split}_{label}_{n}.jpg', source='site', split=split,
        group_id=f'site_{split}', label=label, source_id=f'{split}_{label}_{n}',
        source_sha=f's_{split}_{label}_{n}', crop_sha=f'c_{split}_{label}_{n}')
        for split in ('train', 'val', 'test') for label in range(3) for n in range(8)])


class ObstructionTests(unittest.TestCase):
    def test_explicit_class_order_review_and_invalid_scores(self):
        classes = ['vacant', 'occupied', 'blocked']
        for i, status in enumerate(classes):
            scores = [0.03, 0.03, 0.03]; scores[i] = .94
            result = classify_scores(scores, classes, .8)
            self.assertEqual(result['status'], status)
            self.assertFalse(result['requiresReview'])
            self.assertEqual(result['occupancyScore'], scores[1])
            self.assertEqual(result['obstructionScore'], scores[2])
        self.assertTrue(classify_scores([.2, .2, .6], classes, .8)['requiresReview'])
        for scores in ([.8, .8, .1], [float('nan'), 0, 1], [-.1, .1, 1], [.2, .8]):
            with self.assertRaises(ValueError): classify_scores(scores, classes, .8)
        self.assertEqual(classify_scores([.5], classes[:2], .8)['status'], 'occupied')
        self.assertEqual(classify_scores([.1], classes[:2], .8)['status'], 'vacant')

    def test_metadata_requires_exact_three_class_order_and_matching_weights(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'model.keras'; path.write_bytes(b'fixture')
            metadata = dict(format_version=2, task='parking_three_class', class_names=['vacant', 'occupied', 'blocked'],
                app_statuses=['vacant', 'occupied', 'blocked'], output_activation='softmax', input_size=[224, 224],
                color_mode='RGB', input_dtype='float32', input_range=[0, 255], resize_method='bilinear',
                preprocessing_inside_model=True, sha256=hashlib.sha256(path.read_bytes()).hexdigest())
            sidecar = path.with_suffix('.metadata.json'); sidecar.write_text(json.dumps(metadata))
            self.assertEqual(model_metadata(path)[1]['format_version'], 2)
            metadata['app_statuses'] = ['blocked', 'occupied', 'vacant']; sidecar.write_text(json.dumps(metadata))
            with self.assertRaisesRegex(ValueError, 'label contract'): model_metadata(path)
            metadata['sha256'] = 'wrong'; sidecar.write_text(json.dumps(metadata))
            with self.assertRaisesRegex(ValueError, 'do not match'): model_metadata(path)

    def test_audit_allows_cone_only_source_but_site_needs_all_classes(self):
        frame = fixture()
        cones = frame[frame.label == 2].copy(); cones['source'] = 'tracon'
        for key in ('crop_sha', 'source_sha', 'group_id'): cones[key] = 'cone_' + cones[key]
        result, _ = audit_three(pd.concat([frame, cones], ignore_index=True))
        self.assertEqual(set(result[result.source == 'tracon'].label), {2})
        bad = frame.copy(); bad.loc[0, 'source_sha'] = frame.iloc[-1].source_sha
        bad.loc[1, 'crop_sha'] = 'conflict'; bad.loc[8, 'crop_sha'] = 'conflict'
        result, excluded = audit_three(bad)
        self.assertNotIn('conflict', set(result.crop_sha))
        self.assertEqual(result.groupby('source_sha').split.nunique().max(), 1)
        self.assertEqual(set(excluded.reason), {'conflicting_labels', 'source_sha_cross_split'})
        bad = frame.copy(); bad.loc[0, 'group_id'] = 'site_val'
        with self.assertRaisesRegex(ValueError, 'crosses splits'): audit_three(bad)
        # Public blocked examples do not conceal a missing site-blocked test class.
        bad = pd.concat([frame[~((frame.split == 'test') & (frame.label == 2))], cones])
        with self.assertRaisesRegex(ValueError, 'site/test'): audit_three(bad)

    def test_site_days_and_perceptual_duplicate_grouping(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); rng = np.random.default_rng(42)
            for day in range(3):
                for label in ('vacant', 'occupied', 'blocked'):
                    folder = root / 'site' / f'day{day}' / label; folder.mkdir(parents=True)
                    for n in range(6): Image.fromarray(rng.integers(0, 256, (32, 40, 3), dtype=np.uint8)).save(folder / f'{n}.png')
            frame, _ = audit_three(build_site_three(root / 'site', root / 'crops'))
            self.assertEqual(len(frame), 54)
            self.assertEqual(frame.groupby('group_id').split.nunique().max(), 1)
            path = next((root / 'site').rglob('*.png')); duplicate = root / 'duplicate.png'; duplicate.write_bytes(path.read_bytes())
            groups = perceptual_groups([path, duplicate])
            self.assertEqual(groups[0], groups[1])

    def test_openimages_uses_box_labels_and_excludes_all_objects_from_background(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); cache = root / 'openimages'; (cache / 'images').mkdir(parents=True)
            pd.DataFrame([['/car', 'Car'], ['/box', 'Box']]).to_csv(cache / 'classes.csv', header=False, index=False)
            rows = []; credits = []; rng = np.random.default_rng(42)
            for n in range(60):
                image_id = f'{n:016x}'
                Image.fromarray(rng.integers(0, 256, (100, 100, 3), dtype=np.uint8)).save(cache / 'images' / f'{image_id}.jpg')
                for category, x in [('/car', 0), ('/box', .7)]:
                    rows.append(dict(ImageID=image_id, LabelName=category, IsGroupOf=0, IsDepiction=0,
                        XMin=x, XMax=x+.25, YMin=0, YMax=.3))
                credits.append(dict(ImageID=image_id, License='fixture-license', Author='fixture-author'))
            pd.DataFrame(rows).to_csv(cache / 'boxes.csv', index=False)
            pd.DataFrame(credits).to_csv(cache / 'credits.csv', index=False)
            from ml.obstruction_data import negative_crop
            def checked_background(width, height, objects, rng):
                self.assertEqual(len(objects), 2)  # Box AND vehicle excluded from clear background.
                return negative_crop(width, height, objects, rng)
            with patch('ml.obstruction_data.download_public', side_effect=lambda url, target, **kw: Path(target)), patch('ml.obstruction_data.negative_crop', side_effect=checked_background):
                frame = build_openimages(root, root / 'crops', dict(train=6, val=3, test=3), ['Car'], ['Box'])
            self.assertEqual(set(frame.label), {0, 1, 2})
            self.assertEqual(set(frame[frame.label == 2].subtype), {'Box'})
            self.assertEqual(set(frame.License), {'fixture-license'})
            self.assertEqual(frame.groupby('group_id').split.nunique().max(), 1)

    def test_tracon_yolo_zero_means_blocked_and_splits_whole_photos(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); extracted = root / 'tracon/extracted/dataset'
            (extracted / 'images/train').mkdir(parents=True); (extracted / 'labels/train').mkdir(parents=True)
            rng = np.random.default_rng(71)
            for n in range(30):
                Image.fromarray(rng.integers(0, 256, (64, 80, 3), dtype=np.uint8)).save(extracted / f'images/train/{n}.jpg')
                (extracted / f'labels/train/{n}.txt').write_text('0 0.5 0.5 0.4 0.6\n')
            with patch('ml.obstruction_data.download_public', return_value=root / 'unused.zip'), patch('ml.obstruction_data.safe_extract_zip', return_value=extracted):
                result = build_tracon(root, root / 'crops', dict(train=8, val=3, test=3))
            self.assertEqual(set(result.label), {2})
            self.assertEqual(set(result.subtype), {'Traffic cone'})
            self.assertEqual(set(result.split), {'train', 'val', 'test'})
            self.assertEqual(result.groupby('group_id').split.nunique().max(), 1)

if __name__ == '__main__': unittest.main()
