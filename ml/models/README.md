Place `parkvision_efficientnetb0.keras` here, or set `MODEL_PATH` in `backend/.env`.
The binary model is ignored by Git. Keep a backup of the trained export.

The model expects RGB float32 crops of shape 224×224×3, values 0–255. It includes
its own scaling and predicts empty/occupied only. Scores are not calibrated accuracy.
