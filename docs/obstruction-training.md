# Train the non-vehicle obstruction model

Use [ParkVision_EfficientNetB0_Obstruction_ThreeClass.ipynb](../notebooks/ParkVision_EfficientNetB0_Obstruction_ThreeClass.ipynb). This notebook trains **only EfficientNetB0**, with three outputs from the same parking-region crop:

| App status | Label |
| --- | --- |
| `vacant` | Clear intended parking area, without a vehicle or obstruction |
| `occupied` | Vehicle occupying the position |
| `blocked` | Non-vehicle obstruction affecting the usable area, such as a cone or box |

An empty crop must stay vacant. An object on a wall or outside the intended parking footprint does not make the position blocked. Label actual mixed vehicle/obstruction cases blocked. The classifier does not measure physical clearance or discover parking positions automatically. The existing saved boxes still define positions; keep the camera fixed and exclude unrelated background where possible.

## Run in Colab

1. Open [Google Colab](https://colab.research.google.com/), select **File → Upload notebook**, and upload the notebook above.
2. Choose **Runtime → Change runtime type → T4 GPU**.
3. Choose **Runtime → Run all**. Authorize Drive to preserve checkpoints. Defaults automatically download public data; no camera or CCTV connection is needed.
4. Inspect the sample labels, per-class/source results, cone/box coverage, confusion matrix and error examples. Site accuracy is explicitly **NOT MEASURED** when no independent site crops were supplied.
5. Download `parkvision_three_class_export.zip`. A copy is preserved under `MyDrive/ParkVision_ThreeClass_EfficientNetB0/runs/<run>/`.

The notebook trains a frozen-backbone head, then fine-tunes the final EfficientNetB0 blocks. It uses explicit label order, image/session groups before cropping, duplicate/conflicting-label audits, train-only class/source balancing, validation-based checkpoint selection, ordinary untouched holdout metrics, and export/reload parity checks. The worker accepts RGB float32 224×224 in 0–255 with EfficientNet preprocessing inside the model. No extra `/255`.

Public sources are PKLot parking crops, labeled vehicles/people/boxes/other objects from Open Images, and TraCon cone images. An annotation-free background is a proxy, not verified clear parking ground. Public object crops differ from small objects in a wide parking box. Public-data performance cannot establish your camera's obstruction accuracy. Sources, attribution and licensing notes are embedded in the notebook and exported `SOURCES.md`; original image attribution is retained in the manifest. TraCon's pinned repository has no explicit dataset license file; check permission before external redistribution/commercial use. Raw images are not included in the model ZIP.

## Add site data when available

Set `UPLOAD_SITE_ZIP=True` in the notebook settings. Use **crops of the same fixed parking position** across clear/vehicle/blocked states. Include cones, boxes and relevant other obstructions, different vehicles, lighting, shadows and day/night conditions. An arbitrary unseen object is not guaranteed to be recognized.

```text
site_crops/
  day01/
    vacant/*.jpg
    occupied/*.jpg
    blocked/*.jpg
  day02/
    vacant/*.jpg
    occupied/*.jpg
    blocked/*.jpg
  day03/
    vacant/*.jpg
    occupied/*.jpg
    blocked/*.jpg
```

At least three independent capture sessions, with all classes in each, are required. Five unique crops per class in each final split is a technical minimum; collect more independent scenes for meaningful evaluation. Keep adjacent frames and clips from one session together. Do not recycle binary negative folders: that older task allowed cones/people to be labeled vacant. Keep previously trained-on photos out of a new independent test set, especially if using optional backbone warm-start.

## Install the trained export

1. Unzip the download and review its actual results.
2. Back up the currently installed model **and matching metadata** outside `ml/models/`.
3. Replace both files in `ml/models/` with the pair from the same export:
   - `parkvision_efficientnetb0.keras`
   - `parkvision_efficientnetb0.metadata.json`
4. Restart `npm run dev`. The workspace should show model `ParkVision_EfficientNetB0_ThreeClass`, this export's checksum prefix, and obstruction classification support.
5. Test the existing saved boxes with separate clear, vehicle, cone and box examples, including objects outside the parking area. Verify that below-threshold predictions stay **Needs review**.
6. Click **Publish accepted results**. Accepted blocked observations enter the existing Supabase `blocked` status and open an obstruction event. Availability excludes them. Personnel see a space warning; Alerts polls every two seconds and allows acknowledgement. A later accepted vacant/occupied observation resolves the event. Acknowledging alone does not clear a blockage.

**Keep the database and saved boxes. No SQL reset or schema migration is needed.** The database already includes the blocked status and alert lifecycle. Unseen/unverified/stale spaces do not count as available. A static photo becomes stale after ten seconds; use video replay or device camera monitoring for repeated updates. Active alert events persist until resolved by an accepted new observation, even if a source stops.

Creating the notebook does not train or install new weights. Until you run Colab and install the paired export, the deployed model remains the existing binary vehicle-presence model. The worker selects binary versus three-class mapping from validated export metadata and checks its SHA256 and class order. Never rename an old binary model to imply it has obstruction capability.

## Developer checks

```bash
source ~/.venvs/parkvision-ml/bin/activate
python scripts/build_obstruction_notebook.py
python -m unittest discover -s ml/tests -v
python -m scripts.smoke_obstruction_training
npm test
npm run build
```

The smoke test uses temporary synthetic fixtures, runs both training stages, evaluates, saves/reloads an augmentation-free export, and checks the actual production worker's output against that export. It never installs the fixture weights and does not measure task accuracy. Live public download/crop preparation has also been checked on small Open Images and TraCon subsets. Full public-data training still runs in Colab.
