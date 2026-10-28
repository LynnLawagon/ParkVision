Place `parkvision_efficientnetb0.keras` here, or set `MODEL_PATH` in `backend/.env`.
Model weights are ignored by Git. Keep a backup of each trained model/metadata pair.

Copy the matching `parkvision_efficientnetb0.metadata.json` alongside the weights.
The worker validates their checksum, RGB input contract and class order. Restart
ParkVision after replacing the pair; check the workspace model name/checksum or
`/api/health` to confirm which export is actually loaded.

Version 1 exports classify vehicle absence/presence (`vacant`, `occupied`). Version
2 three-class exports classify `vacant`, vehicle-`occupied`, or non-vehicle-`blocked`
using the same saved parking boxes. Legacy binary S2 weights without a sidecar
remain supported. See [training and installation instructions](../../docs/obstruction-training.md).

Inputs are RGB float32 224×224×3, values 0–255; scaling is inside the model.
Scores are not calibrated accuracy. Independent site validation remains necessary.
