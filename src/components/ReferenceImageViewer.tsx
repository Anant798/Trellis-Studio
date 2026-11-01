"use client";

/* eslint-disable @next/next/no-img-element -- previews use short-lived local blob URLs. */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  Crop,
  Expand,
  ImagePlus,
  Maximize2,
  Minimize2,
  MousePointer2,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Scan,
  Undo2,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import {
  applyAspectToRect,
  calculateFillScale,
  calculateFitScale,
  clampCropRect,
} from "@/components/reference-image-utils";
import type { AspectPreset, CropRect } from "@/components/reference-image-utils";

export type ImageFileInfo = {
  url: string;
  name: string;
  size: number;
  file: File | null;
  objectUrl: boolean;
};

export type AppliedCropInfo = {
  file: File;
  url: string;
  width: number;
  height: number;
};

export type ReferenceImageViewerProps = {
  image: ImageFileInfo | null;
  originalImage: ImageFileInfo | null;
  appliedCrop: AppliedCropInfo | null;
  onSelectFile: (file?: File) => void;
  onClearImage: () => void;
  onApplyCrop: (cropInfo: AppliedCropInfo) => void;
  onRevertCrop: () => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
};

export default function ReferenceImageViewer({
  image,
  originalImage,
  appliedCrop,
  onSelectFile,
  onClearImage,
  onApplyCrop,
  onRevertCrop,
  isFullscreen,
  onToggleFullscreen,
}: ReferenceImageViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  // Preview adjustments state (pan, zoom, rotation)
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [rotation, setRotation] = useState(0); // 0, 90, 180, 270

  // Drag state for panning
  const [isPanning, setIsPanning] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const [draggingFile, setDraggingFile] = useState(false);

  // Crop mode state
  const [isCropping, setIsCropping] = useState(false);
  const [cropAspect, setCropAspect] = useState<AspectPreset>("free");
  const [cropRect, setCropRect] = useState<CropRect>({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 });
  const [activeHandle, setActiveHandle] = useState<string | null>(null);
  const cropDragStartRef = useRef<{ clientX: number; clientY: number; initialRect: CropRect }>({
    clientX: 0,
    clientY: 0,
    initialRect: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
  });

  // Natural image dimensions
  const [naturalDimensions, setNaturalDimensions] = useState<{ width: number; height: number } | null>(null);

  // Active source URL: use original image URL when cropping so user crops from full source
  const displayUrl = isCropping && originalImage ? originalImage.url : image?.url;

  // Reset preview adjustments when a new image is loaded
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setRotation(0);
    setIsCropping(false);
  }, [image?.name, image?.size]);

  // Handle image load to capture natural dimensions
  const handleImageLoaded = useCallback(() => {
    if (!imageRef.current) return;
    const { naturalWidth, naturalHeight } = imageRef.current;
    setNaturalDimensions({ width: naturalWidth, height: naturalHeight });
  }, []);

  // Zoom controls
  const zoomIn = () => setZoom(z => Math.min(8, +(z * 1.25).toFixed(2)));
  const zoomOut = () => setZoom(z => Math.max(0.15, +(z / 1.25).toFixed(2)));
  const resetZoom = () => setZoom(1);

  // Fit to frame: computes scale so entire image fits in container with padding
  const fitToFrame = useCallback(() => {
    if (!containerRef.current || !naturalDimensions) return;
    const containerW = containerRef.current.clientWidth - 32;
    const containerH = containerRef.current.clientHeight - 80;
    const scale = calculateFitScale(containerW, containerH, naturalDimensions.width, naturalDimensions.height, rotation);
    setZoom(scale);
    setPan({ x: 0, y: 0 });
  }, [naturalDimensions, rotation]);

  // Fill frame: computes scale so image fully covers the container
  const fillFrame = useCallback(() => {
    if (!containerRef.current || !naturalDimensions) return;
    const containerW = containerRef.current.clientWidth;
    const containerH = containerRef.current.clientHeight - 80;
    const scale = calculateFillScale(containerW, containerH, naturalDimensions.width, naturalDimensions.height, rotation);
    setZoom(scale);
    setPan({ x: 0, y: 0 });
  }, [naturalDimensions, rotation]);

  // Rotate left (-90 deg) and right (+90 deg)
  const rotateLeft = () => setRotation(r => (r - 90 + 360) % 360);
  const rotateRight = () => setRotation(r => (r + 90) % 360);

  // Reset all adjustments
  const resetAllAdjustments = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setRotation(0);
    setIsCropping(false);
  };

  // Mouse wheel zoom
  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (isCropping) return;
    e.preventDefault();
    if (e.deltaY < 0) {
      setZoom(z => Math.min(8, +(z * 1.1).toFixed(2)));
    } else {
      setZoom(z => Math.max(0.15, +(z / 1.1).toFixed(2)));
    }
  };

  // Pointer event handlers for panning
  const handlePointerDownCanvas = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!image || isCropping) return;
    // Only drag with primary pointer
    if (e.button !== 0) return;
    setIsPanning(true);
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      panX: pan.x,
      panY: pan.y,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMoveCanvas = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!image || !isPanning || isCropping) return;
    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;
    setPan({
      x: dragStartRef.current.panX + dx,
      y: dragStartRef.current.panY + dy,
    });
  };

  const handlePointerUpCanvas = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isPanning) {
      setIsPanning(false);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // Ignored
      }
    }
  };

  // Toggle crop mode
  const startCropMode = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setRotation(0);
    setCropRect({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 });
    setIsCropping(true);
  };

  const cancelCropMode = () => {
    setIsCropping(false);
    setActiveHandle(null);
  };

  const changeAspectPreset = (preset: AspectPreset) => {
    setCropAspect(preset);
    setCropRect(current => applyAspectToRect(preset, current, naturalDimensions));
  };

  // Crop box handle drag handlers
  const handleCropPointerDown = (handle: string, e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setActiveHandle(handle);
    cropDragStartRef.current = {
      clientX: e.clientX,
      clientY: e.clientY,
      initialRect: { ...cropRect },
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handleCropPointerMove = (e: React.PointerEvent) => {
    if (!activeHandle || !imageRef.current) return;
    e.stopPropagation();

    const rect = imageRef.current.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const deltaX = (e.clientX - cropDragStartRef.current.clientX) / rect.width;
    const deltaY = (e.clientY - cropDragStartRef.current.clientY) / rect.height;
    const init = cropDragStartRef.current.initialRect;

    let { x, y, width, height } = init;

    if (activeHandle === "move") {
      x = Math.max(0, Math.min(1 - width, init.x + deltaX));
      y = Math.max(0, Math.min(1 - height, init.y + deltaY));
    } else {
      if (activeHandle.includes("w")) {
        const newX = Math.max(0, Math.min(init.x + init.width - 0.05, init.x + deltaX));
        width = init.width - (newX - init.x);
        x = newX;
      }
      if (activeHandle.includes("e")) {
        width = Math.max(0.05, Math.min(1 - init.x, init.width + deltaX));
      }
      if (activeHandle.includes("n")) {
        const newY = Math.max(0, Math.min(init.y + init.height - 0.05, init.y + deltaY));
        height = init.height - (newY - init.y);
        y = newY;
      }
      if (activeHandle.includes("s")) {
        height = Math.max(0.05, Math.min(1 - init.y, init.height + deltaY));
      }
    }

    setCropRect(clampCropRect({ x, y, width, height }));
  };

  const handleCropPointerUp = (e: React.PointerEvent) => {
    if (activeHandle) {
      setActiveHandle(null);
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        // Ignored
      }
    }
  };

  // Perform non-destructive crop via offscreen canvas
  const executeCrop = () => {
    const sourceImage = imageRef.current;
    if (!sourceImage || !naturalDimensions || !originalImage) return;

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const cropX = Math.max(0, Math.round(cropRect.x * naturalDimensions.width));
    const cropY = Math.max(0, Math.round(cropRect.y * naturalDimensions.height));
    const cropW = Math.max(1, Math.round(cropRect.width * naturalDimensions.width));
    const cropH = Math.max(1, Math.round(cropRect.height * naturalDimensions.height));

    canvas.width = cropW;
    canvas.height = cropH;

    ctx.drawImage(sourceImage, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

    canvas.toBlob(blob => {
      if (!blob) return;
      const croppedFile = new File([blob], `cropped-${originalImage.name.replace(/\.[^/.]+$/, "")}.png`, {
        type: "image/png",
      });
      const croppedUrl = URL.createObjectURL(blob);
      onApplyCrop({
        file: croppedFile,
        url: croppedUrl,
        width: cropW,
        height: cropH,
      });
      setIsCropping(false);
    }, "image/png");
  };

  // Check if adjustments have been made (preview-only)
  const hasPreviewAdjustments = zoom !== 1 || pan.x !== 0 || pan.y !== 0 || rotation !== 0;

  return (
    <div
      ref={containerRef}
      className={`reference-editor ${isFullscreen ? "is-fullscreen" : ""}`}
      onWheel={handleWheel}
      onDragOver={e => {
        e.preventDefault();
        setDraggingFile(true);
      }}
      onDragLeave={() => setDraggingFile(false)}
      onDrop={e => {
        e.preventDefault();
        setDraggingFile(false);
        const file = e.dataTransfer.files?.[0];
        if (file) onSelectFile(file);
      }}
    >
      {/* Editor Top Toolbar */}
      <div className="editor-toolbar">
        <div className="toolbar-left">
          <span className="editor-status-indicator">
            <span className={`live-dot ${image ? "" : "muted"}`} />
            <span className="editor-title">{image ? "REFERENCE IMAGE" : "NO IMAGE LOADED"}</span>
          </span>

          {appliedCrop ? (
            <span className="adjustment-badge crop-badge" title="Cropped version will be sent to the generation pipeline. Original is preserved.">
              <Check size={10} /> CROP APPLIED TO INPUT
            </span>
          ) : hasPreviewAdjustments ? (
            <span className="adjustment-badge preview-badge" title="Zoom, pan, and rotation are preview-only. Generation uses original source image.">
              PREVIEW ADJUSTMENTS
            </span>
          ) : null}
        </div>

        {image && !isCropping && (
          <div className="toolbar-controls">
            <button
              type="button"
              className="toolbar-btn"
              title="Zoom out"
              onClick={zoomOut}
              disabled={zoom <= 0.15}
            >
              <ZoomOut size={13} />
            </button>
            <button
              type="button"
              className="toolbar-btn zoom-level-btn"
              title="Reset zoom to 100%"
              onClick={resetZoom}
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              className="toolbar-btn"
              title="Zoom in"
              onClick={zoomIn}
              disabled={zoom >= 8}
            >
              <ZoomIn size={13} />
            </button>

            <div className="toolbar-divider" />

            <button
              type="button"
              className="toolbar-btn"
              title="Fit to frame"
              onClick={fitToFrame}
            >
              <Scan size={13} />
              <span className="btn-label">Fit</span>
            </button>
            <button
              type="button"
              className="toolbar-btn"
              title="Fill frame"
              onClick={fillFrame}
            >
              <Expand size={13} />
              <span className="btn-label">Fill</span>
            </button>

            <div className="toolbar-divider" />

            <button
              type="button"
              className="toolbar-btn"
              title="Rotate left 90°"
              onClick={rotateLeft}
            >
              <RotateCcw size={13} />
            </button>
            <button
              type="button"
              className="toolbar-btn"
              title="Rotate right 90°"
              onClick={rotateRight}
            >
              <RotateCw size={13} />
            </button>

            <div className="toolbar-divider" />

            <button
              type="button"
              className="toolbar-btn crop-toggle-btn"
              title="Enter crop mode"
              onClick={startCropMode}
            >
              <Crop size={13} />
              <span className="btn-label">Crop</span>
            </button>

            <button
              type="button"
              className="toolbar-btn"
              title="Reset view adjustments"
              onClick={resetAllAdjustments}
              disabled={!hasPreviewAdjustments}
            >
              <Undo2 size={13} />
            </button>

            <div className="toolbar-divider" />

            <label
              className="toolbar-btn"
              title="Replace reference image"
              style={{ cursor: "pointer" }}
            >
              <ImagePlus size={13} />
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                style={{ display: "none" }}
                onChange={e => {
                  onSelectFile(e.target.files?.[0]);
                  e.currentTarget.value = "";
                }}
              />
            </label>

            <button
              type="button"
              className={`toolbar-btn fullscreen-btn ${isFullscreen ? "active" : ""}`}
              title={isFullscreen ? "Exit fullscreen (Esc)" : "Fullscreen viewer"}
              onClick={onToggleFullscreen}
            >
              {isFullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            </button>
          </div>
        )}

        {isCropping && (
          <div className="crop-toolbar">
            <span className="crop-label">ASPECT:</span>
            {(["free", "1:1", "4:3", "16:9"] as const).map(preset => (
              <button
                key={preset}
                type="button"
                className={`crop-preset-btn ${cropAspect === preset ? "active" : ""}`}
                onClick={() => changeAspectPreset(preset)}
              >
                {preset.toUpperCase()}
              </button>
            ))}
            <div className="toolbar-divider" />
            <button
              type="button"
              className="crop-action-btn apply-crop-btn"
              title="Apply crop to generation input"
              onClick={executeCrop}
            >
              <Check size={12} /> Apply to Input
            </button>
            <button
              type="button"
              className="crop-action-btn cancel-crop-btn"
              title="Cancel crop"
              onClick={cancelCropMode}
            >
              <X size={12} /> Cancel
            </button>
          </div>
        )}
      </div>

      {/* Main Canvas Viewport Area */}
      <div
        className={`editor-canvas-stage ${isPanning ? "is-panning" : ""} ${image ? "has-image" : ""}`}
        onPointerDown={image && !isCropping ? handlePointerDownCanvas : undefined}
        onPointerMove={image && !isCropping ? handlePointerMoveCanvas : undefined}
        onPointerUp={image && !isCropping ? handlePointerUpCanvas : undefined}
      >
        {!image ? (
          <label
            className={`dropzone-editor ${draggingFile ? "dragging" : ""}`}
            style={{ cursor: "pointer" }}
            onDragOver={e => {
              e.preventDefault();
              e.stopPropagation();
              setDraggingFile(true);
            }}
            onDragEnter={e => {
              e.preventDefault();
              e.stopPropagation();
              setDraggingFile(true);
            }}
            onDragLeave={e => {
              e.preventDefault();
              e.stopPropagation();
              setDraggingFile(false);
            }}
            onDrop={e => {
              e.preventDefault();
              e.stopPropagation();
              setDraggingFile(false);
              const file = e.dataTransfer.files?.[0];
              if (file) onSelectFile(file);
            }}
          >
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              style={{ display: "none" }}
              onChange={e => {
                onSelectFile(e.target.files?.[0]);
                e.currentTarget.value = "";
              }}
            />
            <div className="drop-orbit">
              <div className="orbit-ring ring-a" />
              <div className="orbit-ring ring-b" />
              <div className="upload-glyph">
                <ImagePlus size={22} />
              </div>
              <span className="orbit-spark spark-one" />
              <span className="orbit-spark spark-two" />
            </div>
            <strong>Drop reference image here</strong>
            <span className="drop-sub">
              or <u>browse files</u> from your device
            </span>
            <span className="format-pills">
              <i>PNG</i>
              <i>JPG</i>
              <i>WEBP</i>
              <b>MAX 10 MB</b>
            </span>
            <span className="drag-hint">
              <Upload size={12} /> RELEASE TO UPLOAD
            </span>
          </label>
        ) : (
          <div className="canvas-interactive-wrapper">
            <div
              className="canvas-image-layer"
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) rotate(${rotation}deg) scale(${zoom})`,
                transformOrigin: "center center",
                transition: isPanning ? "none" : "transform 0.15s ease-out",
              }}
            >
              <img
                ref={imageRef}
                src={displayUrl}
                alt={image.name || "Reference"}
                className="canvas-img"
                draggable={false}
                onLoad={handleImageLoaded}
              />

              {/* Crop Overlay when isCropping === true */}
              {isCropping && (
                <div
                  className="crop-overlay-container"
                  onPointerMove={handleCropPointerMove}
                  onPointerUp={handleCropPointerUp}
                >
                  <div
                    className="crop-box"
                    style={{
                      left: `${cropRect.x * 100}%`,
                      top: `${cropRect.y * 100}%`,
                      width: `${cropRect.width * 100}%`,
                      height: `${cropRect.height * 100}%`,
                    }}
                    onPointerDown={e => handleCropPointerDown("move", e)}
                  >
                    {/* Grid lines */}
                    <div className="crop-grid-h line-1" />
                    <div className="crop-grid-h line-2" />
                    <div className="crop-grid-v line-1" />
                    <div className="crop-grid-v line-2" />

                    {/* Corner & edge handles */}
                    <div className="crop-handle handle-nw" onPointerDown={e => handleCropPointerDown("nw", e)} />
                    <div className="crop-handle handle-n" onPointerDown={e => handleCropPointerDown("n", e)} />
                    <div className="crop-handle handle-ne" onPointerDown={e => handleCropPointerDown("ne", e)} />
                    <div className="crop-handle handle-e" onPointerDown={e => handleCropPointerDown("e", e)} />
                    <div className="crop-handle handle-se" onPointerDown={e => handleCropPointerDown("se", e)} />
                    <div className="crop-handle handle-s" onPointerDown={e => handleCropPointerDown("s", e)} />
                    <div className="crop-handle handle-sw" onPointerDown={e => handleCropPointerDown("sw", e)} />
                    <div className="crop-handle handle-w" onPointerDown={e => handleCropPointerDown("w", e)} />
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Exit fullscreen button overlay when fullscreen */}
        {isFullscreen && (
          <button
            type="button"
            className="exit-fullscreen-floating-btn"
            onClick={onToggleFullscreen}
            title="Exit Fullscreen (Esc)"
          >
            <Minimize2 size={13} /> EXIT FULLSCREEN (ESC)
          </button>
        )}
      </div>

      {/* Editor Bottom Info Bar */}
      <div className="editor-bottomline">
        <div className="bottomline-left">
          {image ? (
            <>
              <MousePointer2 size={11} />
              <span className="file-info-text">
                <strong>{originalImage ? originalImage.name : image.name}</strong> ·{" "}
                {((originalImage ? originalImage.size : image.size) / (1024 * 1024)).toFixed(2)} MB
                {naturalDimensions ? ` (${naturalDimensions.width} × ${naturalDimensions.height} px)` : ""}
              </span>
              {appliedCrop && (
                <span className="crop-meta-text">
                  [Cropped: {appliedCrop.width} × {appliedCrop.height} px]
                </span>
              )}
            </>
          ) : (
            <span>DROP AN IMAGE TO BEGIN · PNG, JPG, WEBP</span>
          )}
        </div>

        <div className="bottomline-right">
          {appliedCrop && (
            <button
              type="button"
              className="revert-crop-btn"
              title="Revert to original uncropped image"
              onClick={onRevertCrop}
            >
              <RefreshCw size={11} /> Revert to Original
            </button>
          )}

          {hasPreviewAdjustments && !appliedCrop && (
            <span className="preview-indicator-text">
              Preview-only adjustments · Not applied to generation input
            </span>
          )}

          {image && (
            <button
              type="button"
              className="remove-image-btn"
              title="Remove reference image"
              onClick={onClearImage}
            >
              <X size={12} /> Remove
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
