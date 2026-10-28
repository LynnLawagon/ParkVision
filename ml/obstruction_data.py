"""Three-class crop preparation; embedded unchanged (apart from imports) in Colab."""
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import hashlib
import math
import random

import numpy as np
import pandas as pd
from PIL import Image, ImageOps
from tqdm.auto import tqdm

from ml.training_data import clean_bbox, overlaps, negative_crop, grouped_split, download_public, file_hash, safe_extract_zip, build_pklot

STATUS_NAMES = ['vacant', 'occupied', 'blocked']
TRACON_COMMIT = '7ac4af371e826b5124a9b4defaa3327bc817817e'
OI_CLASSES = 'https://storage.googleapis.com/openimages/v7/oidv7-class-descriptions-boxable.csv'
OI_BOXES = 'https://storage.googleapis.com/openimages/v5/validation-annotations-bbox.csv'
OI_CREDITS = 'https://storage.googleapis.com/openimages/2018_04/validation/validation-images-with-rotation.csv'


def save_status_crop(image, box, crop_dir, *, label, source, group_id, split, source_id, source_sha, subtype):
    crop = image.crop(box).convert('RGB')
    digest = hashlib.sha256(str(crop.size).encode() + crop.tobytes()).hexdigest()
    folder = Path(crop_dir) / source / split / STATUS_NAMES[label]
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f'{digest}.jpg'
    if not target.exists():
        crop.save(target, quality=95, subsampling=0)
    return dict(path=str(target), label=label, source=source, group_id=group_id, split=split,
                source_id=str(source_id), source_sha=source_sha, crop_sha=digest, subtype=subtype)


def padded_box(box, width, height, rng, maximum=0.35):
    padding = rng.uniform(0.08, maximum)
    bw, bh = box[2] - box[0], box[3] - box[1]
    return (max(0, math.floor(box[0] - bw * padding)), max(0, math.floor(box[1] - bh * padding)),
            min(width, math.ceil(box[2] + bw * padding)), min(height, math.ceil(box[3] + bh * padding)))


def build_openimages(cache_dir, crop_dir, caps, vehicle_names, obstruction_names, seed=42):
    """Repartition the official validation source pool by image BEFORE cropping."""
    cache = Path(cache_dir) / 'openimages'
    classes = pd.read_csv(download_public(OI_CLASSES, cache / 'classes.csv'), header=None, names=['id', 'name'])
    lookup = dict(zip(classes.id, classes.name))
    names = set(classes.name)
    missing = (set(vehicle_names) | set(obstruction_names)) - names
    if missing:
        raise ValueError(f'Open Images category names do not exist: {sorted(missing)}. Check the official class list.')
    if set(vehicle_names) & set(obstruction_names):
        raise ValueError('Vehicle and obstruction categories must not overlap.')
    annotations = pd.read_csv(download_public(OI_BOXES, cache / 'boxes.csv'))
    annotations['name'] = annotations.LabelName.map(lookup)
    annotations['label'] = annotations.name.map(lambda name: 1 if name in vehicle_names else 2 if name in obstruction_names else -1)
    images = pd.DataFrame({'source_id': sorted(annotations.ImageID.unique())})
    images['group_id'] = 'oi_image_' + images.source_id
    images = grouped_split(images, seed=seed)
    split_map = dict(zip(images.source_id, images.split))
    positive = annotations[(annotations.label >= 1) & (annotations.IsGroupOf == 0) & (annotations.IsDepiction == 0)].copy()
    positive['split'] = positive.ImageID.map(split_map)
    selected = set()
    # Sample obstruction subtypes separately so boxes do not disappear behind people.
    for split in ('train', 'val', 'test'):
        for label, requested in [(1, vehicle_names), (2, obstruction_names)]:
            for name in requested:
                pool = positive[(positive.split == split) & (positive.name == name)].ImageID.drop_duplicates()
                pool = pool.sample(frac=1, random_state=seed)
                cap = math.ceil(caps[split] * 3 / len(requested))
                selected.update(pool.head(cap))
    by_image = {image_id: frame.to_dict('records') for image_id, frame in annotations[annotations.ImageID.isin(selected)].groupby('ImageID')}
    def fetch(image_id):
        try:
            target = cache / 'images' / f'{image_id}.jpg'
            download_public(f'https://s3.amazonaws.com/open-images-dataset/validation/{image_id}.jpg', target, max_bytes=30_000_000)
            return image_id, target
        except Exception:
            return image_id, None
    paths = {}
    with ThreadPoolExecutor(max_workers=8) as executor:
        jobs = [executor.submit(fetch, image_id) for image_id in sorted(selected)]
        for future in tqdm(as_completed(jobs), total=len(jobs), desc='Open Images downloads'):
            image_id, path = future.result(); paths[image_id] = path
    output, counts, subtype_counts, ignored = [], Counter(), Counter(), Counter()
    rng = random.Random(seed)
    image_ids = sorted(selected); rng.shuffle(image_ids)
    per_subtype = {split: math.ceil(caps[split] / max(1, len(obstruction_names))) for split in caps}
    for image_id in tqdm(image_ids, desc='Open Images three-class crops'):
        path, split = paths[image_id], split_map[image_id]
        if path is None:
            ignored['download_failed'] += 1; continue
        try:
            with Image.open(path) as original:
                image = original.convert('RGB')
                objects = []
                for row in by_image[image_id]:
                    box = clean_bbox([float(row['XMin']) * image.width, float(row['YMin']) * image.height,
                                      float(row['XMax'] - row['XMin']) * image.width, float(row['YMax'] - row['YMin']) * image.height], image.width, image.height, min_size=1)
                    if box:
                        objects.append((row, box))
                for label in (1, 2):
                    candidates = [(row, box) for row, box in objects if row['label'] == label and not row['IsGroupOf'] and not row['IsDepiction']
                                  and (box[2] - box[0]) * (box[3] - box[1]) >= 400]
                    rng.shuffle(candidates)
                    for row, box in candidates:
                        if counts[split, label] >= caps[split]: break
                        if label == 2 and subtype_counts[split, row['name']] >= per_subtype[split]: continue
                        other = [b for item, b in objects if item['label'] == (2 if label == 1 else 1)]
                        crop_box = padded_box(box, image.width, image.height, rng)
                        if any(overlaps(crop_box, b) for b in other): crop_box = box
                        if any(overlaps(crop_box, b) for b in other):
                            ignored['mixed_vehicle_obstruction'] += 1; continue
                        output.append(save_status_crop(image, crop_box, crop_dir, label=label, source='openimages', group_id='oi_image_' + image_id,
                                                       split=split, source_id=image_id, source_sha=file_hash(str(path)), subtype=row['name']))
                        counts[split, label] += 1; subtype_counts[split, row['name']] += 1
                        break  # At most one positive of each status per source image.
                if counts[split, 0] < caps[split]:
                    # Exclude ALL annotated objects, not only cars, from background negatives.
                    box = negative_crop(image.width, image.height, [box for _, box in objects], rng)
                    if box:
                        output.append(save_status_crop(image, box, crop_dir, label=0, source='openimages', group_id='oi_image_' + image_id,
                                                       split=split, source_id=image_id, source_sha=file_hash(str(path)), subtype='annotation_free_background'))
                        counts[split, 0] += 1
        except (OSError, ValueError): ignored['unreadable_image'] += 1
    if not output:
        raise ValueError('Open Images produced no usable crops; check the network/downloads.')
    # Preserve attribution metadata for selected source images in the exported manifest.
    credits = pd.read_csv(download_public(OI_CREDITS, cache / 'credits.csv'))
    keep = [column for column in ['ImageID', 'OriginalURL', 'OriginalLandingURL', 'License', 'Author', 'Title'] if column in credits]
    result = pd.DataFrame(output).merge(credits[keep], left_on='source_id', right_on='ImageID', how='left')
    print('Open Images retained:', dict(counts), 'Skipped:', dict(ignored))
    return result


def perceptual_groups(paths, distance=4):
    """Group exact/near duplicate cone source photos before assigning any split."""
    hashes, parents = [], list(range(len(paths)))
    def root(index):
        while parents[index] != index:
            parents[index] = parents[parents[index]]; index = parents[index]
        return index
    for index, path in enumerate(paths):
        with Image.open(path) as image:
            pixels = np.asarray(image.convert('L').resize((9, 8), Image.Resampling.BILINEAR))
        bits = (pixels[:, 1:] > pixels[:, :-1]).reshape(-1)
        value = sum(int(bit) << n for n, bit in enumerate(bits))
        for previous, other in enumerate(hashes):
            if (value ^ other).bit_count() <= distance: parents[root(index)] = root(previous)
        hashes.append(value)
    return [f'tracon_scene_{root(index)}' for index in range(len(paths))]


def build_tracon(cache_dir, crop_dir, caps, seed=42):
    cache = Path(cache_dir) / 'tracon'
    archive = download_public(f'https://codeload.github.com/ikatsamenis/Cone-Detection/zip/{TRACON_COMMIT}', cache / 'tracon.zip', max_bytes=200_000_000)
    root = safe_extract_zip(archive, cache / 'extracted')
    paths = sorted(path for path in root.rglob('*') if path.suffix.lower() in {'.jpg', '.jpeg', '.png'} and '/images/' in path.as_posix())
    if not paths: raise ValueError('TraCon images were not found in the pinned archive.')
    groups = perceptual_groups(paths)
    frame = grouped_split(pd.DataFrame({'path': paths, 'group_id': groups}), seed=seed)
    output, counts = [], Counter(); rng = random.Random(seed)
    for row in frame.sample(frac=1, random_state=seed).to_dict('records'):
        if counts[row['split']] >= caps[row['split']]: continue
        path = Path(row['path'])
        label_path = Path(str(path).replace('/images/', '/labels/')).with_suffix('.txt')
        if not label_path.exists(): continue
        with Image.open(path) as original:
            image = original.convert('RGB')
            candidates = []
            for line in label_path.read_text().splitlines():
                values = line.split()
                if len(values) != 5 or values[0] != '0': raise ValueError('Unexpected TraCon class/YOLO label format.')
                cx, cy, width, height = map(float, values[1:])
                box = clean_bbox([(cx - width / 2) * image.width, (cy - height / 2) * image.height,
                                  width * image.width, height * image.height], image.width, image.height)
                if box: candidates.append(box)
            rng.shuffle(candidates)
            # One crop per original photo; cone context remains varied without duplicating a scene.
            if candidates:
                box = padded_box(candidates[0], image.width, image.height, rng, maximum=0.18)
                output.append(save_status_crop(image, box, crop_dir, label=2, source='tracon', group_id=row['group_id'], split=row['split'],
                                               source_id=path.name, source_sha=file_hash(str(path)), subtype='Traffic cone'))
                counts[row['split']] += 1
    print('TraCon retained by split:', dict(counts), 'Source-photo groups:', len(set(groups)))
    return pd.DataFrame(output)


def build_site_three(root, crop_dir, seed=42):
    root = Path(root); records = []
    labels = {name: index for index, name in enumerate(STATUS_NAMES)}
    for path in root.rglob('*'):
        if not path.is_file() or path.suffix.lower() not in {'.jpg', '.jpeg', '.png', '.webp'}: continue
        if path.parent.name.lower() not in labels: continue
        group = path.parent.parent
        if group.resolve() == root.resolve(): raise ValueError('Use day/session folders above vacant/occupied/blocked, not random adjacent-frame splits.')
        records.append(dict(path=path, label=labels[path.parent.name.lower()], group_id='site_' + str(group.relative_to(root))))
    if not records: raise ValueError('No site crops found. Use day01/vacant, day01/occupied and day01/blocked folders.')
    frame = grouped_split(pd.DataFrame(records), seed=seed); output = []
    for row in frame.to_dict('records'):
        with Image.open(row['path']) as original:
            image = ImageOps.exif_transpose(original).convert('RGB')
            if min(image.size) < 16: raise ValueError('A site crop is too small.')
            output.append(save_status_crop(image, (0, 0, image.width, image.height), crop_dir, label=row['label'], source='site',
                group_id=row['group_id'], split=row['split'], source_id=row['path'].name, source_sha=file_hash(str(row['path'])), subtype='site_labeled'))
    return pd.DataFrame(output)


def audit_three(frame):
    frame = frame.copy().reset_index(drop=True)
    if set(frame.label.unique()) != {0, 1, 2} or set(frame.split.unique()) != {'train', 'val', 'test'}:
        raise ValueError('Need explicit vacant=0, occupied=1, blocked=2 across train/val/test.')
    if frame.groupby('group_id').split.nunique().max() > 1: raise ValueError('A capture/scene group crosses splits.')
    conflicts = set(frame.groupby('crop_sha').label.nunique().loc[lambda x: x > 1].index)
    removed = frame[frame.crop_sha.isin(conflicts)].assign(reason='conflicting_labels')
    frame = frame[~frame.crop_sha.isin(conflicts)].copy()
    frame['_priority'] = frame.split.map({'test': 0, 'val': 1, 'train': 2})
    for column in ('source_sha', 'crop_sha'):
        preferred = frame.sort_values('_priority').drop_duplicates(column).set_index(column).split
        mask = frame.split != frame[column].map(preferred)
        removed = pd.concat([removed, frame[mask].assign(reason=f'{column}_cross_split')], ignore_index=True)
        frame = frame[~mask].copy()
    frame = frame.drop_duplicates('crop_sha').drop(columns='_priority').reset_index(drop=True)
    for split in ('train', 'val', 'test'):
        for source in [None] + (['site'] if 'site' in set(frame.source) else []):
            subset = frame[(frame.split == split) & ((frame.source == source) if source else True)]
            counts = subset.label.value_counts()
            if any(counts.get(label, 0) < 5 for label in range(3)):
                raise ValueError(f'{source or "combined"}/{split} needs five unique crops per class after audit. Add independent sessions with all three classes.')
    return frame, removed.drop(columns='_priority', errors='ignore')
