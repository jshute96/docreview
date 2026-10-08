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

  if (mimeType === GoogleMimeType.Markdown) {
    return (
      <svg className={className} viewBox="0 0 24 24" role="img" aria-label="Markdown">
        <Square color="#4285F4" fill={squareFill} stroke={squareStroke} />
        <path
          transform="scale(1.3333)"
          fill="white"
          d="M3.92578 6C3.66369 6.00004 3.44397 6.09575 3.2666 6.28711C3.08913 6.47878 3 6.71667 3 7V12H4.38867V7.5H5.31445V10.5H6.7041V7.5H7.62988V12H9.01855V7C9.01855 6.71667 8.92942 6.47878 8.75195 6.28711C8.57459 6.09575 8.35486 6.00004 8.09277 6H3.92578ZM12.0273 9.125L10.917 7.9248L9.94434 9L12.7227 12L15.5 9L14.5273 7.9248L13.417 9.125V6H12.0273V9.125Z"
        />
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
