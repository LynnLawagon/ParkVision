"""Data integrity and export-contract checks; no public downloads or hosted writes."""
import hashlib
import json
from pathlib import Path
import random
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import numpy as np
import pandas as pd
from PIL import Image

from ml.training_data import (audit_manifest, build_coco, build_local_crops, build_pklot,
                              clean_bbox, frame_group, grouped_split,
                              negative_crop, overlaps, safe_extract_zip)
from ml.worker import model_metadata


def manifest_fixture():
    return pd.DataFrame([
        dict(path=f'{split}_{label}_{n}.jpg', source='site', split=split,
             group_id=f'site_{split}', label=label, source_id=f'{split}_{label}_{n}',
             source_sha=f'source_{split}_{label}_{n}', crop_sha=f'crop_{split}_{label}_{n}')
        for split in ('train', 'val', 'test') for label in (0, 1) for n in range(8)
    ])


class TrainingDataTests(unittest.TestCase):
    def test_groups_are_isolated_and_deterministic(self):
        frame = pd.DataFrame({'group_id': [f'day{n}' for n in range(10) for _ in range(5)]})
        result = grouped_split(frame)
        self.assertEqual(set(result.split), {'train', 'val', 'test'})
        self.assertEqual(result.groupby('group_id').split.nunique().max(), 1)
        pd.testing.assert_frame_equal(result, grouped_split(frame))
        self.assertEqual(set(grouped_split(frame[frame.group_id.isin(['day0', 'day1', 'day2'])]).split), {'train', 'val', 'test'})
        with self.assertRaises(ValueError):
            grouped_split(frame[frame.group_id == 'day0'])
        self.assertEqual(frame_group('2013-03-01_15_00_01_jpg.rf.abcdef.jpg')[0], 'pklot_day_2013-03-01')

    def test_negative_crops_exclude_even_tiny_annotated_cars(self):
        self.assertIsNone(clean_bbox([0, 0, float('nan'), 20], 100, 100))
        self.assertIsNone(clean_bbox([0, 0, -5, 20], 100, 100))
        tiny = clean_bbox([50, 50, 2, 2], 100, 100, min_size=1)
        self.assertIsNotNone(tiny)
        cars = [(0, 0, 40, 100), tiny]
        found = 0
        for seed in range(30):
            box = negative_crop(100, 100, cars, random.Random(seed))
            if box:
                found += 1
                self.assertFalse(any(overlaps(box, car) for car in cars))
        self.assertGreater(found, 10)
        self.assertIsNone(negative_crop(100, 100, [(0, 0, 100, 100)], random.Random(42)))

    def test_audit_excludes_conflicting_labels_and_cross_split_sources(self):
        frame = manifest_fixture()
        frame.loc[0, 'source_sha'] = frame.iloc[-1].source_sha
        frame.loc[1, 'crop_sha'] = 'conflict'
        frame.loc[8, 'crop_sha'] = 'conflict'
        result, excluded = audit_manifest(frame)
        self.assertNotIn('conflict', set(result.crop_sha))
        self.assertEqual(result[result.source_sha == frame.iloc[-1].source_sha].split.tolist(), ['test'])
        self.assertEqual(set(excluded.reason), {'conflicting_labels', 'source_sha_cross_split'})
        self.assertEqual(result.groupby('source_sha').split.nunique().max(), 1)
        frame.loc[0, 'group_id'] = 'site_val'
        with self.assertRaisesRegex(ValueError, 'group appears'):
            audit_manifest(frame)

    def test_zip_rejects_path_traversal(self):
        with tempfile.TemporaryDirectory() as temp:
            archive = Path(temp) / 'bad.zip'
            with zipfile.ZipFile(archive, 'w') as bundle:
                bundle.writestr('../outside.txt', 'no')
            with self.assertRaisesRegex(ValueError, 'unsafe path'):
                safe_extract_zip(archive, Path(temp) / 'extract')

    def test_site_crops_keep_whole_days_and_explicit_class_order(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / 'site'
            rng = np.random.default_rng(42)
            for day in range(3):
                for label in ('unoccupied', 'occupied'):
                    folder = root / f'day{day}' / label
                    folder.mkdir(parents=True)
                    for n in range(6):
                        Image.fromarray(rng.integers(0, 256, (32, 40, 3), dtype=np.uint8)).save(folder / f'{n}.jpg')
            frame, _ = audit_manifest(build_local_crops(root, Path(temp) / 'crops'))
            self.assertEqual(len(frame), 36)
            self.assertEqual(frame.groupby('group_id').split.nunique().max(), 1)
            self.assertTrue(all(('unoccupied' if row.label == 0 else 'occupied') in row.path for row in frame.itertuples()))

    def test_pklot_uses_category_names_not_numeric_order(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / 'pklot'
            root.mkdir()
            data = {'images': [], 'annotations': [], 'categories': [
                {'id': 19, 'name': 'space-empty'}, {'id': 2, 'name': 'space-occupied'}]}
            rng = np.random.default_rng(42)
            for n in range(60):
                name = f'2013-03-{n // 2 + 1:02d}_frame{n}.jpg'
                Image.fromarray(rng.integers(0, 256, (50, 100, 3), dtype=np.uint8)).save(root / name)
                data['images'].append(dict(id=n, file_name=name, width=100, height=50))
                data['annotations'].extend([
                    dict(image_id=n, category_id=19, bbox=[0, 0, 45, 50]),
                    dict(image_id=n, category_id=2, bbox=[50, 0, 45, 50])])
            (root / '_annotations.coco.json').write_text(json.dumps(data))
            caps = dict(train=10, val=5, test=5)
            frame, _ = audit_manifest(build_pklot(root, Path(temp) / 'crops', caps))
            self.assertEqual(frame.groupby('group_id').split.nunique().max(), 1)
            for split, cap in caps.items():
                self.assertEqual(frame[frame.split == split].label.value_counts().to_dict(), {0: cap, 1: cap})

    def test_sidecar_rejects_wrong_weights_or_inverted_classes(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'model.keras'
            path.write_bytes(b'fixture')
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            self.assertEqual(model_metadata(path), (digest, {}))
            sidecar = path.with_suffix('.metadata.json')
            sidecar.write_text(json.dumps({'sha256': 'wrong'}))
            with self.assertRaisesRegex(ValueError, 'do not match'):
                model_metadata(path)
            sidecar.write_text(json.dumps({'sha256': digest, 'class_names': ['occupied', 'unoccupied']}))
            with self.assertRaisesRegex(ValueError, 'label contract'):
                model_metadata(path)

    def test_coco_preparation_separates_images_and_includes_both_negative_types(self):
        with tempfile.TemporaryDirectory() as temp:
            cache = Path(temp) / 'coco'
            (cache / 'images').mkdir(parents=True)
            data = dict(images=[], annotations=[], categories=[{'id': 3, 'name': 'car'}])
            rng = np.random.default_rng(42)
            for n in range(80):
                name = f'{n:012d}.jpg'
                image = rng.integers(0, 256, (80, 100, 3), dtype=np.uint8)
                Image.fromarray(image).save(cache / 'images' / name)
                data['images'].append(dict(id=n, file_name=name, width=100, height=80))
                if n % 2:
                    data['annotations'].append(dict(image_id=n, category_id=3, bbox=[0, 0, 22, 22]))
            (cache / 'instances_val2017.json').write_text(json.dumps(data))
            def cached_download(url, target, **kwargs):
                return Path(target)
            with patch('ml.training_data.download_public', side_effect=cached_download):
                result = build_coco(Path(temp), Path(temp) / 'crops', dict(train=6, val=3, test=3), ('car',))
            self.assertEqual(result.groupby('group_id').split.nunique().max(), 1)
            self.assertEqual(result.groupby(['split', 'label']).size().to_dict(),
                             {('train', 0): 6, ('train', 1): 6, ('val', 0): 3, ('val', 1): 3, ('test', 0): 3, ('test', 1): 3})
            negative_ids = [int(Path(name).stem) for name in result[result.label == 0].source_id]
            self.assertTrue(any(n % 2 == 0 for n in negative_ids))  # Vehicle-free scenes.
            self.assertTrue(any(n % 2 == 1 for n in negative_ids))  # Background within vehicle scenes.


if __name__ == '__main__':
    unittest.main()
