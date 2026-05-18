-- Maps tags using the pre-brand palette names onto the current 9-hue set
-- (see src/db/schema.ts → TAG_COLORS). The CSS aliases for these legacy
-- names are being dropped, so any row still on one of them would render
-- with a missing background-color and disappear visually.
UPDATE tags SET color = 'grey'   WHERE color = 'gray';
UPDATE tags SET color = 'green'  WHERE color = 'teal';
UPDATE tags SET color = 'purple' WHERE color = 'indigo';
