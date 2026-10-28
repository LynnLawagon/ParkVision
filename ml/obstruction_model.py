"""EfficientNetB0 vacant/vehicle/obstruction training and app-compatible export."""
import hashlib
import json
from pathlib import Path
import zipfile

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import tensorflow as tf
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix, f1_score, precision_recall_fscore_support

from ml.training_model import build_vehicle_model, unfreeze_top_blocks, make_dataset

THREE_CLASSES = ['vacant', 'occupied', 'blocked']


def balanced_three(frame, source_weights, max_samples=16000, seed=42):
    draws = max(3, min(max_samples, max(len(frame), 128))) // 3
    parts = []
    for label in range(3):
        subset = frame[frame.label == label]
        if subset.empty: raise ValueError(f'Training class {THREE_CLASSES[label]} is missing.')
        sources = sorted(subset.source.unique())
        total = sum(source_weights.get(source, 1.0) for source in sources)
        for source in sources:
            pool = subset[subset.source == source]
            count = max(1, round(draws * source_weights.get(source, 1.0) / total))
            parts.append(pool.sample(n=count, replace=count > len(pool), random_state=seed + label))
    return pd.concat(parts, ignore_index=True).sample(frac=1, random_state=seed).reset_index(drop=True)


def three_validation_weights(frame, source_weights):
    result = np.zeros(len(frame), dtype=np.float32)
    for label in range(3):
        subset = frame[frame.label == label]
        sources = sorted(subset.source.unique())
        if not sources: raise ValueError('Validation needs all three classes.')
        total = sum(source_weights.get(source, 1.0) for source in sources)
        for source in sources:
            mask = (frame.label == label) & (frame.source == source)
            result[mask.to_numpy()] = source_weights.get(source, 1.0) / total / int(mask.sum()) / 3
    return result / result.mean()


def build_three_model(weights='imagenet', seed=42, starting_model=None):
    template = build_vehicle_model(weights=None if starting_model else weights, seed=seed)
    if starting_model:
        previous = tf.keras.models.load_model(starting_model, compile=False)
        if tuple(previous.input_shape[1:]) != (224, 224, 3): raise ValueError('Warm-start model must accept 224x224 RGB.')
        template.get_layer('efficientnetb0').set_weights(previous.get_layer('efficientnetb0').get_weights())
    probabilities = tf.keras.layers.Dense(3, activation='softmax', name='parking_status_probabilities')(template.get_layer('training_dropout').output)
    return tf.keras.Model(template.input, probabilities, name='ParkVision_EfficientNetB0_ThreeClass_Training')


def compile_three(model, rate):
    model.compile(optimizer=tf.keras.optimizers.Adam(rate, clipnorm=1.0),
                  loss=tf.keras.losses.SparseCategoricalCrossentropy(),
                  metrics=[tf.keras.metrics.SparseCategoricalAccuracy(name='accuracy')], weighted_metrics=[])


def fit_three(train_ds, val_ds, run_dir, head_epochs=5, fine_epochs=10, seed=42, weights='imagenet', starting_model=None):
    run_dir = Path(run_dir); run_dir.mkdir(parents=True, exist_ok=True)
    def callbacks(stage):
        return [tf.keras.callbacks.ModelCheckpoint(str(run_dir / f'best_{stage}.keras'), monitor='val_loss', save_best_only=True),
                tf.keras.callbacks.EarlyStopping(monitor='val_loss', patience=3, restore_best_weights=True),
                tf.keras.callbacks.ReduceLROnPlateau(monitor='val_loss', patience=2, factor=0.5, min_lr=1e-7),
                tf.keras.callbacks.CSVLogger(str(run_dir / f'{stage}_history.csv')), tf.keras.callbacks.TerminateOnNaN()]
    model = build_three_model(weights, seed, starting_model)
    compile_three(model, 1e-3)
    print('Stage 1: train the three-class head.')
    head = model.fit(train_ds, validation_data=val_ds, epochs=head_epochs, callbacks=callbacks('head'))
    model = tf.keras.models.load_model(run_dir / 'best_head.keras', compile=False)
    print('Stage 2: fine-tune EfficientNetB0 blocks 6/7; BatchNorm remains frozen.')
    print('Trainable backbone layers:', unfreeze_top_blocks(model))
    compile_three(model, 1e-5)
    fine = model.fit(train_ds, validation_data=val_ds, epochs=fine_epochs, callbacks=callbacks('finetune'))
    stage, loss = min([('head', min(head.history['val_loss'])), ('finetune', min(fine.history['val_loss']))], key=lambda x: x[1])
    info = dict(selected_stage=stage, validation_loss=float(loss), selection_metric='class/source-balanced validation loss',
                head_epochs_run=len(head.history['loss']), fine_epochs_run=len(fine.history['loss']),
                initialization='supplied EfficientNetB0 backbone' if starting_model else 'ImageNet EfficientNetB0' if weights == 'imagenet' else 'random initialization (mechanics test only)')
    return tf.keras.models.load_model(run_dir / f'best_{stage}.keras', compile=False), info, dict(head=head.history, finetune=fine.history)


def three_metrics(labels, probabilities):
    labels = np.asarray(labels, dtype=int); probabilities = np.asarray(probabilities)
    if probabilities.shape != (len(labels), 3) or not np.isfinite(probabilities).all(): raise ValueError('Invalid three-class prediction array.')
    if (probabilities < 0).any() or (probabilities > 1).any() or not np.allclose(probabilities.sum(axis=1), 1, atol=1e-3): raise ValueError('Expected softmax probabilities.')
    predicted = probabilities.argmax(axis=1)
    precision, recall, f1, support = precision_recall_fscore_support(labels, predicted, labels=[0, 1, 2], zero_division=0)
    present = sorted(set(labels.tolist()))
    return dict(examples=len(labels), accuracy=float(accuracy_score(labels, predicted)),
                macro_f1=float(f1_score(labels, predicted, labels=present, average='macro', zero_division=0)),
                macro_f1_classes=[THREE_CLASSES[index] for index in present],
                confusion_matrix=confusion_matrix(labels, predicted, labels=[0, 1, 2]).tolist(),
                by_class={name: dict(precision=float(precision[index]), recall=float(recall[index]), f1=float(f1[index]),
                                     support=int(support[index])) for index, name in enumerate(THREE_CLASSES)})


def evaluate_three(model, manifest, run_dir, batch_size=32, review_threshold=0.8):
    run_dir = Path(run_dir)
    test = manifest[manifest.split == 'test'].copy().reset_index(drop=True)
    probabilities = np.asarray(model.predict(make_dataset(test, batch_size), verbose=0))
    report = dict(class_order=THREE_CLASSES, overall=three_metrics(test.label, probabilities), by_source={})
    test['prediction'] = probabilities.argmax(axis=1); test['confidence'] = probabilities.max(axis=1)
    test['needs_review'] = test.confidence < review_threshold
    for index, name in enumerate(THREE_CLASSES): test[f'p_{name}'] = probabilities[:, index]
    for source, frame in test.groupby('source'):
        report['by_source'][source] = three_metrics(frame.label, probabilities[frame.index])
    if 'subtype' in test:
        report['positive_subtype_checks'] = [dict(subtype=str(subtype), examples=len(frame),
            correct_class_fraction=float((frame.label == frame.prediction).mean()))
            for subtype, frame in test.dropna(subset=['subtype']).groupby('subtype')]
    accepted = ~test.needs_review
    report['review_filter'] = dict(threshold=review_threshold, accepted=int(accepted.sum()), needs_review=int((~accepted).sum()),
        accepted_accuracy=float((test[accepted].label == test[accepted].prediction).mean()) if accepted.any() else None,
        coverage=float(accepted.mean()))
    print(classification_report(test.label, test.prediction, labels=[0, 1, 2], target_names=THREE_CLASSES, zero_division=0))
    print('All-example metrics:', report['overall'])
    print('Review coverage:', report['review_filter'])
    print('Site metrics:', report['by_source'].get('site', 'NOT MEASURED'))
    if test.prediction.nunique() < 3: print('WARNING: at least one class was never predicted. Inspect the confusion matrix and do not claim the task is solved.')
    test.to_csv(run_dir / 'test_predictions.csv', index=False)
    test[test.label != test.prediction].to_csv(run_dir / 'test_errors.csv', index=False)
    (run_dir / 'metrics.json').write_text(json.dumps(report, indent=2))
    fig, ax = plt.subplots(figsize=(6, 5)); matrix = np.asarray(report['overall']['confusion_matrix'])
    ax.imshow(matrix, cmap='Blues')
    for (row, column), value in np.ndenumerate(matrix): ax.text(column, row, str(value), ha='center', va='center')
    ax.set(xticks=[0, 1, 2], yticks=[0, 1, 2], xticklabels=THREE_CLASSES, yticklabels=THREE_CLASSES,
           xlabel='Predicted', ylabel='Actual', title='Untouched three-class holdout')
    fig.tight_layout(); fig.savefig(run_dir / 'confusion_matrix.png', dpi=160); plt.show()
    return report, test


def inference_three(trained):
    inputs = tf.keras.Input((224, 224, 3), dtype=tf.float32, name='parking_crop_rgb')
    x = trained.get_layer('efficientnetb0')(inputs, training=False)
    x = trained.get_layer('parking_pool')(x)
    outputs = trained.get_layer('parking_status_probabilities')(x)
    return tf.keras.Model(inputs, outputs, name='ParkVision_EfficientNetB0_ThreeClass')


def export_three(trained, manifest, metrics, info, run_dir, config):
    run_dir = Path(run_dir); folder = run_dir / 'export'; folder.mkdir(exist_ok=True)
    model = inference_three(trained)
    validation = manifest[manifest.split == 'val'].head(12)
    images = next(iter(make_dataset(validation, batch_size=12)))[0]
    np.testing.assert_allclose(trained(images, training=False).numpy(), model(images, training=False).numpy(), rtol=1e-5, atol=1e-6)
    path = folder / 'parkvision_efficientnetb0.keras'; model.save(path)
    loaded = tf.keras.models.load_model(path, compile=False)
    np.testing.assert_allclose(model(images, training=False).numpy(), loaded(images, training=False).numpy(), rtol=1e-5, atol=1e-6)
    coverage = manifest.groupby(['source', 'split', 'label']).size().rename('examples').reset_index().to_dict('records')
    metadata = dict(format_version=2, task='parking_three_class', model_name=model.name, model_version=run_dir.name,
        class_names=THREE_CLASSES, app_statuses=THREE_CLASSES, output_activation='softmax',
        input_size=[224, 224], color_mode='RGB', input_dtype='float32', input_range=[0, 255], resize_method='bilinear', preprocessing_inside_model=True,
        sha256=hashlib.sha256(path.read_bytes()).hexdigest(), tensorflow_version=tf.__version__, keras_version=tf.keras.__version__,
        vehicle_categories=config.get('VEHICLE_NAMES', []), obstruction_categories=config.get('OBSTRUCTION_NAMES', []) + ['Traffic cone'],
        label_policy='blocked when a non-vehicle object obstructs the intended usable area; otherwise occupied if a vehicle occupies it; otherwise vacant',
        public_data_limitation='public object/background crops are bootstrap proxies, not verified parking-ground occupancy labels',
        deployment_status='candidate_requires_site_validation', site_test_evaluated='site' in metrics['by_source'],
        training=info, test_metrics=metrics, data_coverage=coverage, save_reload_parity_passed=True, augmentation_removed=True)
    (folder / 'parkvision_efficientnetb0.metadata.json').write_text(json.dumps(metadata, indent=2))
    (folder / 'README.txt').write_text(
        'ParkVision three-class EfficientNetB0 candidate\n0 vacant; 1 occupied by vehicle; 2 blocked by non-vehicle obstruction.\n'
        'Uses the same saved parking-region crops. RGB float32 224x224, values 0..255; no extra /255.\n'
        'Back up the installed model pair, then copy BOTH .keras and .metadata.json into ml/models and restart ParkVision. No SQL reset.\n'
        'Three-class support must be present in ml/worker.py; binary-only workers cannot load this output.\n'
        'Review all-example and per-class metrics, including cone/Box support and independent site data. Public scores are not site accuracy.\n'
        'The export is a candidate; arbitrary obstructions and physical parkability are not proven.\n')
    archive = run_dir / 'parkvision_three_class_export.zip'
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as bundle:
        for item in folder.iterdir(): bundle.write(item, item.name)
        for name in ['metrics.json', 'manifest.csv', 'excluded_records.csv', 'test_predictions.csv', 'test_errors.csv', 'training_info.json',
                     'config.json', 'confusion_matrix.png', 'training_curves.png', 'SOURCES.md']:
            if (run_dir / name).exists(): bundle.write(run_dir / name, name)
    return model, metadata, archive
