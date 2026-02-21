interface DocTypeIconProps {
  mimeType: string | null;
  className?: string;
}

export function DocTypeIcon({ mimeType, className = "h-4 w-4" }: DocTypeIconProps) {
  if (mimeType === "application/vnd.google-apps.document") {
    return (
      <svg className={className} viewBox="0 0 24 24" aria-label="Google Doc">
        <rect width="24" height="24" rx="3" fill="#4285F4" />
        <rect x="5" y="7" width="14" height="2" rx="1" fill="white" />
        <rect x="5" y="11" width="14" height="2" rx="1" fill="white" />
        <rect x="5" y="15" width="9" height="2" rx="1" fill="white" />
      </svg>
    );
  }

  if (mimeType === "application/vnd.google-apps.spreadsheet") {
    return (
      <svg className={className} viewBox="0 0 24 24" aria-label="Google Sheet">
        <rect width="24" height="24" rx="3" fill="#34A853" />
        <rect x="5" y="5" width="6" height="6" rx="0.5" fill="white" />
        <rect x="13" y="5" width="6" height="6" rx="0.5" fill="white" />
        <rect x="5" y="13" width="6" height="6" rx="0.5" fill="white" />
        <rect x="13" y="13" width="6" height="6" rx="0.5" fill="white" />
      </svg>
    );
  }

  if (mimeType === "application/vnd.google-apps.presentation") {
    return (
      <svg className={className} viewBox="0 0 24 24" aria-label="Google Slide">
        <rect width="24" height="24" rx="3" fill="#FBBC04" />
        <rect x="4" y="7" width="16" height="10" rx="1.5" fill="white" />
      </svg>
    );
  }

  return null;
}
