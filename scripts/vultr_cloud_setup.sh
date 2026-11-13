#!/usr/bin/env bash
# PersonaForge cloud GPU setup for a fresh Ubuntu 22.04 / 24.04 machine (Vultr A100 / L40S or similar).
#
# Installs, under /workspace (override with WORKSPACE=...):
#   - ComfyUI v0.45.0 (the version PersonaForge was built against) in /workspace/ComfyUI
#   - the same 9 custom node packs as the laptop install
#   - the models PersonaForge needs (native FP16 Flux, SDXL, ControlNets, IP-Adapter FaceID, detectors,
#     realism LoRAs, upscalers, SegFormer clothes segmentation)
#   - ai-toolkit (Flux LoRA training) in /workspace/ai-toolkit
#   - kohya sd-scripts (SDXL LoRA training) in /workspace/sd-scripts
# and finally prints the SSH port-forward command that connects the PersonaForge studio on your PC to it.
#
# Usage (as root, or as a user with sudo):
#   export HF_TOKEN=hf_xxx          # needed for FLUX.1-dev (gated: accept its licence on huggingface.co first)
#   bash vultr_cloud_setup.sh [--no-models] [--no-training] [--start]
#
#   --no-models    skip the model downloads (about 60 GB with FP16 Flux)
#   --no-training  skip ai-toolkit and sd-scripts
#   --start        start ComfyUI in the background when the setup finishes
#
# Safe to re-run: finished steps are skipped and downloads resume.
# Security: ComfyUI has no login. It is started on 127.0.0.1 ONLY and reached through an SSH tunnel;
# do not open port 8188 in the Vultr firewall.
set -euo pipefail

WORKSPACE="${WORKSPACE:-/workspace}"
COMFY_TAG="${COMFY_TAG:-v0.45.0}"
COMFY_DIR="$WORKSPACE/ComfyUI"
PYTHON_VERSION="${PYTHON_VERSION:-3.12}"
HF_TOKEN="${HF_TOKEN:-}"

DO_MODELS=1
DO_TRAINING=1
DO_START=0
for arg in "$@"; do
  case "$arg" in
    --no-models) DO_MODELS=0 ;;
    --no-training) DO_TRAINING=0 ;;
    --start) DO_START=1 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1;36m>> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*" >&2; }
SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

# ---------------------------------------------------------------------------------------------- GPU check
say "Checking the GPU"
if ! command -v nvidia-smi >/dev/null 2>&1 || ! nvidia-smi >/dev/null 2>&1; then
  warn "nvidia-smi does not work. Use a Vultr GPU image with the NVIDIA driver installed (or run: $SUDO ubuntu-drivers install && $SUDO reboot), then run this script again."
  exit 1
fi
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader
# The driver reports the newest CUDA it supports; pick a matching PyTorch wheel index.
DRIVER_CUDA="$(nvidia-smi | sed -n 's/.*CUDA Version: \([0-9]*\)\.\([0-9]*\).*/\1.\2/p' | head -n1)"
DRIVER_CUDA_MAJOR="${DRIVER_CUDA%%.*}"
DRIVER_CUDA_MINOR="${DRIVER_CUDA##*.}"
if [ "${DRIVER_CUDA_MAJOR:-0}" -ge 13 ]; then TORCH_INDEX_DEFAULT="cu130"
elif [ "${DRIVER_CUDA_MAJOR:-0}" -eq 12 ] && [ "${DRIVER_CUDA_MINOR:-0}" -ge 8 ]; then TORCH_INDEX_DEFAULT="cu128"
else TORCH_INDEX_DEFAULT="cu126"; fi
TORCH_INDEX="${TORCH_INDEX:-$TORCH_INDEX_DEFAULT}"
echo "driver supports CUDA ${DRIVER_CUDA:-unknown}; PyTorch wheels: $TORCH_INDEX (override with TORCH_INDEX=cu126|cu128|cu130)"

# ---------------------------------------------------------------------------------------------- system packages
say "System packages"
export DEBIAN_FRONTEND=noninteractive
$SUDO apt-get update -y
$SUDO apt-get install -y git curl ca-certificates build-essential python3-dev pkg-config unzip tmux \
  ffmpeg libgl1 libglib2.0-0 libsm6 libxext6 libxrender1 aria2
$SUDO mkdir -p "$WORKSPACE" && $SUDO chown "$(id -u):$(id -g)" "$WORKSPACE"

# uv gives us Python 3.12 and fast installs without touching the system Python
if ! command -v uv >/dev/null 2>&1; then
  say "Installing uv"
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
command -v uv >/dev/null 2>&1 || { warn "uv was not found on PATH after install"; exit 1; }

make_venv() { # make_venv <dir>
  [ -x "$1/bin/python" ] || uv venv --python "$PYTHON_VERSION" "$1"
}
pip_in() { # pip_in <venv> <pip args...>
  local venv="$1"; shift
  VIRTUAL_ENV="$venv" uv pip install --python "$venv/bin/python" "$@"
}

# ---------------------------------------------------------------------------------------------- ComfyUI
say "ComfyUI $COMFY_TAG"
if [ ! -d "$COMFY_DIR/.git" ]; then
  git clone --depth 1 --branch "$COMFY_TAG" https://github.com/Comfy-Org/ComfyUI.git "$COMFY_DIR"
fi
COMFY_VENV="$COMFY_DIR/venv"
make_venv "$COMFY_VENV"
pip_in "$COMFY_VENV" torch torchvision torchaudio --index-url "https://download.pytorch.org/whl/$TORCH_INDEX"
pip_in "$COMFY_VENV" -r "$COMFY_DIR/requirements.txt"
[ -f "$COMFY_DIR/manager_requirements.txt" ] && pip_in "$COMFY_VENV" -r "$COMFY_DIR/manager_requirements.txt" || true

# ---------------------------------------------------------------------------------------------- custom nodes (the same 9 packs)
say "Custom nodes"
NODES_DIR="$COMFY_DIR/custom_nodes"
NODE_REPOS=(
  "https://github.com/city96/ComfyUI-GGUF"
  "https://github.com/cubiq/ComfyUI_IPAdapter_plus"
  "https://github.com/ltdrdata/ComfyUI-Impact-Pack"
  "https://github.com/ltdrdata/ComfyUI-Impact-Subpack"
  "https://github.com/Fannovel16/comfyui_controlnet_aux"
  "https://github.com/lquesada/ComfyUI-Inpaint-CropAndStitch"
  "https://github.com/Gourieff/ComfyUI-ReActor"
  "https://github.com/Jonseed/ComfyUI-Detail-Daemon"
  "https://github.com/StartHua/Comfyui_segformer_b2_clothes"
)
for repo in "${NODE_REPOS[@]}"; do
  name="$(basename "$repo")"
  [ -d "$NODES_DIR/$name/.git" ] || git clone --depth 1 "$repo" "$NODES_DIR/$name"
  req="$NODES_DIR/$name/requirements.txt"
  if [ "$name" = "Comfyui_segformer_b2_clothes" ]; then
    # Its requirements.txt pins transformers==4.33.2, which would downgrade ComfyUI's transformers and break other nodes.
    echo "   $name: skipping its pinned requirements.txt (ComfyUI's transformers is used)"
  elif [ -f "$req" ]; then
    echo "   $name: installing requirements"
    pip_in "$COMFY_VENV" -r "$req" || warn "some requirements of $name failed; check the log above"
  fi
done
# insightface (IP-Adapter FaceID, ReActor) is built from source on Linux, and the GPU build of onnxruntime is wanted
pip_in "$COMFY_VENV" insightface onnxruntime-gpu || warn "insightface / onnxruntime-gpu install failed"
# controlnet_aux needs albumentationsx; the legacy 'albumentations' (pulled in by ReActor) shares its import name and breaks it
if VIRTUAL_ENV="$COMFY_VENV" uv pip show --python "$COMFY_VENV/bin/python" albumentationsx >/dev/null 2>&1; then
  VIRTUAL_ENV="$COMFY_VENV" uv pip uninstall --python "$COMFY_VENV/bin/python" albumentations >/dev/null 2>&1 || true
  pip_in "$COMFY_VENV" --reinstall albumentationsx >/dev/null 2>&1 || true
fi

# ---------------------------------------------------------------------------------------------- models
fetch() { # fetch <url> <dest-relative-to-ComfyUI/models> [needs-token]
  local url="$1" dest="$COMFY_DIR/models/$2" needs_token="${3:-}"
  if [ -s "$dest" ]; then echo "   have  $2"; return 0; fi
  if [ -n "$needs_token" ] && [ -z "$HF_TOKEN" ]; then
    warn "skipping $2: it is gated. Accept the licence on its Hugging Face page, then re-run with HF_TOKEN set."
    return 0
  fi
  mkdir -p "$(dirname "$dest")"
  echo "   get   $2"
  local auth=()
  if [ -n "$HF_TOKEN" ] && [[ "$url" == https://huggingface.co/* ]]; then auth=(-H "Authorization: Bearer $HF_TOKEN"); fi
  curl -L --fail --retry 8 --retry-delay 5 --retry-all-errors -C - "${auth[@]}" -o "$dest.part" "$url" && mv "$dest.part" "$dest" \
    || warn "download failed: $2 (re-run the script to resume)"
}
hf() { echo "https://huggingface.co/$1/resolve/main/$2"; }

if [ "$DO_MODELS" -eq 1 ]; then
  say "Models (resumable; this is the long step)"
  # Flux, native FP16 (Remote Cloud GPU mode picks these when you choose a non-.gguf UNet)
  fetch "$(hf black-forest-labs/FLUX.1-dev flux1-dev.safetensors)" diffusion_models/flux1-dev.safetensors gated
  fetch "$(hf ffxvs/vae-flux ae.safetensors)" vae/ae.safetensors
  fetch "$(hf comfyanonymous/flux_text_encoders clip_l.safetensors)" text_encoders/clip_l.safetensors
  fetch "$(hf comfyanonymous/flux_text_encoders t5xxl_fp16.safetensors)" text_encoders/t5xxl_fp16.safetensors
  # SDXL (Engines B and C, the face lock, genesis frames)
  fetch "$(hf SG161222/RealVisXL_V5.0 RealVisXL_V5.0_fp16.safetensors)" checkpoints/RealVisXL_V5.0_fp16.safetensors
  fetch "$(hf madebyollin/sdxl-vae-fp16-fix sdxl_vae.safetensors)" vae/sdxl_vae.safetensors
  fetch "$(hf xinsir/controlnet-openpose-sdxl-1.0 diffusion_pytorch_model_twins.safetensors)" controlnet/controlnet-openpose-sdxl-1.0.safetensors
  fetch "$(hf xinsir/controlnet-depth-sdxl-1.0 diffusion_pytorch_model.safetensors)" controlnet/controlnet-depth-sdxl-1.0.safetensors
  # Identity bootstrap
  fetch "$(hf h94/IP-Adapter-FaceID ip-adapter-faceid-plusv2_sdxl.bin)" ipadapter/ip-adapter-faceid-plusv2_sdxl.bin
  fetch "$(hf h94/IP-Adapter-FaceID ip-adapter-faceid-plusv2_sdxl_lora.safetensors)" loras/ip-adapter-faceid-plusv2_sdxl_lora.safetensors
  fetch "$(hf laion/CLIP-ViT-H-14-laion2B-s32B-b79K open_clip_model.safetensors)" clip_vision/CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors
  # Detectors, upscalers, realism LoRAs
  fetch "$(hf Bingsu/adetailer face_yolov8m.pt)" ultralytics/bbox/face_yolov8m.pt
  fetch "$(hf Bingsu/adetailer hand_yolov8n.pt)" ultralytics/bbox/hand_yolov8n.pt
  fetch "$(hf Kim2091/UltraSharp 4x-UltraSharp.pth)" upscale_models/4x-UltraSharp.pth
  fetch "$(hf ai-forever/Real-ESRGAN RealESRGAN_x2.pth)" upscale_models/RealESRGAN_x2.pth
  fetch "$(hf XLabs-AI/flux-RealismLora lora.safetensors)" loras/flux_realism_lora.safetensors
  fetch "$(hf ujouy/Amateur_Photography_FluxDev amateurphoto-v6-forcu.safetensors)" loras/flux_amateur_photography.safetensors
  fetch "https://dl.fbaipublicfiles.com/segment_anything/sam_vit_b_01ec64.pth" sams/sam_vit_b_01ec64.pth
  # Clothing segmentation: the pack loads BOTH folders when ComfyUI starts
  for f in config.json preprocessor_config.json model.safetensors; do
    fetch "$(hf mattmdjaga/segformer_b2_clothes "$f")" "segformer_b2_clothes/$f"
    fetch "$(hf sayeed99/segformer-b3-fashion "$f")" "segformer_b3_fashion/$f"
  done
  # SDXL base for the trainers (shares the file ComfyUI already has)
  mkdir -p "$WORKSPACE/models"
  ln -sf "$COMFY_DIR/models/checkpoints/RealVisXL_V5.0_fp16.safetensors" "$WORKSPACE/models/RealVisXL_V5.0_fp16.safetensors"
fi

# ---------------------------------------------------------------------------------------------- start script
START_SH="$WORKSPACE/start_comfyui.sh"
cat > "$START_SH" <<EOF
#!/usr/bin/env bash
# Starts ComfyUI on 127.0.0.1:8188 (reach it through an SSH tunnel; never expose it publicly).
cd "$COMFY_DIR"
exec "$COMFY_VENV/bin/python" main.py --listen 127.0.0.1 --port 8188 --disable-auto-launch
EOF
chmod +x "$START_SH"

# ---------------------------------------------------------------------------------------------- model fetcher (studio downloads)
# The studio's "Download Custom Model / LoRA" dialog sends Remote-mode downloads to this helper on 127.0.0.1:8190.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FETCHER_PY="$WORKSPACE/cloud_model_fetcher.py"
FETCH_SH="$WORKSPACE/start_model_fetcher.sh"
if [ -f "$SCRIPT_DIR/cloud_model_fetcher.py" ]; then
  [ "$SCRIPT_DIR/cloud_model_fetcher.py" -ef "$FETCHER_PY" ] || cp "$SCRIPT_DIR/cloud_model_fetcher.py" "$FETCHER_PY"
else
  warn "cloud_model_fetcher.py was not copied next to this script; the studio's model download dialog will not work in Remote mode (scp it to $WORKSPACE and re-run)"
fi
cat > "$FETCH_SH" <<EOF
#!/usr/bin/env bash
# Studio model downloads (Civitai / URL) into $COMFY_DIR/models/{checkpoints,loras}; 127.0.0.1:8190 only.
exec python3 "$FETCHER_PY" --models-dir "$COMFY_DIR/models" --port 8190
EOF
chmod +x "$FETCH_SH"

# ---------------------------------------------------------------------------------------------- trainers
if [ "$DO_TRAINING" -eq 1 ]; then
  say "ai-toolkit (Flux LoRA training)"
  AIT_DIR="$WORKSPACE/ai-toolkit"
  [ -d "$AIT_DIR/.git" ] || git clone --depth 1 https://github.com/ostris/ai-toolkit.git "$AIT_DIR"
  make_venv "$AIT_DIR/venv"
  if [ "$TORCH_INDEX" = "cu130" ]; then
    # versions from the ai-toolkit README
    pip_in "$AIT_DIR/venv" torch==2.13.0 torchvision==0.28.0 torchaudio==2.11.0 --index-url "https://download.pytorch.org/whl/cu130" \
      || pip_in "$AIT_DIR/venv" torch torchvision torchaudio --index-url "https://download.pytorch.org/whl/cu130"
  else
    warn "driver is older than CUDA 13: installing a matching PyTorch ($TORCH_INDEX) instead of the version pinned in the ai-toolkit README"
    pip_in "$AIT_DIR/venv" torch torchvision torchaudio --index-url "https://download.pytorch.org/whl/$TORCH_INDEX"
  fi
  pip_in "$AIT_DIR/venv" -r "$AIT_DIR/requirements.txt"

  say "kohya sd-scripts (SDXL LoRA training)"
  SD_DIR="$WORKSPACE/sd-scripts"
  [ -d "$SD_DIR/.git" ] || git clone --depth 1 https://github.com/kohya-ss/sd-scripts.git "$SD_DIR"
  make_venv "$SD_DIR/venv"
  pip_in "$SD_DIR/venv" torch torchvision --index-url "https://download.pytorch.org/whl/$TORCH_INDEX"
  pip_in "$SD_DIR/venv" -r "$SD_DIR/requirements.txt"
  # the bundle's kohya_sdxl_train.sh calls `accelerate` from PATH
  mkdir -p "$HOME/.cache/huggingface/accelerate"
  cat > "$HOME/.cache/huggingface/accelerate/default_config.yaml" <<'EOF'
compute_environment: LOCAL_MACHINE
distributed_type: 'NO'
downcast_bf16: 'no'
mixed_precision: bf16
num_machines: 1
num_processes: 1
use_cpu: false
EOF
  cat > "$WORKSPACE/train_sdxl_kohya.sh" <<EOF
#!/usr/bin/env bash
# Usage: bash $WORKSPACE/train_sdxl_kohya.sh <path to the bundle's cloud/kohya_sdxl_train.sh>
source "$SD_DIR/venv/bin/activate"
exec bash "\${1:?pass the bundle's cloud/kohya_sdxl_train.sh}" "$SD_DIR"
EOF
  chmod +x "$WORKSPACE/train_sdxl_kohya.sh"
fi

# ---------------------------------------------------------------------------------------------- start + tunnel instructions
if [ "$DO_START" -eq 1 ]; then
  say "Starting ComfyUI in a tmux session called 'comfy'"
  tmux kill-session -t comfy 2>/dev/null || true
  tmux new-session -d -s comfy "bash $START_SH 2>&1 | tee $WORKSPACE/comfyui.log"
  echo "log: $WORKSPACE/comfyui.log"
  if [ -f "$FETCHER_PY" ]; then
    tmux kill-session -t fetcher 2>/dev/null || true
    tmux new-session -d -s fetcher "bash $FETCH_SH 2>&1 | tee $WORKSPACE/model_fetcher.log"
    echo "model fetcher log: $WORKSPACE/model_fetcher.log"
  fi
fi

PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
SSH_USER="$(id -un)"
say "Done"
cat <<EOF

1. Start ComfyUI and the model fetcher on this machine (skip if you used --start):
     tmux new -d -s comfy 'bash $START_SH'
     tmux new -d -s fetcher 'bash $FETCH_SH'

2. On YOUR PC (PowerShell, Command Prompt or any terminal), open the tunnel and leave it running:
     ssh -N -L 8189:127.0.0.1:8188 -L 8190:127.0.0.1:8190 ${SSH_USER}@${PUBLIC_IP}
   (8189 = the cloud ComfyUI, 8190 = the studio's "Download Custom Model / LoRA" dialog)

3. In the PersonaForge studio header choose "Remote Cloud GPU Tunnel" (URL http://127.0.0.1:8189).
   Pick the native FP16 Flux UNet (flux1-dev.safetensors) in the Shoot tab to use the full-precision model.

4. To train: unzip the bundle from the Dataset Curator ("Generate Cloud Training Bundle") into $WORKSPACE/personaforge and follow its README_CLOUD.txt.
   Then copy the .safetensors from the bundle's output/ folder into ComfyUI_windows_portable\\ComfyUI\\models\\loras on your PC.

5. When you are done, STOP or DESTROY the instance in the Vultr console: cloud GPUs bill by the hour even when idle.
EOF
