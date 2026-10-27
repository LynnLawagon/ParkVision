"""Training-data utilities embedded into the standalone ParkVision Colab notebook."""
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from functools import lru_cache
from pathlib import Path
import hashlib
import json
import math
import random
import re
import shutil
import zipfile

import numpy as np
import pandas as pd
from PIL import Image, ImageOps
import requests
from sklearn.model_selection import GroupShuffleSplit, train_test_split
from tqdm.auto import tqdm

SPLITS = ('train', 'val', 'test')
CLASS_NAMES = ['unoccupied', 'occupied']  # Explicit numeric order; never inferred from folders.
IMAGE_SUFFIXES = {'.jpg', '.jpeg', '.png', '.webp'}


def clean_bbox(box, image_width, image_height, min_size=8):
    if not isinstance(box, (list, tuple)) or len(box) != 4:
        return None
    if any(isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x) for x in box):
        return None
    x, y, width, height = box
    if width <= 0 or height <= 0:
        return None
    left, top = max(0, math.floor(x)), max(0, math.floor(y))
    right, bottom = min(image_width, math.ceil(x + width)), min(image_height, math.ceil(y + height))
    return (left, top, right, bottom) if right - left >= min_size and bottom - top >= min_size else None


def overlaps(a, b):
    return min(a[2], b[2]) > max(a[0], b[0]) and min(a[3], b[3]) > max(a[1], b[1])


def negative_crop(width, height, vehicle_boxes, rng, attempts=60):
    """Never label a proposed negative if it overlaps an annotated target vehicle."""
    for _ in range(attempts):
        cw = max(16, round(width * rng.uniform(0.22, 0.75)))
        ch = max(16, round(height * rng.uniform(0.22, 0.75)))
        if cw > width or ch > height:
            continue
        x, y = rng.randint(0, width - cw), rng.randint(0, height - ch)
        box = (x, y, x + cw, y + ch)
        if not any(overlaps(box, vehicle) for vehicle in vehicle_boxes):
            return box
    return None


def frame_group(filename):
    """Keep PKLot capture days together when dates are recoverable from names."""
    name = Path(filename).name
    date = re.search(r'(20\d{2})[-_](\d{2})[-_](\d{2})', name)
    if date:
        return 'pklot_day_' + '-'.join(date.groups()), 'capture_day'
    stem = re.sub(r'\.rf\.[^.]+', '', Path(name).stem)
    return 'pklot_frame_' + stem, 'source_frame_only'


def grouped_split(frame, group_column='group_id', seed=42):
    """Assign complete groups before generating crops, with train/val/test isolation."""
    frame = frame.reset_index(drop=True).copy()
    if frame[group_column].nunique() < 3:
        raise ValueError('Need at least three independent capture-day/recording groups for train, val and test.')
    splitter = GroupShuffleSplit(n_splits=1, test_size=0.30, random_state=seed)
    train_idx, holdout_idx = next(splitter.split(frame, groups=frame[group_column]))
    holdout = frame.iloc[holdout_idx]
    if holdout[group_column].nunique() < 2:
        groups = sorted(frame[group_column].unique())
        random.Random(seed).shuffle(groups)
        mapping = {group: 'train' for group in groups}
        mapping[groups[-1]], mapping[groups[-2]] = 'test', 'val'
        frame['split'] = frame[group_column].map(mapping)
    else:
        second = GroupShuffleSplit(n_splits=1, test_size=0.5, random_state=seed + 1)
        val_idx, test_idx = next(second.split(holdout, groups=holdout[group_column]))
        frame['split'] = 'train'
        frame.loc[holdout.iloc[val_idx].index, 'split'] = 'val'
        frame.loc[holdout.iloc[test_idx].index, 'split'] = 'test'
    assert frame.groupby(group_column)['split'].nunique().max() == 1
    return frame


@lru_cache(maxsize=20000)
def file_hash(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save_crop(image, box, directory, *, source, group_id, split, label, source_id, source_sha):
    crop = image.crop(box).convert('RGB')
    pixel_sha = hashlib.sha256(str(crop.size).encode() + crop.tobytes()).hexdigest()
    directory = Path(directory) / source / split / CLASS_NAMES[label]
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / f'{pixel_sha}.jpg'
    if not target.exists():
        crop.save(target, quality=95, subsampling=0)
    return dict(path=str(target), label=int(label), source=source, group_id=group_id,
                split=split, source_id=str(source_id), source_sha=source_sha, crop_sha=pixel_sha)


def download_public(url, target, max_bytes=400_000_000):
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and target.stat().st_size > 0:
        return target
    for attempt in range(3):
        partial = target.with_suffix(target.suffix + '.part')
        try:
            with requests.get(url, stream=True, timeout=(20, 90)) as response:
                response.raise_for_status()
                size = 0
                with partial.open('wb') as output:
                    for chunk in response.iter_content(1024 * 1024):
                        if chunk:
                            size += len(chunk)
                            if size > max_bytes:
                                raise ValueError(f'Download exceeds the configured size limit: {url}')
                            output.write(chunk)
                if not size:
                    raise ValueError('Empty download')
            partial.replace(target)
            return target
        except (requests.RequestException, OSError):
            partial.unlink(missing_ok=True)
            if attempt == 2:
                raise


def safe_extract_zip(archive, target, max_bytes=5_000_000_000):
    target = Path(target).resolve()
    target.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as bundle:
        if sum(item.file_size for item in bundle.infolist()) > max_bytes:
            raise ValueError('Archive expands beyond the configured size limit.')
        for item in bundle.infolist():
            destination = (target / item.filename).resolve()
            if not destination.is_relative_to(target):
                raise ValueError('Archive contains an unsafe path.')
        bundle.extractall(target)
    return target


def build_pklot(root, crop_dir, per_class, seed=42):
    root = Path(root)
    by_basename = defaultdict(list)
    for path in root.rglob('*'):
        if path.suffix.lower() in IMAGE_SUFFIXES:
            by_basename[path.name].append(path)
    records = []
    ignored = Counter()
    for annotation_file in sorted(root.rglob('*.json')):
        if 'annotation' not in annotation_file.name.lower():
            continue
        data = json.loads(annotation_file.read_text())
        if not all(key in data for key in ('images', 'annotations', 'categories')):
            continue
        names = {item['id']: str(item['name']).lower().strip().replace('_', '-').replace(' ', '-') for item in data['categories']}
        categories = {}
        for category_id, name in names.items():
            if name in {'space-empty', 'empty', 'vacant', 'unoccupied', 'free'}:
                categories[category_id] = 0
            elif name in {'space-occupied', 'occupied', 'busy'}:
                categories[category_id] = 1
        if set(categories.values()) != {0, 1}:
            raise ValueError(f'Unrecognized PKLot category names: {names}. Check the labels explicitly.')
        annotations = defaultdict(list)
        for annotation in data['annotations']:
            if annotation.get('category_id') in categories:
                annotations[annotation['image_id']].append(annotation)
        rng = random.Random(seed)
        for image in data['images']:
            relative = image['file_name']
            path = (annotation_file.parent / relative).resolve()
            if not path.is_relative_to(root.resolve()) or not path.is_file():
                alternatives = by_basename[Path(relative).name]
                if len(alternatives) != 1:
                    ignored['missing_or_ambiguous_image'] += 1
                    continue
                path = alternatives[0]
            candidates = annotations[image['id']][:]
            occupied_boxes = [clean_bbox(item.get('bbox'), image['width'], image['height'], min_size=1)
                              for item in candidates if categories[item['category_id']] == 1]
            occupied_boxes = [box for box in occupied_boxes if box is not None]
            rng.shuffle(candidates)
            counts = Counter()
            group, grouping_rule = frame_group(relative)
            for annotation in candidates:
                label = categories[annotation['category_id']]
                if counts[label] >= 2:  # More source frames, fewer correlated crops per frame.
                    continue
                box = clean_bbox(annotation.get('bbox'), image['width'], image['height'])
                if box is None:
                    ignored['invalid_box'] += 1
                    continue
                # PKLot labels parking positions, rather than every visible car.
                # Drop an empty position whose rectangular crop also intersects
                # an occupied position: that is ambiguous for vehicle presence.
                if label == 0 and any(overlaps(box, occupied) for occupied in occupied_boxes):
                    ignored['empty_crop_overlaps_occupied_position'] += 1
                    continue
                counts[label] += 1
                records.append(dict(source_path=str(path), box=box, label=label, group_id=group,
                                    grouping_rule=grouping_rule, source_id=path.name))
    if not records:
        raise ValueError('No usable PKLot COCO annotations found. Set PKLOT_ROOT to the dataset directory.')
    frame = grouped_split(pd.DataFrame(records), seed=seed)
    output, kept_counts = [], Counter()
    for split in SPLITS:
        for label in (0, 1):
            candidates = frame[(frame.split == split) & (frame.label == label)].sample(frac=1, random_state=seed)
            for row in tqdm(candidates.to_dict('records'), desc=f'PKLot {split} {CLASS_NAMES[label]}', leave=False):
                if kept_counts[split, label] >= per_class[split]:
                    break
                try:
                    with Image.open(row['source_path']) as image:
                        image = image.convert('RGB')
                        if row['box'][2] > image.width or row['box'][3] > image.height:
                            ignored['image_annotation_size_mismatch'] += 1
                            continue
                        item = save_crop(image, row['box'], crop_dir, source='pklot', group_id=row['group_id'],
                                         split=split, label=label, source_id=row['source_id'], source_sha=file_hash(row['source_path']))
                        item['grouping_rule'] = row['grouping_rule']
                        output.append(item)
                        kept_counts[split, label] += 1
                except (OSError, ValueError):
                    ignored['unreadable_image'] += 1
    print('PKLot ignored records:', dict(ignored))
    return pd.DataFrame(output)


def build_coco(cache_dir, crop_dir, per_class, vehicle_categories=('car', 'truck', 'bus'), seed=42):
    cache_dir = Path(cache_dir) / 'coco'
    # Official COCO S3 bucket alias uses a valid HTTPS certificate.
    base_url = 'https://s3.amazonaws.com/images.cocodataset.org'
    archive = download_public(base_url + '/annotations/annotations_trainval2017.zip', cache_dir / 'annotations.zip')
    annotation_path = cache_dir / 'instances_val2017.json'
    if not annotation_path.exists():
        with zipfile.ZipFile(archive) as bundle:
            with bundle.open('annotations/instances_val2017.json') as source, annotation_path.open('wb') as target:
                shutil.copyfileobj(source, target)
    data = json.loads(annotation_path.read_text())
    target_ids = {item['id'] for item in data['categories'] if item['name'] in vehicle_categories}
    if len(target_ids) != len(vehicle_categories):
        raise ValueError('Unknown COCO vehicle category. Check VEHICLE_CATEGORIES.')
    annotations = defaultdict(list)
    for annotation in data['annotations']:
        if annotation['category_id'] in target_ids:
            annotations[annotation['image_id']].append(annotation)
    images = pd.DataFrame(data['images'])
    images['has_vehicle'] = images.id.map(lambda image_id: bool(annotations[image_id])).astype(int)
    train, holdout = train_test_split(images, test_size=0.30, random_state=seed, stratify=images.has_vehicle)
    val, test = train_test_split(holdout, test_size=0.5, random_state=seed + 1, stratify=holdout.has_vehicle)
    selected = []
    for split, frame in [('train', train), ('val', val), ('test', test)]:
        for label in (0, 1):
            pool = frame[frame.has_vehicle == label].sample(frac=1, random_state=seed)
            # Reserve some extra images in case a positive annotation is too small/corrupt.
            pool = pool.head(min(len(pool), math.ceil(per_class[split] * 1.3)))
            selected.extend({**item, 'split': split} for item in pool.to_dict('records'))
    def fetch(record):
        name = Path(record['file_name']).name
        target = cache_dir / 'images' / name
        try:
            download_public(f'{base_url}/val2017/{name}', target, max_bytes=30_000_000)
            return record, target
        except (requests.RequestException, OSError, ValueError):
            return record, None
    paths = {}
    with ThreadPoolExecutor(max_workers=8) as executor:
        jobs = [executor.submit(fetch, record) for record in selected]
        for job in tqdm(as_completed(jobs), total=len(jobs), desc='COCO image downloads'):
            record, path = job.result()
            paths[record['id']] = path
    output, counts = [], Counter()
    rng = random.Random(seed)
    # Vehicle scenes first so their verified background patches become hard negatives.
    selected.sort(key=lambda item: (-item['has_vehicle'], item['id']))
    for record in tqdm(selected, desc='COCO vehicle / no-vehicle crops'):
        path, split = paths[record['id']], record['split']
        if path is None:
            continue
        try:
            with Image.open(path) as original:
                image = original.convert('RGB')
                boxes = [clean_bbox(item['bbox'], image.width, image.height, min_size=1) for item in annotations[record['id']]]
                boxes = [box for box in boxes if box is not None]
                candidates = []
                if record['has_vehicle'] and boxes:
                    # Prefer a clearly visible vehicle, retain varied surrounding context.
                    box = max(boxes, key=lambda b: (b[2] - b[0]) * (b[3] - b[1]))
                    if (box[2] - box[0]) * (box[3] - box[1]) >= 400:
                        padding = rng.uniform(0.12, 0.65)
                        bw, bh = box[2] - box[0], box[3] - box[1]
                        expanded = (max(0, math.floor(box[0] - bw * padding)), max(0, math.floor(box[1] - bh * padding)),
                                    min(image.width, math.ceil(box[2] + bw * padding)), min(image.height, math.ceil(box[3] + bh * padding)))
                        candidates.append((1, expanded))
                    background = negative_crop(image.width, image.height, boxes, rng)
                    # Keep room for vehicle-free scenes too; do not fill every
                    # negative slot from vehicle-scene backgrounds alone.
                    if background and counts[split, 0] < math.ceil(per_class[split] / 2):
                        candidates.append((0, background))
                elif not record['has_vehicle']:
                    box = (0, 0, image.width, image.height) if rng.random() < 0.5 else negative_crop(image.width, image.height, [], rng)
                    if box:
                        candidates.append((0, box))
                for label, box in candidates:
                    if counts[split, label] >= per_class[split]:
                        continue
                    output.append(save_crop(image, box, crop_dir, source='coco', group_id=f"coco_val2017_{record['id']}",
                                            split=split, label=label, source_id=record['file_name'], source_sha=file_hash(str(path))))
                    counts[split, label] += 1
        except (OSError, ValueError):
            continue
    if not output:
        raise ValueError('COCO download/crop generation produced no data. Check the download error and retry.')
    return pd.DataFrame(output)


def build_local_crops(root, crop_dir, seed=42):
    """Input: site/day_or_recording_id/{occupied,unoccupied}/*.jpg."""
    root = Path(root)
    rows = []
    labels = {'unoccupied': 0, 'vacant': 0, 'empty': 0, 'occupied': 1}
    for path in root.rglob('*'):
        if path.suffix.lower() not in IMAGE_SUFFIXES or path.parent.name.lower() not in labels:
            continue
        group_folder = path.parent.parent
        if group_folder.resolve() == root.resolve():
            raise ValueError('Local data needs recording/day folders above the class folders. Do not randomly split neighboring video frames.')
        rows.append(dict(source_path=str(path), label=labels[path.parent.name.lower()], group_id='site_' + str(group_folder.relative_to(root))))
    if not rows:
        raise ValueError('No local crops found. Use day01/occupied and day01/unoccupied folders inside the ZIP.')
    frame = grouped_split(pd.DataFrame(rows), seed=seed)
    output = []
    for row in frame.to_dict('records'):
        with Image.open(row['source_path']) as source:
            image = ImageOps.exif_transpose(source).convert('RGB')
            if min(image.size) < 16:
                raise ValueError(f"Local crop is too small: {row['source_path']}")
            output.append(save_crop(image, (0, 0, image.width, image.height), crop_dir, source='site', group_id=row['group_id'],
                                    split=row['split'], label=row['label'], source_id=Path(row['source_path']).name, source_sha=file_hash(row['source_path'])))
    return pd.DataFrame(output)


def audit_manifest(frame):
    frame = frame.copy().reset_index(drop=True)
    if not set(frame.label.unique()) <= {0, 1} or set(frame.split.unique()) != set(SPLITS):
        raise ValueError('Need explicit binary labels and train/val/test splits.')
    collisions = frame.groupby('group_id')['split'].nunique()
    if (collisions > 1).any():
        raise ValueError('A recording/source group appears in more than one split.')
    conflicts = set(frame.groupby('crop_sha')['label'].nunique().loc[lambda values: values > 1].index)
    removed = frame[frame.crop_sha.isin(conflicts)].assign(reason='conflicting_labels')
    frame = frame[~frame.crop_sha.isin(conflicts)].copy()
    priority = {'test': 0, 'val': 1, 'train': 2}
    frame['_priority'] = frame.split.map(priority)
    for column in ('source_sha', 'crop_sha'):
        keep_split = frame.sort_values('_priority').drop_duplicates(column).set_index(column)['split']
        mask = frame.split != frame[column].map(keep_split)
        removed = pd.concat([removed, frame[mask].assign(reason=f'{column}_cross_split')], ignore_index=True)
        frame = frame[~mask].copy()
    frame = frame.drop_duplicates('crop_sha').drop(columns='_priority').reset_index(drop=True)
    for split in SPLITS:
        counts = frame[frame.split == split].label.value_counts()
        if any(counts.get(label, 0) < 5 for label in (0, 1)):
            raise ValueError(f'{split} needs at least five distinct crops per class after leakage cleaning; collect more groups.')
    for source in frame.source.unique():
        for split in SPLITS:
            counts = frame[(frame.source == source) & (frame.split == split)].label.value_counts()
            if any(counts.get(label, 0) < 5 for label in (0, 1)):
                raise ValueError(f'{source}/{split} needs at least five unique crops of each class. Add recording groups containing both classes.')
    assert frame.groupby('source_sha')['split'].nunique().max() == 1
    assert frame.groupby('crop_sha')['split'].nunique().max() == 1
    return frame, removed.drop(columns='_priority', errors='ignore')
