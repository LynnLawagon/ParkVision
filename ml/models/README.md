Place `parkvision_efficientnetb0.keras` here, or set `MODEL_PATH` in `backend/.env`.
The binary model is ignored by Git. Keep a backup of the trained export.

For a newly trained vehicle-presence export, copy the matching
`parkvision_efficientnetb0.metadata.json` here too. The worker validates the pair's
checksum and input/label contract. Restart the app after replacement. Legacy S2
weights without a sidecar still load. See [the Colab training notebook](../../notebooks/README.md).

The model expects RGB float32 crops of shape 224×224×3, values 0–255. It includes
its own scaling and predicts empty/occupied only. Scores are not calibrated accuracy.
