interface IconProps {
  name: string
  className?: string
  /** Fill the glyph (Material Symbols FILL axis). */
  fill?: boolean
  /** Pixel size; defaults to inherit from font-size. */
  size?: number
}

export function Icon({ name, className = '', fill = false, size }: IconProps) {
  return (
    <span
      className={`material-symbols-outlined select-none ${className}`}
      aria-hidden="true"
      style={{
        fontSize: size,
        fontVariationSettings: fill ? "'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 24" : undefined,
      }}
    >
      {name}
    </span>
  )
}
