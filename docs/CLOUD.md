# Cloud GPU guide (Vultr A100 / L40S)

PersonaForge can send its images to a rented cloud GPU and train full-precision LoRAs there. The studio and the
worker stay on your PC. Only ComfyUI runs in the cloud, and you reach it through an SSH tunnel.

## 1. Set up the cloud machine (once per machine)

1. In Vultr, deploy a **Cloud GPU** instance with Ubuntu 22.04 or 24.04 and an NVIDIA driver already installed
   (an A100 80 GB, or an L40S 48 GB). Add your SSH key. Do **not** open port 8188 in the firewall.
2. Accept the licence for **FLUX.1-dev** on its Hugging Face page and create a read token
   (huggingface.co/settings/tokens). Without it the native FP16 Flux file is skipped; everything else still installs.
3. Copy `scripts/vultr_cloud_setup.sh` and `scripts/cloud_model_fetcher.py` to the machine and run the setup:

   ```bash
   scp scripts/vultr_cloud_setup.sh scripts/cloud_model_fetcher.py root@<cloud-ip>:/root/
   ssh root@<cloud-ip>
   export HF_TOKEN=hf_xxx
   bash vultr_cloud_setup.sh --start
   ```

   It installs ComfyUI v0.45.0, the same 9 custom node packs as the laptop, the models (about 60 GB, resumable),
   ai-toolkit (Flux training) and kohya sd-scripts (SDXL training). It can be re-run safely.
   Options: `--no-models`, `--no-training`, `--start`.
4. The script ends by printing the exact SSH tunnel command. It looks like this:

   ```
   ssh -N -L 8189:127.0.0.1:8188 -L 8190:127.0.0.1:8190 root@<cloud-ip>
   ```

   Run it on your PC and leave that window open. Port 8189 on your PC is now the cloud ComfyUI, and port 8190
   is the cloud model fetcher used by the studio's **Download Model** dialog (both listen on 127.0.0.1 only).

> The script was written from the upstream install instructions and syntax-checked, but it has not been run on a
> real Vultr machine yet. If a step fails, the message names the step; fix it and re-run.

## 2. Use the cloud GPU from the studio

In the header, choose **Remote Cloud GPU Tunnel**. The URL defaults to `http://127.0.0.1:8189`
(`COMFY_REMOTE_URL` in `.env.local`). The studio tells you whether anything answers.

What changes in remote mode:

| | Local Laptop GPU | Remote Cloud GPU |
|---|---|---|
| Flux model | GGUF Q4_K_S | native FP16 `flux1-dev.safetensors` (pick it in the Shoot tab, "Flux UNet") |
| Render size (4:5) | Flux 896x1152, SDXL 832x1216 | Flux 1152x1440, SDXL 1024x1280 |
| `POST /free` between jobs | on every engine or checkpoint change, then a 1.5 s pause | only when switching between Flux and SDXL, no pause |

A queued job runs on whichever ComfyUI is selected when the worker picks it up. A job that is already running
finishes where it started. Native FP16 Flux jobs fail with a clear message if you switch back to the laptop.

Switch back to **Local Laptop GPU** at any time. Nothing else changes.

### Downloading extra checkpoints / LoRAs

The header's **Download Model** button opens the *Download Custom Model / LoRA* dialog. Paste a Civitai model
version ID (the number after `?modelVersionId=`), a Civitai download link or any direct `https://` link to a
`.safetensors` file, and pick `checkpoints` or `loras`.

- Local mode: the file goes into `ComfyUI_windows_portable\ComfyUI\models\<folder>` on the laptop.
- Remote mode: the studio asks `cloud_model_fetcher.py` (port 8190 through the tunnel) to download it straight into
  `/workspace/ComfyUI/models/<folder>` on the cloud machine, so the file never travels through your PC.
- A live percentage is shown. When the download finishes, the model lists refresh from `/object_info`.
- Civitai files are checked against Civitai's SHA-256. Only `.safetensors` is accepted.
- An optional Civitai API key can be saved to `.env.local` as `CIVITAI_TOKEN`. It is only ever sent to civitai.com,
  and never to the storage server Civitai redirects to.

## 3. Train a LoRA in the cloud

1. In the studio's Dataset Curator, tag approved frames with a bucket, then press
   **Generate Cloud Training Bundle (.zip)**.
2. Copy the zip to the cloud machine and unzip it into `/workspace/personaforge`. Then run **one command**:

   ```bash
   scp <bundle>.zip root@<cloud-ip>:/workspace/
   ssh root@<cloud-ip>
   mkdir -p /workspace/personaforge && unzip /workspace/<bundle>.zip -d /workspace/personaforge
   export HF_TOKEN=hf_xxx                      # FLUX.1-dev is gated (or SKIP_FLUX=1)
   bash /workspace/personaforge/<bundle>/run_cloud_training.sh
   ```

   `run_cloud_training.sh`:
   1. calls `POST http://127.0.0.1:8188/free {"unload_models":true,"free_memory":true}` so ComfyUI releases its VRAM;
   2. trains the SDXL LoRA (kohya), then the Flux LoRA (ai-toolkit). The Flux config is picked from the GPU's
      memory (`FLUX_TIER=80gb|48gb|24gb` overrides it);
   3. copies the finished `.safetensors` into `/workspace/ComfyUI/models/loras/` and `/workspace/finished_loras/`
      (step checkpoints go to `/workspace/finished_loras/checkpoints/`), then prints the exact `scp` command to
      run in PowerShell on your laptop.

   Cloud settings for 48 GB / 80 GB cards: rank 32, alpha 32, 2000 steps, a checkpoint every 250 steps,
   lr 1e-4, bf16. Every caption starts `<trigger>, <bucket sub-token>, ...`.

   The manual steps (same as before) are in `README_CLOUD.txt`:

   ```bash
   export HF_TOKEN=hf_xxx
   cd /workspace/ai-toolkit && source venv/bin/activate
   python run.py /workspace/personaforge/<bundle>/cloud/ai-toolkit_flux_80gb.yaml    # or _48gb / _24gb
   bash /workspace/train_sdxl_kohya.sh /workspace/personaforge/<bundle>/cloud/kohya_sdxl_train.sh
   ```

3. Copy the `.safetensors` files from the bundle's `output/` folder back to
   `ComfyUI_windows_portable\ComfyUI\models\loras`, press **Refresh Models**, and set the LoRA on the character.

## 4. Stop paying

Cloud GPUs bill by the hour, also when idle. **Stop or destroy the instance in the Vultr console** when you are done.
Download your LoRA files first.
