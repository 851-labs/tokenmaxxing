const AVATAR_SIZES = {
  sm: 24,
  md: 32,
  lg: 56,
} as const;

type AvatarSize = keyof typeof AVATAR_SIZES | number;

interface AvatarProps {
  src: string | null;
  alt?: string;
  /** Edge length in pixels. */
  size?: AvatarSize;
  /** Eager-load the image (use for above-the-fold avatars). */
  priority?: boolean;
}

/** A square avatar image with a muted fallback when `src` is null. */
function Avatar({ src, alt = "", size = 28, priority = false }: AvatarProps) {
  const pixels = typeof size === "number" ? size : AVATAR_SIZES[size];
  const style = { width: pixels, height: pixels };

  if (src === null) {
    return <span className="shrink-0 select-none bg-muted" style={style} />;
  }

  return (
    <img
      alt={alt}
      className="shrink-0 select-none"
      draggable={false}
      fetchPriority={priority ? "high" : undefined}
      loading={priority ? "eager" : "lazy"}
      src={src}
      style={style}
    />
  );
}

export { Avatar };
