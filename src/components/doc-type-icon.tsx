import { GoogleMimeType } from "@/lib/mime-types";

interface DocTypeIconProps {
  mimeType: string | null;
  className?: string;
  /** Overrides the colored square's fill (e.g. a lighter tint for an
   *  unselected filter). */
  squareFill?: string;
  /** Draws a 1px border around the square in this color. */
  squareStroke?: string;
}

/** The icon's colored square. With a border, it's inset by half the stroke so
 *  the border stays inside the 24x24 viewBox. */
function Square({ color, fill, stroke }: { color: string; fill?: string; stroke?: string }) {
  return stroke ? (
    <rect x="0.75" y="0.75" width="22.5" height="22.5" rx="3" fill={fill ?? color} stroke={stroke} strokeWidth="1.5" />
  ) : (
    <rect width="24" height="24" rx="3" fill={fill ?? color} />
  );
}

export function DocTypeIcon({ mimeType, className = "h-4 w-4", squareFill, squareStroke }: DocTypeIconProps) {
  if (mimeType === GoogleMimeType.Doc) {
    return (
      <svg className={className} viewBox="0 0 24 24" role="img" aria-label="Google Doc">
        <Square color="#4285F4" fill={squareFill} stroke={squareStroke} />
        <rect x="5" y="7" width="14" height="2" rx="1" fill="white" />
        <rect x="5" y="11" width="14" height="2" rx="1" fill="white" />
        <rect x="5" y="15" width="9" height="2" rx="1" fill="white" />
      </svg>
    );
  }

  if (mimeType === GoogleMimeType.Sheet) {
    return (
      <svg className={className} viewBox="0 0 24 24" role="img" aria-label="Google Sheet">
        <Square color="#34A853" fill={squareFill} stroke={squareStroke} />
        <rect x="5" y="5" width="6" height="6" rx="0.5" fill="white" />
        <rect x="13" y="5" width="6" height="6" rx="0.5" fill="white" />
        <rect x="5" y="13" width="6" height="6" rx="0.5" fill="white" />
        <rect x="13" y="13" width="6" height="6" rx="0.5" fill="white" />
      </svg>
    );
  }

  if (mimeType === GoogleMimeType.Slides) {
    return (
      <svg className={className} viewBox="0 0 24 24" role="img" aria-label="Google Slide">
        <Square color="#FBBC04" fill={squareFill} stroke={squareStroke} />
        <rect x="4" y="7" width="16" height="10" rx="1.5" fill="white" />
      </svg>
    );
  }

  return (
    <svg className={className} viewBox="0 0 24 24" role="img" aria-label="Unknown Type">
      <Square color="#a1a1aa" fill={squareFill} stroke={squareStroke} />
      <text
        x="50%"
        y="50%"
        dominantBaseline="central"
        textAnchor="middle"
        fill="white"
        fontSize="16"
        fontWeight="bold"
      >
        ?
      </text>
    </svg>
  );
}
