-- Create helper UDFs for manual querying of obscured fields
CREATE FUNCTION encode_base64(text) RETURNS text AS $$
  SELECT encode(convert_to($1, 'UTF8'), 'base64')
$$ LANGUAGE sql IMMUTABLE;

CREATE FUNCTION decode_base64(text) RETURNS text AS $$
  SELECT convert_from(decode($1, 'base64'), 'UTF8')
$$ LANGUAGE sql IMMUTABLE;

-- Encode existing plaintext values
UPDATE docs SET title = encode_base64(title) WHERE title != '';
UPDATE docs SET notes = encode_base64(notes) WHERE notes IS NOT NULL;
UPDATE docs SET owner = encode_base64(owner) WHERE owner IS NOT NULL;
UPDATE labels SET name = encode_base64(name);
