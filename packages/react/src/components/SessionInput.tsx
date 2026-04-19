import {
  useState,
  useCallback,
  useRef,
  useEffect,
  type KeyboardEvent,
  type ClipboardEvent,
  type DragEvent,
  type ChangeEvent,
} from "react";
import { Send, X, ImageIcon } from "lucide-react";
import type { ImageAttachment } from "@synapse-chat/core";
import { cn } from "../lib/utils.js";

const ACCEPTED_TYPES = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

type ImageMediaType = ImageAttachment["mediaType"];

const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_IMAGES = 10;
const MAX_ROWS = 6;
const LINE_HEIGHT = 20;
const PADDING_Y = 8;

interface PreviewAttachment extends ImageAttachment {
  objectUrl: string;
}

function fileToAttachment(file: File): Promise<PreviewAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(",")[1] ?? "";
      const objectUrl = URL.createObjectURL(file);
      resolve({
        base64,
        mediaType: file.type as ImageMediaType,
        objectUrl,
      });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export interface SessionInputProps {
  /** Controlled text value. */
  value: string;
  /** Called on every text change (keystroke, paste without images, clear). */
  onChange: (value: string) => void;
  /**
   * Called when the user hits Enter or the send button. Receives the trimmed
   * text and optional image attachments. The component clears its image
   * buffer on send; the caller is responsible for clearing `value`.
   */
  onSend: (message: string, images?: ImageAttachment[]) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Maximum number of images the user can attach in a single send. */
  maxImages?: number;
  /** Maximum byte size per image. Larger files are silently rejected. */
  maxImageBytes?: number;
  /** Additional classes merged onto the outer container. */
  className?: string;
}

export function SessionInput({
  value,
  onChange,
  onSend,
  disabled,
  placeholder = "Send a message...",
  maxImages = DEFAULT_MAX_IMAGES,
  maxImageBytes = DEFAULT_MAX_IMAGE_BYTES,
  className,
}: SessionInputProps) {
  const [images, setImages] = useState<PreviewAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imagesRef = useRef<PreviewAttachment[]>([]);

  const resetHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const maxHeight = LINE_HEIGHT * MAX_ROWS + PADDING_Y;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, []);

  useEffect(() => {
    resetHeight();
  }, [value, resetHeight]);

  imagesRef.current = images;

  useEffect(() => {
    return () => {
      for (const img of imagesRef.current) URL.revokeObjectURL(img.objectUrl);
    };
  }, []);

  const addImages = useCallback(
    async (files: File[]) => {
      const valid = files.filter(
        (f) => ACCEPTED_TYPES.has(f.type) && f.size <= maxImageBytes,
      );
      if (valid.length === 0) return;
      const results = await Promise.allSettled(valid.map(fileToAttachment));
      const attachments = results
        .filter(
          (r): r is PromiseFulfilledResult<PreviewAttachment> =>
            r.status === "fulfilled",
        )
        .map((r) => r.value);
      if (attachments.length === 0) return;
      setImages((prev) => {
        const merged = [...prev, ...attachments];
        for (const dropped of merged.slice(maxImages)) {
          URL.revokeObjectURL(dropped.objectUrl);
        }
        return merged.slice(0, maxImages);
      });
    },
    [maxImages, maxImageBytes],
  );

  const removeImage = useCallback((index: number) => {
    setImages((prev) => {
      const removed = prev[index];
      if (removed) URL.revokeObjectURL(removed.objectUrl);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed && images.length === 0) return;
    const toSend: ImageAttachment[] | undefined =
      images.length > 0
        ? images.map(({ base64, mediaType }) => ({ base64, mediaType }))
        : undefined;
    onSend(trimmed, toSend);
    for (const img of images) URL.revokeObjectURL(img.objectUrl);
    setImages([]);
    onChange("");
  }, [value, images, onSend, onChange]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const handleChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      onChange(e.target.value);
    },
    [onChange],
  );

  const handlePaste = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const imageFiles: File[] = [];
      for (const item of items) {
        if (item.kind === "file" && ACCEPTED_TYPES.has(item.type)) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        void addImages(imageFiles);
      }
    },
    [addImages],
  );

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (
      e.relatedTarget instanceof Node &&
      e.currentTarget.contains(e.relatedTarget)
    ) {
      return;
    }
    setDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      const files = Array.from(e.dataTransfer.files);
      void addImages(files);
    },
    [addImages],
  );

  const handleFileSelect = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      void addImages(files);
      e.target.value = "";
    },
    [addImages],
  );

  const canSend = !disabled && (value.trim().length > 0 || images.length > 0);

  return (
    <div
      className={cn(
        "border-t border-border",
        dragOver && "bg-primary/5 border-primary/30",
        className,
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {images.length > 0 && (
        <div className="flex gap-2 px-3 pt-3 pb-1 flex-wrap">
          {images.map((img, i) => (
            <div key={i} className="relative group">
              <img
                src={img.objectUrl}
                alt={`Attachment ${i + 1}`}
                className="h-16 w-16 rounded border border-border object-cover"
              />
              <button
                type="button"
                onClick={() => removeImage(i)}
                className={cn(
                  "absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full bg-destructive text-destructive-foreground",
                  "flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity",
                )}
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2 p-3 items-end">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          className="hidden"
          onChange={handleFileChange}
        />
        <button
          type="button"
          onClick={handleFileSelect}
          disabled={disabled}
          title="Attach image"
          className={cn(
            "shrink-0 inline-flex h-9 w-9 items-center justify-center rounded-md",
            "text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          <ImageIcon className="h-4 w-4" />
        </button>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          className={cn(
            "flex-1 resize-none overflow-y-auto rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors",
            "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={!canSend}
          className={cn(
            "shrink-0 inline-flex h-9 w-9 items-center justify-center rounded-md",
            "bg-primary text-primary-foreground hover:bg-primary/90 transition-colors",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
