/**
 * Image attachments for the notch AI.
 *
 * A screenshot straight from the snipping tool can be 4-8 MB of PNG. Sending
 * that as base64 (which is ~33% bigger again) would cost the webview tens of
 * megabytes of transient allocation for every question, and the vision models
 * downscale it anyway. So the file is decoded once, drawn into a canvas at most
 * 1280 px on the long edge and re-encoded as JPEG. That keeps a typical
 * screenshot around 100-250 KB while staying readable for the model.
 *
 * Nothing here is kept after the request: the caller drops the data URLs, and
 * the backend drops the base64 right after the HTTP call.
 */

export interface AiImage {
  id: string;
  /** `data:image/jpeg;base64,...`, ready for `ai_ask`. */
  dataUrl: string;
  name: string;
}

export const AI_MAX_IMAGES = 4;

/** Refuse absurd sources before decoding them into a bitmap. */
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const MAX_EDGE = 1280;
const JPEG_QUALITY = 0.82;

function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    return createImageBitmap(file).catch(() => loadWithImageElement(file));
  }
  return loadWithImageElement(file);
}

function loadWithImageElement(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("image-decode"));
    };
    image.src = url;
  });
}

export async function fileToAiImage(file: File): Promise<AiImage> {
  if (!file.type.startsWith("image/")) {
    throw new Error("not-an-image");
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error("too-large");
  }

  const source = await loadBitmap(file);
  const width = "width" in source ? source.width : 0;
  const height = "height" in source ? source.height : 0;
  if (!width || !height) {
    throw new Error("image-decode");
  }

  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("image-decode");
  }
  // JPEG has no alpha channel: without an explicit white background a
  // transparent PNG turns into black, which hides half of a UI screenshot.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, targetWidth, targetHeight);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source as CanvasImageSource, 0, 0, targetWidth, targetHeight);
  if ("close" in source && typeof source.close === "function") {
    source.close();
  }

  const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  // Drop the canvas backing store now instead of waiting for GC: at 1280 px it
  // is several megabytes that the renderer would otherwise keep around.
  canvas.width = 0;
  canvas.height = 0;

  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    dataUrl,
    name: file.name || "image",
  };
}

/** Pick image files out of a drop/paste payload. */
export function imageFilesFrom(list: FileList | File[] | null | undefined): File[] {
  if (!list) return [];
  return Array.from(list).filter((file) => file.type.startsWith("image/"));
}

/**
 * A pasted screenshot does not always show up in `files` (WebView2 puts it in
 * `items`), so fall back to the item list.
 */
export function imageFilesFromDataTransfer(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files = imageFilesFrom(data.files);
  if (files.length) return files;
  const out: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) out.push(file);
  }
  return out;
}
