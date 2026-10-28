"""Generate a standalone Colab notebook for the three-class parking classifier."""
from pathlib import Path
import textwrap
import nbformat as nbf

ROOT = Path(__file__).resolve().parents[1]
cells = []
def md(text): cells.append(nbf.v4.new_markdown_cell(textwrap.dedent(text).strip()))
def code(text, tag):
    cell = nbf.v4.new_code_cell(textwrap.dedent(text).strip())
    cell.metadata['tags'] = [tag]; cells.append(cell)
def embedded(name):
    return '\n'.join(line for line in (ROOT / 'ml' / name).read_text().splitlines() if not line.startswith('from ml.'))

SOURCES = '''# Dataset sources and reporting
- PKLot: https://web.inf.ufpr.br/vri/databases/parking-lot-database/ ; mirror: https://www.kaggle.com/datasets/ammarnassanalhajali/pklot-dataset . Retains dataset terms/citation.
- Open Images V7 class list and V5 validation boxes: https://storage.googleapis.com/openimages/web/download_v7.html . Selected source images retain their original licenses; OriginalURL/License/Author are carried into manifest.csv. Verify original image terms before redistribution.
- TraCon: https://github.com/ikatsamenis/Cone-Detection ; paper https://arxiv.org/abs/2205.11830 . Pinned commit 7ac4af371e826b5124a9b4defaa3327bc817817e. Cite the authors. No explicit dataset license file was found in that pinned repository; confirm permission before redistributing its images or commercial use. Raw images are not bundled in the model export.
- EfficientNet inputs: https://keras.io/api/applications/efficientnet/ ; fine-tuning: https://keras.io/guides/transfer_learning/ . RGB 0..255, preprocessing inside EfficientNet.

PKLot is regrouped by capture day. The Open Images validation SOURCE POOL is repartitioned into this experiment's own train/validation/test groups by image, not reported as its official benchmark. TraCon source photos are regrouped with perceptual near-duplicate grouping before splitting, ignoring its original split. This reduces leakage but cannot prove all related scenes were found. Keep your own capture sessions together.
Public object and annotation-free background crops are bootstrap proxies. An annotation-free patch is not verified parking ground; an object in an image does not prove it obstructs a parking space. Site-labeled fixed-box crops establish that distinction. Do not reuse binary COCO 'unoccupied' crops: those can contain people/objects that now need a different label.
Report the new run's full holdout scores, class precision/recall/support, per-source scores, and coverage of the review filter. Do not reuse the old S2 score, tune settings against test errors, or describe public performance as site accuracy. The three-class argmax is separate from the app's 0.80 review threshold. Confidence is not verified accuracy. Any site data included in previous model training must not be used as a new independent test set.
'''
md('''
# ParkVision · EfficientNetB0 · vacant / vehicle / obstruction

**Upload this notebook to Google Colab → select T4 GPU → Run all.** It is self-contained; no repository upload is needed. It trains only EfficientNetB0 and exports a candidate compatible with ParkVision's existing saved parking boxes.

| Output | Meaning inside ONE fixed parking-region crop |
|---|---|
| 0 `vacant` | No vehicle or non-vehicle obstruction occupies the intended usable area. |
| 1 `occupied` | A vehicle occupies the position. |
| 2 `blocked` | A non-vehicle obstruction (for example a cone or box) occupies the intended usable area. |

A ceiling/wall/background object outside the usable parking area is **not** a blockage. When an actual obstruction and vehicle both affect a position, label it **blocked**. Public positive crops with mixed vehicle/obstruction annotations are excluded rather than guessing that relationship. Label ambiguous site examples carefully or exclude them before splitting.

Defaults download actual parking examples (PKLot), labeled vehicles/people/boxes and other objects (Open Images), and traffic cones (TraCon). **These provide a public-data baseline, not proof of site performance or arbitrary-object detection.** Add representative fixed-box site crops to teach what counts as blocking your parking area. The system cannot determine physical parkability or vehicle clearance from a classifier alone. No CCTV connection is needed to train or test this.
''')
md('''
## 1 · Install
Use **Runtime → Change runtime type → T4 GPU**. Run in a fresh runtime. Data download can take several minutes and several GB, especially PKLot. Authorize Drive to preserve checkpoints. The full GPU run must be performed by you; creating this notebook does not train or replace the installed app model.
''')
code('''
import sys, subprocess
subprocess.check_call([sys.executable, '-m', 'pip', 'install', '-q',
    'tensorflow==2.20.0', 'keras==3.13.2', 'Pillow>=11.3,<13',
    'pandas>=2.2,<3', 'scikit-learn>=1.5,<2', 'matplotlib>=3.9,<4',
    'kagglehub>=0.3,<1', 'requests>=2.32,<3', 'tqdm>=4.66,<5'])
''', 'install')
md('''
## 2 · Settings
The defaults run without uploading your own data. For stronger site results, add the three-class ZIP described in section 4. `WARM_START_UPLOAD=True` optionally loads only the backbone from your existing EfficientNetB0 `.keras` model (or its export ZIP); the three-class head is newly trained. Keep every image used by that old model out of the new independent test set. Leave False if that earlier data provenance is unclear. ImageNet initialization is the default.
''')
code('''
CONFIG = {
    'SEED': 42, 'REQUIRE_GPU': True, 'USE_GOOGLE_DRIVE': True,
    'USE_PKLOT': True, 'USE_OPEN_IMAGES': True, 'USE_TRACON': True,
    'PKLOT_ROOT': '', 'SITE_ROOT': '', 'UPLOAD_SITE_ZIP': False,
    'WARM_START_UPLOAD': False,
    'VEHICLE_NAMES': ['Car', 'Van', 'Truck', 'Bus', 'Motorcycle', 'Bicycle'],
    'OBSTRUCTION_NAMES': ['Person', 'Man', 'Woman', 'Boy', 'Girl', 'Box', 'Chair', 'Cart',
                          'Waste container', 'Luggage and bags', 'Plastic bag', 'Handbag'],
    'PKLOT_PER_CLASS': {'train': 2500, 'val': 400, 'test': 400},
    'OPENIMAGES_PER_CLASS': {'train': 1000, 'val': 200, 'test': 200},
    'TRACON_CAPS': {'train': 350, 'val': 70, 'test': 70},
    'SOURCE_WEIGHTS': {'pklot': 1.0, 'openimages': 1.5, 'tracon': 0.6, 'site': 4.0},
    'MAX_TRAIN_SAMPLES_PER_EPOCH': 16000, 'BATCH_SIZE': 32,
    'HEAD_EPOCHS': 5, 'FINE_TUNE_EPOCHS': 10,
    'REVIEW_THRESHOLD': 0.80, 'RUN_MANUAL_IMAGE_TEST': False,
}
''', 'config')
code('''
import os, json, random
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
    raise RuntimeError('Choose Runtime → Change runtime type → T4 GPU, then Run all.')
for gpu in gpus:
    try: tf.config.experimental.set_memory_growth(gpu, True)
    except RuntimeError: pass
if CONFIG['USE_GOOGLE_DRIVE']:
    from google.colab import drive
    drive.mount('/content/drive')
    PROJECT_DIR = Path('/content/drive/MyDrive/ParkVision_ThreeClass_EfficientNetB0')
else:
    PROJECT_DIR = Path('/content/ParkVision_ThreeClass_EfficientNetB0')
    print('Drive disabled: runtime files disappear on disconnect; download the export.')
CACHE_DIR = Path('/content/parkvision_threeclass_cache')
CROP_DIR = CACHE_DIR / 'crops'
RUN_DIR = PROJECT_DIR / 'runs' / datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')
for directory in (CACHE_DIR, CROP_DIR, RUN_DIR): directory.mkdir(parents=True, exist_ok=True)
(RUN_DIR / 'config.json').write_text(json.dumps(CONFIG, indent=2))
print('Checkpoints/reports:', RUN_DIR)
print('Class order is FIXED: 0 vacant, 1 occupied, 2 blocked.')
''', 'runtime')
md('''
## 3 · Prepare public data
Run the helper cells unchanged. All helpers are embedded below. Source images/scenes are assigned to splits **before** cropping. Exact conflicting labels and cross-split duplicates are removed later. Open Images backgrounds exclude all annotated objects, but missing annotations remain possible; inspect the labels. TraCon supplies cone positives only, since its labels cannot establish that a background is clear of other objects.
''')
code(embedded('training_data.py'), 'base_data_helpers')
code(embedded('obstruction_data.py'), 'three_class_data_helpers')
code('''
sources = []
if CONFIG['USE_PKLOT']:
    if CONFIG['PKLOT_ROOT']:
        pklot_root = Path(CONFIG['PKLOT_ROOT'])
    else:
        import kagglehub
        pklot_root = Path(kagglehub.dataset_download('ammarnassanalhajali/pklot-dataset'))
    sources.append(build_pklot(pklot_root, CROP_DIR, CONFIG['PKLOT_PER_CLASS'], CONFIG['SEED']))
if CONFIG['USE_OPEN_IMAGES']:
    sources.append(build_openimages(CACHE_DIR, CROP_DIR, CONFIG['OPENIMAGES_PER_CLASS'],
                                   CONFIG['VEHICLE_NAMES'], CONFIG['OBSTRUCTION_NAMES'], CONFIG['SEED']))
if CONFIG['USE_TRACON']:
    sources.append(build_tracon(CACHE_DIR, CROP_DIR, CONFIG['TRACON_CAPS'], CONFIG['SEED']))
for frame in sources:
    display(frame.groupby(['source', 'split', 'label']).size().rename('examples').reset_index())
''', 'public_data')
md('''
## 4 · Optional site crops — recommended before deployment
Set `UPLOAD_SITE_ZIP=True` above, or set `SITE_ROOT` to an extracted folder. Use real **crops of the same fixed parking position**, matching the saved app box. Include independent day/night sessions, empty ground, vehicles of different colors, cones, boxes, and other relevant obstructions. Avoid unrelated ceiling and neighboring spaces in the box. Do not draw a different favorable crop for every image. A sack on the parking footprint can be blocked; a sack permanently outside it is background.

```text
site_crops/
  day01/
    vacant/      # Clear intended usable area, no vehicle.
    occupied/    # Vehicle occupies that area.
    blocked/     # Non-vehicle object obstructs that area.
  day02/
    vacant/...
    occupied/...
    blocked/...
  day03/
    vacant/...
    occupied/...
    blocked/...
```

Use **at least three independent recording days/sessions**, with all three classes in each session and at least five unique crops per class in every final split (a technical minimum, not enough to establish deployment quality). Keep adjacent frames and all clips from one session together. More independent sessions are better than many nearly identical frames. Reserve new sessions for a final site test. Do not reuse the old binary negative folders: cones/people may have been labeled vacant there. Do not label every non-car background as blocked.
''')
code('''
site_root = CONFIG['SITE_ROOT']
if CONFIG['UPLOAD_SITE_ZIP']:
    from google.colab import files
    uploaded = files.upload()
    archives = [name for name in uploaded if name.lower().endswith('.zip')]
    if len(archives) != 1: raise ValueError('Upload one ZIP with session/vacant, occupied, blocked folders.')
    site_root = str(safe_extract_zip(archives[0], CACHE_DIR / 'site_upload'))
if site_root:
    sources.append(build_site_three(site_root, CROP_DIR, CONFIG['SEED']))
else:
    print('SITE PERFORMANCE NOT MEASURED: public-data candidate only.')
if not sources: raise ValueError('Enable public datasets or supply site crops.')
''', 'site_data')
md('''
## 5 · Audit and inspect labels before training
This stops when a class/split is missing. Single-class cone data is allowed as one source, but all three classes are required in the combined splits and in site splits if supplied. Exact duplicate photos cannot leak across splits. TraCon additionally groups similar source photos; grouping cannot establish that every related scene was found. Manually inspect backgrounds and positive object crops. Public objects fill their crop more than a small object in a wide parking view; site crops are needed to address that difference.
''')
code('''
manifest, excluded = audit_three(pd.concat(sources, ignore_index=True))
manifest.to_csv(RUN_DIR / 'manifest.csv', index=False)
excluded.to_csv(RUN_DIR / 'excluded_records.csv', index=False)
display(manifest.groupby(['source', 'split', 'label']).size().rename('examples').reset_index())
assert manifest.groupby('group_id').split.nunique().max() == 1
assert manifest.groupby('source_sha').split.nunique().max() == 1
assert manifest.groupby('crop_sha').split.nunique().max() == 1
train_examples = manifest[manifest.split == 'train']
n = min(6, int(train_examples.label.value_counts().min()))
fig, axes = plt.subplots(3, n, figsize=(3 * n, 8), squeeze=False)
for label, row_axes in enumerate(axes):
    examples = train_examples[train_examples.label == label].sample(n=n, random_state=CONFIG['SEED'])
    for axis, item in zip(row_axes, examples.to_dict('records')):
        with Image.open(item['path']) as image: axis.imshow(image)
        axis.set_title(f"{STATUS_NAMES[label]} · {item['source']}\\n{item.get('subtype', '')}", fontsize=8)
        axis.axis('off')
fig.tight_layout(); plt.show()
print('Retained:', len(manifest), 'Excluded:', len(excluded))
print('Inspect Box and Traffic cone support in the table; download failures can reduce category coverage.')
if 'subtype' in manifest: display(manifest[manifest.label == 2].groupby(['split', 'subtype']).size().rename('blocked_examples').reset_index())
''', 'audit')
code('SOURCES_TEXT = ' + repr(SOURCES) + "\n(RUN_DIR / 'SOURCES.md').write_text(SOURCES_TEXT)", 'sources_record')
md('''
## 6 · EfficientNetB0 and datasets
RGB float32 inputs remain **0–255**; EfficientNet includes scaling. A three-unit softmax replaces the binary head. Augmentation applies during training only. Training is balanced by class, then by available source within each class. Validation checkpoint loss is class/source balanced. Final holdout accuracy is ordinary unweighted accuracy, reported separately by source. No augmentation or oversampling of the test set.
''')
code(embedded('training_model.py'), 'base_model_helpers')
code(embedded('obstruction_model.py'), 'three_class_model_helpers')
code('''
starting_model = None
if CONFIG['WARM_START_UPLOAD']:
    from google.colab import files
    uploaded = files.upload()
    paths = [Path(name) for name in uploaded]
    if len(paths) != 1: raise ValueError('Upload one previous .keras model or export ZIP.')
    if paths[0].suffix.lower() == '.zip':
        extracted = safe_extract_zip(paths[0], CACHE_DIR / 'warm_start')
        paths = list(extracted.rglob('parkvision_efficientnetb0.keras'))
    if len(paths) != 1 or paths[0].suffix != '.keras': raise ValueError('Could not find the previous .keras model.')
    starting_model = str(paths[0])
train_frame = manifest[manifest.split == 'train'].reset_index(drop=True)
val_frame = manifest[manifest.split == 'val'].reset_index(drop=True)
sampled = balanced_three(train_frame, CONFIG['SOURCE_WEIGHTS'], CONFIG['MAX_TRAIN_SAMPLES_PER_EPOCH'], CONFIG['SEED'])
train_ds = make_dataset(sampled, CONFIG['BATCH_SIZE'], training=True, seed=CONFIG['SEED'])
val_ds = make_dataset(val_frame, CONFIG['BATCH_SIZE'], weights=three_validation_weights(val_frame, CONFIG['SOURCE_WEIGHTS']))
images, labels = next(iter(train_ds))
assert images.shape[1:] == (224, 224, 3)
assert 0 <= float(tf.reduce_min(images)) <= float(tf.reduce_max(images)) <= 255
display(sampled.groupby(['source', 'label']).size().rename('training_draws').reset_index())
''', 'datasets')
md('''
## 7 · Train the head, then fine-tune
Head training uses a frozen ImageNet backbone by default. Stage 2 unfreezes blocks 6/7 at a smaller learning rate; BatchNorm remains frozen. Save best checkpoints on Drive. Choose the candidate by validation loss only. Do not interrupt a working runtime to export, or restart it after training before saving.
''')
code('''
best_model, training_info, histories = fit_three(train_ds, val_ds, RUN_DIR,
    head_epochs=CONFIG['HEAD_EPOCHS'], fine_epochs=CONFIG['FINE_TUNE_EPOCHS'],
    seed=CONFIG['SEED'], weights='imagenet', starting_model=starting_model)
(RUN_DIR / 'training_info.json').write_text(json.dumps(training_info, indent=2))
(RUN_DIR / 'histories.json').write_text(json.dumps(histories, indent=2))
print(training_info)
fig, axes = plt.subplots(1, 2, figsize=(11, 4))
for stage, history in histories.items():
    for key, axis in [('loss', axes[0]), ('accuracy', axes[1])]:
        axis.plot(history[key], label=f'{stage} train')
        axis.plot(history[f'val_{key}'], '--', label=f'{stage} validation')
for axis in axes: axis.set_xlabel('Epoch within stage'); axis.legend()
axes[0].set_title('Class/source-balanced validation loss'); axes[1].set_title('Unweighted accuracy')
fig.tight_layout(); fig.savefig(RUN_DIR / 'training_curves.png', dpi=160); plt.show()
''', 'train')
md('''
## 8 · Untouched holdout evaluation
Prediction = highest of three scores. Report **all-example** accuracy/macro F1, each class's precision/recall/support, source-specific results, cone/Box checks, and the confusion matrix. The 80% publication filter is reported separately so reviewed/skipped mistakes do not disappear from the headline score. If site data is absent, site accuracy is NOT MEASURED. The source mix affects overall accuracy; public and local results are not interchangeable. Test errors are for reporting, not tuning this run.
''')
code('''
metrics, test_predictions = evaluate_three(best_model, manifest, RUN_DIR, CONFIG['BATCH_SIZE'], CONFIG['REVIEW_THRESHOLD'])
display(pd.DataFrame(metrics['overall']['by_class']).T)
display(pd.DataFrame({source: result['accuracy'] for source, result in metrics['by_source'].items()}, index=['accuracy']).T)
if 'positive_subtype_checks' in metrics: display(pd.DataFrame(metrics['positive_subtype_checks']))
errors = test_predictions[test_predictions.label != test_predictions.prediction].sort_values('confidence', ascending=False).head(12)
if len(errors):
    fig, axes = plt.subplots(3, 4, figsize=(12, 9))
    for axis in axes.ravel(): axis.axis('off')
    for axis, item in zip(axes.ravel(), errors.to_dict('records')):
        with Image.open(item['path']) as image: axis.imshow(image)
        axis.set_title(f"true={THREE_CLASSES[item['label']]}\\npred={THREE_CLASSES[item['prediction']]} ({item['confidence']:.2f})", fontsize=8)
    fig.tight_layout(); fig.savefig(RUN_DIR / 'hard_errors.png', dpi=160); plt.show()
''', 'evaluate')
md('''
## 9 · Export and download
Native `.keras` export removes augmentation/dropout and checks output parity before and after saving/reloading. **Do not use `tf.saved_model.save`.** The model and checksum metadata must stay together. Exporting does not mean the candidate passed site validation.
''')
code('''
inference_model, metadata, export_zip = export_three(best_model, manifest, metrics, training_info, RUN_DIR, CONFIG)
print('Export:', export_zip)
print('Model:', metadata['model_name'], 'SHA256:', metadata['sha256'])
print('Site test evaluated:', metadata['site_test_evaluated'])
from google.colab import files
files.download(str(export_zip))
EXPORT_DONE_THIS_SESSION = True
''', 'export')
md('''
## 10 · Install in ParkVision
1. Unzip `parkvision_three_class_export.zip` and review `metrics.json`, confusion matrix and error examples.
2. Back up the app's existing **model and metadata pair** outside `ml/models/`.
3. Copy **both** `parkvision_efficientnetb0.keras` and `parkvision_efficientnetb0.metadata.json` into `ParkVision/ml/models/`.
4. Restart `npm run dev`. The workspace should report three-class obstruction support and model name `ParkVision_EfficientNetB0_ThreeClass` with this export's checksum prefix.
5. Use the **same saved parking boxes**. Test clear/vehicle/cone/box examples. Publish accepted results; blocked should produce a slot warning/alert and never count as available. Later accepted clear/vehicle observations resolve the alert. Low class scores remain Needs review.

**Keep Supabase and all existing regions. No SQL reset is needed.** Older binary-only app workers must first be updated to three-class support. The app still uses a separate minimum class score of 0.80 for publication; this is not a verified accuracy guarantee. Cones outside the parking footprint should not be labeled blocked. New obstruction types need representative training and independent testing.
''')
md('''
## 11 · Optional photo and box test
Set `RUN_MANUAL_IMAGE_TEST=True`, upload one photo and edit the normalized `TEST_BOXES`. These examples are illustrative. Test data is not used for training. Keep the same parking box when a car or object leaves. A correct single photo is a sanity check, not measured deployment accuracy.
''')
code('''
if CONFIG['RUN_MANUAL_IMAGE_TEST']:
    from google.colab import files
    uploaded = files.upload()
    image = ImageOps.exif_transpose(Image.open(next(iter(uploaded)))).convert('RGB')
    TEST_BOXES = [dict(name='left', x=0.08, y=0.45, width=0.38, height=0.50),
                  dict(name='right', x=0.46, y=0.40, width=0.53, height=0.48)]
    crops = []
    for box in TEST_BOXES:
        bounds = clean_bbox([box['x']*image.width, box['y']*image.height, box['width']*image.width, box['height']*image.height], image.width, image.height)
        if bounds is None: raise ValueError('Invalid test rectangle.')
        crops.append(tf.image.resize(np.asarray(image.crop(bounds), dtype=np.float32), (224, 224)))
    probabilities = np.asarray(inference_model(tf.stack(crops), training=False))
    fig, axes = plt.subplots(1, len(crops), figsize=(5*len(crops), 4), squeeze=False)
    for axis, box, crop, scores in zip(axes.ravel(), TEST_BOXES, crops, probabilities):
        winner = int(scores.argmax())
        axis.imshow(np.clip(crop.numpy(), 0, 255).astype('uint8')); axis.axis('off')
        axis.set_title(f"{box['name']}: {THREE_CLASSES[winner]} {scores[winner]:.1%}\\n" + ('Needs review' if scores[winner] < CONFIG['REVIEW_THRESHOLD'] else 'Above review threshold'))
        print(box['name'], dict(zip(THREE_CLASSES, scores.tolist())))
    fig.tight_layout(); plt.show()
else: print('Optional manual photo test skipped; the ZIP has already been downloaded.')
''', 'manual_test')
md('''
## Recovery after disconnect
Run only this cell in a new session to download the latest completed Drive export. Checkpoints preserve weights if training stopped, but a checkpoint still needs held-out evaluation/export before deployment. Do not rebuild a fresh untrained head and assume it contains your old training.
''')
code('''
from pathlib import Path
if globals().get('EXPORT_DONE_THIS_SESSION', False):
    print('This run already downloaded its export.')
else:
    from google.colab import drive, files
    drive.mount('/content/drive')
    runs = Path('/content/drive/MyDrive/ParkVision_ThreeClass_EfficientNetB0/runs')
    exports = sorted(runs.glob('*/parkvision_three_class_export.zip'))
    if exports: files.download(str(exports[-1]))
    else:
        print('No completed export. Saved checkpoints:')
        for path in sorted(runs.glob('*/best_*.keras')): print(path)
''', 'recovery')
md(SOURCES)
notebook = nbf.v4.new_notebook(cells=cells, metadata={
    'kernelspec': {'display_name': 'Python 3', 'language': 'python', 'name': 'python3'},
    'language_info': {'name': 'python', 'version': '3.11'},
    'colab': {'name': 'ParkVision_EfficientNetB0_Obstruction_ThreeClass.ipynb', 'provenance': []},
    'accelerator': 'GPU'})
nbf.validate(notebook)
output = ROOT / 'notebooks/ParkVision_EfficientNetB0_Obstruction_ThreeClass.ipynb'
nbf.write(notebook, output)
print(f'Wrote {output} ({len(cells)} cells)')
