"""EfficientNetB0-only training/export helpers embedded into the Colab notebook."""
import hashlib
import json
import math
from pathlib import Path
import zipfile

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import tensorflow as tf
from sklearn.metrics import (accuracy_score, average_precision_score, balanced_accuracy_score,
                             brier_score_loss, classification_report, confusion_matrix,
                             f1_score, precision_score, recall_score, roc_auc_score)


def balanced_training_frame(frame, source_weights, max_samples=16000, seed=42):
    """Balance classes AND source contributions; do not let PKLot drown out local data."""
    sources = sorted(frame.source.unique())
    total_weight = sum(source_weights.get(source, 1.0) for source in sources)
    target = min(max_samples, max(len(frame), 128))
    sampled = []
    for source in sources:
        weight = source_weights.get(source, 1.0)
        count = max(1, round(target * weight / total_weight / 2))
        for label in (0, 1):
            pool = frame[(frame.source == source) & (frame.label == label)]
            if pool.empty:
                raise ValueError(f'Training source {source} has no class {label}; collect more recording groups.')
            sampled.append(pool.sample(n=count, replace=count > len(pool), random_state=seed + label))
    return pd.concat(sampled, ignore_index=True).sample(frac=1, random_state=seed).reset_index(drop=True)


def validation_weights(frame, source_weights):
    weights = np.zeros(len(frame), dtype=np.float32)
    for source in frame.source.unique():
        for label in (0, 1):
            mask = (frame.source == source) & (frame.label == label)
            count = int(mask.sum())
            if count:
                weights[mask.to_numpy()] = source_weights.get(source, 1.0) / count / 2
    return weights / weights.mean()


def make_dataset(frame, batch_size=32, training=False, weights=None, seed=42):
    paths = frame.path.astype(str).to_numpy()
    labels = frame.label.to_numpy(dtype=np.float32)
    if weights is None:
        dataset = tf.data.Dataset.from_tensor_slices((paths, labels))
    else:
        dataset = tf.data.Dataset.from_tensor_slices((paths, labels, np.asarray(weights, dtype=np.float32)))
    if training:
        dataset = dataset.shuffle(min(len(frame), 4096), seed=seed, reshuffle_each_iteration=True)
    def decode(path, label, *sample_weight):
        image = tf.io.decode_image(tf.io.read_file(path), channels=3, expand_animations=False)
        image.set_shape([None, None, 3])
        # Same RGB, bilinear resize, float32 and 0–255 contract as ml/worker.py.
        image = tf.image.resize(tf.cast(image, tf.float32), (224, 224), method='bilinear')
        return (image, label, sample_weight[0]) if sample_weight else (image, label)
    dataset = dataset.map(decode, num_parallel_calls=tf.data.AUTOTUNE)
    options = tf.data.Options()
    options.experimental_deterministic = not training
    return dataset.with_options(options).batch(batch_size).prefetch(tf.data.AUTOTUNE)


def build_vehicle_model(weights='imagenet', seed=42):
    inputs = tf.keras.Input((224, 224, 3), dtype=tf.float32, name='parking_crop_rgb')
    augmentation = tf.keras.Sequential([
        tf.keras.layers.RandomFlip('horizontal', seed=seed),
        tf.keras.layers.RandomRotation(0.025, fill_mode='reflect', seed=seed + 1),
        tf.keras.layers.RandomTranslation(0.04, 0.04, fill_mode='reflect', seed=seed + 2),
        tf.keras.layers.RandomZoom(0.10, fill_mode='reflect', seed=seed + 3),
        tf.keras.layers.RandomContrast(0.20, seed=seed + 4),
        tf.keras.layers.RandomBrightness(0.20, value_range=(0, 255), seed=seed + 5),
    ], name='training_augmentation')
    base = tf.keras.applications.EfficientNetB0(include_top=False, weights=weights, input_shape=(224, 224, 3), name='efficientnetb0')
    base.trainable = False
    x = base(augmentation(inputs), training=False)
    x = tf.keras.layers.GlobalAveragePooling2D(name='parking_pool')(x)
    x = tf.keras.layers.Dropout(0.30, seed=seed + 6, name='training_dropout')(x)
    output = tf.keras.layers.Dense(1, activation='sigmoid', name='vehicle_probability')(x)
    return tf.keras.Model(inputs, output, name='ParkVision_EfficientNetB0_Training')


def compile_vehicle_model(model, learning_rate):
    model.compile(optimizer=tf.keras.optimizers.Adam(learning_rate, clipnorm=1.0),
                  loss=tf.keras.losses.BinaryCrossentropy(label_smoothing=0.02),
                  metrics=[tf.keras.metrics.BinaryAccuracy(name='accuracy', threshold=0.5),
                           tf.keras.metrics.Precision(name='precision'), tf.keras.metrics.Recall(name='recall'),
                           tf.keras.metrics.AUC(name='auc')], weighted_metrics=[])


def unfreeze_top_blocks(model):
    base = model.get_layer('efficientnetb0')
    base.trainable = True
    for layer in base.layers:
        layer.trainable = layer.name.startswith(('block6', 'block7', 'top_conv')) and not isinstance(layer, tf.keras.layers.BatchNormalization)
    return sum(layer.trainable for layer in base.layers)


def train_stages(train_dataset, validation_dataset, run_dir, head_epochs=5, fine_epochs=10, seed=42, weights='imagenet'):
    run_dir = Path(run_dir)
    run_dir.mkdir(parents=True, exist_ok=True)
    def callbacks(stage):
        return [tf.keras.callbacks.ModelCheckpoint(str(run_dir / f'best_{stage}.keras'), monitor='val_loss', save_best_only=True),
                tf.keras.callbacks.EarlyStopping(monitor='val_loss', patience=3, restore_best_weights=True),
                tf.keras.callbacks.ReduceLROnPlateau(monitor='val_loss', patience=2, factor=0.5, min_lr=1e-7),
                tf.keras.callbacks.CSVLogger(str(run_dir / f'{stage}_history.csv')),
                tf.keras.callbacks.TerminateOnNaN()]
    model = build_vehicle_model(weights=weights, seed=seed)
    compile_vehicle_model(model, 1e-3)
    print('Stage 1: train the binary classification head; convolutional base frozen.')
    head = model.fit(train_dataset, validation_data=validation_dataset, epochs=head_epochs, callbacks=callbacks('head'))
    model = tf.keras.models.load_model(run_dir / 'best_head.keras', compile=False)
    print('Stage 2: fine-tune final EfficientNet blocks; BatchNorm stays frozen.')
    print('Trainable backbone layers:', unfreeze_top_blocks(model))
    compile_vehicle_model(model, 1e-5)
    fine = model.fit(train_dataset, validation_data=validation_dataset, epochs=fine_epochs, callbacks=callbacks('finetune'))
    candidates = [('head', min(head.history['val_loss'])), ('finetune', min(fine.history['val_loss']))]
    selected_stage, best_loss = min(candidates, key=lambda item: item[1])
    # Selection uses validation loss ONLY. Test results cannot change this choice.
    best = tf.keras.models.load_model(run_dir / f'best_{selected_stage}.keras', compile=False)
    info = {'selected_stage': selected_stage, 'validation_loss': float(best_loss),
            'head_epochs_run': len(head.history['loss']), 'fine_epochs_run': len(fine.history['loss']),
            'selection_metric': 'source-balanced validation loss'}
    return best, info, {'head': head.history, 'finetune': fine.history}


def predict_frame(model, frame, batch_size=32):
    dataset = make_dataset(frame, batch_size=batch_size)
    probabilities = np.asarray(model.predict(dataset, verbose=0)).reshape(-1)
    if len(probabilities) != len(frame) or not np.isfinite(probabilities).all():
        raise ValueError('Prediction count/values are invalid.')
    return probabilities


def binary_metrics(labels, probabilities):
    labels = np.asarray(labels, dtype=int)
    predictions = (np.asarray(probabilities) >= 0.5).astype(int)
    both_classes = len(np.unique(labels)) == 2
    return {'examples': int(len(labels)), 'unoccupied_examples': int((labels == 0).sum()),
            'occupied_examples': int((labels == 1).sum()), 'accuracy': float(accuracy_score(labels, predictions)),
            'balanced_accuracy': float(balanced_accuracy_score(labels, predictions)) if both_classes else None,
            'precision_occupied': float(precision_score(labels, predictions, zero_division=0)),
            'recall_occupied': float(recall_score(labels, predictions, zero_division=0)),
            'f1_occupied': float(f1_score(labels, predictions, zero_division=0)),
            'roc_auc': float(roc_auc_score(labels, probabilities)) if both_classes else None,
            'average_precision': float(average_precision_score(labels, probabilities)) if both_classes else None,
            'brier_score': float(brier_score_loss(labels, probabilities)),
            'confusion_matrix': confusion_matrix(labels, predictions, labels=[0, 1]).tolist(),
            'predicted_unoccupied': int((predictions == 0).sum()), 'predicted_occupied': int((predictions == 1).sum())}


def evaluate_holdout(model, manifest, run_dir, batch_size=32):
    run_dir = Path(run_dir)
    test = manifest[manifest.split == 'test'].reset_index(drop=True).copy()
    test['p_occupied'] = predict_frame(model, test, batch_size)
    test['prediction'] = (test.p_occupied >= 0.5).astype(int)
    report = {'threshold': 0.5, 'overall': binary_metrics(test.label, test.p_occupied), 'by_source': {}}
    for source, frame in test.groupby('source'):
        report['by_source'][source] = binary_metrics(frame.label, frame.p_occupied)
    print(classification_report(test.label, test.prediction, labels=[0, 1], target_names=['unoccupied', 'occupied'], zero_division=0))
    print('Per-source holdout results:')
    display_columns = ['examples', 'accuracy', 'precision_occupied', 'recall_occupied', 'f1_occupied']
    print(pd.DataFrame(report['by_source']).T[display_columns].to_string())
    if (test.prediction == test.prediction.iloc[0]).all():
        print('WARNING: The model predicted one class for the entire test set. Inspect data and do not claim it is validated.')
    test.to_csv(run_dir / 'test_predictions.csv', index=False)
    test[test.label != test.prediction].to_csv(run_dir / 'test_errors.csv', index=False)
    (run_dir / 'metrics.json').write_text(json.dumps(report, indent=2))
    fig, axis = plt.subplots(figsize=(5, 4))
    matrix = np.asarray(report['overall']['confusion_matrix'])
    axis.imshow(matrix, cmap='Blues')
    for (row, column), value in np.ndenumerate(matrix):
        axis.text(column, row, str(value), ha='center', va='center', color='white' if value > matrix.max() / 2 else 'black')
    axis.set(xticks=[0, 1], yticks=[0, 1], xticklabels=['unoccupied', 'occupied'], yticklabels=['unoccupied', 'occupied'],
             xlabel='Predicted', ylabel='Actual', title='Untouched holdout · EfficientNetB0')
    fig.tight_layout(); fig.savefig(run_dir / 'confusion_matrix.png', dpi=160); plt.show()
    return report, test


def inference_only_model(trained_model):
    """Reuse learned weights, discard augmentation/dropout; no custom layers needed."""
    inputs = tf.keras.Input((224, 224, 3), dtype=tf.float32, name='parking_crop_rgb')
    x = trained_model.get_layer('efficientnetb0')(inputs, training=False)
    x = trained_model.get_layer('parking_pool')(x)
    outputs = trained_model.get_layer('vehicle_probability')(x)
    return tf.keras.Model(inputs, outputs, name='ParkVision_EfficientNetB0_VehiclePresence')


def export_vehicle_model(trained_model, manifest, metrics, training_info, run_dir, config):
    run_dir = Path(run_dir)
    export_dir = run_dir / 'export'
    export_dir.mkdir(exist_ok=True)
    model = inference_only_model(trained_model)
    validation = manifest[manifest.split == 'val'].head(16)
    sample = next(iter(make_dataset(validation, batch_size=16)))[0]
    np.testing.assert_allclose(trained_model(sample, training=False).numpy(), model(sample, training=False).numpy(), rtol=1e-5, atol=1e-6)
    model_path = export_dir / 'parkvision_efficientnetb0.keras'
    model.save(model_path)
    loaded = tf.keras.models.load_model(model_path, compile=False)
    np.testing.assert_allclose(model(sample, training=False).numpy(), loaded(sample, training=False).numpy(), rtol=1e-5, atol=1e-6)
    local = metrics['by_source'].get('site')
    metadata = {'format_version': 1, 'model_name': model.name, 'model_version': run_dir.name,
                'class_names': ['unoccupied', 'occupied'], 'app_statuses': ['vacant', 'occupied'],
                'semantic_target': 'target vehicle present inside the supplied crop',
                'vehicle_categories': list(config['VEHICLE_CATEGORIES']), 'occupied_threshold': 0.5,
                'input_size': [224, 224], 'color_mode': 'RGB', 'input_dtype': 'float32', 'input_range': [0, 255],
                'resize_method': 'bilinear', 'preprocessing_inside_model': True,
                'tensorflow_version': tf.__version__, 'keras_version': tf.keras.__version__,
                'sha256': hashlib.sha256(model_path.read_bytes()).hexdigest(), 'training': training_info,
                'test_metrics': metrics, 'site_test_evaluated': bool(local and local['unoccupied_examples'] >= 5 and local['occupied_examples'] >= 5),
                'deployment_status': 'candidate_requires_site_validation',
                'save_reload_parity_passed': True, 'augmentation_removed': True}
    metadata_path = export_dir / 'parkvision_efficientnetb0.metadata.json'
    metadata_path.write_text(json.dumps(metadata, indent=2))
    (export_dir / 'README.txt').write_text(
        'ParkVision EfficientNetB0 binary vehicle-presence classifier\n'
        '0 = unoccupied (no target vehicle); 1 = occupied (target vehicle).\n'
        'No target vehicle does not mean physically unobstructed/parkable.\n'
        'This export is a candidate; inspect metrics and held-out site results.\n'
        'Copy BOTH model and metadata into ParkVision/ml/models, backing up the old pair.\n'
        'Restart ParkVision after replacing model files. The input stays RGB 224x224 float32, 0..255.\n'
        'Do not divide by 255; preprocessing is inside EfficientNet.\n'
        'The app review threshold is separate from the binary decision threshold (0.5).\n'
    )
    archive = run_dir / 'parkvision_efficientnetb0_export.zip'
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as bundle:
        for path in export_dir.iterdir():
            bundle.write(path, path.name)
        for name in ['metrics.json', 'test_predictions.csv', 'test_errors.csv', 'confusion_matrix.png', 'manifest.csv', 'training_info.json']:
            if (run_dir / name).exists():
                bundle.write(run_dir / name, name)
    return model, metadata, archive
