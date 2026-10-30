"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
/* eslint-disable @next/next/no-img-element -- previews use short-lived local blob URLs. */
import { Box, ChevronDown, CircleHelp, Clock3, Command, Cpu, Download, FolderOpen, ImagePlus, Layers3, Maximize2, MoreHorizontal, MousePointer2, PanelRightClose, Plus, RotateCcw, Settings2, ShieldCheck, Sparkles, Trash2, Upload, X, Zap } from "lucide-react";
import { DRONE_ASSET_URL } from "@/lib/model";
import type { ModelDimensions } from "@/lib/model";
import type { GenerationResponse, WorkerStatus } from "@/lib/generations";

const ModelViewer = dynamic(() => import("@/components/ModelViewer"), {
  ssr: false,
  loading: () => <div className="viewer-loading-fallback"><span className="viewer-spinner"/> PREPARING 3D VIEWER</div>,
});

const MAX_SIZE = 10 * 1024 * 1024;
const allowed = ["image/png", "image/jpeg", "image/webp"];
type ViewName = "front" | "back" | "left" | "right" | "top";
type ViewSelection = { url: string; name: string; size: number; file: File };

export default function Home() {
  const picker = useRef<HTMLInputElement>(null);
  const viewPickers = useRef<Partial<Record<ViewName, HTMLInputElement | null>>>({});
  const [image, setImage] = useState<{ url: string; name: string; size: number; file: File | null; objectUrl: boolean } | null>(null);
  const [inputMode, setInputMode] = useState<"single-image" | "orthographic-views">("single-image");
  const [engine, setEngine] = useState<"triposr" | "hunyuan3d-2mini" | "hunyuan3d-2mv">("triposr");
  const [orthographicViews, setOrthographicViews] = useState<Partial<Record<ViewName, ViewSelection>>>({});
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("New generation");
  const [toast, setToast] = useState("");
  const [resetVersion, setResetVersion] = useState(0);
  const [modelDimensions, setModelDimensions] = useState<ModelDimensions | null>(null);
  const [modelError, setModelError] = useState("");
  const [fullscreen, setFullscreen] = useState(false);
  const [activeGeneration, setActiveGeneration] = useState<GenerationResponse | null>(null);
  const [history, setHistory] = useState<GenerationResponse[]>([]);
  const [workerStatus, setWorkerStatus] = useState<WorkerStatus | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const viewerRef = useRef<HTMLDivElement>(null);
  const submissionController = useRef<AbortController | null>(null);

  const chooseFile = useCallback((file?: File) => {
    setError(""); if (!file) return;
    if (!allowed.includes(file.type)) { setError("Choose a PNG, JPG, or WebP image."); return; }
    if (file.size > MAX_SIZE) { setError("Image must be smaller than 10 MB."); return; }
    setImage(old => { if (old?.objectUrl) URL.revokeObjectURL(old.url); return { url: URL.createObjectURL(file), name: file.name, size: file.size, file, objectUrl: true }; });
    setActiveGeneration(null);
  }, []);
  const chooseViewFile = useCallback((view: ViewName, file?: File) => {
    setError(""); if (!file) return;
    if (!allowed.includes(file.type)) { setError("Choose a supported image for the " + view + " view."); return; }
    if (file.size > MAX_SIZE) { setError("Each orthographic image must be smaller than 10 MB."); return; }
    setOrthographicViews(old => {
      const previous = old[view];
      if (previous) URL.revokeObjectURL(previous.url);
      return { ...old, [view]: { url: URL.createObjectURL(file), name: file.name, size: file.size, file } };
    });
    setActiveGeneration(null);
  }, []);
  const changeInputMode = (mode: "single-image" | "orthographic-views") => {
    if (image?.objectUrl) URL.revokeObjectURL(image.url);
    for (const selected of Object.values(orthographicViews)) if (selected) URL.revokeObjectURL(selected.url);
    setImage(null); setOrthographicViews({}); setActiveGeneration(null); setError("");
    setInputMode(mode); setEngine(mode === "single-image" ? "triposr" : "hunyuan3d-2mv");
  };
  const reset = () => { submissionController.current?.abort(); submissionController.current = null; if (image?.objectUrl) URL.revokeObjectURL(image.url); for (const selected of Object.values(orthographicViews)) if (selected) URL.revokeObjectURL(selected.url); setImage(null); setOrthographicViews({}); setInputMode("single-image"); setEngine("triposr"); setActiveGeneration(null); setSubmitting(false); setError(""); setTab("New generation"); setResetVersion(v => v + 1); };
  const message = (s: string) => { setToast(s); window.setTimeout(() => setToast(""), 3200); };
  const onModelLoaded = useCallback((dimensions: ModelDimensions) => { setModelDimensions(dimensions); setModelError(""); }, []);
  const onModelError = useCallback((reason: string) => { setModelError(reason); setModelDimensions(null); }, []);
  const submitGeneration = async (fileOverride?: File, engineOverride?: "triposr" | "hunyuan3d-2mini" | "hunyuan3d-2mv", modeOverride?: "single-image" | "orthographic-views") => {
    if (submitting) return;
    const selectedEngine = engineOverride ?? engine;
    const selectedMode = modeOverride ?? inputMode;
    const file = fileOverride ?? image?.file;
    if (selectedMode === "single-image" && !file) { setError("Add a reference image before generating."); return; }
    if (selectedMode === "orthographic-views" && (!orthographicViews.front || ![orthographicViews.back, orthographicViews.left, orthographicViews.right].some(Boolean))) { setError("Add a front image and at least one additional horizontal view."); return; }
    const controller = new AbortController();
    submissionController.current = controller;
    setSubmitting(true);
    setError("");
    const body = new FormData();
    body.append("inputMode", selectedMode);
    body.append("engine", selectedEngine);
    if (selectedMode === "single-image" && file) body.append("image", file, file.name);
    if (selectedMode === "orthographic-views") for (const view of ["front", "back", "left", "right", "top"] as const) {
      const selection = orthographicViews[view];
      if (selection) body.append(view, selection.file, selection.file.name);
    }
    try {
      const response = await fetch("/api/v1/generations", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body,
        signal: controller.signal,
      });
      const result = await response.json() as { generation?: GenerationResponse; error?: { message?: string } };
      if (result.generation) {
        setActiveGeneration(result.generation);
        setHistory(items => [result.generation!, ...items.filter(item => item.id !== result.generation!.id)]);
        if (result.generation.status === "failed") message(result.error?.message ?? result.generation.errorMessage ?? "The selected local engine is unavailable.");
      } else {
        setError(result.error?.message ?? "The backend could not create a generation record.");
      }
    } catch (requestError) {
      if (!controller.signal.aborted) setError(requestError instanceof Error ? `Backend request failed: ${requestError.message}` : "The backend could not be reached.");
    } finally {
      if (submissionController.current === controller) {
        submissionController.current = null;
        setSubmitting(false);
      }
    }
  };
  const openGeneration = (generation: GenerationResponse) => {
    setImage(current => {
      if (current?.objectUrl) URL.revokeObjectURL(current.url);
      return { url: generation.inputImageUrl, name: generation.originalFilename, size: generation.fileSize, file: null, objectUrl: false };
    });
    setActiveGeneration(generation);
    setInputMode("single-image");
    setEngine(generation.generationSettings.engine === "hunyuan3d-2mini" ? "hunyuan3d-2mini" : "triposr");
    setTab("Workspace");
  };
  const retryGeneration = async (generation: GenerationResponse) => {
    if (generation.generationSettings.inputMode === "orthographic-views") { setError("Retry is unavailable until genuine multi-view inference is installed."); return; }
    try {
      const response = await fetch(generation.inputImageUrl, { cache: "no-store" });
      if (!response.ok) throw new Error("The stored source image could not be loaded.");
      const source = await response.blob();
      const file = new File([source], generation.originalFilename, { type: generation.contentType });
      setImage(current => {
        if (current?.objectUrl) URL.revokeObjectURL(current.url);
        return { url: generation.inputImageUrl, name: generation.originalFilename, size: file.size, file, objectUrl: false };
      });
      setActiveGeneration(generation);
      setTab("Workspace");
      const selectedEngine = generation.generationSettings.engine === "hunyuan3d-2mini" ? "hunyuan3d-2mini" : "triposr";
      setInputMode("single-image"); setEngine(selectedEngine);
      await submitGeneration(file, selectedEngine, "single-image");
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : "Could not retry this generation.");
    }
  };
  const deleteGeneration = async (generation: GenerationResponse) => {
    if (!window.confirm(`Delete generation ${generation.id.slice(0, 8)} and its stored files?`)) return;
    try {
      const response = await fetch(`/api/v1/generations/${generation.id}`, { method: "DELETE" });
      if (!response.ok) {
        const result = await response.json() as { error?: { message?: string } };
        message(result.error?.message ?? "Could not delete this generation.");
        return;
      }
      setHistory(items => items.filter(item => item.id !== generation.id));
      if (activeGeneration?.id === generation.id) {
        setActiveGeneration(null);
        setImage(current => { if (current?.objectUrl) URL.revokeObjectURL(current.url); return null; });
      }
      message("Generation and private files deleted.");
    } catch { message("The backend could not be reached to delete this generation."); }
  };
  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await viewerRef.current?.requestFullscreen();
    } catch { message("Fullscreen is not available in this browser."); }
  };
  useEffect(() => {
    const syncFullscreen = () => setFullscreen(document.fullscreenElement === viewerRef.current);
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () => document.removeEventListener("fullscreenchange", syncFullscreen);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    if (tab === "Generation history") { setHistoryLoading(true); setHistoryError(""); }
    fetch("/api/v1/generations?limit=50", { cache: "no-store", signal: controller.signal })
      .then(async response => {
        const result = await response.json() as { generations?: GenerationResponse[]; error?: { message?: string } };
        if (!response.ok) throw new Error(result.error?.message ?? "Could not load generation history.");
        setHistory(result.generations ?? []);
      })
      .catch(reason => { if (!controller.signal.aborted) setHistoryError(reason instanceof Error ? reason.message : "Could not load generation history."); })
      .finally(() => { if (!controller.signal.aborted) setHistoryLoading(false); });
    return () => controller.abort();
  }, [tab]);
  useEffect(() => {
    const controller = new AbortController();
    const loadWorker = async () => {
      try {
        const response = await fetch("/api/v1/worker/status", { cache: "no-store", signal: controller.signal });
        if (!response.ok) return;
        const result = await response.json() as { worker?: WorkerStatus };
        if (result.worker) setWorkerStatus(result.worker);
      } catch { /* Keep the worker state unknown when the local API is unavailable. */ }
    };
    void loadWorker();
    const timer = window.setInterval(() => void loadWorker(), 15_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, []);
  useEffect(() => {
    const current = activeGeneration;
    if (!current || (current.status !== "queued" && current.status !== "processing")) return;
    const controller = new AbortController();
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/v1/generations/${current.id}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) return;
        const result = await response.json() as { generation?: GenerationResponse };
        if (!result.generation) return;
        setActiveGeneration(value => value?.id === current.id ? result.generation! : value);
        setHistory(items => items.map(item => item.id === current.id ? result.generation! : item));
      } catch { /* The active status remains visible; no synthetic progress is shown. */ }
    }, 2500);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [activeGeneration]);

  const generatedAssetUrl = activeGeneration?.status === "completed" ? activeGeneration.assetUrl : null;
  const viewerAssetUrl = generatedAssetUrl ?? DRONE_ASSET_URL;
  const hasGeneratedAsset = Boolean(generatedAssetUrl);
  const selectedEngineStatus = workerStatus?.engines?.find(item => item.id === engine);
  const canSubmit = inputMode === "single-image" ? Boolean(image?.file) : Boolean(orthographicViews.front && [orthographicViews.back, orthographicViews.left, orthographicViews.right].some(Boolean));

  return <main className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Layers3 size={17}/></div><span>TRELLIS<span className="brand-light"> STUDIO</span></span><span className="brand-version">0.1</span></div>
      <button className="new-button" onClick={reset}><Plus size={16}/> New generation <kbd>⌘ K</kbd></button>
      <div className="nav-label">WORKSPACE</div>
      <nav className="nav-list">
        <button className={tab === "New generation" ? "nav-item selected" : "nav-item"} onClick={() => setTab("New generation")}><Sparkles size={16}/> New generation</button>
        <button className={tab === "Workspace" ? "nav-item selected" : "nav-item"} onClick={() => setTab("Workspace")}><Box size={16}/> Workspace</button>
        <button className={tab === "Generation history" ? "nav-item selected" : "nav-item"} onClick={() => setTab("Generation history")}><Clock3 size={16}/> Generation history <span className="nav-count">{history.length}</span></button>
      </nav>
      <div className="nav-label lower-label">PREFERENCES</div>
      <button className="nav-item" onClick={() => message("Settings will be available when the API is configured.")}><Settings2 size={16}/> Settings</button>
      <div className="sidebar-spacer"/>
      <div className="inference-card"><div className="inference-heading"><span className={`status-dot ${workerStatus?.ready ? "" : "muted"}`}/> LOCAL INFERENCE</div><div className="inference-title"><Cpu size={15}/> {workerStatus?.ready ? "TripoSR configured" : "TripoSR offline"}</div><p>{workerStatus?.message ?? "Checking the local inference environment…"}</p><button onClick={() => message("Preview asset: mech_drone.glb")}>Preview model available <ChevronDown size={13}/></button></div>
      <div className="user-row"><div className="avatar">A</div><div className="user-meta"><strong>Personal workspace</strong><span>Local session</span></div><MoreHorizontal size={17}/></div>
    </aside>

    <section className="work-area">
      <header className="topbar"><div className="breadcrumbs"><span>Workspace</span><span className="crumb-slash">/</span><strong>{tab}</strong></div><div className="top-actions"><span className="gpu-tag"><span className={`status-dot ${workerStatus?.ready ? "" : "muted"}`}/> TRIPOSR <span className={workerStatus?.ready ? "online" : "offline"}>{workerStatus?.ready ? "CONFIGURED" : "OFFLINE"}</span></span><button className="icon-button" title="Help" onClick={() => message("Upload an image and generate a local TripoSR mesh. The model files and CUDA Python environment must be installed first.")}><CircleHelp size={17}/></button><div className="top-avatar">A</div></div></header>

      <div className="content-wrap">
        <div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line"/> IMAGE TO 3D <span className="eyebrow-line"/></div><h1>{tab === "New generation" ? <>Give your image<br/><em>a new dimension.</em></> : tab === "Workspace" ? <>Your <em>workspace.</em></> : <>Generation <em>history.</em></>}</h1><p className="subheading">Transform a single image into a production-ready 3D asset.</p></div><div className="heading-index"><span>01</span><div/></div></div>

        {tab === "Generation history" ? <div className="history-screen"><div className="history-header"><div><span className="section-title">SAVED GENERATIONS</span><p>Persistent job records and private source images.</p></div><button className="secondary-button" onClick={reset}><Plus size={15}/> New generation</button></div>{historyLoading && <div className="history-message">Loading generation history…</div>}{historyError && <div className="history-message history-error" role="alert">{historyError}</div>}{!historyLoading && !historyError && history.length === 0 && <div className="empty-history"><div className="empty-icon"><FolderOpen size={24}/></div><h2>No generations yet</h2><p>Your submitted jobs will appear here and remain available after restart.</p><button className="secondary-button" onClick={reset}><Plus size={15}/> Start a generation</button></div>}{history.length > 0 && <div className="history-list">{history.map(item => <article className="history-card" key={item.id}><div className="history-thumb"><img src={item.inputImageUrl} alt=""/></div><div className="history-details"><strong title={item.originalFilename}>{item.originalFilename}</strong><span>{new Date(item.createdAt).toISOString().replace("T", " ").slice(0, 19)} UTC · {(item.fileSize / 1024 / 1024).toFixed(2)} MB</span><small>{item.errorMessage ?? `Job ${item.id.slice(0, 8)}`}</small></div><span className={`history-status status-${item.status}`}>{item.status}</span><div className="history-actions">{item.status === "failed" && <button title="Retry this generation with TripoSR" onClick={() => void retryGeneration(item)}>Retry</button>}<button title="Reopen generation" onClick={() => openGeneration(item)}>Open</button>{item.assetUrl && <a href={item.assetUrl} download={`generation-${item.id}.glb`}>Download</a>}<button className="delete-history" title="Delete generation and private files" onClick={() => void deleteGeneration(item)}><Trash2 size={14}/></button></div></article>)}</div>}</div> :
        <div className="studio-grid">
          <div className="center-column">
            <div className="input-mode-switch" role="group" aria-label="Input mode">
              <button className={inputMode === "single-image" ? "selected" : ""} onClick={() => changeInputMode("single-image")}>Single Image</button>
              <button className={inputMode === "orthographic-views" ? "selected" : ""} onClick={() => changeInputMode("orthographic-views")}>Orthographic Views <span>UNAVAILABLE</span></button>
            </div>
            <div className="section-heading"><div><span className="step-number">01</span><span className="section-title">{inputMode === "single-image" ? "REFERENCE IMAGE" : "ORTHOGRAPHIC VIEWS"}</span></div><span className="section-meta">{inputMode === "single-image" ? "INPUT · 1 IMAGE" : "INPUT · FRONT + OPTIONAL VIEWS"}</span></div>
            {inputMode === "single-image" ? <div className="viewport" onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); chooseFile(e.dataTransfer.files[0]); }}>
              <div className="viewport-topline"><span><span className="live-dot"/> {image ? "REFERENCE LOADED" : "AWAITING INPUT"}</span><span className="view-label">SOURCE VIEW <span>·</span> 01</span></div>
              {!image ? <motion.button className={`dropzone ${dragging ? "dragging" : ""}`} onClick={() => picker.current?.click()} whileTap={{ scale: .995 }}>
                <div className="drop-orbit"><div className="orbit-ring ring-a"/><div className="orbit-ring ring-b"/><div className="upload-glyph"><ImagePlus size={21}/></div><span className="orbit-spark spark-one"/><span className="orbit-spark spark-two"/></div>
                <strong>Drop your image here</strong><span className="drop-sub">or <u>browse files</u> from your device</span><span className="format-pills"><i>PNG</i><i>JPG</i><i>WEBP</i><b>MAX 10 MB</b></span>
                <span className="drag-hint"><Upload size={12}/> RELEASE TO UPLOAD</span>
              </motion.button> : <div className="image-preview"><img src={image.url} alt="Selected reference"/><div className="image-overlay"><div className="loaded-tag"><span className="live-dot"/> IMAGE READY</div><button className="replace-image" onClick={() => picker.current?.click()}><ImagePlus size={14}/> Replace</button></div></div>}
              <div className="viewport-bottomline"><span><MousePointer2 size={12}/> {image ? `${image.name} · ${(image.size / 1024 / 1024).toFixed(2)} MB` : "DROP AN IMAGE TO BEGIN"}</span><span>PNG · JPG · WEBP</span></div>
            </div> : <div className="orthographic-grid">
              {(["front", "back", "left", "right", "top"] as const).map(view => {
                const selected = orthographicViews[view];
                const required = view === "front";
                return <div className="orthographic-card" key={view}>
                  <input ref={element => { viewPickers.current[view] = element; }} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={event => { chooseViewFile(view, event.target.files?.[0]); event.currentTarget.value = ""; }}/>
                  <div className="ortho-label">{view.toUpperCase()} <small>{required ? "REQUIRED" : view === "top" ? "OPTIONAL" : "OPTIONAL"}</small></div>
                  {selected ? <div className="ortho-image"><img src={selected.url} alt={view + " view preview"}/></div> : <div className="ortho-empty">{view === "top" ? "Optional top view" : "Add " + view + " view"}</div>}
                  <div className="ortho-actions"><button onClick={() => viewPickers.current[view]?.click()}><ImagePlus size={13}/>{selected ? "Replace" : "Choose image"}</button>{selected && <button title={"Remove " + view + " view"} onClick={() => { URL.revokeObjectURL(selected.url); setOrthographicViews(old => { const next = { ...old }; delete next[view]; return next; }); }}><X size={13}/></button>}</div>
                </div>;
              })}
              <p className="multiview-unavailable">Hunyuan3D-2mv is under evaluation on this 6 GB GPU. These views can be validated and saved, but multi-view generation is not enabled yet.</p>
            </div>}
            <div className="viewer-placeholder viewer-stage" ref={viewerRef}>
              <ModelViewer assetUrl={viewerAssetUrl} assetName={hasGeneratedAsset ? `generation-${activeGeneration?.id}.glb` : "mech_drone.glb"} resetVersion={resetVersion} onLoaded={onModelLoaded} onError={onModelError}/>
              <div className="viewer-overlay viewer-topline"><span><span className={`live-dot ${modelError ? "error-dot" : ""}`}/>{modelError ? "MODEL LOAD ERROR" : hasGeneratedAsset ? "GENERATED OUTPUT ASSET" : "PREVIEW ASSET · MECH_DRONE.GLB"}</span><span className="view-label">INTERACTIVE VIEW <span>·</span> GLB</span></div>
              <a className="viewer-download" href={viewerAssetUrl} download={hasGeneratedAsset ? `generation-${activeGeneration?.id}.glb` : "mech_drone.glb"} aria-label={`Download ${hasGeneratedAsset ? "generated model" : "mech_drone.glb"}`}><Download size={13}/><span>DOWNLOAD GLB</span></a>
              <div className="viewport-corner bottom-left">{modelDimensions ? `${modelDimensions.x.toFixed(1)} × ${modelDimensions.y.toFixed(1)} × ${modelDimensions.z.toFixed(1)} UNITS` : modelError ? "ASSET UNAVAILABLE" : "LOADING MODEL"}</div>
              {modelError && <div className="viewer-error-banner" role="alert"><strong>{hasGeneratedAsset ? "Could not load the generated GLB" : "Could not load mech_drone.glb"}</strong><span>{modelError}</span></div>}
            </div>
            <div className="viewer-footer"><span><span className={`status-dot ${modelDimensions ? "" : "muted"}`}/>{modelError ? "MODEL LOAD FAILED" : modelDimensions ? hasGeneratedAsset ? "GENERATED OUTPUT ASSET" : "PREVIEW ASSET — MECH_DRONE.GLB" : "LOADING 3D ASSET"}<b>·</b> {hasGeneratedAsset ? "FROM COMPLETED JOB" : "NOT AI-GENERATED"}</span><a href={viewerAssetUrl} download={hasGeneratedAsset ? `generation-${activeGeneration?.id}.glb` : "mech_drone.glb"}><Download size={12}/> DOWNLOAD</a><button onClick={() => setResetVersion(v => v + 1)}><RotateCcw size={12}/> RESET VIEW</button><button onClick={toggleFullscreen}><Maximize2 size={12}/> {fullscreen ? "EXIT FULLSCREEN" : "FULLSCREEN"}</button></div>
          </div>

          <aside className="settings-panel"><div className="panel-heading"><div><Settings2 size={15}/><span>GENERATION SETTINGS</span></div><button title="Collapse settings"><PanelRightClose size={15}/></button></div>
            <div className="panel-section"><div className="panel-section-title"><span>{inputMode === "single-image" ? "INPUT IMAGE" : "ORTHOGRAPHIC VIEWS"}</span><span className="tiny-count">{inputMode === "single-image" ? image ? "01" : "—" : Object.keys(orthographicViews).length + "/5"}</span></div>{inputMode === "single-image" ? image ? <div className="file-card"><div className="file-thumb"><img src={image.url} alt=""/></div><div className="file-meta"><strong title={image.name}>{image.name}</strong><span>{(image.size / 1024 / 1024).toFixed(2)} MB · {image.name.split(".").pop()?.toUpperCase()}</span></div><button title="Remove image" onClick={() => { if (image.objectUrl) URL.revokeObjectURL(image.url); setImage(null); }}><X size={14}/></button></div> : <button className="add-reference" onClick={() => picker.current?.click()}><Plus size={14}/> Add a reference image</button> : <div className="view-file-list">{(["front", "back", "left", "right", "top"] as const).map(view => { const item = orthographicViews[view]; return <div key={view} className="view-file-row"><span>{view.toUpperCase()}</span>{item ? <><img src={item.url} alt=""/><strong title={item.name}>{item.name}</strong><button onClick={() => viewPickers.current[view]?.click()}>Replace</button></> : <button onClick={() => viewPickers.current[view]?.click()}>Add {view}</button>}</div>; })}</div>}</div>
            <div className="panel-section"><div className="panel-section-title"><span>OUTPUT RESOLUTION</span><button className="help-mini" title="TripoSR mesh resolution is configured locally"><CircleHelp size={13}/></button></div><div className="segmented">{["512", "1024", "1536"].map((v,i) => <button key={v} disabled title="TripoSR mesh resolution is configured locally">{v}<span>{["1K","2K","3K"][i]}</span></button>)}</div><p className="field-hint">Change TRIPOSR_MC_RESOLUTION in .env.local.</p></div>
            <div className="panel-section model-section"><div className="panel-section-title"><span>GENERATION ENGINE</span><span className="beta-badge">LOCAL</span></div><div className="engine-select-wrap"><select aria-label="Generation engine" value={engine} onChange={event => setEngine(event.target.value as typeof engine)}>{inputMode === "single-image" ? <><option value="triposr" disabled={workerStatus ? !workerStatus.engines?.find(item => item.id === "triposr")?.available : false}>TripoSR{workerStatus?.engines?.find(item => item.id === "triposr")?.available ? " · ready" : " · unavailable"}</option><option value="hunyuan3d-2mini" disabled={workerStatus ? !workerStatus.engines?.find(item => item.id === "hunyuan3d-2mini")?.available : false}>Hunyuan3D-2mini{workerStatus?.engines?.find(item => item.id === "hunyuan3d-2mini")?.available ? " · experimental" : " · unavailable"}</option></> : <option value="hunyuan3d-2mv" disabled>Hunyuan3D-2mv · unavailable</option>}</select></div><p className="field-hint">{selectedEngineStatus?.capability ?? (inputMode === "orthographic-views" ? "Orthographic set · multi-view generation disabled" : "Checking local engines…")}</p><p className="engine-message">{selectedEngineStatus?.message ?? "Engine readiness is loading."}</p></div>
            <div className="panel-spacer"/><div className="cloud-notice"><div className="notice-icon"><Zap size={14}/></div><div><strong>{selectedEngineStatus?.available ? selectedEngineStatus.label + " ready" : selectedEngineStatus?.label + " unavailable"}</strong><p>{selectedEngineStatus?.message ?? "Checking local generation engines…"}</p><a href="#setup" onClick={e => { e.preventDefault(); message("Local engine setup information is documented in the project README."); }}>View setup guide <span>↗</span></a></div></div>
            <button className="generate-button" disabled={submitting || !canSubmit} onClick={() => void submitGeneration()}><Sparkles size={16}/> {submitting ? "Submitting request…" : inputMode === "orthographic-views" ? "Validate & save views" : "Generate 3D model"} <span className="button-arrow">↗</span></button>
            {activeGeneration && <div className="job-status-card" aria-live="polite"><div><span>JOB STATUS</span><span className={`history-status status-${activeGeneration.status}`}>{activeGeneration.status.toUpperCase()}</span></div><small>ID {activeGeneration.id}</small>{activeGeneration.errorMessage && <p>{activeGeneration.errorMessage}</p>}{activeGeneration.status === "failed" && <button className="secondary-button" onClick={() => void retryGeneration(activeGeneration)}>Retry with {activeGeneration.generationSettings.engine === "hunyuan3d-2mini" ? "Hunyuan3D-2mini" : "TripoSR"}</button>}{activeGeneration.status === "completed" && activeGeneration.assetUrl && <a href={activeGeneration.assetUrl} download={`generation-${activeGeneration.id}.glb`}>Download completed GLB <Download size={12}/></a>}</div>}
            <div className="secure-note"><ShieldCheck size={12}/> {activeGeneration ? "Reference stored privately on this device" : "Image preview stays in this browser session"}</div>
          </aside>
        </div>}
        <footer className="page-footer"><span>TRELLIS STUDIO <b>·</b> PERSONAL WORKSPACE</span><span>MODEL <b>·</b> <strong>TripoSR</strong></span><button onClick={() => message("Trellis Studio · local development build")}>ABOUT <Command size={11}/></button></footer>
      </div>
      <input ref={picker} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={e => { chooseFile(e.target.files?.[0]); e.currentTarget.value = ""; }}/>
      {error && <div className="error-toast" role="alert"><span>{error}</span><button onClick={() => setError("")}><X size={14}/></button></div>}
      {toast && <div className="toast"><span className="toast-dot"/>{toast}</div>}
    </section>
  </main>;
}
