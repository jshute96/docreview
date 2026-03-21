-- Owner is now fetched on demand from Google Drive API and cached in browser localStorage
ALTER TABLE docs DROP COLUMN IF EXISTS owner;
