"""Build a self-contained Colab notebook; embedded helpers need no repository import."""
from pathlib import Path
import textwrap
import nbformat as nbf

ROOT = Path(__file__).resolve().parents[1]
cells = []

def md(source):
    cells.append(nbf.v4.new_markdown_cell(textwrap.dedent(source).strip()))

def code(source, tag=None):
    cell = nbf.v4.new_code_cell(textwrap.dedent(source).strip())
    if tag:
        cell.metadata['tags'] = [tag]
    cells.append(cell)

md('''
# ParkVision · EfficientNetB0: vehicle present / no vehicle

**Upload this `.ipynb` into Google Colab, select a T4 GPU, then Run all.**

This notebook trains **only EfficientNetB0**. It exports a `.keras` file that fits
the existing ParkVision worker without changing the database or input shape.

**The exact rule:** one supplied parking-box crop → target vehicle visible =
`occupied` (1); no target vehicle = `unoccupied` (0, mapped to `vacant` in the app).
Cars/SUVs/vans/pickups are covered by COCO's car/truck categories; bus is included.
Add `motorcycle` to `VEHICLE_CATEGORIES` if it should count too.

No vehicle does **not** prove a space is physically clear or large enough to park.
People, boxes and cones are negatives for this binary task; obstruction detection
is outside this notebook. This revises the target from general occupancy to
vehicle presence. Do not claim the original three-class requirement is complete.

**What changed from S2:** broader vehicle/no-vehicle examples, annotation-checked background
negatives, grouped splits, source/class balancing, actual backbone fine-tuning,
Drive checkpoints, an untouched test set, and an augmentation-free export.

Public datasets can start the run immediately. To address the real Luzano night
errors, add representative labeled crops from the mounted phone. No notebook can
promise correct predictions on unseen cameras without measuring them.
''')
md('''
## 1 · Runtime and installation

Use **Runtime → Change runtime type → T4 GPU**. Run from the top in a fresh
session. The first cells install matching TensorFlow/Keras versions. Drive access
is requested once so checkpoints survive disconnection. The notebook downloads
public data in Colab, including a 253 MB COCO annotation archive plus selected
images and the PKLot download; allow several GB of disk space.
''')
code('''
import sys, subprocess
PACKAGES = [
    'tensorflow==2.20.0', 'keras==3.13.2', 'Pillow>=11.3,<13',
    'pandas>=2.2,<3', 'scikit-learn>=1.5,<2', 'matplotlib>=3.9,<4',
    'kagglehub>=0.3,<1', 'requests>=2.32,<3', 'tqdm>=4.66,<5',
]
subprocess.check_call([sys.executable, '-m', 'pip', 'install', '-q', *PACKAGES])
print('Dependencies installed. Continue downward in this session.')
''', 'install')
md('''
## 2 · Settings

Defaults train on PKLot crops plus COCO vehicle/background crops. No model API
key is needed. `UPLOAD_SITE_ZIP=True` adds your camera-specific crops using the
folder format shown in section 5. Leave it False for a public-data baseline.
Sampling caps control runtime, not the real dataset size. Class 0/1 order is fixed.
''')
code('''
CONFIG = {
    'SEED': 42,
    'REQUIRE_GPU': True,
    'USE_GOOGLE_DRIVE': True,
    'USE_PKLOT': True,
    'USE_COCO': True,
    'PKLOT_ROOT': '',  # Existing Colab dataset path, or empty to use kagglehub.
    'UPLOAD_SITE_ZIP': False,
    'SITE_ROOT': '',   # Existing extracted local-crop directory instead of ZIP upload.
    'VEHICLE_CATEGORIES': ['car', 'truck', 'bus'],
    'PKLOT_PER_CLASS': {'train': 3500, 'val': 600, 'test': 600},
    'COCO_PER_CLASS': {'train': 700, 'val': 150, 'test': 150},
    'SOURCE_WEIGHTS': {'pklot': 1.0, 'coco': 2.0, 'site': 4.0},
    'MAX_TRAIN_SAMPLES_PER_EPOCH': 16000,
    'BATCH_SIZE': 32,
    'HEAD_EPOCHS': 5,
    'FINE_TUNE_EPOCHS': 10,
    'RUN_MANUAL_IMAGE_TEST': False,
}
''', 'config')
code('''
import os, json, random, hashlib, zipfile, math
from pathlib import Path
from datetime import datetime, timezone
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '2'
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import tensorflow as tf
from PIL import Image, ImageOps
from IPython.display import display

tf.keras.utils.set_random_seed(CONFIG['SEED'])
gpus = tf.config.list_physical_devices('GPU')
print('TensorFlow:', tf.__version__, 'Keras:', tf.keras.__version__, 'GPU:', gpus)
if CONFIG['REQUIRE_GPU'] and not gpus:
    raise RuntimeError('Select Runtime → Change runtime type → T4 GPU, then Run all again. No training has started.')
for gpu in gpus:
    try:
        tf.config.experimental.set_memory_growth(gpu, True)
    except RuntimeError:
        pass
if CONFIG['USE_GOOGLE_DRIVE']:
    from google.colab import drive
    drive.mount('/content/drive')
    PROJECT_DIR = Path('/content/drive/MyDrive/ParkVision_EfficientNetB0')
else:
    PROJECT_DIR = Path('/content/ParkVision_EfficientNetB0')
    print('WARNING: Drive is disabled. Download exports before this temporary runtime ends.')
CACHE_DIR = Path('/content/parkvision_data_cache')
CROP_DIR = CACHE_DIR / 'crops'
RUN_DIR = PROJECT_DIR / 'runs' / datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')
for directory in (CACHE_DIR, CROP_DIR, RUN_DIR):
    directory.mkdir(parents=True, exist_ok=True)
(RUN_DIR / 'config.json').write_text(json.dumps(CONFIG, indent=2))
print('Checkpoints and reports:', RUN_DIR)
print('0 = unoccupied / app vacant; 1 = occupied. Inputs stay RGB 0–255.')
''', 'runtime')
md('''
## 3 · Data preparation helpers (run this cell unchanged)

The following code is embedded in this notebook. You do not need to upload the
ParkVision repository. PKLot labels come from category names, not guessed IDs.
Whole capture-day/source-image groups are assigned before cropping. COCO negative
crops cannot overlap an annotated target vehicle. Inspect the sample images:
public annotations can still have mistakes, especially for tiny/partly hidden cars.
Empty PKLot crops that intersect an occupied-position box are excluded because
their labels would be ambiguous for the vehicle-presence target.
''')
code((ROOT / 'ml/training_data.py').read_text(), 'data_helpers')
md('''
## 4 · Build the public-data baseline

PKLot supplies actual empty/occupied parking positions. COCO adds different car
angles and vehicle-free backgrounds, including negative patches from car scenes.
The COCO **val2017 source pool is repartitioned** here into this experiment's own
train/val/test groups; it is not being presented as the official COCO benchmark.
PKLot is also regrouped by capture day when filenames permit, instead of retaining
a potentially frame-random third-party split. All resulting assignments are saved.
''')
code('''
sources = []
if CONFIG['USE_PKLOT']:
    if CONFIG['PKLOT_ROOT']:
        pklot_root = Path(CONFIG['PKLOT_ROOT'])
    else:
        import kagglehub
        pklot_root = Path(kagglehub.dataset_download('ammarnassanalhajali/pklot-dataset'))
    print('PKLot directory:', pklot_root)
    pklot = build_pklot(pklot_root, CROP_DIR, CONFIG['PKLOT_PER_CLASS'], CONFIG['SEED'])
    sources.append(pklot)
    display(pklot.groupby(['split', 'label']).size().unstack(fill_value=0))
    print('PKLot grouping methods:', pklot.grouping_rule.value_counts().to_dict())
if CONFIG['USE_COCO']:
    coco = build_coco(CACHE_DIR, CROP_DIR, CONFIG['COCO_PER_CLASS'], tuple(CONFIG['VEHICLE_CATEGORIES']), CONFIG['SEED'])
    sources.append(coco)
    display(coco.groupby(['split', 'label']).size().unstack(fill_value=0))
''', 'public_data')
md('''
## 5 · Optional: add your mounted-phone crops

Set `UPLOAD_SITE_ZIP=True` above to choose a ZIP, or set `SITE_ROOT` to an existing
extracted folder. Each image must already be a **crop of one intended parking
position**, using the same box when occupied/empty. Include empty floor, walls,
shadows, building ceiling where unavoidable, night/day lighting, cars of different
colors, and partly visible cars. Do not redraw a special favorable box for each car.

Organize independent capture **days/sessions** like this (at least three groups):

```text
site_crops/
  day01/
    occupied/       # Vehicle visible in that parking crop.
      frame_001.jpg
    unoccupied/     # No target vehicle in the crop.
      frame_002.jpg
  day02/
    occupied/...
    unoccupied/...
  day03/
    occupied/...
    unoccupied/...
```

Keep neighboring frames and all clips from one capture session in the same group.
More independent groups are better than thousands of nearly identical frames.
Two photos are a useful sanity check, not enough to measure deployment accuracy.
Local training and held-out groups must contain both classes. Site data receives
more sampling weight when present; no local accuracy is claimed when it is absent.
''')
code('''
site_root = CONFIG['SITE_ROOT']
if CONFIG['UPLOAD_SITE_ZIP']:
    from google.colab import files
    uploaded = files.upload()
    archives = [name for name in uploaded if name.lower().endswith('.zip')]
    if len(archives) != 1:
        raise ValueError('Upload exactly one ZIP of labeled site crops.')
    site_root = str(safe_extract_zip(archives[0], CACHE_DIR / 'site_upload'))
if site_root:
    site = build_local_crops(site_root, CROP_DIR, CONFIG['SEED'])
    sources.append(site)
    display(site.groupby(['split', 'label']).size().unstack(fill_value=0))
else:
    print('No site crops supplied. This run is a public-data candidate, not a validated Luzano model.')
if not sources:
    raise ValueError('Enable a public dataset or supply local crops before training.')
''', 'local_data')
md('''
## 6 · Leakage/label audit and inspect actual inputs

Conflicting exact crop labels are excluded. Duplicate source images/crops cannot
cross splits: holdout data is retained in preference to training copies. This does
not prove all near-duplicates are gone; grouping by real capture sessions remains
important. If a split lacks enough unique examples, the notebook stops rather than
reporting a misleading evaluation.
''')
code('''
manifest, excluded = audit_manifest(pd.concat(sources, ignore_index=True))
manifest.to_csv(RUN_DIR / 'manifest.csv', index=False)
excluded.to_csv(RUN_DIR / 'excluded_records.csv', index=False)
print('Retained:', len(manifest), 'Excluded conflicting/leaking rows:', len(excluded))
display(manifest.groupby(['source', 'split', 'label']).size().rename('examples').reset_index())
assert manifest.groupby('group_id')['split'].nunique().max() == 1
assert manifest.groupby('source_sha')['split'].nunique().max() == 1
assert manifest.groupby('crop_sha')['split'].nunique().max() == 1

train_examples = manifest[manifest.split == 'train']
examples_per_class = min(8, int(train_examples.label.value_counts().min()))
sample = train_examples.groupby('label', group_keys=False).sample(n=examples_per_class, random_state=CONFIG['SEED'])
fig, axes = plt.subplots(4, 4, figsize=(11, 11))
for axis in axes.ravel():
    axis.axis('off')
for axis, row in zip(axes.ravel(), sample.to_dict('records')):
    with Image.open(row['path']) as image:
        axis.imshow(image)
    axis.set_title(f"{row['source']} · {CLASS_NAMES[row['label']]}", fontsize=9)
    axis.axis('off')
fig.suptitle('Inspect labels BEFORE training; do not relabel errors just to improve scores')
fig.tight_layout(); plt.show()
''', 'audit')
md('''
## 7 · EfficientNetB0 model and datasets

Pixels remain RGB float32 in **0–255**; EfficientNet includes its own scaling.
Only training sees augmentation. Classes and sources are balanced through training
sampling, while validation loss is source-balanced so a small site dataset is not
drowned out by PKLot. Final reported accuracy/F1 are ordinary unweighted holdout
metrics, shown separately for each source.
''')
code((ROOT / 'ml/training_model.py').read_text(), 'model_helpers')
code('''
train_frame = manifest[manifest.split == 'train'].reset_index(drop=True)
val_frame = manifest[manifest.split == 'val'].reset_index(drop=True)
sampled_train = balanced_training_frame(train_frame, CONFIG['SOURCE_WEIGHTS'], CONFIG['MAX_TRAIN_SAMPLES_PER_EPOCH'], CONFIG['SEED'])
val_weights = validation_weights(val_frame, CONFIG['SOURCE_WEIGHTS'])
train_ds = make_dataset(sampled_train, CONFIG['BATCH_SIZE'], training=True, seed=CONFIG['SEED'])
val_ds = make_dataset(val_frame, CONFIG['BATCH_SIZE'], weights=val_weights)
sample_images, sample_labels = next(iter(train_ds))
assert sample_images.shape[1:] == (224, 224, 3)
assert 0 <= float(tf.reduce_min(sample_images)) <= float(tf.reduce_max(sample_images)) <= 255
print('Batch:', sample_images.shape, 'pixel range:', float(tf.reduce_min(sample_images)), float(tf.reduce_max(sample_images)))
print('Balanced training samples per epoch:', len(sampled_train))
display(sampled_train.groupby(['source', 'label']).size().rename('draws_per_epoch').reset_index())
''', 'datasets')
md('''
## 8 · Train, then fine-tune (EfficientNetB0 only)

Stage 1 trains the head. Stage 2 unfreezes blocks 6/7 and the top convolution with
a smaller learning rate; BatchNorm stays frozen. Best checkpoints are written to
Drive after each improved epoch. The final candidate is selected **only by
validation loss**, never by its test score. Nothing is saved into your app yet.
''')
code('''
best_model, training_info, histories = train_stages(
    train_ds, val_ds, RUN_DIR,
    head_epochs=CONFIG['HEAD_EPOCHS'], fine_epochs=CONFIG['FINE_TUNE_EPOCHS'],
    seed=CONFIG['SEED'], weights='imagenet',
)
(RUN_DIR / 'training_info.json').write_text(json.dumps(training_info, indent=2))
(RUN_DIR / 'histories.json').write_text(json.dumps(histories, indent=2))
print('Chosen checkpoint:', training_info)
fig, axes = plt.subplots(1, 2, figsize=(11, 4))
for stage, history in histories.items():
    axes[0].plot(history['loss'], label=f'{stage} train')
    axes[0].plot(history['val_loss'], '--', label=f'{stage} validation')
    axes[1].plot(history['accuracy'], label=f'{stage} train')
    axes[1].plot(history['val_accuracy'], '--', label=f'{stage} validation')
axes[0].set_title('Loss (source-balanced validation)'); axes[1].set_title('Unweighted accuracy')
for axis in axes:
    axis.set_xlabel('Epoch within stage'); axis.legend()
fig.tight_layout(); fig.savefig(RUN_DIR / 'training_curves.png', dpi=160); plt.show()
''', 'train')
md('''
## 9 · Evaluate the untouched test groups

Decision threshold stays **0.5**, matching ParkVision. Do not adjust it after
looking at test errors. A high public-data score is not evidence of night-camera
accuracy. The table below explicitly shows whether site test data exists.
''')
code('''
metrics, test_predictions = evaluate_holdout(best_model, manifest, RUN_DIR, CONFIG['BATCH_SIZE'])
display(pd.DataFrame(metrics['by_source']).T)
if 'site' not in metrics['by_source']:
    print('SITE VALIDATION: NOT MEASURED. Add independent mounted-phone recordings before claiming Luzano accuracy.')
else:
    print('SITE TEST:', metrics['by_source']['site'])
errors = test_predictions[test_predictions.label != test_predictions.prediction].copy()
if len(errors):
    errors['wrong_score'] = np.where(errors.prediction == 1, errors.p_occupied, 1 - errors.p_occupied)
    examples = errors.sort_values('wrong_score', ascending=False).head(12)
    fig, axes = plt.subplots(3, 4, figsize=(11, 8))
    for axis in axes.ravel():
        axis.axis('off')
    for axis, row in zip(axes.ravel(), examples.to_dict('records')):
        with Image.open(row['path']) as image:
            axis.imshow(image)
        axis.set_title(f"{row['source']} true={CLASS_NAMES[row['label']]}\\np(occupied)={row['p_occupied']:.3f}", fontsize=8)
    fig.suptitle('Hard errors: inspect them; keep them in the evaluation')
    fig.tight_layout(); fig.savefig(RUN_DIR / 'hard_errors.png', dpi=160); plt.show()
''', 'evaluate')
md('''
## 10 · Export and download the app-ready package

The export reuses the learned weights but removes training augmentation/dropout.
It checks inference parity before/after export and after reloading `.keras`.
**Do not use `tf.saved_model.save` here.** One ZIP contains the model, metadata,
metrics, confusion matrix and split manifest. The ZIP is also preserved on Drive.
''')
code('''
inference_model, metadata, export_zip = export_vehicle_model(
    best_model, manifest, metrics, training_info, RUN_DIR, CONFIG,
)
print('EXPORT:', export_zip)
print('MODEL:', metadata['model_name'], 'SHA256:', metadata['sha256'])
print('Save/reload parity:', metadata['save_reload_parity_passed'])
print('Site test evaluated:', metadata['site_test_evaluated'])
print('This is a candidate. Review the actual test results before replacing the app model.')
from google.colab import files
files.download(str(export_zip))
EXPORT_DONE_THIS_SESSION = True
''', 'export')
md('''
## 11 · Put it into ParkVision

Unzip the download. The two files that belong together are:

- `parkvision_efficientnetb0.keras`
- `parkvision_efficientnetb0.metadata.json`

Back up the previous model, then place both files into `ParkVision/ml/models/`.
Restart `npm run dev` so Python loads the new weights. **No SQL reset or new
Supabase tables are needed.** The worker still expects RGB 224×224 float32, 0–255,
with output 0 = app vacant, 1 = occupied. Do not add another `/255` operation.

The app's `MINIMUM_CONFIDENCE=0.80` is a separate publication/review filter, not the
binary decision threshold or a measured accuracy guarantee. Keep model evaluation
separate from whether the UI permits publication.
''')
md('''
## 12 · Optional: test your actual photo (does not train on it)

Set `RUN_MANUAL_IMAGE_TEST=True` and rerun this cell. Upload one photo and edit
`TEST_BOXES` to your normalized x/y/width/height values. Leave out the building
ceiling where practical, but keep a fixed parking-region box when a car leaves.
The default rectangles are illustrative, not a guaranteed calibration.
''')
code('''
if CONFIG['RUN_MANUAL_IMAGE_TEST']:
    from google.colab import files
    uploaded = files.upload()
    name = next(iter(uploaded))
    image = ImageOps.exif_transpose(Image.open(name)).convert('RGB')
    TEST_BOXES = [
        {'name': 'left position', 'x': 0.08, 'y': 0.45, 'width': 0.38, 'height': 0.50},
        {'name': 'right position', 'x': 0.46, 'y': 0.40, 'width': 0.53, 'height': 0.48},
    ]
    crops = []
    for box in TEST_BOXES:
        pixel_box = clean_bbox([box['x'] * image.width, box['y'] * image.height,
                                box['width'] * image.width, box['height'] * image.height], image.width, image.height)
        if pixel_box is None:
            raise ValueError('Invalid test rectangle.')
        crops.append(tf.image.resize(np.asarray(image.crop(pixel_box), dtype=np.float32), (224, 224), method='bilinear'))
    scores = np.asarray(inference_model(tf.stack(crops), training=False)).reshape(-1)
    fig, axes = plt.subplots(1, len(crops), figsize=(5 * len(crops), 4), squeeze=False)
    for axis, box, crop, score in zip(axes.ravel(), TEST_BOXES, crops, scores):
        axis.imshow(np.clip(crop.numpy(), 0, 255).astype('uint8'))
        axis.set_title(f"{box['name']}\\n{CLASS_NAMES[int(score >= 0.5)]}, p(occupied)={score:.3f}")
        axis.axis('off')
    fig.tight_layout(); plt.show()
else:
    print('Skipped optional photo upload. The model ZIP has already been exported.')
''', 'manual_test')
md('''
## Recovery after Colab disconnects

If an export completed, run **only the cell below** in a new session to download
the latest saved ZIP. It does not retrain. If training stopped before export, the
Drive run folder still contains `best_head.keras` / `best_finetune.keras` and logs.
Restore that checkpoint instead of rebuilding an untrained head. A partially
trained checkpoint still needs its held-out evaluation before deployment.
''')
code('''
# Independent recovery cell. No training variables are needed.
from pathlib import Path
if globals().get('EXPORT_DONE_THIS_SESSION', False):
    print('Normal run completed; the export was already downloaded. Recovery is only needed in a new session.')
else:
    from google.colab import drive, files
    drive.mount('/content/drive')
    saved_exports = sorted(Path('/content/drive/MyDrive/ParkVision_EfficientNetB0/runs').glob('*/parkvision_efficientnetb0_export.zip'))
    if saved_exports:
        print('Downloading saved export:', saved_exports[-1])
        files.download(str(saved_exports[-1]))
    else:
        checkpoints = sorted(Path('/content/drive/MyDrive/ParkVision_EfficientNetB0/runs').glob('*/best_*.keras'))
        print('No completed export found. Saved checkpoints:')
        for checkpoint in checkpoints:
            print(checkpoint)
        print('Weights in these .keras checkpoints are preserved; do not overwrite them by rebuilding an untrained model.')
''', 'recovery')
md('''
## Sources and reporting

- [Keras EfficientNet fine-tuning](https://keras.io/examples/vision/image_classification_efficientnet_fine_tuning/)
- [Keras transfer learning / BatchNorm guidance](https://keras.io/guides/transfer_learning/)
- [Keras model saving](https://keras.io/api/models/model_saving_apis/model_saving_and_loading/)
- [PKLot dataset / citation and license](https://web.inf.ufpr.br/vri/databases/parking-lot-database/)
- [COCO dataset / terms](https://cocodataset.org/#termsofuse)

Public datasets retain their original licenses. Cite the datasets in your report.
Report this as a **new EfficientNetB0 experiment**, not the old S2 comparison score.
Do not copy the old 96.88% result onto newly trained weights. Use the metrics saved
by this run, and explicitly state when local day/night accuracy was not measured.
''')

notebook = nbf.v4.new_notebook(cells=cells, metadata={
    'kernelspec': {'display_name': 'Python 3', 'language': 'python', 'name': 'python3'},
    'language_info': {'name': 'python', 'version': '3.11'},
    'colab': {'name': 'ParkVision_EfficientNetB0_VehiclePresence.ipynb', 'provenance': []},
    'accelerator': 'GPU',
})
nbf.validate(notebook)
output = ROOT / 'notebooks/ParkVision_EfficientNetB0_VehiclePresence.ipynb'
output.parent.mkdir(parents=True, exist_ok=True)
nbf.write(notebook, output)
print(f'Wrote {output} ({len(cells)} cells)')
