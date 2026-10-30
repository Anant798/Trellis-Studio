# Trellis Studio

A local image-to-3D workstation that uses the existing TripoSR clone at `~/Desktop/TripoSR`. The app remains a Next.js App Router project with SQLite job records, private local storage, and the existing Three.js GLB viewer.

## Start the web app

Requirements: Node.js 20.9+ and npm. From the project root:

```powershell
npm install
npm run dev
```

Open <http://127.0.0.1:3000>. The app runs one local GPU inference at a time as a Python child process; it does not start a second web server. Stop the app and worker together with `Ctrl+C` in the Next.js terminal.

## TripoSR configuration

The worker runs the existing repository's `run.py`, writes a native GLB into private storage, and updates the existing queued/processing/completed/failed job record. It does not automatically download model weights. `GET /api/v1/worker/status` reports whether the repository, Python environment, CUDA PyTorch, and model files are available.

Copy `.env.example` to `.env.local` if you need to override paths. Defaults are:

- `TRIPOSR_REPO`: `~/Desktop/TripoSR`
- `TRIPOSR_PYTHON`: `./.venv-triposr/Scripts/python.exe`
- `TRIPOSR_MODEL_DIR`: unset until the official files are downloaded
- `TRIPOSR_CHUNK_SIZE`: `4096`
- `TRIPOSR_MC_RESOLUTION`: `256`
- `TRIPOSR_TIMEOUT_MS`: `900000`

`TRIPOSR_MODEL_DIR` must point to a local folder containing both `config.yaml` and `model.ckpt`. The official `stabilityai/TripoSR` checkpoint is about 1.68 GB. The project was not found in the local Hugging Face cache, so the app reports the worker offline instead of downloading the checkpoint on first use. The cached `rembg` U2Net model is already present at the standard user cache location.

Use an isolated Python 3.10–3.14 environment (Python 3.12 is a suitable choice) and install the PyTorch CUDA wheel plus the requirements from the existing TripoSR repository inside that environment. Do not install them into global Python. For a fresh environment, the following PowerShell commands use `uv`:

```powershell
$env:TRIPOSR_REPO = Join-Path ([Environment]::GetFolderPath('Desktop')) 'TripoSR'
uv venv --python 3.12 .venv-triposr
$env:TRIPOSR_PYTHON = (Resolve-Path '.venv-triposr\Scripts\python.exe').Path
uv pip install --python $env:TRIPOSR_PYTHON --index-url https://download.pytorch.org/whl/cu118 torch==2.5.1 torchvision==0.20.1
uv pip install --python $env:TRIPOSR_PYTHON -r "$env:TRIPOSR_REPO\requirements.txt"
```

Set `TRIPOSR_REPO`, `TRIPOSR_PYTHON`, and `TRIPOSR_MODEL_DIR` in `.env.local`, then restart Next.js. The TripoSR repository documents `python run.py <image> --output-dir <dir>`; this worker supplies its own private output directory and uses `--model-save-format glb`.

The laptop has an RTX 3050 Laptop GPU with 6 GB VRAM. TripoSR's README estimates about 6 GB at its default settings. The worker defaults to the supported smaller `--chunk-size 4096`; if a real run runs out of memory, lower `TRIPOSR_CHUNK_SIZE` (for example, `2048`) or `TRIPOSR_MC_RESOLUTION` (for example, `128`) and retry. Lower mesh resolution reduces output detail. The installed CUDA Toolkit is 11.8; TripoSR's `torchmcubes` dependency can use a CPU-only extractor without CUDA Toolkit 12+, while GPU marching-cubes acceleration requires a newer Toolkit and a compatible build.

## Hunyuan3D-2mini and orthographic input

Single-image Hunyuan3D-2mini shape generation uses a separate Python environment and local checkpoint directory. Defaults resolve to `./.uv-cache/hunyuan3d-env/Scripts/python.exe`, `./.uv-cache/Hunyuan3D-2-source`, and `./.uv-cache/hy3dgen-models`; override them with `HUNYUAN_PYTHON`, `HUNYUAN_SOURCE`, and `HY3DGEN_MODELS` in `.env.local`. The official model files are large and are not committed to the project. Only the shape model is used; texture generation is not installed. Hunyuan's Tencent community license is non-commercial, so review the [official license](https://github.com/Tencent/Hunyuan3D-2/blob/main/LICENSE) before using it beyond personal evaluation.

Hunyuan3D-2mini is marked experimental and runs with the official 50 inference steps and 384 octree resolution. Its local worker uses Accelerate CPU offload to fit the 6 GB RTX 3050. Orthographic image upload/validation and private storage are available, but Hunyuan3D-2mv generation remains disabled until its official multi-view checkpoint and actual multi-view inference are validated on this hardware. The app saves orthographic files alongside the job record and reports that capability as unavailable; it never falls back to a single image.

## API and storage

- `POST/GET /api/v1/generations`
- `GET/DELETE /api/v1/generations/:id`
- `GET /api/v1/generations/:id/input`
- `GET /api/v1/generations/:id/views/:view` for privately stored orthographic views
- `GET /api/v1/generations/:id/asset` for completed GLBs only
- `GET /api/v1/worker/status`

SQLite metadata and input/output files live below `storage/`, outside `public/`. API routes accept local-host requests only. Upload signatures, MIME types, and file size are validated. The model name and chunk/mesh settings are recorded with each generation. Failed jobs can be retried from the workspace or history; retrying creates a new job with the same private source image.

The supplied `public/models/mech_drone.glb` remains the clearly labeled preview asset. It is not presented as an AI-generated result. Only a completed TripoSR or Hunyuan3D-2mini job switches the viewer to its generated GLB.

## Verification

```powershell
npm run typecheck
npm run lint
npm test
npm run build
```

The backend tests exercise API validation, worker readiness reporting, persistence, job transitions, storage, and private asset serving. A successful mocked worker lifecycle test is not evidence of real TripoSR inference; verify an actual GLB generation on the target GPU before describing inference as working.
