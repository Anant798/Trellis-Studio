export type CropRect = {
  x: number; // 0..1
  y: number; // 0..1
  width: number; // 0..1
  height: number; // 0..1
};

export type AspectPreset = "free" | "1:1" | "4:3" | "16:9";

/**
 * Clamps crop rectangle coordinates to valid normalized bounds [0, 1].
 */
export function clampCropRect(rect: CropRect): CropRect {
  const width = Math.max(0.05, Math.min(1, rect.width));
  const height = Math.max(0.05, Math.min(1, rect.height));
  const x = Math.max(0, Math.min(1 - width, rect.x));
  const y = Math.max(0, Math.min(1 - height, rect.y));
  return { x, y, width, height };
}

/**
 * Calculates a new crop rectangle when an aspect ratio preset is selected.
 */
export function applyAspectToRect(
  aspect: AspectPreset,
  currentRect: CropRect,
  naturalDimensions: { width: number; height: number } | null
): CropRect {
  if (aspect === "free" || !naturalDimensions || naturalDimensions.width <= 0 || naturalDimensions.height <= 0) {
    return clampCropRect(currentRect);
  }

  let targetRatio = 1;
  if (aspect === "1:1") targetRatio = 1;
  else if (aspect === "4:3") targetRatio = 4 / 3;
  else if (aspect === "16:9") targetRatio = 16 / 9;

  const imgAspect = naturalDimensions.width / naturalDimensions.height;
  let newWidth = currentRect.width;
  let newHeight = (newWidth * imgAspect) / targetRatio;

  if (newHeight > 0.95) {
    newHeight = 0.95;
    newWidth = (newHeight * targetRatio) / imgAspect;
  }

  const newX = Math.max(0, Math.min(1 - newWidth, currentRect.x));
  const newY = Math.max(0, Math.min(1 - newHeight, currentRect.y));
  return clampCropRect({ x: newX, y: newY, width: newWidth, height: newHeight });
}

/**
 * Computes zoom factor to fit the image inside the container bounds.
 */
export function calculateFitScale(
  containerWidth: number,
  containerHeight: number,
  imageWidth: number,
  imageHeight: number,
  rotation: number
): number {
  if (containerWidth <= 0 || containerHeight <= 0 || imageWidth <= 0 || imageHeight <= 0) return 1;
  const isRotated90 = (rotation % 180 + 180) % 180 !== 0;
  const effectiveW = isRotated90 ? imageHeight : imageWidth;
  const effectiveH = isRotated90 ? imageWidth : imageHeight;
  const scale = Math.min(containerWidth / effectiveW, containerHeight / effectiveH, 1.5);
  return Math.max(0.15, +scale.toFixed(2));
}

/**
 * Computes zoom factor to fill the image inside the container bounds.
 */
export function calculateFillScale(
  containerWidth: number,
  containerHeight: number,
  imageWidth: number,
  imageHeight: number,
  rotation: number
): number {
  if (containerWidth <= 0 || containerHeight <= 0 || imageWidth <= 0 || imageHeight <= 0) return 1;
  const isRotated90 = (rotation % 180 + 180) % 180 !== 0;
  const effectiveW = isRotated90 ? imageHeight : imageWidth;
  const effectiveH = isRotated90 ? imageWidth : imageHeight;
  const scale = Math.max(containerWidth / effectiveW, containerHeight / effectiveH);
  return Math.max(0.15, +scale.toFixed(2));
}
