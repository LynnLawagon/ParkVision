# Three-class obstruction notebook

For the next project phase, use [ParkVision_EfficientNetB0_Obstruction_ThreeClass.ipynb](ParkVision_EfficientNetB0_Obstruction_ThreeClass.ipynb). It trains only EfficientNetB0 for **vacant / occupied by vehicle / blocked by non-vehicle object** and uses the same saved app boxes. It downloads PKLot, Open Images and TraCon cone data, and accepts optional labeled site crops. Full steps and limitations: [obstruction-training.md](../docs/obstruction-training.md).

Upload it to Colab, select T4 GPU, then Run all. Review actual metrics, download the ZIP, replace both matching model/metadata files and restart the app. Creating the notebook does not train new weights. Keep your database.

Developer regeneration: `python scripts/build_obstruction_notebook.py`; mechanics check: `python -m scripts.smoke_obstruction_training` (temporary synthetic fixtures, never deployment weights or measured accuracy).

---

# Train the replacement EfficientNetB0

Use [ParkVision_EfficientNetB0_VehiclePresence.ipynb](ParkVision_EfficientNetB0_VehiclePresence.ipynb).
It is self-contained: only upload this notebook to Colab, not the repository.

1. Open [Google Colab](https://colab.research.google.com/), choose **File → Upload notebook**, and select the `.ipynb`.
2. Choose **Runtime → Change runtime type → T4 GPU**.
3. Choose **Runtime → Run all** and authorize Drive for checkpoint backups. Defaults download PKLot and selected COCO images automatically.
4. Inspect the sample labels and final test/error tables. The notebook downloads `parkvision_efficientnetb0_export.zip` and saves a copy in Drive.
5. Unzip it. Back up your current `ml/models/parkvision_efficientnetb0.keras` and any matching metadata. Copy the new `.keras` **and** `.metadata.json` files into `ml/models/`, then restart `npm run dev`. Keep your database.

The exact task is one parking-region crop → **occupied if a target vehicle is visible; unoccupied otherwise**. Numeric labels stay fixed at `0 = unoccupied` (app `vacant`), `1 = occupied`. The export includes RGB/resize/range/label metadata and a checksum. The worker rejects a mismatched pair. No training augmentation or custom Python layer is needed to load the exported model.

The notebook trains only EfficientNetB0 with ImageNet initialization, then fine-tunes its final blocks. PKLot gives parking examples; COCO adds vehicle angles and backgrounds. It uses grouped splits, explicit label checks, train-only balancing, validation-based checkpoint selection, fixed-threshold evaluation, and save/reload parity checks. The app's 80% review filter remains separate from the binary decision at 0.5.

**For your actual night camera:** enable `UPLOAD_SITE_ZIP` in settings and add labeled parking-box crops from at least three independent recording days/sessions. The notebook shows the ZIP layout. Use consistent boxes for occupied and empty examples. Public-data training alone cannot establish performance on your phone view. Two example photos are insufficient for a credible training/test split.

No target vehicle does not prove a space is physically clear: people, cones, and other obstructions require separate handling. This notebook implements the requested binary vehicle-presence task.

## Developer verification

The notebook is generated from readable helpers, embedded into its cells:

```bash
source ~/.venvs/parkvision-ml/bin/activate
python -m pip install -r ml/requirements-training.txt
python scripts/build_training_notebook.py
python -m unittest discover -s ml/tests -v
python -m scripts.smoke_training
```

The smoke run exercises both training stages, native `.keras` export/reload, ZIP metadata, and the actual app worker using temporary synthetic fixtures. It does not measure real-world accuracy or replace the installed model. The full public-data GPU training must run in Colab; its actual metrics are saved with the export.
